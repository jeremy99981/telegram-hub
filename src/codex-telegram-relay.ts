import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type PullMessage = {
  id: string;
  project_key: string;
  thread_id: string;
  role: string;
  text: string;
  chat_id: number;
  telegram_message_id: number;
};

type PullResponse = {
  ok: boolean;
  messages?: PullMessage[];
  error?: string;
};

type PushResponse = {
  ok: boolean;
  outbox_id?: string;
  telegram_message_id?: number;
  error?: string;
};

type RelayState = {
  started_at: string;
  processed_message_ids: string[];
  updated_at: string;
};

type CodexEvent = {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
};

const hubUrl = (process.env.TELEGRAM_HUB_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const hubToken = (process.env.HUB_API_TOKEN || "").trim();
const projectKey = (process.env.TELEGRAM_PROJECT_KEY || "pilotage-ed").trim();
const threadId = (process.env.TELEGRAM_THREAD_ID || "default").trim();
const pollIntervalMs = Math.max(Number(process.env.CODEX_RELAY_POLL_MS || 2000), 500);
const thinkingPingMs = Math.max(Number(process.env.CODEX_RELAY_THINKING_PING_MS || 15000), 5000);
const defaultWorkspace = (process.env.CODEX_DEFAULT_WORKSPACE || process.cwd()).trim();
const projectWorkspaceMapRaw = (process.env.CODEX_PROJECT_WORKSPACES || "").trim();
const statePath = resolve(
  process.env.CODEX_RELAY_STATE_PATH || ".data/codex-telegram-relay-state.json"
);
const maxTelegramChars = 3500;
const isWindows = process.platform === "win32";
const codexPs1Path = resolve(process.env.APPDATA || "", "npm", "codex.ps1");

const requiredEnv = (name: string, value: string) => {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

requiredEnv("HUB_API_TOKEN", hubToken);

const parseWorkspaceMap = (raw: string): Record<string, string> => {
  const map: Record<string, string> = {};
  if (!raw) return map;
  for (const token of raw.split(";")) {
    const pair = token.trim();
    if (!pair) continue;
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();
    if (key && value) {
      map[key] = value;
    }
  }
  return map;
};

const workspaceMap = parseWorkspaceMap(projectWorkspaceMapRaw);

const resolveWorkspace = (project: string): string => {
  return workspaceMap[project.toLowerCase()] || defaultWorkspace;
};

const nowIso = () => new Date().toISOString();

const loadState = (): RelayState => {
  try {
    const content = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(content) as Partial<RelayState>;
    return {
      started_at: parsed.started_at || nowIso(),
      processed_message_ids: Array.isArray(parsed.processed_message_ids)
        ? parsed.processed_message_ids.slice(-5000)
        : [],
      updated_at: parsed.updated_at || nowIso(),
    };
  } catch {
    return {
      started_at: nowIso(),
      processed_message_ids: [],
      updated_at: nowIso(),
    };
  }
};

let relayState = loadState();

const saveState = () => {
  mkdirSync(dirname(statePath), { recursive: true });
  relayState.updated_at = nowIso();
  writeFileSync(statePath, JSON.stringify(relayState, null, 2), "utf8");
};

const seenMessage = (id: string): boolean => relayState.processed_message_ids.includes(id);

const markMessageSeen = (id: string) => {
  relayState.processed_message_ids.push(id);
  relayState.processed_message_ids = relayState.processed_message_ids.slice(-5000);
  saveState();
};

const postHub = async <T>(path: string, payload: object): Promise<T> => {
  const response = await fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${hubToken}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text().catch(() => "");
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!response.ok) {
    throw new Error(text || `HTTP ${response.status}`);
  }
  return json as T;
};

const splitMessage = (text: string): string[] => {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxTelegramChars) return [normalized];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxTelegramChars) {
    let cut = remaining.lastIndexOf("\n", maxTelegramChars);
    if (cut <= 0) cut = remaining.lastIndexOf(" ", maxTelegramChars);
    if (cut <= 0) cut = maxTelegramChars;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

const pushMessage = async (
  project: string,
  thread: string,
  role: "assistant" | "system" | "subagent" | "question",
  text: string
) => {
  for (const chunk of splitMessage(text)) {
    const response = await postHub<PushResponse>("/bridge/push", {
      project_key: project,
      thread_id: thread,
      role,
      text: chunk,
    });
    if (!response.ok) {
      throw new Error(response.error || "Push failed");
    }
  }
};

const pullMessages = async (): Promise<PullMessage[]> => {
  const response = await postHub<PullResponse>("/bridge/pull", {
    project_key: projectKey,
    thread_id: threadId,
    limit: 20,
    consume: true,
  });
  if (!response.ok) {
    throw new Error(response.error || "Pull failed");
  }
  return response.messages || [];
};

const runCommand = async (
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string }> => {
  return new Promise((resolvePromise) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
};

const getGitStatusSummary = async (workspace: string): Promise<string> => {
  const check = await runCommand("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"], workspace);
  if (check.code !== 0 || !check.stdout.includes("true")) {
    return "";
  }
  const status = await runCommand("git", ["-C", workspace, "status", "--short"], workspace);
  const lines = status.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "";
  const preview = lines.slice(0, 30).join("\n");
  const extra = lines.length > 30 ? `\n... ${lines.length - 30} ligne(s) supplementaire(s)` : "";
  return `${preview}${extra}`;
};

const buildRelayPrompt = (userText: string, workspace: string): string => {
  return [
    "Tu es Codex CLI en mode relais Telegram.",
    "Reponds en francais.",
    "Si la demande implique du code, effectue les modifications directement dans le workspace.",
    "Reste concret et actionnable.",
    `Workspace: ${workspace}`,
    "",
    "Demande utilisateur Telegram:",
    userText,
  ].join("\n");
};

const runCodexExec = async (
  userText: string,
  workspace: string,
  project: string,
  thread: string
): Promise<{ reply: string; status: string }> => {
  const prompt = buildRelayPrompt(userText, workspace);
  const codexArgs = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    workspace,
  ];

  return new Promise((resolvePromise) => {
    const command = isWindows && existsSync(codexPs1Path) ? "powershell.exe" : "codex";
    const args =
      command === "powershell.exe"
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", codexPs1Path, ...codexArgs]
        : codexArgs;

    const proc = spawn(command, args, {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    let stderr = "";
    let finalReply = "";
    let done = false;
    let lastProgressAt = Date.now();

    const thinkingTimer = setInterval(() => {
      const now = Date.now();
      if (now - lastProgressAt >= thinkingPingMs) {
        lastProgressAt = now;
        void pushMessage(project, thread, "system", "Je suis toujours en reflexion sur ta demande...");
      }
    }, 2000);

    const finalize = (reply: string, status: string) => {
      if (done) return;
      done = true;
      clearInterval(thinkingTimer);
      resolvePromise({ reply, status });
    };

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const event = JSON.parse(trimmed) as CodexEvent;
        if (event.type === "turn.started") {
          lastProgressAt = Date.now();
        }
        if (event.type === "item.completed" && event.item?.type === "agent_message") {
          finalReply = event.item.text || finalReply;
          lastProgressAt = Date.now();
        }
      } catch {
        // Ignore non-JSON lines from codex warnings.
      }
    };

    let stdoutBuffer = "";
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        handleLine(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) {
        handleLine(stdoutBuffer);
      }
      if (code === 0) {
        finalize(finalReply.trim() || "Termine sans reponse textuelle.", "ok");
        return;
      }
      const err = stderr.trim() || `codex exec failed with code ${code}`;
      finalize("", err);
    });
  });
};

