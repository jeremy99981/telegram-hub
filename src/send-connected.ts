import { config, telegramApiBase } from "./config.js";
import { sendTelegramMessage } from "./telegram.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: {
      id?: number;
    };
  };
};

type TelegramApiResult<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type LocalStore = {
  settings?: {
    owner_chat_id?: number;
  };
};

const getLocalOwnerChatId = (): number | null => {
  const path = resolve(process.env.HUB_LOCAL_STORE_PATH || ".data/telegram-hub-store.json");
  try {
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content) as LocalStore;
    const chatId = Number(parsed.settings?.owner_chat_id);
    return Number.isFinite(chatId) ? chatId : null;
  } catch {
    return null;
  }
};

const resolveChatId = async (): Promise<number> => {
  if (config.ownerChatId) {
    const numeric = Number(config.ownerChatId);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  const localOwner = getLocalOwnerChatId();
  if (localOwner != null) {
    return localOwner;
  }

  const response = await fetch(`${telegramApiBase}/getUpdates`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      timeout: 0,
      limit: 100,
      allowed_updates: ["message"],
    }),
  });

  const json = (await response.json().catch(() => ({}))) as TelegramApiResult<TelegramUpdate[]>;
  if (!response.ok || !json.ok) {
    throw new Error(json.description || `getUpdates failed (${response.status})`);
  }

  const updates = json.result || [];
  for (let idx = updates.length - 1; idx >= 0; idx -= 1) {
    const chatId = Number(updates[idx].message?.chat?.id);
    if (Number.isFinite(chatId)) {
      return chatId;
    }
  }

  throw new Error(
    "Aucun chat detecte. Ecris d'abord au bot sur Telegram (/start ou /bind pilotage-ed), puis relance."
  );
};

async function main() {
  const chatId = await resolveChatId();
  const result = await sendTelegramMessage(chatId, "Connecte");
  if (result.error) {
    throw new Error(result.error);
  }
  console.log(`Message "Connecte" envoye au chat ${chatId}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
