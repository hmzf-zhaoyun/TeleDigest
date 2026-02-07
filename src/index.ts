export interface Env {
  DB: D1Database;
  TG_BOT_TOKEN: string;
  TG_BOT_OWNER_ID: string;
  TG_WEBHOOK_SECRET?: string;
  LLM_PROVIDER?: string;
  LLM_API_KEY?: string;
  LLM_API_BASE?: string;
  LLM_MODEL?: string;
  LLM_MAX_TOKENS?: string;
  LLM_TEMPERATURE?: string;
  SCHEDULE_TZ_OFFSET_MINUTES?: string;
}

type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
  id: string;
  from?: TelegramUser;
  data?: string;
  message?: {
    chat?: TelegramChat;
  };
};

type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  from?: TelegramUser;
  chat: TelegramChat;
  forward_origin?: TelegramForwardOrigin;
  forward_from?: TelegramUser;
  forward_from_chat?: TelegramChat;
  forward_from_message_id?: number;
  forward_sender_name?: string;
  photo?: unknown[];
  video?: unknown;
  document?: unknown;
  audio?: unknown;
  voice?: unknown;
  sticker?: unknown;
  animation?: unknown;
};

type TelegramEntity = {
  type: string;
  offset: number;
  length: number;
};

type TelegramChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
};

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
};

type TelegramForwardOrigin = {
  type: "channel" | "chat" | "user" | "hidden_user";
  chat?: TelegramChat;
  message_id?: number;
  sender_chat?: TelegramChat;
  sender_user?: TelegramUser;
  sender_user_name?: string;
};

type GroupConfigRow = {
  group_id: number;
  group_name: string;
  enabled: number;
  schedule: string;
  target_chat_id: number | null;
  last_summary_time: string | null;
  last_message_id: number;
  spoiler_enabled?: number;
  spoiler_auto_delete?: number;
};

type GroupMessageRow = {
  message_id: number;
  group_id: number;
  sender_id: number;
  sender_name: string;
  content: string;
  message_date: string;
  has_media: number;
  media_type: string | null;
  is_summarized: number;
};

type Schedule =
  | { kind: "interval"; ms: number }
  | { kind: "cron"; fields: string[] };

type SummaryResult = {
  success: boolean;
  content: string;
  error?: string;
};

type LlmProvider = "openai" | "openai-responses" | "claude" | "gemini";

type InlineKeyboardButton = {
  text: string;
  callback_data?: string;
  url?: string;
};

type InlineKeyboardMarkup = {
  inline_keyboard: InlineKeyboardButton[][];
};

type AdminActionRow = {
  user_id: number;
  action: string;
  group_id: number;
  expires_at: string | null;
};

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_SCHEDULE = "0 * * * *";
const MAX_MESSAGES_PER_SUMMARY = 500;
const LLM_TIMEOUT_MS = 120000;
const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_SAFE_LIMIT = 3500;
const DEFAULT_LLM_MAX_TOKENS = 1000;
const DEFAULT_LLM_TEMPERATURE = 0.7;
const ADMIN_ACTION_TTL_MINUTES = 10;
const CALLBACK_PANEL_OPEN = "panel:open";
const CALLBACK_PANEL_LIST = "panel:list";
const CALLBACK_GROUP_SHOW = "grp:show";
const CALLBACK_GROUP_ENABLE = "grp:enable";
const CALLBACK_GROUP_DISABLE = "grp:disable";
const CALLBACK_GROUP_SUMMARY = "grp:summary";
const CALLBACK_SCHEDULE_MENU = "sch:menu";
const CALLBACK_SCHEDULE_SET = "sch:set";
const CALLBACK_SCHEDULE_CUSTOM = "sch:custom";
const CALLBACK_SPOILER_MENU = "spo:menu";
const CALLBACK_SPOILER_TOGGLE = "spo:toggle";
const CALLBACK_SPOILER_DELETE = "spo:delete";

let schemaReady = false;

const SCHEDULE_PRESETS: Array<{ label: string; value: string; description: string }> = [
  { label: "每小时", value: "1h", description: "每隔1小时" },
  { label: "每2小时", value: "2h", description: "每隔2小时" },
  { label: "每4小时", value: "4h", description: "每隔4小时" },
  { label: "每天早9点", value: "0 9 * * *", description: "每天 09:00" },
  { label: "每天晚8点", value: "0 20 * * *", description: "每天 20:00" },
  { label: "每12小时", value: "12h", description: "每隔12小时" },
];

const SCHEDULE_CUSTOM_OPTIONS: Array<{ label: string; value: string }> = [
  { label: "30分钟", value: "30m" },
  { label: "45分钟", value: "45m" },
  { label: "90分钟", value: "90m" },
  { label: "3小时", value: "3h" },
  { label: "6小时", value: "6h" },
  { label: "8小时", value: "8h" },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") {
      return handleTelegramWebhook(request, env, ctx);
    }
    if (url.pathname === "/health") {
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduledSummaries(env));
  },
};

function normalizeProvider(raw: string | undefined): LlmProvider {
  const value = (raw || "openai").trim().toLowerCase();
  if (value === "custom") return "openai";
  if (value === "openai-responses" || value === "openai_responses" || value === "openairesponses") {
    return "openai-responses";
  }
  if (value === "claude") return "claude";
  if (value === "gemini") return "gemini";
  return "openai";
}

function parseNumberEnv(
  value: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (options.min !== undefined && parsed < options.min) return options.min;
  if (options.max !== undefined && parsed > options.max) return options.max;
  return parsed;
}

