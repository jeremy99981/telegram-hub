import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  config,
  normalizeProjectKey,
  normalizeThreadId,
  telegramApiBase,
} from "./config.js";
import { sendTelegramMessage } from "./telegram.js";
import type {
  BridgePullPayload,
  BridgePushPayload,
  ProjectsBindPayload,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

type ProjectRecord = {
  project_key: string;
  enabled: boolean;
  primary_chat_id?: number;
  created_at: string;
  updated_at: string;
};

type BindingRecord = {
  project_key: string;
  chat_id: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type ChatContextRecord = {
  active_project_key?: string;
  active_thread_id?: string;
  updated_at: string;
};

type InboxRecord = {
  id: string;
  project_key: string;
  thread_id: string;
  role: "user";
  text: string;
  source: "telegram";
  status: "pending" | "consumed";
  chat_id: number;
  telegram_message_id: number;
  created_at: string;
  consumed_at?: string;
};

type OutboxRecord = {
  id: string;
  project_key: string;
  thread_id: string;
  role: string;
  text: string;
  source: "bridge";
  status: "sent" | "failed";
  chat_id: number;
  telegram_message_id?: number;
  created_at: string;
  sent_at?: string;
  error?: string;
};

type LocalStore = {
  settings: {
    owner_chat_id?: number;
    last_update_id?: number;
    updated_at?: string;
  };
  projects: Record<string, ProjectRecord>;
  bindings: Record<string, BindingRecord>;
  chatContexts: Record<string, ChatContextRecord>;
  inbox: Record<string, InboxRecord>;
  outbox: Record<string, OutboxRecord>;
};

type TelegramApiResult<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

const nowIso = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const storePath = resolve(
  process.env.HUB_LOCAL_STORE_PATH || ".data/telegram-hub-store.json"
);

const loadStore = (): LocalStore => {
  try {
    const content = readFileSync(storePath, "utf8");
    const parsed = JSON.parse(content) as Partial<LocalStore>;
    return {
      settings: parsed.settings || {},
      projects: parsed.projects || {},
      bindings: parsed.bindings || {},
      chatContexts: parsed.chatContexts || {},
      inbox: parsed.inbox || {},
      outbox: parsed.outbox || {},
    };
  } catch {
    return {
      settings: {},
      projects: {},
      bindings: {},
      chatContexts: {},
      inbox: {},
      outbox: {},
    };
  }
};

let store = loadStore();

const saveStore = () => {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify(store, null, 2), "utf8");
};

const formatBridgeMessage = (
  role: string | undefined,
  projectKey: string,
  threadId: string,
  text: string
): string => {
  const prefix =
    role === "question"
      ? "Question"
      : role === "subagent"
      ? "Subagent"
      : role === "system"
      ? "Systeme"
      : "Assistant";
  return `[${projectKey}/${threadId}] ${prefix}\n${text}`;
};

const bindingDocId = (projectKey: string, chatId: number) => `${projectKey}_${chatId}`;

const getOwnerChatId = (): number | null => {
  if (config.ownerChatId) {
    const numeric = Number(config.ownerChatId);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return typeof store.settings.owner_chat_id === "number"
    ? store.settings.owner_chat_id
    : null;
};

const ensureOwnerChat = (chatId: number): boolean => {
  const configuredOwner = getOwnerChatId();
  if (configuredOwner != null) {
    return configuredOwner === chatId;
  }
  store.settings.owner_chat_id = chatId;
  store.settings.updated_at = nowIso();
  saveStore();
  return true;
};

const resolveActiveProjectForChat = (chatId: number): string | null => {
  const context = store.chatContexts[String(chatId)];
  const activeFromContext = context?.active_project_key;
  if (activeFromContext) return activeFromContext;

  const activeBindings = Object.values(store.bindings).filter(
    (record) => record.chat_id === chatId && record.active
  );
  if (activeBindings.length === 1) {
    return activeBindings[0].project_key;
  }
  return null;
};

const bindProjectToChat = (
  projectKeyRaw: string,
  chatId: number,
  enabled = true,
  primary = true
) => {
  const projectKey = normalizeProjectKey(projectKeyRaw);
  const timestamp = nowIso();
  const existingProject = store.projects[projectKey];
  store.projects[projectKey] = {
    project_key: projectKey,
    enabled,
    primary_chat_id: primary ? chatId : existingProject?.primary_chat_id,
    created_at: existingProject?.created_at || timestamp,
    updated_at: timestamp,
  };

  const bindingId = bindingDocId(projectKey, chatId);
  const existingBinding = store.bindings[bindingId];
  store.bindings[bindingId] = {
    project_key: projectKey,
    chat_id: chatId,
    active: true,
    created_at: existingBinding?.created_at || timestamp,
    updated_at: timestamp,
  };

  const existingContext = store.chatContexts[String(chatId)];
  store.chatContexts[String(chatId)] = {
    active_project_key: projectKey,
    active_thread_id: existingContext?.active_thread_id || "default",
    updated_at: timestamp,
  };
  saveStore();
  return projectKey;
};

const parseCommand = (text: string): { cmd: string; args: string[] } => {
  const [rawCmd, ...rest] = text.trim().split(/\s+/);
  return { cmd: rawCmd.toLowerCase(), args: rest };
};

const helpText =
  "Commandes:\n" +
  "/bind <project_key> -> lier ce chat au projet\n" +
  "/use <project_key> -> definir le projet actif\n" +
  "/thread <thread_id> -> definir le thread actif\n" +
  "Puis envoie ton message normal.";

const pushInboxMessage = async (message: TelegramMessage) => {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (!text) return;

  const activeProject = resolveActiveProjectForChat(chatId);
  if (!activeProject) {
    await sendTelegramMessage(
      chatId,
      "Aucun projet actif sur ce chat. Utilise /bind <project_key>."
    );
    return;
  }

  const project = store.projects[activeProject];
  if (!project || project.enabled === false) {
    await sendTelegramMessage(chatId, `Projet ${activeProject} inactif.`);
    return;
  }

  const context = store.chatContexts[String(chatId)];
  const threadId = normalizeThreadId(context?.active_thread_id || "default");
  const recordId = `${activeProject}_${threadId}_${message.message_id}`;

  store.inbox[recordId] = {
    id: recordId,
    project_key: activeProject,
    thread_id: threadId,
    role: "user",
    text,
    source: "telegram",
    status: "pending",
    chat_id: chatId,
    telegram_message_id: message.message_id,
    created_at: nowIso(),
  };
  saveStore();

  if (config.autoAck) {
    const ackText = `Message recu et transmis.\nProjet: ${activeProject}\nThread: ${threadId}`;
    const ackResult = await sendTelegramMessage(chatId, ackText);
    if (ackResult.error) {
      console.error(`[auto-ack] ${ackResult.error}`);
    } else {
      const outboxId = `${activeProject}_${threadId}_${ackResult.messageId || Date.now()}`;
      store.outbox[outboxId] = {
        id: outboxId,
        project_key: activeProject,
        thread_id: threadId,
        role: "system",
        text: ackText,
        source: "bridge",
        status: "sent",
        chat_id: chatId,
        telegram_message_id: ackResult.messageId,
        created_at: nowIso(),
        sent_at: nowIso(),
      };
      saveStore();
    }
  }
};

const handleTelegramCommand = async (message: TelegramMessage): Promise<boolean> => {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();
  if (!text.startsWith("/")) return false;

  const { cmd, args } = parseCommand(text);
  if (cmd === "/start" || cmd === "/help") {
    await sendTelegramMessage(chatId, helpText);
    return true;
  }

  if (cmd === "/bind") {
    const projectKey = args[0];
    if (!projectKey) {
      await sendTelegramMessage(chatId, "Usage: /bind <project_key>");
      return true;
    }
    const normalized = bindProjectToChat(projectKey, chatId, true, true);
    await sendTelegramMessage(chatId, `Connecte\nProjet: ${normalized}\nThread: default`);
    return true;
  }

  if (cmd === "/use") {
    const projectKey = args[0];
    if (!projectKey) {
      await sendTelegramMessage(chatId, "Usage: /use <project_key>");
      return true;
    }
    const normalized = normalizeProjectKey(projectKey);
    const binding = store.bindings[bindingDocId(normalized, chatId)];
    if (!binding || binding.active !== true) {
      await sendTelegramMessage(chatId, `Ce chat n'est pas lie a ${normalized}.`);
      return true;
    }
    const existingContext = store.chatContexts[String(chatId)];
    store.chatContexts[String(chatId)] = {
      active_project_key: normalized,
      active_thread_id: existingContext?.active_thread_id || "default",
      updated_at: nowIso(),
    };
    saveStore();
    await sendTelegramMessage(chatId, `Projet actif: ${normalized}`);
    return true;
  }

  if (cmd === "/thread") {
    const threadId = normalizeThreadId(args[0] || "default");
    const existingContext = store.chatContexts[String(chatId)];
    store.chatContexts[String(chatId)] = {
      active_project_key: existingContext?.active_project_key,
      active_thread_id: threadId,
      updated_at: nowIso(),
    };
    saveStore();
    await sendTelegramMessage(chatId, `Thread actif: ${threadId}`);
    return true;
  }

  return false;
};

const processTelegramMessage = async (message: TelegramMessage) => {
  if (!message?.chat?.id) return;
  const chatId = message.chat.id;
  const authorized = ensureOwnerChat(chatId);
  if (!authorized) {
    await sendTelegramMessage(
      chatId,
      "Acces refuse: ce bot est reserve au chat proprietaire."
    );
    return;
  }
  const handled = await handleTelegramCommand(message);
  if (!handled) {
    await pushInboxMessage(message);
  }
};

const requireHubToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== config.hubApiToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "local",
    store_path: storePath,
    owner_chat_id: getOwnerChatId(),
  });
});

