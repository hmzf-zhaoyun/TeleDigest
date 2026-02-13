import {
  TELEGRAM_API_BASE,
  TELEGRAM_SAFE_LIMIT,
  TELEGRAM_TEXT_LIMIT,
} from "../constants";
import type { Env, InlineKeyboardMarkup } from "../types";
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
