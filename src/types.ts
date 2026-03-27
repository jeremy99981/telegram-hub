export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id: number;
  date?: number;
  text?: string;
  chat: {
    id: number;
    type?: string;
    username?: string;
    title?: string;
  };
  from?: {
    id: number;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
};

export type BridgePushPayload = {
  project_key: string;
  thread_id?: string;
  role?: "assistant" | "question" | "subagent" | "system";
  text: string;
};

export type BridgePullPayload = {
  project_key: string;
  thread_id?: string;
  limit?: number;
  consume?: boolean;
};

export type ProjectsBindPayload = {
  project_key: string;
  chat_id?: number;
  enabled?: boolean;
  primary?: boolean;
};

export type InboxRecord = {
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

export type OutboxRecord = {
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