async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  schemaReady = true;
  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS admin_actions (
        user_id INTEGER PRIMARY KEY,
        action TEXT NOT NULL,
        group_id INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT
      )`
    ).run();

    const info = await env.DB.prepare("PRAGMA table_info(group_configs)").all<{
      name: string;
    }>();
    const columns = new Set((info.results || []).map((row) => row.name));

    if (!columns.has("spoiler_enabled")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN spoiler_enabled INTEGER DEFAULT 0"
      ).run();
    }
    if (!columns.has("spoiler_auto_delete")) {
      await env.DB.prepare(
        "ALTER TABLE group_configs ADD COLUMN spoiler_auto_delete INTEGER DEFAULT 0"
      ).run();
    }
  } catch (error) {
    schemaReady = false;
    console.error("ensureSchema failed", error);
  }
}

async function handleTelegramWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!env.TG_BOT_TOKEN || !env.DB) {
    return new Response("Missing configuration", { status: 500 });
  }

  await ensureSchema(env);

  const secret = (env.TG_WEBHOOK_SECRET || "").trim();
  if (secret) {
    const incoming = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (incoming !== secret) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  ctx.waitUntil(
    processUpdate(update, env).catch((error) => {
      console.error("processUpdate failed", error);
    }),
  );
  return new Response("ok");
}

async function processUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  if (message) {
    await handleMessage(message, env);
  }

  if (update.callback_query?.id) {
    await handleCallbackQuery(update.callback_query, env);
  }
}

async function handleMessage(message: TelegramMessage, env: Env): Promise<void> {
  const userId = message.from?.id;
  const isOwner = userId ? isOwnerUser(env, userId) : false;

  if (isOwner && message.chat.type === "private") {
    const pending = await getAdminAction(env, userId);
    if (pending && message.text) {
      const consumed = await handlePendingAdminAction(pending, message, env);
      if (consumed) {
        return;
      }
    }
  }

  const command = parseCommand(message);
  if (command) {
    await handleCommand(command, message, env);
    return;
  }

  if (isOwner && message.chat.type === "private" && isPanelTrigger(message.text)) {
    await sendGroupList(env, message.chat.id);
    return;
  }

  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    await handleSpoilerMessage(message, env);
    await saveGroupMessage(message, env);
  }
}

function parseCommand(message: TelegramMessage): { name: string; args: string[] } | null {
  if (!message.text) {
    return null;
  }
  const entities = message.entities || [];
  const isCommand = entities.some((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!isCommand) {
    return null;
  }

  const trimmed = message.text.trim();
  const firstSpace = trimmed.indexOf(" ");
  const cmdPart = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const argsText = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  const name = cmdPart.replace(/^\/+/, "").split("@")[0].toLowerCase();
  const args = argsText ? argsText.split(/\s+/) : [];
  return { name, args };
}

async function handleCommand(
  command: { name: string; args: string[] },
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id;
  const userId = message.from?.id;
  const isOwner = userId ? isOwnerUser(env, userId) : false;

  switch (command.name) {
    case "start":
      await sendStartMessage(env, chatId, isOwner);
      return;
    case "help":
      await sendHelpMessage(env, chatId, isOwner);
      return;
    case "groups":
      if (!isOwner) {
        await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
        return;
      }
      await sendGroupList(env, chatId);
      return;
    case "enable":
      await handleEnable(command.args, chatId, env, isOwner);
      return;
    case "disable":
      await handleDisable(command.args, chatId, env, isOwner);
      return;
    case "setschedule":
      await handleSetSchedule(command.args, chatId, env, isOwner);
      return;
    case "status":
      await handleStatus(chatId, env, isOwner);
      return;
    case "summary":
      await handleSummary(command.args, chatId, env, isOwner);
      return;
    default:
      return;
  }
}

function buildHelpText(isOwner: boolean): string {
  const base = [
    "📖 帮助信息",
    "",
    "/start - 启动机器人",
    "/help - 显示帮助信息",
    "",
  ];

  if (!isOwner) {
    base.push("ℹ️ 请联系机器人主人进行配置。");
    return base.join("\n");
  }

  base.push("管理方式 (仅主人可用):");
  base.push("• 点击下方“管理面板”按钮");
  base.push("• 私聊发送“管理面板/管理”");
  base.push("");
  base.push("管理命令（可选）:");
  base.push("/groups - 交互式群组管理");
  base.push("/status - 查看群组状态");
  base.push("/enable <群组ID> - 启用群组总结");
  base.push("/disable <群组ID> - 禁用群组总结");
  base.push("/setschedule <群组ID> <表达式> - 设置定时");
  base.push("/summary <群组ID> - 手动触发总结");
  base.push("");
  base.push("定时表达式格式:");
  base.push("Cron: 0 * * * *  (每小时)");
  base.push("间隔: 30m / 2h / 1d");
  return base.join("\n");
}

async function sendStartMessage(env: Env, chatId: number, isOwner: boolean): Promise<void> {
  if (!isOwner) {
    await sendMessage(env, chatId, "👋 你好！我是消息总结机器人。\n\n使用 /help 查看可用命令。");
    return;
  }
  const text =
    "👋 你好！我是消息总结机器人。\n\n" +
    "点击下方按钮打开管理面板，或私聊发送“管理面板/管理”。";
  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "打开管理面板", callback_data: CALLBACK_PANEL_OPEN }]],
    },
  });
}

async function sendHelpMessage(env: Env, chatId: number, isOwner: boolean): Promise<void> {
  const text = buildHelpText(isOwner);
  if (!isOwner) {
    await sendMessage(env, chatId, text);
    return;
  }
  await sendMessage(env, chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "管理面板", callback_data: CALLBACK_PANEL_OPEN }]],
    },
  });
}

async function handleEnable(
  args: string[],
  chatId: number,
  env: Env,
  isOwner: boolean,
): Promise<void> {
  if (!isOwner) {
    await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
    return;
  }

  const groupId = parseGroupIdArg(args, env, chatId);
  if (!groupId) {
    return;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", true, DEFAULT_SCHEDULE);
  } else {
    await updateGroupEnabled(env, groupId, true);
  }

  await sendMessage(env, chatId, `✅ 已启用群组 ${groupId} 的消息总结功能`);
}

async function handleDisable(
  args: string[],
  chatId: number,
  env: Env,
  isOwner: boolean,
): Promise<void> {
  if (!isOwner) {
    await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
    return;
  }

  const groupId = parseGroupIdArg(args, env, chatId);
  if (!groupId) {
    return;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendMessage(env, chatId, `❌ 群组 ${groupId} 未配置`);
    return;
  }

  await updateGroupEnabled(env, groupId, false);
  await sendMessage(env, chatId, `✅ 已禁用群组 ${groupId} 的消息总结功能`);
}

async function handleSetSchedule(
  args: string[],
  chatId: number,
  env: Env,
  isOwner: boolean,
): Promise<void> {
  if (!isOwner) {
    await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
    return;
  }

  if (args.length < 2) {
    await sendMessage(
      env,
      chatId,
      "❌ 用法: /setschedule <群组ID> <表达式>\n\n支持格式:\n• Cron: 0 * * * *\n• 间隔: 30m / 2h / 1d",
    );
    return;
  }

  const groupId = parseInt(args[0], 10);
  if (!Number.isFinite(groupId)) {
    await sendMessage(env, chatId, "❌ 群组ID必须是数字");
    return;
  }

  const schedule = args.slice(1).join(" ").trim();
  if (!parseSchedule(schedule)) {
    await sendMessage(env, chatId, "❌ 无效的定时表达式");
    return;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", false, schedule);
  } else {
    await updateGroupSchedule(env, groupId, schedule);
  }

  await sendMessage(env, chatId, `✅ 已设置群组 ${groupId} 的定时: ${schedule}`);
}

async function handleStatus(chatId: number, env: Env, isOwner: boolean): Promise<void> {
  if (!isOwner) {
    await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
    return;
  }

  const groups = await getAllGroups(env);
  if (!groups.length) {
    await sendMessage(env, chatId, "📋 暂无配置的群组");
    return;
  }

  const lines: string[] = ["📋 群组配置状态", ""];
  for (const group of groups) {
    const statusEmoji = Number(group.enabled) === 1 ? "✅" : "⭕";
    const name = group.group_name || String(group.group_id);
    const lastSummary = group.last_summary_time || "无";
    lines.push(
      `${statusEmoji} ${name}`,
      `ID: ${group.group_id}`,
      `定时: ${group.schedule || DEFAULT_SCHEDULE}`,
      `上次总结: ${lastSummary}`,
      "",
    );
  }
  await sendMessage(env, chatId, lines.join("\n"));
}

async function handleSummary(
  args: string[],
  chatId: number,
  env: Env,
  isOwner: boolean,
): Promise<void> {
  if (!isOwner) {
    await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
    return;
  }

  const groupId = parseGroupIdArg(args, env, chatId);
  if (!groupId) {
    return;
  }

  await sendMessage(env, chatId, `⏳ 正在为群组 ${groupId} 生成总结...`);
  const result = await runSummaryForGroup(env, groupId);
  if (result.success) {
    await sendMessage(env, chatId, `✅ 群组 ${groupId} 的总结已完成`);
  } else {
    await sendMessage(env, chatId, `❌ 总结失败: ${result.error || "未知错误"}`);
  }
}

async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
  env: Env,
): Promise<void> {
  const userId = callbackQuery.from?.id;
  if (!userId || !isOwnerUser(env, userId)) {
    await answerCallbackQuery(env, callbackQuery.id, "⛔ 无权限", true);
    return;
  }

  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) {
    await answerCallbackQuery(env, callbackQuery.id, "无法识别会话", true);
    return;
  }

  const data = callbackQuery.data || "";
  try {
    const handled = await processCallbackData(data, chatId, userId, env);
    if (!handled) {
      await answerCallbackQuery(env, callbackQuery.id, "未识别的操作", false);
      return;
    }
    await answerCallbackQuery(env, callbackQuery.id, "", false);
  } catch (error) {
    console.error("handleCallbackQuery failed", error);
    await answerCallbackQuery(env, callbackQuery.id, "操作失败，请稍后重试", true);
  }
}

async function processCallbackData(
  data: string,
  chatId: number,
  userId: number,
  env: Env,
): Promise<boolean> {
  if (data === CALLBACK_PANEL_OPEN || data === CALLBACK_PANEL_LIST) {
    await sendGroupList(env, chatId);
    return true;
  }

  const parts = data.split(":");
  if (parts.length < 2) {
    return false;
  }

  const namespace = parts[0];
  const action = parts[1];
  const groupIdRaw = parts[2];
  const groupId = groupIdRaw ? parseInt(groupIdRaw, 10) : NaN;

  if (namespace === "grp") {
    if (!Number.isFinite(groupId)) {
      await sendMessage(env, chatId, "❌ 群组ID无效");
      return true;
    }
    if (action === "show") {
      await sendGroupActions(env, chatId, groupId);
      return true;
    }
    if (action === "enable") {
      await setGroupEnabled(env, chatId, groupId, true);
      await sendGroupActions(env, chatId, groupId);
      return true;
    }
    if (action === "disable") {
      await setGroupEnabled(env, chatId, groupId, false);
      await sendGroupActions(env, chatId, groupId);
      return true;
    }
    if (action === "summary") {
      await runSummaryForGroupAndNotify(env, chatId, groupId);
      return true;
    }
    return false;
  }

  if (namespace === "sch") {
    if (!Number.isFinite(groupId)) {
      await sendMessage(env, chatId, "❌ 群组ID无效");
      return true;
    }
    if (action === "menu") {
      await sendScheduleMenu(env, chatId, groupId);
      return true;
    }
    if (action === "set") {
      const encoded = parts[3] || "";
      const schedule = decodeCallbackValue(encoded);
      await applySchedule(env, chatId, groupId, schedule);
      return true;
    }
    if (action === "custom") {
      await setAdminAction(env, userId, "set_schedule", groupId, ADMIN_ACTION_TTL_MINUTES);
      await sendMessage(
        env,
        chatId,
        "✍️ 请输入定时表达式（支持 30m / 2h / 1d 或 5 段 Cron）。\n发送“取消”可退出。",
      );
      return true;
    }
    return false;
  }

  if (namespace === "spo") {
    if (!Number.isFinite(groupId)) {
      await sendMessage(env, chatId, "❌ 群组ID无效");
      return true;
    }
    if (action === "menu") {
      await sendSpoilerMenu(env, chatId, groupId);
      return true;
    }
    if (action === "toggle") {
      await toggleSpoilerEnabled(env, chatId, groupId);
      return true;
    }
    if (action === "delete") {
      await toggleSpoilerAutoDelete(env, chatId, groupId);
      return true;
    }
    return false;
  }

  return false;
}

function parseGroupIdArg(args: string[], env: Env, chatId: number): number | null {
  if (!args.length) {
    void sendMessage(env, chatId, "❌ 群组ID必须是数字");
    return null;
  }
  const groupId = parseInt(args[0], 10);
  if (!Number.isFinite(groupId)) {
    void sendMessage(env, chatId, "❌ 群组ID必须是数字");
    return null;
  }
  return groupId;
}

async function handleSpoilerMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }

  if (message.from?.is_bot) {
    return;
  }

  if (!shouldTriggerSpoiler(message)) {
    return;
  }

  const config = await getGroupConfig(env, chat.id);
  if (!config || Number(config.spoiler_enabled) !== 1) {
    return;
  }

  const headerParts: string[] = [];
  const senderInfo = buildSenderInfo(message.from);
  if (senderInfo) {
    headerParts.push(`发送者: ${senderInfo}`);
  }
  const forwardInfo = buildForwardInfo(message);
  if (forwardInfo) {
    headerParts.push(forwardInfo);
  }
  const headerText = headerParts.join("\n");

  const plainText = message.text || message.caption || "";
  const spoilerText = plainText ? `<tg-spoiler>${escapeHtml(plainText)}</tg-spoiler>` : "";

  let finalText = "";
  if (headerText && spoilerText) {
    finalText = `${headerText}\n\n${spoilerText}`;
  } else if (headerText) {
    finalText = headerText;
  } else {
    finalText = spoilerText;
  }

  try {
    if (message.photo && message.photo.length > 0) {
      const fileId = extractPhotoFileId(message.photo);
      if (fileId) {
        await telegramApi(env, "sendPhoto", {
          chat_id: chat.id,
          photo: fileId,
          caption: finalText || undefined,
          parse_mode: finalText ? "HTML" : undefined,
          has_spoiler: true,
        });
      }
    } else if (finalText) {
      await sendMessage(env, chat.id, finalText, { parse_mode: "HTML" });
    }

    if (Number(config.spoiler_auto_delete) === 1) {
      await telegramApi(env, "deleteMessage", {
        chat_id: chat.id,
        message_id: message.message_id,
      });
    }
  } catch (error) {
    console.error("spoiler handling failed", error);
  }
}

function shouldTriggerSpoiler(message: TelegramMessage): boolean {
  if (isForwardedMessage(message)) {
    return true;
  }
  const text = message.text || message.caption || "";
  return /#nsfw/i.test(text);
}

function isForwardedMessage(message: TelegramMessage): boolean {
  return Boolean(
    message.forward_origin ||
      message.forward_from ||
      message.forward_from_chat ||
      message.forward_sender_name ||
      message.forward_from_message_id,
  );
}

function buildSenderInfo(sender?: TelegramUser): string | null {
  if (!sender) return null;
  const name = escapeHtml([sender.first_name, sender.last_name].filter(Boolean).join(" ").trim());
  const username = sender.username ? escapeHtml(sender.username) : "";
  if (name && username) {
    return `${name}(@${username})`;
  }
  if (name) return name;
  if (username) return `@${username}`;
  return String(sender.id);
}

function buildForwardInfo(message: TelegramMessage): string | null {
  const origin = message.forward_origin;
  if (origin) {
    if (origin.type === "channel") {
      const chat = origin.chat;
      if (chat) {
        return formatForwardLink(chat.title || "频道", chat.username, origin.message_id);
      }
    }
    if (origin.type === "chat") {
      const chat = origin.sender_chat;
      if (chat) {
        return formatForwardLink(chat.title || "群组", chat.username, origin.message_id);
      }
    }
    if (origin.type === "user") {
      const user = origin.sender_user;
      if (user) {
        return formatUserForward(user);
      }
    }
    if (origin.type === "hidden_user") {
      const name = origin.sender_user_name ? escapeHtml(origin.sender_user_name) : "未知用户";
      return `📤 转发自: ${name}`;
    }
  }

  if (message.forward_from_chat) {
    const chat = message.forward_from_chat;
    return formatForwardLink(chat.title || "频道", chat.username, message.forward_from_message_id);
  }
  if (message.forward_from) {
    return formatUserForward(message.forward_from);
  }
  if (message.forward_sender_name) {
    return `📤 转发自: ${escapeHtml(message.forward_sender_name)}`;
  }
  return null;
}

function formatForwardLink(title: string, username?: string, messageId?: number): string {
  const safeTitle = escapeHtml(title);
  if (username && messageId) {
    return `📤 转发自: <a href="https://t.me/${escapeHtml(username)}/${messageId}">${safeTitle}(@${escapeHtml(username)})</a>`;
  }
  if (username) {
    return `📤 转发自: <a href="https://t.me/${escapeHtml(username)}">${safeTitle}(@${escapeHtml(username)})</a>`;
  }
  return `📤 转发自: ${safeTitle}`;
}

function formatUserForward(user: TelegramUser): string {
  const name = escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "用户");
  const username = user.username ? escapeHtml(user.username) : "";
  if (username) {
    return `📤 转发自: <a href="https://t.me/${username}">${name}(@${username})</a>`;
  }
  return `📤 转发自: ${name}`;
}

function extractPhotoFileId(photo: unknown[]): string | null {
  if (!photo.length) return null;
  const last = photo[photo.length - 1] as { file_id?: string };
  return last?.file_id || null;
}

function isPanelTrigger(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed === "管理面板" || trimmed === "管理";
}

async function handlePendingAdminAction(
  pending: AdminActionRow,
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const content = (message.text || "").trim();
  if (!content) {
    return false;
  }
  if (content.startsWith("/")) {
    return false;
  }
  if (content === "取消") {
    await clearAdminAction(env, pending.user_id);
    await sendMessage(env, message.chat.id, "✅ 已取消操作");
    return true;
  }
  if (pending.action === "set_schedule") {
    const ok = await applySchedule(env, message.chat.id, pending.group_id, content);
    if (ok) {
      await clearAdminAction(env, pending.user_id);
    }
    return true;
  }
  return false;
}

async function sendGroupList(env: Env, chatId: number): Promise<void> {
  const groups = await getAllGroups(env);
  if (!groups.length) {
    await sendMessage(env, chatId, "📋 暂无配置的群组");
    return;
  }

  const keyboard: InlineKeyboardButton[][] = groups.map((group) => {
    const status = Number(group.enabled) === 1 ? "✅" : "⭕";
    const name = group.group_name || String(group.group_id);
    const label = `${status} ${truncateLabel(name, 24)}`;
    return [{ text: label, callback_data: `${CALLBACK_GROUP_SHOW}:${group.group_id}` }];
  });
  keyboard.push([
    { text: "🔄 刷新", callback_data: CALLBACK_PANEL_LIST },
  ]);

  await sendMessage(env, chatId, "📋 群组列表（点击进入管理）", {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendGroupActions(env: Env, chatId: number, groupId: number): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendMessage(env, chatId, "❌ 群组未配置或暂无消息记录");
    return;
  }

  const status = Number(config.enabled) === 1 ? "✅ 已启用" : "⭕ 未启用";
  const spoilerEnabled = Number(config.spoiler_enabled) === 1;
  const spoilerAutoDelete = Number(config.spoiler_auto_delete) === 1;
  const name = config.group_name || String(groupId);
  const lastSummary = config.last_summary_time || "无";
  const lines = [
    `📌 ${name}`,
    `ID: ${groupId}`,
    `状态: ${status}`,
    `定时: ${config.schedule || DEFAULT_SCHEDULE}`,
    `剧透模式: ${spoilerEnabled ? "✅ 开启" : "⭕ 关闭"}`,
    `自动删除: ${spoilerAutoDelete ? "✅ 开启" : "⭕ 关闭"}`,
    `上次总结: ${lastSummary}`,
  ];

  const toggleLabel = Number(config.enabled) === 1 ? "禁用总结" : "启用总结";
  const toggleAction = Number(config.enabled) === 1 ? CALLBACK_GROUP_DISABLE : CALLBACK_GROUP_ENABLE;

  const keyboard: InlineKeyboardButton[][] = [
    [{ text: toggleLabel, callback_data: `${toggleAction}:${groupId}` }],
    [{ text: "剧透设置", callback_data: `${CALLBACK_SPOILER_MENU}:${groupId}` }],
    [{ text: "手动总结", callback_data: `${CALLBACK_GROUP_SUMMARY}:${groupId}` }],
    [{ text: "设置定时", callback_data: `${CALLBACK_SCHEDULE_MENU}:${groupId}` }],
    [{ text: "⬅️ 返回列表", callback_data: CALLBACK_PANEL_LIST }],
  ];

  await sendMessage(env, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendScheduleMenu(env: Env, chatId: number, groupId: number): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendMessage(env, chatId, "❌ 群组未配置或暂无消息记录");
    return;
  }

  const lines = [
    "⏰ 选择定时方案",
    `当前: ${config.schedule || DEFAULT_SCHEDULE}`,
    "",
    "预设选项:",
    ...SCHEDULE_PRESETS.map((preset) => `• ${preset.label}（${preset.description}）`),
  ];

  const keyboard: InlineKeyboardButton[][] = [];
  for (const preset of SCHEDULE_PRESETS) {
    keyboard.push([
      {
        text: preset.label,
        callback_data: `${CALLBACK_SCHEDULE_SET}:${groupId}:${encodeCallbackValue(preset.value)}`,
      },
    ]);
  }
  keyboard.push(...SCHEDULE_CUSTOM_OPTIONS.map((preset) => ([
    {
      text: preset.label,
      callback_data: `${CALLBACK_SCHEDULE_SET}:${groupId}:${encodeCallbackValue(preset.value)}`,
    },
  ])));
  keyboard.push([
    { text: "自定义表达式", callback_data: `${CALLBACK_SCHEDULE_CUSTOM}:${groupId}` },
  ]);
  keyboard.push([
    { text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SHOW}:${groupId}` },
  ]);

  await sendMessage(env, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendSpoilerMenu(env: Env, chatId: number, groupId: number): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendMessage(env, chatId, "❌ 群组未配置或暂无消息记录");
    return;
  }
  const spoilerEnabled = Number(config.spoiler_enabled) === 1;
  const spoilerAutoDelete = Number(config.spoiler_auto_delete) === 1;
  const lines = [
    "🫣 剧透模式设置",
    `当前状态: ${spoilerEnabled ? "✅ 开启" : "⭕ 关闭"}`,
    `自动删除原消息: ${spoilerAutoDelete ? "✅ 开启" : "⭕ 关闭"}`,
    "",
    "触发规则：转发消息或包含 #nsfw（群内成员均可触发）",
  ];

  const keyboard: InlineKeyboardButton[][] = [
    [
      {
        text: spoilerEnabled ? "关闭剧透模式" : "开启剧透模式",
        callback_data: `${CALLBACK_SPOILER_TOGGLE}:${groupId}`,
      },
    ],
    [
      {
        text: spoilerAutoDelete ? "关闭自动删除" : "开启自动删除",
        callback_data: `${CALLBACK_SPOILER_DELETE}:${groupId}`,
      },
    ],
    [{ text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SHOW}:${groupId}` }],
  ];

  await sendMessage(env, chatId, lines.join("\n"), {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function toggleSpoilerEnabled(env: Env, chatId: number, groupId: number): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendMessage(env, chatId, "❌ 群组未配置或暂无消息记录");
    return;
  }
  const next = Number(config.spoiler_enabled) !== 1;
  await updateGroupSpoilerEnabled(env, groupId, next);
  await sendSpoilerMenu(env, chatId, groupId);
}

async function toggleSpoilerAutoDelete(env: Env, chatId: number, groupId: number): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendMessage(env, chatId, "❌ 群组未配置或暂无消息记录");
    return;
  }
  const next = Number(config.spoiler_auto_delete) !== 1;
  await updateGroupSpoilerAutoDelete(env, groupId, next);
  await sendSpoilerMenu(env, chatId, groupId);
}

async function setGroupEnabled(
  env: Env,
  chatId: number,
  groupId: number,
  enabled: boolean,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", enabled, DEFAULT_SCHEDULE);
  } else {
    await updateGroupEnabled(env, groupId, enabled);
  }
  await sendMessage(
    env,
    chatId,
    enabled
      ? `✅ 已启用群组 ${groupId} 的消息总结功能`
      : `✅ 已禁用群组 ${groupId} 的消息总结功能`,
  );
}

async function applySchedule(
  env: Env,
  chatId: number,
  groupId: number,
  schedule: string,
): Promise<boolean> {
  const trimmed = schedule.trim();
  if (!parseSchedule(trimmed)) {
    await sendMessage(env, chatId, "❌ 无效的定时表达式，请重新输入或发送“取消”。");
    return false;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", false, trimmed);
  } else {
    await updateGroupSchedule(env, groupId, trimmed);
  }
  await sendMessage(env, chatId, `✅ 已设置群组 ${groupId} 的定时: ${trimmed}`);
  return true;
}

async function runSummaryForGroupAndNotify(
  env: Env,
  chatId: number,
  groupId: number,
): Promise<void> {
  await sendMessage(env, chatId, `⏳ 正在为群组 ${groupId} 生成总结...`);
  const result = await runSummaryForGroup(env, groupId);
  if (result.success) {
    if (!result.content) {
      await sendMessage(env, chatId, `ℹ️ 群组 ${groupId} 暂无可总结消息`);
      return;
    }
    await sendMessage(env, chatId, `✅ 群组 ${groupId} 的总结已完成`);
  } else {
    await sendMessage(env, chatId, `❌ 总结失败: ${result.error || "未知错误"}`);
  }
}

function truncateLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3))}...`;
}

function encodeCallbackValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCallbackValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function saveGroupMessage(message: TelegramMessage, env: Env): Promise<void> {
  const chat = message.chat;
  const groupId = chat.id;
  const groupName = chat.title || "";
  await upsertGroupFromMessage(env, groupId, groupName);

  const sender = message.from;
  const senderName = buildSenderName(sender);
  const content = message.text || message.caption || "";
  const mediaType = detectMediaType(message);
  const hasMedia = mediaType !== null;
  const messageDate = new Date(message.date * 1000).toISOString();

  await env.DB.prepare(
    `INSERT OR IGNORE INTO group_messages
     (message_id, group_id, sender_id, sender_name, content, message_date, has_media, media_type, is_summarized, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  )
    .bind(
      message.message_id,
      groupId,
      sender?.id || 0,
      senderName,
      content,
      messageDate,
      hasMedia ? 1 : 0,
      mediaType,
      new Date().toISOString(),
    )
    .run();
}

function buildSenderName(sender?: TelegramUser): string {
  if (!sender) {
    return "Unknown";
  }
  const fullName = [sender.first_name, sender.last_name].filter(Boolean).join(" ");
  return fullName || sender.username || String(sender.id);
}

function detectMediaType(message: TelegramMessage): string | null {
  if (message.photo && message.photo.length > 0) return "photo";
  if (message.video) return "video";
  if (message.document) return "document";
  if (message.audio) return "audio";
  if (message.voice) return "voice";
  if (message.sticker) return "sticker";
  if (message.animation) return "animation";
  return null;
}

async function runScheduledSummaries(env: Env): Promise<void> {
  if (!env.DB || !env.TG_BOT_TOKEN) {
    return;
  }

  const groups = await getEnabledGroups(env);
  if (!groups.length) {
    return;
  }

  const now = new Date();
  const tzOffset = getScheduleTzOffsetMinutes(env);

  for (const group of groups) {
    try {
      const schedule = group.schedule || DEFAULT_SCHEDULE;
      const parsed = parseSchedule(schedule);
      if (!parsed) {
        continue;
      }
      if (!isScheduleDue(parsed, group.last_summary_time, now, tzOffset)) {
        continue;
      }
      await runSummaryForGroup(env, group.group_id);
    } catch (error) {
      console.error("scheduled summary failed", {
        groupId: group.group_id,
        error,
      });
    }
  }
}

function getScheduleTzOffsetMinutes(env: Env): number {
  const value = parseNumberEnv(env.SCHEDULE_TZ_OFFSET_MINUTES, 0);
  return Math.trunc(value);
}

function parseSchedule(schedule: string): Schedule | null {
  const trimmed = schedule.trim();
  const intervalMatch = /^(\d+)\s*([mhd])$/.exec(trimmed);
  if (intervalMatch) {
    const amount = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2];
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    const multiplier =
      unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return { kind: "interval", ms: amount * multiplier };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 5) {
    return { kind: "cron", fields: parts };
  }

  return null;
}

function isScheduleDue(
  schedule: Schedule,
  lastSummary: string | null,
  now: Date,
  tzOffsetMinutes: number,
): boolean {
  if (schedule.kind === "interval") {
    if (!lastSummary) {
      return true;
    }
    const last = Date.parse(lastSummary);
    if (Number.isNaN(last)) {
      return true;
    }
    return now.getTime() - last >= schedule.ms;
  }

  const localNow = new Date(now.getTime() + tzOffsetMinutes * 60000);
  if (!cronMatches(schedule.fields, localNow)) {
    return false;
  }
  if (!lastSummary) {
    return true;
  }
  const last = new Date(lastSummary);
  if (Number.isNaN(last.getTime())) {
    return true;
  }
  return !isSameMinute(last, now, tzOffsetMinutes);
}

function isSameMinute(a: Date, b: Date, tzOffsetMinutes: number): boolean {
  const aLocal = new Date(a.getTime() + tzOffsetMinutes * 60000);
  const bLocal = new Date(b.getTime() + tzOffsetMinutes * 60000);
  return (
    aLocal.getUTCFullYear() === bLocal.getUTCFullYear() &&
    aLocal.getUTCMonth() === bLocal.getUTCMonth() &&
    aLocal.getUTCDate() === bLocal.getUTCDate() &&
    aLocal.getUTCHours() === bLocal.getUTCHours() &&
    aLocal.getUTCMinutes() === bLocal.getUTCMinutes()
  );
}

function cronMatches(fields: string[], date: Date): boolean {
  const [minField, hourField, dayField, monthField, dowField] = fields;
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const day = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();

  const minOk = cronFieldMatches(minField, minute, 0, 59, false);
  const hourOk = cronFieldMatches(hourField, hour, 0, 23, false);
  const monthOk = cronFieldMatches(monthField, month, 1, 12, false);
  const domOk = cronFieldMatches(dayField, day, 1, 31, false);
  const dowOk = cronFieldMatches(dowField, dow, 0, 7, true);

  if (!minOk || !hourOk || !monthOk) {
    return false;
  }

  const dayFieldAny = dayField === "*";
  const dowFieldAny = dowField === "*";
  if (dayFieldAny && dowFieldAny) {
    return true;
  }
  if (dayFieldAny) {
    return dowOk;
  }
  if (dowFieldAny) {
    return domOk;
  }
  return domOk || dowOk;
}

function cronFieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
  isDow: boolean,
): boolean {
  if (field === "*") {
    return true;
  }

  const parts = field.split(",");
  for (const part of parts) {
    if (cronPartMatches(part.trim(), value, min, max, isDow)) {
      return true;
    }
  }
  return false;
}

function cronPartMatches(
  part: string,
  value: number,
  min: number,
  max: number,
  isDow: boolean,
): boolean {
  if (!part) {
    return false;
  }

  let rangePart = part;
  let step = 1;
  if (part.includes("/")) {
    const [range, stepRaw] = part.split("/");
    rangePart = range || "*";
    step = parseInt(stepRaw, 10);
    if (!Number.isFinite(step) || step <= 0) {
      return false;
    }
  }

  if (rangePart === "*") {
    return ((value - min) % step) === 0;
  }

  let rangeStart: number;
  let rangeEnd: number;

  if (rangePart.includes("-")) {
    const [startRaw, endRaw] = rangePart.split("-");
    rangeStart = parseInt(startRaw, 10);
    rangeEnd = parseInt(endRaw, 10);
  } else {
    rangeStart = parseInt(rangePart, 10);
    rangeEnd = rangeStart;
  }

  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) {
    return false;
  }

  if (isDow) {
    rangeStart = rangeStart === 7 ? 0 : rangeStart;
    rangeEnd = rangeEnd === 7 ? 0 : rangeEnd;
  }

  if (rangeStart < min || rangeEnd > max) {
    return false;
  }

  if (rangeStart <= rangeEnd) {
    if (value < rangeStart || value > rangeEnd) {
      return false;
    }
    return ((value - rangeStart) % step) === 0;
  }

  if (value >= rangeStart || value <= rangeEnd) {
    const distance = value >= rangeStart ? value - rangeStart : (max - rangeStart + 1) + value;
    return distance % step === 0;
  }

  return false;
}

async function runSummaryForGroup(env: Env, groupId: number): Promise<SummaryResult> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    return { success: false, content: "", error: "群组配置不存在" };
  }

  const messages = await getUnsummarizedMessages(env, groupId, MAX_MESSAGES_PER_SUMMARY);
  if (!messages.length) {
    return { success: true, content: "" };
  }

  const formatted = formatMessages(messages);
  const summary = await summarizeMessages(formatted, env);
  if (!summary.success) {
    return summary;
  }

  const targetChat = config.target_chat_id ?? groupId;
  await sendSummary(env, targetChat, config.group_name || String(groupId), summary.content);

  const maxMessageId = Math.max(...messages.map((msg) => msg.message_id));
  await markMessagesSummarized(env, groupId, maxMessageId);
  await updateGroupAfterSummary(env, groupId, maxMessageId);

  return summary;
}

function formatMessages(messages: GroupMessageRow[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const time = formatTime(message.message_date);
    const sender = message.sender_name || "Unknown";
    let content = message.content || "";
    if (message.has_media && message.media_type) {
      content = content ? `[${message.media_type}] ${content}` : `[${message.media_type}]`;
    }
    lines.push(`[${time}] ${sender}: ${content}`);
  }
  return lines;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function summarizeMessages(messages: string[], env: Env): Promise<SummaryResult> {
  const provider = normalizeProvider(env.LLM_PROVIDER);
  const apiKey = env.LLM_API_KEY || "";
  const model = env.LLM_MODEL || defaultModel(provider);
  const maxTokens = Math.trunc(
    parseNumberEnv(env.LLM_MAX_TOKENS, DEFAULT_LLM_MAX_TOKENS, { min: 1 }),
  );
  const temperature = parseNumberEnv(env.LLM_TEMPERATURE, DEFAULT_LLM_TEMPERATURE, {
    min: 0,
    max: 2,
  });

  if (!apiKey) {
    return { success: false, content: "", error: "LLM API Key 未配置" };
  }

  const prompt = buildDefaultPrompt(messages);

  try {
    if (provider === "openai-responses") {
      return await callOpenAIResponses(prompt, apiKey, model, maxTokens, temperature, env.LLM_API_BASE);
    }
    if (provider === "claude") {
      return await callClaude(prompt, apiKey, model, maxTokens, env.LLM_API_BASE);
    }
    if (provider === "gemini") {
      return await callGemini(prompt, apiKey, model, maxTokens, temperature, env.LLM_API_BASE);
    }
    return await callOpenAI(prompt, apiKey, model, maxTokens, temperature, env.LLM_API_BASE);
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM 调用失败";
    return { success: false, content: "", error: message };
  }
}

function buildDefaultPrompt(messages: string[]): string {
  const joined = messages.join("\n");
  return (
    "请对以下群组聊天消息进行总结，提取关键信息和重要讨论点：\n\n" +
    joined +
    "\n\n请用简洁的语言总结以上内容，包括：\n" +
    "1. 主要讨论话题\n" +
    "2. 重要结论或决定\n" +
    "3. 值得关注的信息\n\n总结："
  );
}

function defaultModel(provider: LlmProvider): string {
  if (provider === "openai-responses") return "gpt-4.1-mini";
  if (provider === "claude") return "claude-3-haiku-20240307";
  if (provider === "gemini") return "gemini-1.5-flash";
  return "gpt-4o-mini";
}

type OpenAIResponseContent = {
  type?: string;
  text?: string;
};

type OpenAIResponseOutput = {
  content?: OpenAIResponseContent[];
};

type OpenAIResponseBody = {
  output?: OpenAIResponseOutput[];
  output_text?: string;
};

function extractOpenAIResponseText(data: OpenAIResponseBody): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }
  const parts: string[] = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

async function callOpenAIResponses(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const base = (apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/responses`;
  const payload = {
    model,
    instructions: "你是一个专业的消息总结助手。",
    input: prompt,
    max_output_tokens: maxTokens,
    temperature,
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as OpenAIResponseBody;
  const content = extractOpenAIResponseText(data).trim();
  if (!content) {
    return { success: false, content: "", error: "OpenAI 返回空内容" };
  }
  return { success: true, content };
}

async function callOpenAI(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const base = (apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const payload = {
    model,
    messages: [
      { role: "system", content: "你是一个专业的消息总结助手。" },
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = (data.choices?.[0]?.message?.content || "").trim();
  if (!content) {
    return { success: false, content: "", error: "OpenAI 返回空内容" };
  }
  return { success: true, content };
}

async function callClaude(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const base = (apiBase || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const url = `${base}/messages`;
  const payload = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as {
    content?: { text?: string }[];
  };
  const content = (data.content?.[0]?.text || "").trim();
  if (!content) {
    return { success: false, content: "", error: "Claude 返回空内容" };
  }
  return { success: true, content };
}

async function callGemini(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const normalizedModel = model.startsWith("models/") ? model.slice(7) : model;
  const base = (apiBase || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${base}/models/${normalizedModel}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const content = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  if (!content) {
    return { success: false, content: "", error: "Gemini 返回空内容" };
  }
  return { success: true, content };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = LLM_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendSummary(env: Env, chatId: number, groupName: string, summary: string): Promise<void> {
  const escapedGroup = escapeHtml(groupName);
  const escapedSummary = escapeHtml(summary);
  const html = `<blockquote expandable>📊 ${escapedGroup}\n\n${escapedSummary}</blockquote>`;
  const plain = `📊 ${groupName}\n\n${summary}`;

  if (html.length <= TELEGRAM_TEXT_LIMIT) {
    try {
      await sendMessage(env, chatId, html, { parse_mode: "HTML" });
      return;
    } catch {
      // fallback below
    }
  }
  await sendPlainTextChunked(env, chatId, plain);
}

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  options: { parse_mode?: "HTML" | "Markdown"; reply_markup?: InlineKeyboardMarkup } = {},
): Promise<void> {
  if (!options.parse_mode && !options.reply_markup && text.length > TELEGRAM_TEXT_LIMIT) {
    await sendPlainTextChunked(env, chatId, text);
    return;
  }
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...options,
  });
}

async function answerCallbackQuery(
  env: Env,
  callbackQueryId: string,
  text: string,
  showAlert: boolean,
): Promise<void> {
  const payload: { callback_query_id: string; text?: string; show_alert?: boolean } = {
    callback_query_id: callbackQueryId,
  };
  if (text) {
    payload.text = text;
  }
  if (showAlert) {
    payload.show_alert = true;
  }
  await telegramApi(env, "answerCallbackQuery", payload);
}

async function telegramApi(env: Env, method: string, payload: unknown): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!token) {
    return;
  }
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(data.description || "Telegram API error");
  }
}

function splitTextForTelegram(text: string, limit: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) {
      cut = remaining.lastIndexOf(" ", limit);
    }
    if (cut <= 0) {
      cut = limit;
    }
    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk) {
      parts.push(chunk);
    }
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) {
    parts.push(remaining);
  }
  return parts.length ? parts : [text];
}

