import {
  ADMIN_ACTION_TTL_MINUTES,
  CALLBACK_GROUP_DISABLE,
  CALLBACK_GROUP_ENABLE,
  CALLBACK_GROUP_LEADERBOARD,
  CALLBACK_GROUP_LEADERBOARD_MENU,
  CALLBACK_GROUP_SHOW,
  CALLBACK_GROUP_SUMMARY,
  CALLBACK_GROUP_SUMMARY_MENU,
  CALLBACK_LEADERBOARD_CUSTOM,
  CALLBACK_LEADERBOARD_MENU,
  CALLBACK_LEADERBOARD_SET,
  CALLBACK_LEADERBOARD_TOGGLE,
  CALLBACK_LEADERBOARD_WINDOW_CUSTOM,
  CALLBACK_LEADERBOARD_WINDOW_MENU,
  CALLBACK_LEADERBOARD_WINDOW_SET,
  CALLBACK_LINUXDO_TOKEN_DELETE,
  CALLBACK_LINUXDO_TOKEN_MENU,
  CALLBACK_LINUXDO_TOKEN_SET,
  CALLBACK_PANEL_LIST,
  CALLBACK_PANEL_OPEN,
  CALLBACK_PANEL_SYNC,
  CALLBACK_SCHEDULE_CUSTOM,
  CALLBACK_SCHEDULE_MENU,
  CALLBACK_SCHEDULE_SET,
  CALLBACK_SPOILER_DELETE,
  CALLBACK_SPOILER_MENU,
  CALLBACK_SPOILER_TOGGLE,
  CALLBACK_LINUXDO_MENU,
  CALLBACK_LINUXDO_TOGGLE,
  CALLBACK_SCRAPE_GEO_MENU,
  CALLBACK_SCRAPE_GEO_SET,
  CALLBACK_SCRAPE_GEO_CUSTOM,
  CALLBACK_SCRAPE_GEO_DELETE,
  CALLBACK_SCRAPE_SUPER_MENU,
  CALLBACK_SCRAPE_SUPER_TOGGLE,
  DEFAULT_LEADERBOARD_WINDOW,
  DEFAULT_LEADERBOARD_SCHEDULE,
  DEFAULT_SCHEDULE,
  KV_SYNC_WINDOW_MS,
  LEADERBOARD_WINDOW_PRESETS,
  SCHEDULE_CUSTOM_OPTIONS,
  SCHEDULE_PRESETS,
  SCRAPE_GEO_PRESETS,
} from "../constants";
import type {
  Env,
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramChatMemberUpdated,
  TelegramMessage,
  TelegramUpdate,
} from "../types";
import {
  decodeCallbackValue,
  encodeCallbackValue,
  extractMentionUsername,
  isOwnerUser,
  parseDuration,
  truncateLabel,
} from "../utils";
import {
  clearAdminAction,
  deleteGlobalLinuxdoToken,
  deleteScrapeGeoCode,
  ensureSchema,
  findUserByUsernameInGroup,
  getAdminAction,
  getAllGroups,
  getGlobalLinuxdoToken,
  getScrapeGeoCode,
  getGroupConfig,
  insertGroupConfig,
  openKvSyncWindow,
  saveGroupMessage,
  setAdminAction,
  setGlobalLinuxdoToken,
  setScrapeGeoCode,
  getScrapeSuper,
  setScrapeSuper,
  updateGroupEnabled,
  updateGroupLeaderboardEnabled,
  updateGroupLeaderboardSchedule,
  updateGroupLeaderboardWindow,
  updateGroupSchedule,
  updateGroupSpoilerAutoDelete,
  updateGroupSpoilerEnabled,
  updateGroupLinuxdoEnabled,
} from "../db";
import { parseSchedule } from "../schedule";
import { runLeaderboardForGroup } from "../leaderboard";
import { runSummaryForGroup } from "../summary";
import {
  answerCallbackQuery,
  banChatMember,
  editMessage,
  getChatMember,
  getMe,
  registerBotCommands,
  sendMessage,
  unbanChatMember,
} from "./api";
import { handleSpoilerMessage } from "./spoiler";
import { handleLinuxdoLink } from "./linuxdo";
import { handleQuoteCommand } from "./quote";
import { registerGroup, removeGroup, syncGroupsFromRegistry, updateRegistryFromConfig } from "../registry";

let commandsRegistered = false;

export async function handleTelegramWebhook(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!env.TG_BOT_TOKEN || !env.DB) {
    return new Response("Missing configuration", { status: 500 });
  }

  await ensureSchema(env);

  if (!commandsRegistered) {
    commandsRegistered = true;
    registerBotCommands(env).catch((e) => {
      console.error("registerBotCommands failed", e);
      commandsRegistered = false;
    });
  }

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

  try {
    await processUpdate(update, env, _ctx);
  } catch (error) {
    console.error("processUpdate failed", error);
  }
  return new Response("ok");
}