app.post("/telegram/webhook/:secret", async (req: Request<{ secret: string }>, res: Response) => {
  try {
    if (req.params.secret !== config.webhookSecret) {
      return res.status(401).json({ error: "Invalid webhook secret" });
    }
    if (config.webhookHeaderToken) {
      const headerToken = req.headers["x-telegram-bot-api-secret-token"];
      if (headerToken !== config.webhookHeaderToken) {
        return res.status(401).json({ error: "Invalid webhook header token" });
      }
    }
    const update = req.body as TelegramUpdate;
    if (update.message) {
      await processTelegramMessage(update.message);
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error("[local-webhook]", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.post("/projects/bind", requireHubToken, async (req: Request, res: Response) => {
  try {
    const body = req.body as ProjectsBindPayload;
    if (!body.project_key) {
      return res.status(400).json({ error: "Missing project_key" });
    }
    const ownerChatId = getOwnerChatId();
    const chatId = Number(body.chat_id ?? ownerChatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ error: "Missing chat_id and no owner configured yet" });
    }
    const projectKey = bindProjectToChat(
      body.project_key,
      chatId,
      body.enabled ?? true,
      body.primary ?? true
    );
    await sendTelegramMessage(chatId, `Connecte\nProjet: ${projectKey}\nThread: default`);
    return res.json({ ok: true, project_key: projectKey, chat_id: chatId });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Bind failed",
    });
  }
});

app.post("/bridge/push", requireHubToken, async (req: Request, res: Response) => {
  try {
    const body = req.body as BridgePushPayload;
    const projectKey = normalizeProjectKey(body.project_key || "");
    const threadId = normalizeThreadId(body.thread_id);
    const role = body.role || "assistant";
    const text = (body.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }
    const project = store.projects[projectKey];
    if (!project || project.enabled === false) {
      return res.status(404).json({ error: "Project not found or disabled" });
    }
    const chatId = Number(project.primary_chat_id);
    if (!Number.isFinite(chatId)) {
      return res.status(409).json({ error: "Project is not bound to a chat" });
    }
    const binding = store.bindings[bindingDocId(projectKey, chatId)];
    if (!binding || binding.active !== true) {
      return res.status(409).json({ error: "Binding missing or inactive" });
    }
    const formatted = formatBridgeMessage(role, projectKey, threadId, text);
    const sendResult = await sendTelegramMessage(chatId, formatted);
    const fallbackId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const messageId = sendResult.messageId ?? fallbackId;
    const outboxId = `${projectKey}_${threadId}_${messageId}`;
    store.outbox[outboxId] = {
      id: outboxId,
      project_key: projectKey,
      thread_id: threadId,
      role,
      text,
      source: "bridge",
      status: sendResult.error ? "failed" : "sent",
      chat_id: chatId,
      telegram_message_id: sendResult.messageId,
      created_at: nowIso(),
      sent_at: sendResult.error ? undefined : nowIso(),
      error: sendResult.error,
    };
    saveStore();
    if (sendResult.error) {
      return res.status(502).json({ error: sendResult.error, outbox_id: outboxId });
    }
    return res.json({ ok: true, outbox_id: outboxId, telegram_message_id: sendResult.messageId });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Push failed",
    });
  }
});