async function sendPlainTextChunked(env: Env, chatId: number, text: string): Promise<void> {
  const parts = splitTextForTelegram(text, TELEGRAM_SAFE_LIMIT);
  for (const part of parts) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: part,
    });
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isOwnerUser(env: Env, userId: number): boolean {
  const raw = env.TG_BOT_OWNER_ID || "";
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
  return ids.includes(userId);
}

async function getGroupConfig(env: Env, groupId: number): Promise<GroupConfigRow | null> {
  const row = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, target_chat_id, last_summary_time, last_message_id,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs WHERE group_id = ?`
  )
    .bind(groupId)
    .first<GroupConfigRow>();
  return row || null;
}

async function getAllGroups(env: Env): Promise<GroupConfigRow[]> {
  const results = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, target_chat_id, last_summary_time, last_message_id,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs ORDER BY updated_at DESC`
  ).all<GroupConfigRow>();
  return results.results || [];
}

async function getEnabledGroups(env: Env): Promise<GroupConfigRow[]> {
  const results = await env.DB.prepare(
    `SELECT group_id, group_name, enabled, schedule, target_chat_id, last_summary_time, last_message_id,
            spoiler_enabled, spoiler_auto_delete
     FROM group_configs WHERE enabled = 1`
  ).all<GroupConfigRow>();
  return results.results || [];
}

