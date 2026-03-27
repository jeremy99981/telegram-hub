const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
};

export const config = {
  botToken: required("TELEGRAM_BOT_TOKEN"),
  webhookSecret: required("TELEGRAM_WEBHOOK_SECRET"),
  hubApiToken: required("HUB_API_TOKEN"),
  webhookHeaderToken: process.env.TELEGRAM_WEBHOOK_HEADER_TOKEN?.trim() || "",
  ownerChatId: process.env.TELEGRAM_OWNER_CHAT_ID?.trim() || "",
  publicUrl: process.env.HUB_PUBLIC_URL?.trim() || "",
  autoAck: /^(1|true|yes|on)$/i.test(process.env.TELEGRAM_AUTO_ACK?.trim() || "true"),
  port: Number(process.env.PORT || 8080),
};

export const telegramApiBase = `https://api.telegram.org/bot${config.botToken}`;

export const normalizeProjectKey = (raw: string): string => {
  const value = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(value)) {
    throw new Error("Invalid project_key. Use [a-z0-9_-], min 2 chars.");
  }
  return value;
};

export const normalizeThreadId = (raw?: string): string => {
  const value = (raw || "default").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value)) {
    return "default";
  }
  return value;
};
