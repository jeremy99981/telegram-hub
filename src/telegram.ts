import { config, telegramApiBase } from "./config.js";

type TelegramSendResponse = {
  ok: boolean;
  result?: {
    message_id: number;
  };
  description?: string;
};

export async function sendTelegramMessage(
  chatId: number,
  text: string
): Promise<{ messageId?: number; error?: string }> {
  const response = await fetch(`${telegramApiBase}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  const json = (await response.json().catch(() => ({}))) as TelegramSendResponse;
  if (!response.ok || !json.ok) {
    return {
      error: json.description || `sendMessage failed (${response.status})`,
    };
  }

  return {
    messageId: json.result?.message_id,
  };
}

export async function setTelegramWebhook(): Promise<void> {
  if (!config.publicUrl) {
    throw new Error("HUB_PUBLIC_URL is required for setWebhook.");
  }

  const webhookUrl = `${config.publicUrl.replace(/\/+$/, "")}/telegram/webhook/${config.webhookSecret}`;

  const response = await fetch(`${telegramApiBase}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: config.webhookHeaderToken || undefined,
      allowed_updates: ["message"],
      drop_pending_updates: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`setWebhook failed (${response.status}) ${text}`);
  }
}
