import { setTimeout as delay } from "node:timers/promises";

type BridgePullResponse = {
  ok: boolean;
  messages?: Array<{
    id: string;
    project_key: string;
    thread_id: string;
    role: string;
    text: string;
    chat_id: number;
    telegram_message_id: number;
  }>;
  consumed?: boolean;
  error?: string;
};

const hubUrl = (process.env.TELEGRAM_HUB_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const apiToken = (process.env.HUB_API_TOKEN || "").trim();
const defaultProject = (process.env.TELEGRAM_PROJECT_KEY || "pilotage-ed").trim();

const usage = [
  "Usage:",
  "  npm run bridge -- bind [project_key] [chat_id]",
  "  npm run bridge -- pull [project_key] [thread_id]",
  "  npm run bridge -- push [project_key] [thread_id] [role] <text...>",
  "  npm run bridge -- watch [project_key] [thread_id] [interval_ms]",
].join("\n");

const ensureToken = () => {
  if (!apiToken) {
    throw new Error("Missing HUB_API_TOKEN environment variable.");
  }
};

const headers = () => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiToken}`,
});

const postJson = async <T>(path: string, payload: object): Promise<T> => {
  ensureToken();
  const response = await fetch(`${hubUrl}${path}`, {
    method: "POST",
    headers: headers(),
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
    const payloadText = text || `HTTP ${response.status}`;
    throw new Error(payloadText);
  }

  return json as T;
};

const cmdBind = async (args: string[]) => {
  const projectKey = (args[0] || defaultProject).trim();
  const chatIdArg = args[1] ? Number(args[1]) : undefined;
  const payload: { project_key: string; chat_id?: number } = { project_key: projectKey };
  if (Number.isFinite(chatIdArg)) payload.chat_id = chatIdArg;
  const result = await postJson<{ ok: boolean; project_key: string; chat_id: number }>(
    "/projects/bind",
    payload
  );
  console.log(JSON.stringify(result, null, 2));
};

const cmdPull = async (args: string[]) => {
  const projectKey = (args[0] || defaultProject).trim();
  const threadId = (args[1] || "default").trim();
  const result = await postJson<BridgePullResponse>("/bridge/pull", {
    project_key: projectKey,
    thread_id: threadId,
    consume: true,
    limit: 50,
  });
  console.log(JSON.stringify(result, null, 2));
};

const cmdPush = async (args: string[]) => {
  const projectKey = (args[0] || defaultProject).trim();
  const threadId = (args[1] || "default").trim();
  const role = (args[2] || "assistant").trim();
  const text = args.slice(3).join(" ").trim();
  if (!text) {
    throw new Error("Missing text for push.");
  }
  const result = await postJson<{ ok: boolean; outbox_id: string; telegram_message_id: number }>(
    "/bridge/push",
    {
      project_key: projectKey,
      thread_id: threadId,
      role,
      text,
    }
  );
  console.log(JSON.stringify(result, null, 2));
};

const cmdWatch = async (args: string[]) => {
  const projectKey = (args[0] || defaultProject).trim();
  const threadId = (args[1] || "default").trim();
  const intervalMs = Math.max(Number(args[2] || 2000), 500);
  console.log(
    `[bridge-watch] ${projectKey}/${threadId} from ${hubUrl} every ${intervalMs}ms (consume=true)`
  );

  while (true) {
    try {
      const result = await postJson<BridgePullResponse>("/bridge/pull", {
        project_key: projectKey,
        thread_id: threadId,
        consume: true,
        limit: 50,
      });
      for (const message of result.messages || []) {
        const ts = new Date().toISOString();
        console.log(`[${ts}] ${message.project_key}/${message.thread_id} ${message.role}:`);
        console.log(message.text);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
    }
    await delay(intervalMs);
  }
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.log(usage);
    return;
  }

  if (command === "bind") {
    await cmdBind(args);
    return;
  }
  if (command === "pull") {
    await cmdPull(args);
    return;
  }
  if (command === "push") {
    await cmdPush(args);
    return;
  }
  if (command === "watch") {
    await cmdWatch(args);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${usage}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