const processUserMessage = async (message: PullMessage) => {
  const userText = (message.text || "").trim();
  if (!userText) return;

  if (seenMessage(message.id)) return;
  markMessageSeen(message.id);

  const workspace = resolveWorkspace(message.project_key);
  if (!existsSync(workspace)) {
    await pushMessage(
      message.project_key,
      message.thread_id,
      "system",
      `Workspace introuvable pour ${message.project_key}: ${workspace}`
    );
    return;
  }

  await pushMessage(
    message.project_key,
    message.thread_id,
    "system",
    `Reflexion en cours...\nProjet: ${message.project_key}\nThread: ${message.thread_id}\nWorkspace: ${workspace}`
  );

  const result = await runCodexExec(
    userText,
    workspace,
    message.project_key,
    message.thread_id
  );

  if (result.status !== "ok") {
    await pushMessage(
      message.project_key,
      message.thread_id,
      "system",
      `Erreur Codex CLI:\n${result.status}`
    );
    return;
  }

  await pushMessage(message.project_key, message.thread_id, "assistant", result.reply);

  const gitSummary = await getGitStatusSummary(workspace);
  if (gitSummary) {
    await pushMessage(
      message.project_key,
      message.thread_id,
      "system",
      `Modifications detectees dans le workspace:\n${gitSummary}`
    );
  }
};

const runLoop = async () => {
  await pushMessage(
    projectKey,
    threadId,
    "system",
    "Connecte. Relais Codex CLI local actif."
  );

  while (true) {
    try {
      const messages = await pullMessages();
      for (const message of messages) {
        await processUserMessage(message);
      }
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      console.error(`[relay] ${errText}`);
    }
    await delay(pollIntervalMs);
  }
};

runLoop().catch((error) => {
  const errText = error instanceof Error ? error.message : String(error);
  console.error(errText);
  process.exit(1);
});
