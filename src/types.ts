export interface Env {
  DB: D1Database;
  TG_BOT_TOKEN: string;
  TG_BOT_OWNER_ID: string;
  TG_WEBHOOK_SECRET?: string;
  GROUPS_KV?: KVNamespace;
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_API_BASE?: string;
  LLM_MODEL?: string;
  LLM_MAX_TOKENS?: string;
  LLM_TEMPERATURE?: string;
  SCHEDULE_TZ_OFFSET_MINUTES?: string;
  LINUXDO_COOKIE?: string;
  SCRAPE_DO_TOKEN?: string;
}

export type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  my_chat_member?: TelegramChatMemberUpdated;
};

export type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: {
    chat?: TelegramChat;
    message_id?: number;
  };
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  from?: TelegramUser;
  chat: TelegramChat;
  reply_to_message?: TelegramMessage;
  quote?: TelegramTextQuote;
  forward_origin?: TelegramForwardOrigin;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_from_message_id?: number;
  forward_sender_name?: string;
  media_group_id?: string;
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  sticker?: unknown;
  animation?: unknown;
  video_note?: unknown;
};

export type TelegramTextQuote = {
  text: string;
  position: number;
  entities?: TelegramEntity[];
  is_manual?: boolean;
};

export type TelegramEntity = {
  type: string;
  offset: number;
  length: number;
};

export type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
};

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
};

export type TelegramForwardOrigin = {
  type: "channel" | "chat" | "user" | "hidden_user";
  chat?: TelegramChat;
  message_id?: number;
  sender_chat?: TelegramChat;
  sender_user?: TelegramUser;
  sender_user_name?: string;
};

export type TelegramChatMember = {
  status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
  user?: TelegramUser;
};

export type TelegramChatMemberUpdated = {
  chat: TelegramChat;
  from?: TelegramUser;
  date?: number;
  old_chat_member?: TelegramChatMember;
  new_chat_member?: TelegramChatMember;
};

export type GroupConfigRow = {
  group_id: number;
  group_name: string;
  enabled: number;
  schedule: string;
  leaderboard_schedule: string | null;
  leaderboard_enabled: number;
  leaderboard_window: string | null;
  target_chat_id: number | null;
  last_summary_time: string | null;
  last_message_id: number;
  last_leaderboard_time: string | null;
  spoiler_enabled?: number;
  spoiler_auto_delete?: number;
  linuxdo_enabled?: number;
};

export type GroupMessageRow = {
  message_id: number;
  group_id: number;
  sender_id: number;
  sender_name: string;
  sender_is_bot?: number;
  content: string;
  message_date: string;
  has_media: number;
  media_type: string | null;
  is_summarized: number;
};

export type Schedule =
  | { kind: "interval"; ms: number }
  | { kind: "cron"; fields: string[] };

export type SummaryResult = {
  success: boolean;
  content: string;
  error?: string;
};

export type LlmProvider = "openai" | "openai-responses" | "claude" | "gemini" | "custom";

export type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

export type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

export type AdminActionRow = {
  user_id: number;
  action: string;
  group_id: number;
  expires_at: string | null;
};
