import type { Env, TelegramMessage } from "../types";
import { sendMessage } from "./api";
import { escapeHtml } from "../utils";
import { getGroupConfig, getUserLinuxdoToken } from "../db";

const LINUXDO_URL_PATTERN = /https?:\/\/linux\.do\/t\/topic\/(\d+)(?:\/(\d+))?/i;

export interface LinuxdoPost {
  title: string;
  author: string;
  content: string;
}

interface LinuxdoApiResponse {
  title?: string;
  fancy_title?: string;
  post_stream?: {
    posts?: Array<{
      name?: string;
      username?: string;
      cooked?: string;
      post_number?: number;
    }>;
  };
}

export function extractLinuxdoUrl(text: string): string | null {
  const match = LINUXDO_URL_PATTERN.exec(text);
  if (!match) return null;
  const topicId = match[1];
  const postNumber = match[2] || "1";
  return `https://linux.do/t/topic/${topicId}/${postNumber}.json`;
}

/**
 * Normalize cookie value: if it already looks like a full cookie string
 * (contains "="), use as-is; otherwise treat as a bare _t token value.
 */
function buildCookieString(raw: string): string {
  return raw.includes("=") ? raw : `_t=${raw}`;
}

export async function fetchLinuxdoPost(jsonUrl: string, env: Env, userToken?: string | null): Promise<LinuxdoPost | null> {
  const rawCookie = userToken || env.LINUXDO_COOKIE || null;
  const cookie = rawCookie ? buildCookieString(rawCookie) : null;
  console.log(`[linuxdo] url=${jsonUrl} cookieSource=${userToken ? "user" : env.LINUXDO_COOKIE ? "env" : "none"} cookieLen=${cookie?.length ?? 0} hasScrape=${!!env.SCRAPE_DO_TOKEN}`);

  // 策略1: scrape.do 代理 + cookie（绕过 Cloudflare 且带认证）
  if (env.SCRAPE_DO_TOKEN) {
    const result = await fetchViaScrapeProxy(jsonUrl, env.SCRAPE_DO_TOKEN, cookie);
    console.log(`[linuxdo] scrape.do result=${!!result}`);
    if (result) return result;
  }

  // 策略2: cookie 直连（无代理时降级）
  if (cookie) {
    const result = await fetchDirect(jsonUrl, cookie);
    console.log(`[linuxdo] direct result=${!!result}`);
    if (result) return result;
  }

  return null;
}

async function fetchViaScrapeProxy(jsonUrl: string, token: string, cookie?: string | null): Promise<LinuxdoPost | null> {
  try {
    let proxyUrl = `https://api.scrape.do/?token=${token}&url=${encodeURIComponent(jsonUrl)}`;
    if (cookie) {
      proxyUrl += `&setCookies=${encodeURIComponent(cookie)}`;
    }
    console.log(`[linuxdo] scrape.do requesting...`);
    const response = await fetch(proxyUrl);
    console.log(`[linuxdo] scrape.do status=${response.status}`);
    if (!response.ok) {
      const body = await response.text();
      console.error(`[linuxdo] scrape.do body=${body.slice(0, 500)}`);
      return null;
    }
    const text = await response.text();
    console.log(`[linuxdo] scrape.do responseLen=${text.length} preview=${text.slice(0, 200)}`);
    const data = JSON.parse(text) as LinuxdoApiResponse;
    return parseLinuxdoResponse(data);
  } catch (error) {
    console.error("[linuxdo] scrape.do error:", error);
    return null;
  }
}

async function fetchDirect(jsonUrl: string, cookie: string): Promise<LinuxdoPost | null> {
  try {
    const response = await fetch(jsonUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: cookie,
      },
    });
    console.log(`[linuxdo] direct status=${response.status}`);
    if (!response.ok) {
      const body = await response.text();
      console.error(`[linuxdo] direct body=${body.slice(0, 300)}`);
      return null;
    }
    const data = await response.json() as LinuxdoApiResponse;
    return parseLinuxdoResponse(data);
  } catch (error) {
    console.error("[linuxdo] direct error:", error);
    return null;
  }
}

function parseLinuxdoResponse(data: LinuxdoApiResponse): LinuxdoPost | null {
  const title = data.title || data.fancy_title || "";
  const firstPost = data.post_stream?.posts?.[0];
  if (!firstPost) return null;

  const author = firstPost.name || firstPost.username || "未知";
  const rawHtml = firstPost.cooked || "";
  const content = stripHtml(rawHtml);

  if (!title && !content) return null;

  return { title, author, content };
}

function stripHtml(html: string): string {
  return html
    // 图片 → 可点击链接文本
    .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, (_m, src) => `\n🖼 ${src}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<blockquote[^>]*>/gi, "\n> ")
    .replace(/<\/blockquote>/gi, "\n")
    // 清理 Discourse lightbox 尺寸描述（如 "image1045×1139 86.2 KB"）
    .replace(/<[^>]+>/g, "")
    .replace(/\b\w*\d+×\d+\s+[\d.]+\s*[KMG]?B\b/gi, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatPostMessage(post: LinuxdoPost, originalUrl: string): string {
  const maxContentLength = 2000;
  let content = post.content;
  if (content.length > maxContentLength) {
    content = content.slice(0, maxContentLength) + "...";
  }

  const escapedTitle = escapeHtml(post.title);
  const escapedAuthor = escapeHtml(post.author);
  let escapedContent = escapeHtml(content);
  // 将图片占位符转为可点击链接（escapeHtml 后 URL 中 & 已变为 &amp; 需还原 href）
  escapedContent = escapedContent.replace(
    /🖼 (https?:\/\/[^\s]+)/g,
    (_m, url) => `🖼 <a href="${url.replace(/&amp;/g, "&")}">查看图片</a>`
  );

  return (
    `📝 <b>${escapedTitle}</b>\n\n` +
    `👤 作者: ${escapedAuthor}\n\n` +
    `<blockquote expandable>${escapedContent}</blockquote>\n\n` +
    `🔗 <a href="${originalUrl}">查看原帖</a>`
  );
}

export async function handleLinuxdoLink(message: TelegramMessage, env: Env): Promise<boolean> {
  const text = message.text || "";
  const match = LINUXDO_URL_PATTERN.exec(text);
  if (!match) return false;

  // 群组消息需要检查开关
  if (message.chat.type === "group" || message.chat.type === "supergroup") {
    const config = await getGroupConfig(env, message.chat.id);
    if (!config || Number(config.linuxdo_enabled) !== 1) {
      return false;
    }
  }

  const originalUrl = match[0];
  const jsonUrl = extractLinuxdoUrl(text);
  if (!jsonUrl) return false;

  // 获取发送者的 token（如果有）
  const userId = message.from?.id;
  const userToken = userId ? await getUserLinuxdoToken(env, userId) : null;

  const post = await fetchLinuxdoPost(jsonUrl, env, userToken);
  if (!post) {
    await sendMessage(env, message.chat.id, "❌ 无法获取 Linux.do 帖子内容");
    return true;
  }

  const formattedMessage = formatPostMessage(post, originalUrl);
  await sendMessage(env, message.chat.id, formattedMessage, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  return true;
}