async function processUpdate(update: TelegramUpdate, env: Env, ctx: ExecutionContext): Promise<void> {
  const message =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;

  if (message) {
    await handleMessage(message, env, ctx);
  }

  if (update.callback_query?.id) {
    await handleCallbackQuery(update.callback_query, env);
  }

  if (update.my_chat_member) {
    await handleMyChatMemberUpdate(update.my_chat_member, env);
  }
}

async function handleMessage(message: TelegramMessage, env: Env, ctx: ExecutionContext): Promise<void> {
  const userId = message.from?.id;
  const isOwner = userId ? isOwnerUser(env, userId) : false;

  if (isOwner && userId && message.chat.type === "private") {
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

  // 处理 Linux.do 链接
  if (message.text) {
    const handled = await handleLinuxdoLink(message, env);
    if (handled) {
      return;
    }
  }

  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    await registerGroup(env, message.chat.id, message.chat.title || "");
    await handleSpoilerMessage(message, env, ctx);
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
    case "status":
      await handleStatus(chatId, env, isOwner);
      return;
    case "q":
      await handleQuoteCommand(message, env);
      return;
    case "kick":
      await handleModerationCommand("kick", message, env);
      return;
    case "ban":
      await handleModerationCommand("ban", message, env);
      return;
    case "unban":
      await handleModerationCommand("unban", message, env);
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
    "/status - 查看群组状态",
    "/q - 引用卡片",
    "/kick @username - 踢出用户（允许重新加入）",
    "/ban @username - 永久封禁用户",
    "/unban @username - 解除封禁",
    "",
    "🔐 管理类命令：主人或群管理员可在群组中使用，需将本机器人设为群管理员并赋予“封禁用户”权限。",
    "",
  ];

  if (!isOwner) {
    base.push("ℹ️ 群组配置请联系机器人主人。");
    return base.join("\n");
  }

  base.push("管理方式 (仅主人可用):");
  base.push('• 点击下方\u201c管理面板\u201d按钮');
  base.push('• 私聊发送\u201c管理面板/管理\u201d');
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
    const leaderboardEmoji = Number(group.leaderboard_enabled) === 1 ? "✅" : "⭕";
    const name = group.group_name || String(group.group_id);
    const lastSummary = group.last_summary_time || "无";
    lines.push(
      `${statusEmoji} ${name}`,
      `ID: ${group.group_id}`,
      `定时: ${group.schedule || DEFAULT_SCHEDULE}`,
      `排行榜: ${leaderboardEmoji} ${group.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE}`,
      `统计窗口: ${group.leaderboard_window || DEFAULT_LEADERBOARD_WINDOW}`,
      `上次总结: ${lastSummary}`,
      `上次排行榜: ${group.last_leaderboard_time || "无"}`,
      "",
    );
  }
  await sendMessage(env, chatId, lines.join("\n"));
}


type ModerationAction = "kick" | "ban" | "unban";

type ModerationTarget = {
  userId: number;
  label: string;
};

