import {
  TELEGRAM_API_BASE,
  TELEGRAM_SAFE_LIMIT,
  TELEGRAM_TEXT_LIMIT,
} from "../constants";
import type { Env, InlineKeyboardMarkup, TelegramUser } from "../types";
import { escapeHtml } from "../utils";

export async function sendSummary(
  env: Env,
  chatId: number,
  groupName: string,
  summary: string,
): Promise<void> {
  const escapedGroup = escapeHtml(groupName);
  const escapedSummary = escapeHtml(summary);
  const html = `<blockquote expandable>📊 ${escapedGroup}\n\n${escapedSummary}</blockquote>`;
  const plain = `📊 ${groupName}\n\n${summary}`;

  if (html.length <= TELEGRAM_TEXT_LIMIT) {
    try {
      await sendMessage(env, chatId, html, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return;
    } catch {
      // fallback below
    }
  }
  await sendPlainTextChunked(env, chatId, plain, true);
}

export async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  options: {
    parse_mode?: "HTML" | "Markdown";
    reply_markup?: InlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
  } = {},
): Promise<void> {
  if (!options.parse_mode && !options.reply_markup && text.length > TELEGRAM_TEXT_LIMIT) {
    await sendPlainTextChunked(env, chatId, text, options.disable_web_page_preview);
    return;
  }
  await telegramApi(env, "sendMessage", {
    chat_id: chatId,
    text,
    ...options,
  });
}

export async function answerCallbackQuery(
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

export async function editMessage(
  env: Env,
  chatId: number,
  messageId: number,
  text: string,
  options: { parse_mode?: "HTML" | "Markdown"; reply_markup?: InlineKeyboardMarkup } = {},
): Promise<void> {
  await telegramApi(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...options,
  });
}

export async function sendPhoto(
  env: Env,
  chatId: number,
  photoBuffer: ArrayBuffer,
  options: { reply_to_message_id?: number } = {},
): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([photoBuffer], { type: "image/png" }), "quote.png");
  if (options.reply_to_message_id) {
    form.append("reply_to_message_id", String(options.reply_to_message_id));
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(data.description || "Telegram sendPhoto error");
  }
}

/** 以文档形式发送图片，避免 Telegram 压缩 */
export async function sendDocument(
  env: Env,
  chatId: number,
  docBuffer: ArrayBuffer,
  filename: string,
  options: { reply_to_message_id?: number } = {},
): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("document", new Blob([docBuffer], { type: "image/png" }), filename);
  if (options.reply_to_message_id) {
    form.append("reply_to_message_id", String(options.reply_to_message_id));
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, {
    method: "POST",
    body: form,
  });
  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(data.description || "Telegram sendDocument error");
  }
}

/** 获取频道/群组头像 file_id */
export async function getChatAvatarFileId(
  env: Env,
  chatId: number,
): Promise<string | null> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getChat?chat_id=${chatId}`,
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: { photo?: { small_file_id?: string } };
    };
    if (!data.ok || !data.result?.photo?.small_file_id) return null;
    return data.result.photo.small_file_id;
  } catch {
    return null;
  }
}

/** 获取用户头像照片列表，返回最小尺寸的 file_id */
export async function getUserAvatarFileId(
  env: Env,
  userId: number,
): Promise<string | null> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getUserProfilePhotos?user_id=${userId}&limit=1`,
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: { photos: Array<Array<{ file_id: string; width: number }>> };
    };
    if (!data.ok || !data.result?.photos?.length) return null;
    const sizes = data.result.photos[0];
    // 取最小尺寸（第一个），足够 40px 头像使用
    return sizes[0]?.file_id ?? null;
  } catch {
    return null;
  }
}