async function insertGroupConfig(
  env: Env,
  groupId: number,
  groupName: string,
  enabled: boolean,
  schedule: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO group_configs
     (group_id, group_name, enabled, schedule, target_chat_id, last_summary_time, last_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)`
  )
    .bind(groupId, groupName, enabled ? 1 : 0, schedule, now, now)
    .run();
}

async function upsertGroupFromMessage(
  env: Env,
  groupId: number,
  groupName: string,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO group_configs
     (group_id, group_name, enabled, schedule, target_chat_id, last_summary_time, last_message_id, created_at, updated_at)
     VALUES (?, ?, 0, ?, NULL, NULL, 0, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       group_name = excluded.group_name,
       updated_at = excluded.updated_at`
  )
    .bind(groupId, groupName, DEFAULT_SCHEDULE, now, now)
    .run();
}

async function updateGroupEnabled(env: Env, groupId: number, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET enabled = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

async function updateGroupSchedule(env: Env, groupId: number, schedule: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET schedule = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(schedule, new Date().toISOString(), groupId)
    .run();
}

async function updateGroupSpoilerEnabled(env: Env, groupId: number, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET spoiler_enabled = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

async function updateGroupSpoilerAutoDelete(env: Env, groupId: number, enabled: boolean): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET spoiler_auto_delete = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(enabled ? 1 : 0, new Date().toISOString(), groupId)
    .run();
}

async function updateGroupAfterSummary(
  env: Env,
  groupId: number,
  lastMessageId: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE group_configs SET last_summary_time = ?, last_message_id = ?, updated_at = ? WHERE group_id = ?"
  )
    .bind(new Date().toISOString(), lastMessageId, new Date().toISOString(), groupId)
    .run();
}

