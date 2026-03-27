import express, { type NextFunction, type Request, type Response } from "express";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import {
  config,
  normalizeProjectKey,
  normalizeThreadId,
} from "./config.js";
import { sendTelegramMessage } from "./telegram.js";
import type {
  BridgePullPayload,
  BridgePushPayload,
  ProjectsBindPayload,
  TelegramMessage,
  TelegramUpdate,
} from "./types.js";

type InboxPullRecord = {
  id: string;
  project_key: string;
  thread_id: string;
  role: "user";
  text: string;
  status: "pending" | "consumed";
  chat_id: number;
  telegram_message_id: number;
};

const app = express();
app.use(express.json({ limit: "1mb" }));

const SETTINGS_DOC = db.collection("settings").doc("hub");

const projectDoc = (projectKey: string) => db.collection("projects").doc(projectKey);
const bindingDocId = (projectKey: string, chatId: number) => `${projectKey}_${chatId}`;
const bindingDoc = (projectKey: string, chatId: number) =>
  db.collection("bindings").doc(bindingDocId(projectKey, chatId));
const chatContextDoc = (chatId: number) => db.collection("chatContexts").doc(String(chatId));

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

const getOwnerChatId = async (): Promise<number | null> => {
  if (config.ownerChatId) {
    const numeric = Number(config.ownerChatId);
    return Number.isFinite(numeric) ? numeric : null;
  }

  const snapshot = await SETTINGS_DOC.get();
  const value = snapshot.get("owner_chat_id");
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value.trim());
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
};