/** 下载 Telegram 文件，返回 ArrayBuffer */
export async function downloadTelegramFile(
  env: Env,
  fileId: string,
): Promise<ArrayBuffer | null> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return null;
  try {
    const fileRes = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${fileId}`,
    );
    const fileData = (await fileRes.json()) as {
      ok: boolean;
      result?: { file_path: string };
    };
    if (!fileData.ok || !fileData.result?.file_path) return null;
    const dlRes = await fetch(
      `${TELEGRAM_API_BASE}/file/bot${token}/${fileData.result.file_path}`,
    );
    if (!dlRes.ok) return null;
    return dlRes.arrayBuffer();
  } catch {
    return null;
  }
}

/** 发送贴纸（WebP/PNG） */
export async function sendSticker(
  env: Env,
  chatId: number,
  stickerBuffer: ArrayBuffer,
  options: { reply_to_message_id?: number } = {},
): Promise<void> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return;

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "sticker",
    new Blob([stickerBuffer], { type: "image/png" }),
    "quote.png",
  );
  if (options.reply_to_message_id) {
    form.append("reply_to_message_id", String(options.reply_to_message_id));
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendSticker`, {
    method: "POST",
    body: form,
  });
  const data = (await response.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(data.description || "Telegram sendSticker error");
  }
}

/** Send a group of photos as an album (max 10) via URL */
export async function sendMediaGroup(
  env: Env,
  chatId: number,
  imageUrls: string[],
): Promise<void> {
  if (imageUrls.length === 0) return;
  const media = imageUrls.slice(0, 10).map((url) => ({
    type: "photo" as const,
    media: url,
  }));
  await telegramApi(env, "sendMediaGroup", {
    chat_id: chatId,
    media,
  });
}

export async function telegramApi(env: Env, method: string, payload: unknown): Promise<void> {
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

/** 查询群成员状态，用于权限校验 */
export async function getChatMember(
  env: Env,
  chatId: number,
  userId: number,
): Promise<{ status: string; user?: TelegramUser } | null> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(
      `${TELEGRAM_API_BASE}/bot${token}/getChatMember?chat_id=${chatId}&user_id=${userId}`,
    );
    const data = (await res.json()) as {
      ok: boolean;
      result?: { status: string; user?: TelegramUser };
    };
    if (!data.ok || !data.result) return null;
    return data.result;
  } catch {
    return null;
  }
}

/** 永久封禁群成员 */
export async function banChatMember(
  env: Env,
  chatId: number,
  userId: number,
): Promise<void> {
  await telegramApi(env, "banChatMember", { chat_id: chatId, user_id: userId });
}

/** 解除群成员封禁；onlyIfBanned 为 true 时仅在已封禁的情况下生效 */
export async function unbanChatMember(
  env: Env,
  chatId: number,
  userId: number,
  onlyIfBanned = false,
): Promise<void> {
  await telegramApi(env, "unbanChatMember", {
    chat_id: chatId,
    user_id: userId,
    only_if_banned: onlyIfBanned,
  });
}

/** 获取 bot 自身信息（id/username），用于自踢防御 */
export async function getMe(env: Env): Promise<{ id: number; username?: string } | null> {
  const token = env.TG_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok: boolean;
      result?: { id: number; username?: string };
    };
    if (!data.ok || !data.result) return null;
    return data.result;
  } catch {
    return null;
  }
}

const BOT_COMMANDS = [
  { command: "start", description: "启动机器人" },
  { command: "help", description: "显示帮助信息" },
  { command: "status", description: "查看群组状态" },
  { command: "q", description: "引用卡片" },
  { command: "kick", description: "踢出用户（允许重新加入）" },
  { command: "ban", description: "永久封禁用户" },
  { command: "unban", description: "解除封禁" },
];

export async function registerBotCommands(env: Env): Promise<void> {
  await telegramApi(env, "setMyCommands", { commands: BOT_COMMANDS });
}

async function sendPlainTextChunked(
  env: Env,
  chatId: number,
  text: string,
  disableWebPreview?: boolean,
): Promise<void> {
  const parts = splitTextForTelegram(text, TELEGRAM_SAFE_LIMIT);
  for (const part of parts) {
    await telegramApi(env, "sendMessage", {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: disableWebPreview ? true : undefined,
    });
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