async function setAdminAction(
  env: Env,
  userId: number,
  action: string,
  groupId: number,
  ttlMinutes: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_actions (user_id, action, group_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       action = excluded.action,
       group_id = excluded.group_id,
       expires_at = excluded.expires_at,
       created_at = excluded.created_at`
  )
    .bind(userId, action, groupId, expiresAt, new Date().toISOString())
    .run();
}

async function getAdminAction(env: Env, userId: number): Promise<AdminActionRow | null> {
  const row = await env.DB.prepare(
    `SELECT user_id, action, group_id, expires_at
     FROM admin_actions WHERE user_id = ?`
  )
    .bind(userId)
    .first<AdminActionRow>();
  if (!row) {
    return null;
  }
  if (row.expires_at) {
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      await clearAdminAction(env, userId);
      return null;
    }
  }
  return row;
}

async function clearAdminAction(env: Env, userId: number): Promise<void> {
  await env.DB.prepare("DELETE FROM admin_actions WHERE user_id = ?")
    .bind(userId)
    .run();
}

async function getUnsummarizedMessages(
  env: Env,
  groupId: number,
  limit: number,
): Promise<GroupMessageRow[]> {
  const results = await env.DB.prepare(
    `SELECT message_id, group_id, sender_id, sender_name, content, message_date, has_media, media_type, is_summarized
     FROM group_messages
     WHERE group_id = ? AND is_summarized = 0
     ORDER BY message_date ASC
     LIMIT ?`
  )
    .bind(groupId, limit)
    .all<GroupMessageRow>();
  return results.results || [];
}

async function markMessagesSummarized(
  env: Env,
  groupId: number,
  upToMessageId: number,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE group_messages
     SET is_summarized = 1
     WHERE group_id = ? AND message_id <= ? AND is_summarized = 0`
  )
    .bind(groupId, upToMessageId)
    .run();
}