const ensureOwnerChat = async (chatId: number): Promise<boolean> => {
  if (config.ownerChatId) {
    return Number(config.ownerChatId) === chatId;
  }

  const current = await getOwnerChatId();
  if (current != null) return current === chatId;

  await SETTINGS_DOC.set(
    {
      owner_chat_id: chatId,
      owner_bound_at: FieldValue.serverTimestamp(),
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  return true;
};

const requireHubToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token || token !== config.hubApiToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
};

const resolveActiveProjectForChat = async (chatId: number): Promise<string | null> => {
  const contextSnapshot = await chatContextDoc(chatId).get();
  const activeFromContext = contextSnapshot.get("active_project_key");
  if (typeof activeFromContext === "string" && activeFromContext.trim()) {
    return activeFromContext;
  }

  const bindings = await db
    .collection("bindings")
    .where("chat_id", "==", chatId)
    .where("active", "==", true)
    .limit(2)
    .get();

  if (bindings.size === 1) {
    const projectKey = bindings.docs[0].get("project_key");
    return typeof projectKey === "string" ? projectKey : null;
  }

  return null;
};

const bindProjectToChat = async (
  projectKeyRaw: string,
  chatId: number,
  enabled = true,
  primary = true
) => {
  const projectKey = normalizeProjectKey(projectKeyRaw);

  await projectDoc(projectKey).set(
    {
      project_key: projectKey,
      enabled,
      primary_chat_id: primary ? chatId : undefined,
      updated_at: FieldValue.serverTimestamp(),
      created_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await bindingDoc(projectKey, chatId).set(
    {
      project_key: projectKey,
      chat_id: chatId,
      active: true,
      updated_at: FieldValue.serverTimestamp(),
      created_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await chatContextDoc(chatId).set(
    {
      active_project_key: projectKey,
      active_thread_id: "default",
      updated_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

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

  const activeProject = await resolveActiveProjectForChat(chatId);
  if (!activeProject) {
    await sendTelegramMessage(
      chatId,
      "Aucun projet actif sur ce chat. Utilise /bind <project_key>."
    );
    return;
  }

  const projectSnapshot = await projectDoc(activeProject).get();
  if (!projectSnapshot.exists || projectSnapshot.get("enabled") === false) {
    await sendTelegramMessage(
      chatId,
      `Projet ${activeProject} inactif.`
    );
    return;
  }

  const threadId =
    (await chatContextDoc(chatId).get()).get("active_thread_id") || "default";
  const normalizedThread = normalizeThreadId(String(threadId));
  const recordId = `${activeProject}_${normalizedThread}_${message.message_id}`;

  await db.collection("inbox").doc(recordId).set(
    {
      project_key: activeProject,
      thread_id: normalizedThread,
      role: "user",
      text,
      source: "telegram",
      status: "pending",
      chat_id: chatId,
      telegram_message_id: message.message_id,
      created_at: FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
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

    const normalized = await bindProjectToChat(projectKey, chatId, true, true);
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
    const binding = await bindingDoc(normalized, chatId).get();
    if (!binding.exists || binding.get("active") !== true) {
      await sendTelegramMessage(chatId, `Ce chat n'est pas lie a ${normalized}.`);
      return true;
    }

    await chatContextDoc(chatId).set(
      {
        active_project_key: normalized,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await sendTelegramMessage(chatId, `Projet actif: ${normalized}`);
    return true;
  }

  if (cmd === "/thread") {
    const threadId = normalizeThreadId(args[0] || "default");
    await chatContextDoc(chatId).set(
      {
        active_thread_id: threadId,
        updated_at: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await sendTelegramMessage(chatId, `Thread actif: ${threadId}`);
    return true;
  }

  return false;
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/telegram/webhook/:secret",
  async (req: Request<{ secret: string }>, res: Response) => {
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
      const message = update.message;
      if (!message?.chat?.id) {
        return res.json({ ok: true });
      }

      const authorized = await ensureOwnerChat(message.chat.id);
      if (!authorized) {
        await sendTelegramMessage(
          message.chat.id,
          "Acces refuse: ce bot est reserve au chat proprietaire."
        );
        return res.json({ ok: true });
      }

      const commandHandled = await handleTelegramCommand(message);
      if (!commandHandled) {
        await pushInboxMessage(message);
      }

      return res.json({ ok: true });
    } catch (error) {
      console.error("[telegram-webhook]", error);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

app.post("/projects/bind", requireHubToken, async (req: Request, res: Response) => {
  try {
    const body = req.body as ProjectsBindPayload;
    const projectKeyRaw = body.project_key;
    if (!projectKeyRaw) {
      return res.status(400).json({ error: "Missing project_key" });
    }

    const ownerChatId = await getOwnerChatId();
    const chatId = Number(body.chat_id ?? ownerChatId);
    if (!Number.isFinite(chatId)) {
      return res.status(400).json({ error: "Missing chat_id and no owner configured yet" });
    }

    const projectKey = await bindProjectToChat(
      projectKeyRaw,
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

    const projectSnapshot = await projectDoc(projectKey).get();
    if (!projectSnapshot.exists || projectSnapshot.get("enabled") === false) {
      return res.status(404).json({ error: "Project not found or disabled" });
    }

    const chatId = Number(projectSnapshot.get("primary_chat_id"));
    if (!Number.isFinite(chatId)) {
      return res.status(409).json({ error: "Project is not bound to a chat" });
    }

    const bindingSnapshot = await bindingDoc(projectKey, chatId).get();
    if (!bindingSnapshot.exists || bindingSnapshot.get("active") !== true) {
      return res.status(409).json({ error: "Binding missing or inactive" });
    }

    const formatted = formatBridgeMessage(role, projectKey, threadId, text);
    const sendResult = await sendTelegramMessage(chatId, formatted);

    const fallbackId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const messageId = sendResult.messageId ?? fallbackId;
    const outboxId = `${projectKey}_${threadId}_${messageId}`;

    await db.collection("outbox").doc(outboxId).set(
      {
        project_key: projectKey,
        thread_id: threadId,
        role,
        text,
        source: "bridge",
        status: sendResult.error ? "failed" : "sent",
        chat_id: chatId,
        telegram_message_id: sendResult.messageId,
        created_at: FieldValue.serverTimestamp(),
        sent_at: sendResult.error ? undefined : FieldValue.serverTimestamp(),
        error: sendResult.error,
      },
      { merge: true }
    );

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

    const projectSnapshot = await projectDoc(projectKey).get();
    if (!projectSnapshot.exists || projectSnapshot.get("enabled") === false) {
      return res.status(404).json({ error: "Project not found or disabled" });
    }

    const prefix = `${projectKey}_${threadId}_`;
    const snapshot = await db
      .collection("inbox")
      .where(FieldPath.documentId(), ">=", prefix)
      .where(FieldPath.documentId(), "<=", `${prefix}\uf8ff`)
      .limit(limit * 5)
      .get();

    const pending = snapshot.docs
      .map((doc) => {
        const data = doc.data() as Partial<Omit<InboxPullRecord, "id">>;
        return {
          id: doc.id,
          project_key: typeof data.project_key === "string" ? data.project_key : "",
          thread_id: typeof data.thread_id === "string" ? data.thread_id : "",
          role: "user",
          text: typeof data.text === "string" ? data.text : "",
          status: data.status === "consumed" ? "consumed" : "pending",
          chat_id: Number(data.chat_id || 0),
          telegram_message_id: Number(data.telegram_message_id || 0),
        } as InboxPullRecord;
      })
      .filter((record) => record.status === "pending" && record.text.trim().length > 0)
      .slice(0, limit);

    if (consume && pending.length > 0) {
      const batch = db.batch();
      for (const record of pending) {
        batch.set(
          db.collection("inbox").doc(record.id),
          {
            status: "consumed",
            consumed_at: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }
      await batch.commit();
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

const start = () => {
  app.listen(config.port, () => {
    console.log(`[telegram-hub] listening on :${config.port}`);
  });
};

start();
