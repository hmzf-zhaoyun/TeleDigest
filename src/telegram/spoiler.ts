import type { Env, TelegramMessage, TelegramUser } from "../types";
import { escapeHtml } from "../utils";
import { getGroupConfig } from "../db";
import { sendMessage, telegramApi } from "./api";

const MEDIA_GROUP_DEBOUNCE_MS = 1500;

type PendingMediaItem = {
  type: "photo" | "video";
  media: string;
  messageId: number;
};

type PendingMediaGroup = {
  chatId: number;
  items: PendingMediaItem[];
  caption?: string;
  lastUpdated: number;
  flushing: boolean;
  autoDelete: boolean;
};

const pendingMediaGroups = new Map<string, PendingMediaGroup>();

export async function handleSpoilerMessage(message: TelegramMessage, env: Env, ctx?: ExecutionContext): Promise<void> {
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
    if (message.media_group_id) {
      const queued = queueMediaGroupSpoiler(
        message,
        finalText,
        env,
        Number(config.spoiler_auto_delete) === 1,
        ctx,
      );
      if (queued) {
        return;
      }
    }

    let sent = false;
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
        sent = true;
      }
    } else if (message.video) {
      const fileId = extractMediaFileId(message.video);
      if (fileId) {
        await telegramApi(env, "sendVideo", {
          chat_id: chat.id,
          video: fileId,
          caption: finalText || undefined,
          parse_mode: finalText ? "HTML" : undefined,
          has_spoiler: true,
        });
        sent = true;
      }
    } else if (message.animation) {
      const fileId = extractMediaFileId(message.animation);
      if (fileId) {
        await telegramApi(env, "sendAnimation", {
          chat_id: chat.id,
          animation: fileId,
          caption: finalText || undefined,
          parse_mode: finalText ? "HTML" : undefined,
          has_spoiler: true,
        });
        sent = true;
      }
    } else if (message.document) {
      const info = extractDocumentInfo(message.document);
      if (info.fileId && looksLikeVideo(info.mimeType, info.fileName)) {
        await telegramApi(env, "sendVideo", {
          chat_id: chat.id,
          video: info.fileId,
          caption: finalText || undefined,
          parse_mode: finalText ? "HTML" : undefined,
          has_spoiler: true,
        });
        sent = true;
      } else if (info.fileId && looksLikeAnimation(info.mimeType, info.fileName)) {
        await telegramApi(env, "sendAnimation", {
          chat_id: chat.id,
          animation: info.fileId,
          caption: finalText || undefined,
          parse_mode: finalText ? "HTML" : undefined,
          has_spoiler: true,
        });
        sent = true;
      }
    }
    if (!sent && finalText) {
      await sendMessage(env, chat.id, finalText, { parse_mode: "HTML" });
      sent = true;
    }

    if (sent && Number(config.spoiler_auto_delete) === 1) {
      await telegramApi(env, "deleteMessage", {
        chat_id: chat.id,
        message_id: message.message_id,
      });
    }
  } catch (error) {
    console.error("spoiler handling failed", error);
  }
}

function queueMediaGroupSpoiler(
  message: TelegramMessage,
  captionHtml: string,
  env: Env,
  autoDelete: boolean,
  ctx?: ExecutionContext,
): boolean {
  const groupId = message.media_group_id;
  if (!groupId) {
    return false;
  }
  const item = extractMediaGroupItem(message);
  if (!item) {
    return false;
  }

  const key = `${message.chat.id}:${groupId}`;
  const now = Date.now();
  const entry: PendingMediaGroup = pendingMediaGroups.get(key) || {
    chatId: message.chat.id,
    items: [],
    caption: undefined,
    lastUpdated: now,
    flushing: false,
    autoDelete,
  };

  if (autoDelete && !entry.autoDelete) {
    entry.autoDelete = true;
  }
  if (!entry.items.some((existing) => existing.messageId === item.messageId)) {
    entry.items.push(item);
  }
  if (captionHtml && !entry.caption) {
    entry.caption = captionHtml;
  }
  entry.lastUpdated = now;
  pendingMediaGroups.set(key, entry);

  const flushPromise = flushMediaGroupWhenIdle(key, now, env);
  if (ctx) {
    ctx.waitUntil(flushPromise);
  }
  return true;
}