app.post("/bridge/pull", requireHubToken, async (req: Request, res: Response) => {
  try {
    const body = req.body as BridgePullPayload;
    const projectKey = normalizeProjectKey(body.project_key || "");
    const threadId = normalizeThreadId(body.thread_id);
    const limit = Math.min(Math.max(Number(body.limit || 20), 1), 100);
    const consume = body.consume !== false;

    const project = store.projects[projectKey];
    if (!project || project.enabled === false) {
      return res.status(404).json({ error: "Project not found or disabled" });
    }

    const prefix = `${projectKey}_${threadId}_`;
    const pending = Object.values(store.inbox)
      .filter((record) => record.id.startsWith(prefix) && record.status === "pending")
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit);

    if (consume) {
      const consumedAt = nowIso();
      for (const record of pending) {
        store.inbox[record.id] = {
          ...record,
          status: "consumed",
          consumed_at: consumedAt,
        };
      }
      if (pending.length > 0) {
        saveStore();
      }
    }

    const messages = pending.map((record) => ({
      id: record.id,
      project_key: record.project_key,
      thread_id: record.thread_id,
      role: record.role,
      text: record.text,
      chat_id: record.chat_id,
      telegram_message_id: record.telegram_message_id,
    }));
    return res.json({ ok: true, messages, consumed: consume });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "Pull failed",
    });
  }
});

const pollTelegramOnce = async () => {
  const offset = Number(store.settings.last_update_id || 0) + 1;
  const response = await fetch(`${telegramApiBase}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeout: 25,
      offset,
      allowed_updates: ["message"],
    }),
  });

  const json = (await response.json().catch(() => ({}))) as TelegramApiResult<TelegramUpdate[]>;
  if (!response.ok || !json.ok) {
    throw new Error(json.description || `getUpdates failed (${response.status})`);
  }

  const updates = json.result || [];
  if (updates.length === 0) return;

  for (const update of updates) {
    if (typeof update.update_id === "number") {
      store.settings.last_update_id = update.update_id;
      store.settings.updated_at = nowIso();
    }
    if (update.message) {
      await processTelegramMessage(update.message);
    }
  }
  saveStore();
};

const startPollingLoop = async () => {
  while (true) {
    try {
      await pollTelegramOnce();
    } catch (error) {
      console.error("[polling]", error instanceof Error ? error.message : String(error));
      await sleep(2000);
    }
  }
};

const start = () => {
  app.listen(config.port, () => {
    console.log(`[telegram-hub-local] listening on :${config.port}`);
    console.log(`[telegram-hub-local] store: ${storePath}`);
  });
};

start();
void startPollingLoop();