async function handleModerationCommand(
  action: ModerationAction,
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const chatId = message.chat.id;
  const callerId = message.from?.id;

  if (message.chat.type !== "group" && message.chat.type !== "supergroup") {
    await sendMessage(env, chatId, "⚠️ 该命令仅在群组内可用");
    return;
  }
  if (!callerId) {
    return;
  }

  const isOwner = isOwnerUser(env, callerId);
  if (!isOwner) {
    const callerMember = await getChatMember(env, chatId, callerId);
    const callerStatus = callerMember?.status;
    if (callerStatus !== "creator" && callerStatus !== "administrator") {
      await sendMessage(env, chatId, "⛔ 您没有权限执行此命令（仅主人或群管理员）");
      return;
    }
  }

  const target = await resolveModerationTarget(message, env);
  if (!target) {
    await sendMessage(
      env,
      chatId,
      `⚠️ 请通过 /${action} @username 指定目标，或回复目标消息后发送 /${action}`,
    );
    return;
  }

  if (isOwnerUser(env, target.userId)) {
    await sendMessage(env, chatId, "⛔ 不能对机器人主人执行该操作");
    return;
  }

  const me = await getMe(env);
  if (me && target.userId === me.id) {
    await sendMessage(env, chatId, "⛔ 不能对机器人自身执行该操作");
    return;
  }

  if (!isOwner) {
    const targetMember = await getChatMember(env, chatId, target.userId);
    const targetStatus = targetMember?.status;
    if (targetStatus === "creator" || targetStatus === "administrator") {
      await sendMessage(env, chatId, "⛔ 不能对其他管理员执行该操作");
      return;
    }
  }

  try {
    if (action === "kick") {
      await banChatMember(env, chatId, target.userId);
      await unbanChatMember(env, chatId, target.userId, false);
      await sendMessage(env, chatId, `✅ 已踢出 ${target.label}（允许重新加入）`);
    } else if (action === "ban") {
      await banChatMember(env, chatId, target.userId);
      await sendMessage(env, chatId, `✅ 已永久封禁 ${target.label}`);
    } else {
      await unbanChatMember(env, chatId, target.userId, true);
      await sendMessage(env, chatId, `✅ 已解除封禁 ${target.label}`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await sendMessage(env, chatId, `❌ 操作失败: ${reason}`);
  }
}

function buildUserLabel(user: { username?: string; first_name?: string; last_name?: string; id: number }): string {
  if (user.username) return `@${user.username}`;
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || String(user.id);
}

async function resolveModerationTarget(
  message: TelegramMessage,
  env: Env,
): Promise<ModerationTarget | null> {
  const replyTarget = message.reply_to_message?.from;
  if (replyTarget?.id) {
    return { userId: replyTarget.id, label: buildUserLabel(replyTarget) };
  }

  const entities = message.entities || [];
  for (const entity of entities) {
    if (entity.type === "text_mention" && entity.user?.id) {
      return { userId: entity.user.id, label: buildUserLabel(entity.user) };
    }
  }

  const username = message.text ? extractMentionUsername(message.text) : null;
  if (!username) return null;
  const found = await findUserByUsernameInGroup(env, message.chat.id, username);
  if (!found) return null;
  return { userId: found.user_id, label: `@${username}` };
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
  const messageId = callbackQuery.message?.message_id ?? null;

  const data = callbackQuery.data || "";
  try {
    const handled = await processCallbackData(data, chatId, userId, env, messageId);
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
  messageId: number | null,
): Promise<boolean> {
  if (data === CALLBACK_PANEL_OPEN || data === CALLBACK_PANEL_LIST) {
    await sendGroupList(env, chatId, messageId);
    return true;
  }
  if (data === CALLBACK_PANEL_SYNC) {
    await handleSyncGroups(chatId, env, messageId);
    await sendGroupList(env, chatId, messageId);
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
    const context = parts[3] || "";
    if (action === "show") {
      await sendGroupActions(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "summary_menu") {
      await sendSummarySettingsMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "leaderboard_menu") {
      await sendLeaderboardSettingsMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "enable") {
      await setGroupEnabled(env, chatId, groupId, true, messageId);
      if (context === "summary") {
        await sendSummarySettingsMenu(env, chatId, groupId, messageId);
      } else {
        await sendGroupActions(env, chatId, groupId, messageId);
      }
      return true;
    }
    if (action === "disable") {
      await setGroupEnabled(env, chatId, groupId, false, messageId);
      if (context === "summary") {
        await sendSummarySettingsMenu(env, chatId, groupId, messageId);
      } else {
        await sendGroupActions(env, chatId, groupId, messageId);
      }
      return true;
    }
    if (action === "summary") {
      await runSummaryForGroupAndNotify(env, chatId, groupId);
      return true;
    }
    if (action === "leaderboard") {
      await runLeaderboardForGroupAndNotify(env, chatId, groupId);
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
      await sendScheduleMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "set") {
      const encoded = parts[3] || "";
      const schedule = decodeCallbackValue(encoded);
      await applySchedule(env, chatId, groupId, schedule, messageId);
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
      await sendSpoilerMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "toggle") {
      await toggleSpoilerEnabled(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "delete") {
      await toggleSpoilerAutoDelete(env, chatId, groupId, messageId);
      return true;
    }
    return false;
  }

  if (namespace === "ldo") {
    if (!Number.isFinite(groupId)) {
      await sendMessage(env, chatId, "❌ 群组ID无效");
      return true;
    }
    if (action === "menu") {
      await sendLinuxdoMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "toggle") {
      await toggleLinuxdoEnabled(env, chatId, groupId, messageId);
      return true;
    }
    return false;
  }

  if (namespace === "lb") {
    if (!Number.isFinite(groupId)) {
      await sendMessage(env, chatId, "❌ 群组ID无效");
      return true;
    }
    if (action === "menu") {
      await sendLeaderboardMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "toggle") {
      const context = parts[3] || "";
      const returnTo = context === "settings" ? "leaderboard" : "group";
      await toggleLeaderboardEnabled(env, chatId, groupId, messageId, returnTo);
      return true;
    }
    if (action === "set") {
      const encoded = parts[3] || "";
      const schedule = decodeCallbackValue(encoded);
      await applyLeaderboardSchedule(env, chatId, groupId, schedule, messageId);
      return true;
    }
    if (action === "window_menu") {
      await sendLeaderboardWindowMenu(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "window_set") {
      const encoded = parts[3] || "";
      const windowText = decodeCallbackValue(encoded);
      await applyLeaderboardWindow(env, chatId, groupId, windowText, messageId);
      return true;
    }
    if (action === "custom") {
      await setAdminAction(env, userId, "set_leaderboard_schedule", groupId, ADMIN_ACTION_TTL_MINUTES);
      await sendMessage(
        env,
        chatId,
        "✍️ 请输入排行榜定时表达式（支持 30m / 2h / 1d 或 5 段 Cron）。\n发送“取消”可退出。",
      );
      return true;
    }
    if (action === "window_custom") {
      await setAdminAction(env, userId, "set_leaderboard_window", groupId, ADMIN_ACTION_TTL_MINUTES);
      await sendMessage(
        env,
        chatId,
        "✍️ 请输入排行榜统计窗口（例如 30m / 2h / 1d）。\n发送“取消”可退出。",
      );
      return true;
    }
    return false;
  }

  if (namespace === "ldt") {
    if (action === "menu") {
      await sendLinuxdoTokenMenu(env, chatId, messageId);
      return true;
    }
    if (action === "set") {
      await setAdminAction(env, userId, "set_linuxdo_token", 0, ADMIN_ACTION_TTL_MINUTES);
      await sendMessage(
        env,
        chatId,
        "✍️ 请输入全局 Linux.do Token（_t cookie 值）。\n发送 \"取消\" 可退出。\n\n" +
        "获取方式:\n" +
        "1. 登录 linux.do\n" +
        "2. 按 F12 打开开发者工具\n" +
        "3. 切换到 Application 标签\n" +
        "4. 在 Cookies → linux.do 中找到 _t\n" +
        "5. 复制 _t 的值",
      );
      return true;
    }
    if (action === "delete") {
      await deleteGlobalLinuxdoToken(env);
      await sendLinuxdoTokenMenu(env, chatId, messageId);
      return true;
    }
    return false;
  }

  if (namespace === "geo") {
    if (action === "menu") {
      await sendScrapeGeoMenu(env, chatId, messageId);
      return true;
    }
    if (action === "set") {
      const encoded = parts[2] || "";
      const geoCode = decodeCallbackValue(encoded);
      if (!geoCode) {
        await deleteScrapeGeoCode(env);
      } else {
        await setScrapeGeoCode(env, geoCode);
      }
      await sendScrapeGeoMenu(env, chatId, messageId);
      return true;
    }
    if (action === "custom") {
      await setAdminAction(env, userId, "set_scrape_geo", 0, ADMIN_ACTION_TTL_MINUTES);
      await sendMessage(
        env,
        chatId,
        "✍️ 请输入 scrape.do 地区代码（如 us、jp、sg、hk 等）。\n发送 \"取消\" 可退出。",
      );
      return true;
    }
    if (action === "delete") {
      await deleteScrapeGeoCode(env);
      await sendScrapeGeoMenu(env, chatId, messageId);
      return true;
    }
    return false;
  }

  if (namespace === "sup") {
    if (action === "menu") {
      await sendScrapeSuperMenu(env, chatId, messageId);
      return true;
    }
    if (action === "toggle") {
      const current = await getScrapeSuper(env);
      await setScrapeSuper(env, !current);
      await sendScrapeSuperMenu(env, chatId, messageId);
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

function isPanelTrigger(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed === "管理面板" || trimmed === "管理";
}

async function handlePendingAdminAction(
  pending: { user_id: number; action: string; group_id: number },
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
  if (pending.action === "set_leaderboard_schedule") {
    const ok = await applyLeaderboardSchedule(env, message.chat.id, pending.group_id, content);
    if (ok) {
      await clearAdminAction(env, pending.user_id);
    }
    return true;
  }
  if (pending.action === "set_leaderboard_window") {
    const ok = await applyLeaderboardWindow(env, message.chat.id, pending.group_id, content);
    if (ok) {
      await clearAdminAction(env, pending.user_id);
    }
    return true;
  }
  if (pending.action === "set_linuxdo_token") {
    await setGlobalLinuxdoToken(env, content);
    await clearAdminAction(env, pending.user_id);
    await sendMessage(env, message.chat.id, "✅ 已保存全局 Linux.do Token");
    return true;
  }
  if (pending.action === "set_scrape_geo") {
    const geo = content.trim().toLowerCase();
    await setScrapeGeoCode(env, geo);
    await clearAdminAction(env, pending.user_id);
    await sendMessage(env, message.chat.id, `✅ 已设置 Scrape 地区: ${geo}`);
    return true;
  }
  return false;
}

async function sendGroupList(
  env: Env,
  chatId: number,
  messageId: number | null = null,
): Promise<void> {
  let groups = await getAllGroups(env);
  if (!groups.length) {
    const syncResult = await syncGroupsFromRegistry(env);
    if (!syncResult.unavailable) {
      groups = await getAllGroups(env);
    }
  }
  if (!groups.length) {
    await sendPanelMessage(env, chatId, "📋 暂无配置的群组", messageId);
    return;
  }

  const keyboard = groups.map((group) => {
    const status = Number(group.enabled) === 1 ? "✅" : "⭕";
    const name = group.group_name || String(group.group_id);
    const label = `${status} ${truncateLabel(name, 24)}`;
    return [{ text: label, callback_data: `${CALLBACK_GROUP_SHOW}:${group.group_id}` }];
  });
  keyboard.push([
    { text: "🔁 同步群组", callback_data: CALLBACK_PANEL_SYNC },
  ]);
  keyboard.push([
    { text: "🔗 Linuxdo Token 管理", callback_data: CALLBACK_LINUXDO_TOKEN_MENU },
  ]);
  keyboard.push([
    { text: "🌍 Scrape 地区设置", callback_data: CALLBACK_SCRAPE_GEO_MENU },
  ]);
  keyboard.push([
    { text: "⚡ Super 模式", callback_data: CALLBACK_SCRAPE_SUPER_MENU },
  ]);
  keyboard.push([
    { text: "🔄 刷新", callback_data: CALLBACK_PANEL_LIST },
  ]);

  await sendPanelMessage(env, chatId, "📋 群组列表（点击进入管理）", messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendGroupActions(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const status = Number(config.enabled) === 1 ? "✅ 已启用" : "⭕ 未启用";
  const leaderboardEnabled = Number(config.leaderboard_enabled) === 1;
  const spoilerEnabled = Number(config.spoiler_enabled) === 1;
  const spoilerAutoDelete = Number(config.spoiler_auto_delete) === 1;
  const name = config.group_name || String(groupId);
  const lastSummary = config.last_summary_time || "无";
  const lastLeaderboard = config.last_leaderboard_time || "无";
  const lines = [
    `📌 ${name}`,
    `ID: ${groupId}`,
    `状态: ${status}`,
    `定时: ${config.schedule || DEFAULT_SCHEDULE}`,
    `排行榜: ${leaderboardEnabled ? "✅ 已启用" : "⭕ 未启用"}`,
    `排行榜周期: ${config.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE}`,
    `统计窗口: ${config.leaderboard_window || DEFAULT_LEADERBOARD_WINDOW}`,
    `剧透模式: ${spoilerEnabled ? "✅ 开启" : "⭕ 关闭"}`,
    `自动删除: ${spoilerAutoDelete ? "✅ 开启" : "⭕ 关闭"}`,
    `Linuxdo解析: ${Number(config.linuxdo_enabled) === 1 ? "✅ 开启" : "⭕ 关闭"}`,
    `上次总结: ${lastSummary}`,
    `上次排行榜: ${lastLeaderboard}`,
  ];

  const keyboard = [
    [{ text: "总结设置", callback_data: `${CALLBACK_GROUP_SUMMARY_MENU}:${groupId}` }],
    [{ text: "排行榜设置", callback_data: `${CALLBACK_GROUP_LEADERBOARD_MENU}:${groupId}` }],
    [{ text: "剧透设置", callback_data: `${CALLBACK_SPOILER_MENU}:${groupId}` }],
    [{ text: "Linuxdo解析", callback_data: `${CALLBACK_LINUXDO_MENU}:${groupId}` }],
    [{ text: "⬅️ 返回列表", callback_data: CALLBACK_PANEL_LIST }],
  ];

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendSummarySettingsMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const enabled = Number(config.enabled) === 1;
  const name = config.group_name || String(groupId);
  const lastSummary = config.last_summary_time || "无";
  const lines = [
    "📝 总结设置",
    `群组: ${name}`,
    `ID: ${groupId}`,
    `状态: ${enabled ? "✅ 已启用" : "⭕ 未启用"}`,
    `定时: ${config.schedule || DEFAULT_SCHEDULE}`,
    `上次总结: ${lastSummary}`,
  ];

  const toggleLabel = enabled ? "禁用总结" : "启用总结";
  const toggleAction = enabled ? CALLBACK_GROUP_DISABLE : CALLBACK_GROUP_ENABLE;
  const keyboard = [
    [{ text: toggleLabel, callback_data: `${toggleAction}:${groupId}:summary` }],
    [{ text: "设置定时", callback_data: `${CALLBACK_SCHEDULE_MENU}:${groupId}` }],
    [{ text: "手动总结", callback_data: `${CALLBACK_GROUP_SUMMARY}:${groupId}` }],
    [{ text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SHOW}:${groupId}` }],
  ];

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendLeaderboardSettingsMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const enabled = Number(config.leaderboard_enabled) === 1;
  const name = config.group_name || String(groupId);
  const lastLeaderboard = config.last_leaderboard_time || "无";
  const lines = [
    "🏆 排行榜设置",
    `群组: ${name}`,
    `ID: ${groupId}`,
    `状态: ${enabled ? "✅ 已启用" : "⭕ 未启用"}`,
    `排行榜周期: ${config.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE}`,
    `统计窗口: ${config.leaderboard_window || DEFAULT_LEADERBOARD_WINDOW}`,
    `上次排行榜: ${lastLeaderboard}`,
  ];

  const toggleLabel = enabled ? "禁用排行榜" : "启用排行榜";
  const keyboard = [
    [{ text: toggleLabel, callback_data: `${CALLBACK_LEADERBOARD_TOGGLE}:${groupId}:settings` }],
    [{ text: "设置排行榜周期", callback_data: `${CALLBACK_LEADERBOARD_MENU}:${groupId}` }],
    [{ text: "设置统计窗口", callback_data: `${CALLBACK_LEADERBOARD_WINDOW_MENU}:${groupId}` }],
    [{ text: "手动排行榜", callback_data: `${CALLBACK_GROUP_LEADERBOARD}:${groupId}` }],
    [{ text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SHOW}:${groupId}` }],
  ];

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendScheduleMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const lines = [
    "⏰ 选择定时方案",
    `当前: ${config.schedule || DEFAULT_SCHEDULE}`,
    "",
    "预设选项:",
    ...SCHEDULE_PRESETS.map((preset) => `• ${preset.label}（${preset.description}）`),
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
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
    { text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SUMMARY_MENU}:${groupId}` },
  ]);

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendLeaderboardMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const lines = [
    "🏆 选择排行榜周期",
    `当前: ${config.leaderboard_schedule || DEFAULT_LEADERBOARD_SCHEDULE}`,
    "",
    "预设选项:",
    ...SCHEDULE_PRESETS.map((preset) => `• ${preset.label}（${preset.description}）`),
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const preset of SCHEDULE_PRESETS) {
    keyboard.push([
      {
        text: preset.label,
        callback_data: `${CALLBACK_LEADERBOARD_SET}:${groupId}:${encodeCallbackValue(preset.value)}`,
      },
    ]);
  }
  keyboard.push(...SCHEDULE_CUSTOM_OPTIONS.map((preset) => ([
    {
      text: preset.label,
      callback_data: `${CALLBACK_LEADERBOARD_SET}:${groupId}:${encodeCallbackValue(preset.value)}`,
    },
  ])));
  keyboard.push([
    { text: "自定义表达式", callback_data: `${CALLBACK_LEADERBOARD_CUSTOM}:${groupId}` },
  ]);
  keyboard.push([
    { text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_LEADERBOARD_MENU}:${groupId}` },
  ]);

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendLeaderboardWindowMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const lines = [
    "⏱️ 选择统计窗口",
    `当前: ${config.leaderboard_window || DEFAULT_LEADERBOARD_WINDOW}`,
    "",
    "预设选项:",
    ...LEADERBOARD_WINDOW_PRESETS.map((preset) => `• ${preset.label}（${preset.description}）`),
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const preset of LEADERBOARD_WINDOW_PRESETS) {
    keyboard.push([
      {
        text: preset.label,
        callback_data: `${CALLBACK_LEADERBOARD_WINDOW_SET}:${groupId}:${encodeCallbackValue(preset.value)}`,
      },
    ]);
  }
  keyboard.push([{
    text: "自定义时长",
    callback_data: `${CALLBACK_LEADERBOARD_WINDOW_CUSTOM}:${groupId}`,
  }]);
  keyboard.push([
    { text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_LEADERBOARD_MENU}:${groupId}` },
  ]);

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendSpoilerMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const spoilerEnabled = Number(config.spoiler_enabled) === 1;
  const spoilerAutoDelete = Number(config.spoiler_auto_delete) === 1;

  const lines = [
    "🫣 剧透模式设置",
    `当前状态: ${spoilerEnabled ? "✅ 开启" : "⭕ 关闭"}`,
    `自动删除原消息: ${spoilerAutoDelete ? "✅ 开启" : "⭕ 关闭"}`,
  ];

  const keyboard = [
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

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function toggleSpoilerEnabled(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }
  const next = Number(config.spoiler_enabled) !== 1;
  await updateGroupSpoilerEnabled(env, groupId, next);
  await updateRegistryFromConfig(env, { ...config, spoiler_enabled: next ? 1 : 0 });
  await sendSpoilerMenu(env, chatId, groupId, messageId);
}

async function toggleSpoilerAutoDelete(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }
  const next = Number(config.spoiler_auto_delete) !== 1;
  await updateGroupSpoilerAutoDelete(env, groupId, next);
  await updateRegistryFromConfig(env, { ...config, spoiler_auto_delete: next ? 1 : 0 });
  await sendSpoilerMenu(env, chatId, groupId, messageId);
}

async function sendLinuxdoMenu(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }

  const linuxdoEnabled = Number(config.linuxdo_enabled) === 1;

  const lines = [
    "🔗 Linuxdo 链接解析设置",
    `当前状态: ${linuxdoEnabled ? "✅ 开启" : "⭕ 关闭"}`,
  ];

  const keyboard = [
    [
      {
        text: linuxdoEnabled ? "关闭解析" : "开启解析",
        callback_data: `${CALLBACK_LINUXDO_TOGGLE}:${groupId}`,
      },
    ],
    [{ text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SHOW}:${groupId}` }],
  ];

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function toggleLinuxdoEnabled(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }
  const next = Number(config.linuxdo_enabled) !== 1;
  await updateGroupLinuxdoEnabled(env, groupId, next);
  await updateRegistryFromConfig(env, { ...config, linuxdo_enabled: next ? 1 : 0 });
  await sendLinuxdoMenu(env, chatId, groupId, messageId);
}

async function sendLinuxdoTokenMenu(
  env: Env,
  chatId: number,
  messageId: number | null = null,
): Promise<void> {
  const existingToken = await getGlobalLinuxdoToken(env);
  const hasToken = !!existingToken;

  const lines = [
    "🔗 全局 Linux.do Token",
    "",
    `状态: ${hasToken ? "✅ 已设置" : "⭕ 未设置"}`,
    "",
    "设置 Token 后，所有群组解析 Linux.do 链接时将使用此 Token 获取内容。",
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  keyboard.push([
    { text: hasToken ? "更新 Token" : "设置 Token", callback_data: CALLBACK_LINUXDO_TOKEN_SET },
  ]);
  if (hasToken) {
    keyboard.push([
      { text: "删除 Token", callback_data: CALLBACK_LINUXDO_TOKEN_DELETE },
    ]);
  }
  keyboard.push([
    { text: "⬅️ 返回列表", callback_data: CALLBACK_PANEL_LIST },
  ]);

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendScrapeGeoMenu(
  env: Env,
  chatId: number,
  messageId: number | null = null,
): Promise<void> {
  const currentGeo = await getScrapeGeoCode(env);

  const lines = [
    "🌍 Scrape.do 地区设置",
    "",
    `当前地区: ${currentGeo ? `🔹 ${currentGeo.toUpperCase()}` : "🚫 未指定 (自动)"}`,
    "",
    "设置 scrape.do 代理请求的出口地区，不同地区可能影响 Cloudflare 拦截策略。",
  ];

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  for (const preset of SCRAPE_GEO_PRESETS) {
    if (preset.value === "__custom__") {
      keyboard.push([{ text: preset.label, callback_data: CALLBACK_SCRAPE_GEO_CUSTOM }]);
    } else {
      const isCurrent = (preset.value || null) === (currentGeo || null);
      const label = isCurrent ? `${preset.label} ✓` : preset.label;
      keyboard.push([{ text: label, callback_data: `${CALLBACK_SCRAPE_GEO_SET}:${encodeCallbackValue(preset.value)}` }]);
    }
  }
  keyboard.push([{ text: "⬅️ 返回列表", callback_data: CALLBACK_PANEL_LIST }]);

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function sendScrapeSuperMenu(
  env: Env,
  chatId: number,
  messageId: number | null = null,
): Promise<void> {
  const enabled = await getScrapeSuper(env);

  const lines = [
    "⚡ Scrape.do Super 模式",
    "",
    `当前状态: ${enabled ? "✅ 开启" : "⭕ 关闭"}`,
    "",
    "Super 模式使用无头浏览器渲染，可绕过 Cloudflare JS Challenge。",
    "⚠️ 每次请求消耗 5-25 credits，请注意额度。",
  ];

  const keyboard = [
    [{ text: enabled ? "关闭 Super" : "开启 Super", callback_data: CALLBACK_SCRAPE_SUPER_TOGGLE }],
    [{ text: "⬅️ 返回列表", callback_data: CALLBACK_PANEL_LIST }],
  ];

  await sendPanelMessage(env, chatId, lines.join("\n"), messageId, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function toggleLeaderboardEnabled(
  env: Env,
  chatId: number,
  groupId: number,
  messageId: number | null = null,
  returnTo: "group" | "leaderboard" = "group",
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await sendPanelMessage(env, chatId, "❌ 群组未配置或暂无消息记录", messageId);
    return;
  }
  const next = Number(config.leaderboard_enabled) !== 1;
  await updateGroupLeaderboardEnabled(env, groupId, next);
  await updateRegistryFromConfig(env, { ...config, leaderboard_enabled: next ? 1 : 0 });
  if (returnTo === "leaderboard") {
    await sendLeaderboardSettingsMenu(env, chatId, groupId, messageId);
    return;
  }
  await sendGroupActions(env, chatId, groupId, messageId);
}

async function setGroupEnabled(
  env: Env,
  chatId: number,
  groupId: number,
  enabled: boolean,
  messageId: number | null = null,
): Promise<void> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", enabled, DEFAULT_SCHEDULE);
  } else {
    await updateGroupEnabled(env, groupId, enabled);
  }
  const updatedConfig = await getGroupConfig(env, groupId);
  if (updatedConfig) {
    await updateRegistryFromConfig(env, updatedConfig);
  }
  if (!messageId) {
    await sendMessage(
      env,
      chatId,
      enabled
        ? `✅ 已启用群组 ${groupId} 的消息总结功能`
        : `✅ 已禁用群组 ${groupId} 的消息总结功能`,
    );
  }
}

async function applySchedule(
  env: Env,
  chatId: number,
  groupId: number,
  schedule: string,
  messageId: number | null = null,
): Promise<boolean> {
  const trimmed = schedule.trim();
  if (!parseSchedule(trimmed)) {
    await sendPanelMessage(
      env,
      chatId,
      "❌ 无效的定时表达式，请重新输入或发送“取消”。",
      messageId,
    );
    return false;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", false, trimmed);
  } else {
    await updateGroupSchedule(env, groupId, trimmed);
  }
  const updatedConfig = await getGroupConfig(env, groupId);
  if (updatedConfig) {
    await updateRegistryFromConfig(env, updatedConfig);
  }
  if (messageId) {
    await sendScheduleMenu(env, chatId, groupId, messageId);
    return true;
  }
  await sendPanelMessage(env, chatId, `✅ 已设置群组 ${groupId} 的定时: ${trimmed}`, null);
  return true;
}

async function applyLeaderboardSchedule(
  env: Env,
  chatId: number,
  groupId: number,
  schedule: string,
  messageId: number | null = null,
): Promise<boolean> {
  const trimmed = schedule.trim();
  if (!parseSchedule(trimmed)) {
    await sendPanelMessage(
      env,
      chatId,
      "❌ 无效的排行榜定时表达式，请重新输入或发送“取消”。",
      messageId,
    );
    return false;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", false, DEFAULT_SCHEDULE);
  }
  await updateGroupLeaderboardSchedule(env, groupId, trimmed);

  const updatedConfig = await getGroupConfig(env, groupId);
  if (updatedConfig) {
    await updateRegistryFromConfig(env, updatedConfig);
  }
  if (messageId) {
    await sendLeaderboardMenu(env, chatId, groupId, messageId);
    return true;
  }
  await sendPanelMessage(env, chatId, `✅ 已设置群组 ${groupId} 的排行榜定时: ${trimmed}`, null);
  return true;
}

async function applyLeaderboardWindow(
  env: Env,
  chatId: number,
  groupId: number,
  windowText: string,
  messageId: number | null = null,
): Promise<boolean> {
  const trimmed = windowText.trim();
  if (!parseDuration(trimmed)) {
    await sendPanelMessage(
      env,
      chatId,
      "❌ 无效的统计窗口，请使用 30m / 2h / 1d 这类格式。",
      messageId,
    );
    return false;
  }

  const config = await getGroupConfig(env, groupId);
  if (!config) {
    await insertGroupConfig(env, groupId, "", false, DEFAULT_SCHEDULE);
  }
  await updateGroupLeaderboardWindow(env, groupId, trimmed);

  const updatedConfig = await getGroupConfig(env, groupId);
  if (updatedConfig) {
    await updateRegistryFromConfig(env, updatedConfig);
  }
  if (messageId) {
    await sendLeaderboardWindowMenu(env, chatId, groupId, messageId);
    return true;
  }
  await sendPanelMessage(env, chatId, `✅ 已设置群组 ${groupId} 的统计窗口: ${trimmed}`, null);
  return true;
}

async function sendPanelMessage(
  env: Env,
  chatId: number,
  text: string,
  messageId: number | null,
  options: { parse_mode?: "HTML" | "Markdown"; reply_markup?: InlineKeyboardMarkup } = {},
): Promise<void> {
  if (messageId) {
    try {
      await editMessage(env, chatId, messageId, text, options);
      return;
    } catch (error) {
      console.error("edit panel message failed", error);
    }
  }
  await sendMessage(env, chatId, text, options);
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

async function runLeaderboardForGroupAndNotify(
  env: Env,
  chatId: number,
  groupId: number,
): Promise<void> {
  await sendMessage(env, chatId, `⏳ 正在统计群组 ${groupId} 的排行榜...`);
  const result = await runLeaderboardForGroup(env, groupId);
  if (result.success) {
    if (!result.content) {
      await sendMessage(env, chatId, `ℹ️ 群组 ${groupId} 暂无可统计消息`);
      return;
    }
    await sendMessage(env, chatId, `✅ 群组 ${groupId} 的排行榜已发送`);
  } else {
    await sendMessage(env, chatId, `❌ 排行榜失败: ${result.error || "未知错误"}`);
  }
}

async function handleMyChatMemberUpdate(
  update: TelegramChatMemberUpdated,
  env: Env,
): Promise<void> {
  const chat = update.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") {
    return;
  }
  const status = update.new_chat_member?.status;
  if (status === "member" || status === "administrator" || status === "creator") {
    await registerGroup(env, chat.id, chat.title || "");
    return;
  }
  if (status === "left" || status === "kicked") {
    await removeGroup(env, chat.id);
  }
}

async function handleSyncGroups(
  chatId: number,
  env: Env,
  messageId: number | null = null,
): Promise<void> {
  await openKvSyncWindow(env, KV_SYNC_WINDOW_MS);
  const result = await syncGroupsFromRegistry(env);
  if (result.unavailable) {
    await sendPanelMessage(
      env,
      chatId,
      "⚠️ 未配置 GROUPS_KV，无法同步群组。",
      messageId,
    );
    return;
  }
  const windowSeconds = Math.round(KV_SYNC_WINDOW_MS / 1000);
  await sendPanelMessage(
    env,
    chatId,
    `✅ 已同步群组：总计 ${result.total}，新增 ${result.inserted}，更新 ${result.updated}，跳过 ${result.skipped}\n⏳ KV 读写窗口已开启 ${windowSeconds} 秒`,
    messageId,
  );
}
