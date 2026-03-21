import { TELEGRAM_API_BASE, TELEGRAM_SAFE_LIMIT, TELEGRAM_TEXT_LIMIT, } from "../constants";
import { escapeHtml } from "../utils";
export async function sendSummary(env, chatId, groupName, summary) {
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
        }
        catch {
            // fallback below
        }
    }
    await sendPlainTextChunked(env, chatId, plain, true);
}
export async function sendMessage(env, chatId, text, options = {}) {
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
export async function answerCallbackQuery(env, callbackQueryId, text, showAlert) {
    const payload = {
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
export async function editMessage(env, chatId, messageId, text, options = {}) {
    await telegramApi(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...options,
    });
}
export async function sendPhoto(env, chatId, photoBuffer, options = {}) {
    const token = env.TG_BOT_TOKEN;
    if (!token)
        return;
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
    const data = (await response.json());
    if (!data.ok) {
        throw new Error(data.description || "Telegram sendPhoto error");
    }
}
/** 以文档形式发送图片，避免 Telegram 压缩 */
export async function sendDocument(env, chatId, docBuffer, filename, options = {}) {
    const token = env.TG_BOT_TOKEN;
    if (!token)
        return;
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
    const data = (await response.json());
    if (!data.ok) {
        throw new Error(data.description || "Telegram sendDocument error");
    }
}
/** 获取频道/群组头像 file_id */
export async function getChatAvatarFileId(env, chatId) {
    const token = env.TG_BOT_TOKEN;
    if (!token)
        return null;
    try {
        const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getChat?chat_id=${chatId}`);
        const data = (await res.json());
        if (!data.ok || !data.result?.photo?.small_file_id)
            return null;
        return data.result.photo.small_file_id;
    }
    catch {
        return null;
    }
}
/** 获取用户头像照片列表，返回最小尺寸的 file_id */
export async function getUserAvatarFileId(env, userId) {
    const token = env.TG_BOT_TOKEN;
    if (!token)
        return null;
    try {
        const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getUserProfilePhotos?user_id=${userId}&limit=1`);
        const data = (await res.json());
        if (!data.ok || !data.result?.photos?.length)
            return null;
        const sizes = data.result.photos[0];
        // 取最小尺寸（第一个），足够 40px 头像使用
        return sizes[0]?.file_id ?? null;
    }
    catch {
        return null;
    }
}
/** 下载 Telegram 文件，返回 ArrayBuffer */
export async function downloadTelegramFile(env, fileId) {
    const token = env.TG_BOT_TOKEN;
    if (!token)
        return null;
    try {
        const fileRes = await fetch(`${TELEGRAM_API_BASE}/bot${token}/getFile?file_id=${fileId}`);
        const fileData = (await fileRes.json());
        if (!fileData.ok || !fileData.result?.file_path)
            return null;
        const dlRes = await fetch(`${TELEGRAM_API_BASE}/file/bot${token}/${fileData.result.file_path}`);
        if (!dlRes.ok)
            return null;
        return dlRes.arrayBuffer();
    }
    catch {
        return null;
    }
}
/** 发送贴纸（WebP/PNG） */
export async function sendSticker(env, chatId, stickerBuffer, options = {}) {
    const token = env.TG_BOT_TOKEN;
    if (!token)
        return;
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("sticker", new Blob([stickerBuffer], { type: "image/png" }), "quote.png");
    if (options.reply_to_message_id) {
        form.append("reply_to_message_id", String(options.reply_to_message_id));
    }
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendSticker`, {
        method: "POST",
        body: form,
    });
    const data = (await response.json());
    if (!data.ok) {
        throw new Error(data.description || "Telegram sendSticker error");
    }
}
/** Send a group of photos as an album (max 10) via URL */
export async function sendMediaGroup(env, chatId, imageUrls) {
    if (imageUrls.length === 0)
        return;
    const media = imageUrls.slice(0, 10).map((url) => ({
        type: "photo",
        media: url,
    }));
    await telegramApi(env, "sendMediaGroup", {
        chat_id: chatId,
        media,
    });
}
export async function telegramApi(env, method, payload) {
    const token = env.TG_BOT_TOKEN;
    if (!token) {
        return;
    }
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const data = (await response.json());
    if (!data.ok) {
        throw new Error(data.description || "Telegram API error");
    }
}
const BOT_COMMANDS = [
    { command: "start", description: "启动机器人" },
    { command: "help", description: "显示帮助信息" },
    { command: "status", description: "查看群组状态" },
    { command: "q", description: "引用卡片" },
];
export async function registerBotCommands(env) {
    await telegramApi(env, "setMyCommands", { commands: BOT_COMMANDS });
}
async function sendPlainTextChunked(env, chatId, text, disableWebPreview) {
    const parts = splitTextForTelegram(text, TELEGRAM_SAFE_LIMIT);
    for (const part of parts) {
        await telegramApi(env, "sendMessage", {
            chat_id: chatId,
            text: part,
            disable_web_page_preview: disableWebPreview ? true : undefined,
        });
    }
}
function splitTextForTelegram(text, limit) {
    const parts = [];
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