async function flushMediaGroupWhenIdle(
  key: string,
  observedUpdatedAt: number,
  env: Env,
): Promise<void> {
  await sleep(MEDIA_GROUP_DEBOUNCE_MS);
  const entry = pendingMediaGroups.get(key);
  if (!entry) {
    return;
  }
  if (entry.lastUpdated !== observedUpdatedAt) {
    return;
  }
  if (entry.flushing) {
    return;
  }
  entry.flushing = true;
  pendingMediaGroups.set(key, entry);

  try {
    await sendMediaGroupSpoiler(env, entry);
  } catch (error) {
    console.error("spoiler media group failed", error);
  } finally {
    pendingMediaGroups.delete(key);
  }
}

async function sendMediaGroupSpoiler(env: Env, group: PendingMediaGroup): Promise<void> {
  if (!group.items.length) {
    return;
  }

  let sent = false;
  if (group.items.length === 1) {
    await sendSingleSpoilerItem(env, group.chatId, group.items[0], group.caption);
    sent = true;
  } else {
    const media = group.items.map((item, index) => {
      const payload: Record<string, unknown> = {
        type: item.type,
        media: item.media,
        has_spoiler: true,
      };
      if (index === 0 && group.caption) {
        payload.caption = group.caption;
        payload.parse_mode = "HTML";
      }
      return payload;
    });

    try {
      await telegramApi(env, "sendMediaGroup", {
        chat_id: group.chatId,
        media,
      });
      sent = true;
    } catch (error) {
      console.error("sendMediaGroup failed, fallback to single sends", error);
      for (let i = 0; i < group.items.length; i += 1) {
        const caption = i === 0 ? group.caption : undefined;
        await sendSingleSpoilerItem(env, group.chatId, group.items[i], caption);
      }
      sent = true;
    }
  }

  if (sent && group.autoDelete) {
    await deleteOriginalMessages(env, group.chatId, group.items.map((item) => item.messageId));
  }
}

async function sendSingleSpoilerItem(
  env: Env,
  chatId: number,
  item: PendingMediaItem,
  caption?: string,
): Promise<void> {
  const basePayload = {
    chat_id: chatId,
    caption: caption || undefined,
    parse_mode: caption ? "HTML" : undefined,
    has_spoiler: true,
  };
  if (item.type === "photo") {
    await telegramApi(env, "sendPhoto", {
      ...basePayload,
      photo: item.media,
    });
    return;
  }
  await telegramApi(env, "sendVideo", {
    ...basePayload,
    video: item.media,
  });
}

async function deleteOriginalMessages(
  env: Env,
  chatId: number,
  messageIds: number[],
): Promise<void> {
  for (const messageId of messageIds) {
    await telegramApi(env, "deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }
}

function extractMediaGroupItem(message: TelegramMessage): PendingMediaItem | null {
  if (message.photo && message.photo.length > 0) {
    const fileId = extractPhotoFileId(message.photo);
    if (fileId) {
      return { type: "photo", media: fileId, messageId: message.message_id };
    }
  }
  if (message.video) {
    const fileId = extractMediaFileId(message.video);
    if (fileId) {
      return { type: "video", media: fileId, messageId: message.message_id };
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shouldTriggerSpoiler(message: TelegramMessage): boolean {
  if (isForwardedMessage(message) && hasMedia(message)) {
    return true;
  }
  const text = message.text || message.caption || "";
  return /#nsfw/i.test(text);
}

function hasMedia(message: TelegramMessage): boolean {
  return Boolean(
    (message.photo && message.photo.length > 0) ||
      message.video ||
      message.animation ||
      message.document,
  );
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

function extractMediaFileId(media: unknown): string | null {
  const file = media as { file_id?: string };
  return file?.file_id || null;
}

function extractDocumentInfo(document: unknown): {
  fileId: string | null;
  mimeType: string | null;
  fileName: string | null;
} {
  const file = document as { file_id?: string; mime_type?: string; file_name?: string };
  return {
    fileId: file?.file_id || null,
    mimeType: file?.mime_type || null,
    fileName: file?.file_name || null,
  };
}

function looksLikeVideo(mimeType: string | null, fileName: string | null): boolean {
  if (mimeType && mimeType.startsWith("video/")) return true;
  if (!fileName) return false;
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith(".mp4") ||
    lower.endsWith(".mov") ||
    lower.endsWith(".mkv") ||
    lower.endsWith(".webm") ||
    lower.endsWith(".m4v")
  );
}

function looksLikeAnimation(mimeType: string | null, fileName: string | null): boolean {
  if (mimeType === "image/gif") return true;
  if (!fileName) return false;
  return fileName.toLowerCase().endsWith(".gif");
}
