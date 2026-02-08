import {
  ADMIN_ACTION_TTL_MINUTES,
  CALLBACK_GROUP_DISABLE,
  CALLBACK_GROUP_ENABLE,
  CALLBACK_GROUP_SHOW,
  CALLBACK_GROUP_SUMMARY,
  CALLBACK_PANEL_LIST,
  CALLBACK_PANEL_OPEN,
  CALLBACK_PANEL_SYNC,
  CALLBACK_SCHEDULE_CUSTOM,
  CALLBACK_SCHEDULE_MENU,
  CALLBACK_SCHEDULE_SET,
  CALLBACK_SPOILER_DELETE,
  CALLBACK_SPOILER_MENU,
  CALLBACK_SPOILER_TOGGLE,
  DEFAULT_SCHEDULE,
  KV_SYNC_WINDOW_MS,
  SCHEDULE_CUSTOM_OPTIONS,
  SCHEDULE_PRESETS,
} from "../constants";
import type {
  Env,
  InlineKeyboardMarkup,
  TelegramCallbackQuery,
  TelegramChatMemberUpdated,
  TelegramMessage,
  TelegramUpdate,
} from "../types";
import { decodeCallbackValue, encodeCallbackValue, isOwnerUser, truncateLabel } from "../utils";
import {
  clearAdminAction,
  ensureSchema,
  getAdminAction,
  getAllGroups,
  getGroupConfig,
  insertGroupConfig,
  openKvSyncWindow,
  saveGroupMessage,
  setAdminAction,
  updateGroupEnabled,
  updateGroupSchedule,
  updateGroupSpoilerAutoDelete,
  updateGroupSpoilerEnabled,
} from "../db";
import { parseSchedule } from "../schedule";
import { runSummaryForGroup } from "../summary";
import { answerCallbackQuery, editMessage, sendMessage } from "./api";
import { handleSpoilerMessage } from "./spoiler";
import { registerGroup, removeGroup, syncGroupsFromRegistry, updateRegistryFromConfig } from "../registry";

export async function handleTelegramWebhook(
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

  if (update.my_chat_member) {
    await handleMyChatMemberUpdate(update.my_chat_member, env);
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
    await registerGroup(env, message.chat.id, message.chat.title || "");
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
    case "syncgroups":
      if (!isOwner) {
        await sendMessage(env, chatId, "⛔ 您没有权限执行此命令");
        return;
      }
      await handleSyncGroups(chatId, env);
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
  base.push("/syncgroups - 从注册表同步群组");
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
    if (action === "show") {
      await sendGroupActions(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "enable") {
      await setGroupEnabled(env, chatId, groupId, true, messageId);
      await sendGroupActions(env, chatId, groupId, messageId);
      return true;
    }
    if (action === "disable") {
      await setGroupEnabled(env, chatId, groupId, false, messageId);
      await sendGroupActions(env, chatId, groupId, messageId);
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

  const keyboard = [
    [{ text: toggleLabel, callback_data: `${toggleAction}:${groupId}` }],
    [{ text: "剧透设置", callback_data: `${CALLBACK_SPOILER_MENU}:${groupId}` }],
    [{ text: "手动总结", callback_data: `${CALLBACK_GROUP_SUMMARY}:${groupId}` }],
    [{ text: "设置定时", callback_data: `${CALLBACK_SCHEDULE_MENU}:${groupId}` }],
    [{ text: "⬅️ 返回列表", callback_data: CALLBACK_PANEL_LIST }],
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
    { text: "⬅️ 返回", callback_data: `${CALLBACK_GROUP_SHOW}:${groupId}` },
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
