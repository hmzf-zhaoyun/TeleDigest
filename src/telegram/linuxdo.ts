import type { Env, TelegramMessage } from "../types";
import { sendMessage, sendMediaGroup } from "./api";
import { escapeHtml } from "../utils";
import { getGroupConfig, getGlobalLinuxdoToken, setGlobalLinuxdoToken } from "../db";

const LINUXDO_URL_PATTERN = /https?:\/\/linux\.do\/t\/topic\/(\d+)(?:\/(\d+))?/i;

export interface LinuxdoPost {
  title: string;
  author: string;
  content: string;
  images: string[];
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

interface FetchResult {
  post: LinuxdoPost | null;
  newCookie?: string | null;
}

/**
 * Extract new _t token from scrape.do response headers.
 * scrape.do may forward Set-Cookie via Scrape.do-Set-Cookie or standard Set-Cookie header.
 */
function extractNewToken(response: Response): string | null {
  // Scrape.do returns cookies via custom header: Scrape.do-Cookies
  for (const headerName of ["Scrape.do-Cookies", "set-cookie"]) {
    const raw = response.headers.get(headerName);
    if (!raw) continue;
    const match = /_t=([^;]+)/.exec(raw);
    if (match) {
      console.log(`[linuxdo] found new _t token in ${headerName}`);
      return match[1];
    }
  }
  return null;
}

export async function fetchLinuxdoPost(jsonUrl: string, env: Env): Promise<LinuxdoPost | null> {
  const rawCookie = await getGlobalLinuxdoToken(env);
  const cookie = rawCookie ? buildCookieString(rawCookie) : null;
  console.log(`[linuxdo] url=${jsonUrl} cookieSource=${rawCookie ? "db" : "none"} cookieLen=${cookie?.length ?? 0} hasScrape=${!!env.SCRAPE_DO_TOKEN}`);

  // 策略1: scrape.do 代理 + cookie（绕 CF 且带认证，geoCode 锁定新加坡减少 IP 漂移）
  if (env.SCRAPE_DO_TOKEN) {
    const result = await fetchViaScrapeProxy(jsonUrl, env.SCRAPE_DO_TOKEN, cookie);
    console.log(`[linuxdo] scrape.do result=${!!result.post}`);
    // Auto-renew: save new token back to D1
    if (result.newCookie && rawCookie) {
      console.log(`[linuxdo] auto-renewing global token`);
      try {
        await setGlobalLinuxdoToken(env, result.newCookie);
      } catch (e) {
        console.error(`[linuxdo] failed to save renewed token:`, e);
      }
    }
    if (result.post) return result.post;
  }

  // 策略2: cookie 直连降级（Workers 出口可能被 CF 拦截）
  if (cookie) {
    const result = await fetchDirect(jsonUrl, cookie);
    console.log(`[linuxdo] direct result=${!!result}`);
    if (result) return result;
  }

  return null;
}

async function fetchViaScrapeProxy(jsonUrl: string, token: string, cookie?: string | null): Promise<FetchResult> {
  try {
    let proxyUrl = `https://api.scrape.do/?token=${token}&url=${encodeURIComponent(jsonUrl)}&geoCode=sg&pureCookies=true`;
    if (cookie) {
      proxyUrl += `&setCookies=${encodeURIComponent(cookie)}`;
    }
    console.log(`[linuxdo] scrape.do requesting...`);
    const response = await fetch(proxyUrl);
    console.log(`[linuxdo] scrape.do status=${response.status}`);

    // Try to extract renewed _t token regardless of status
    const newCookie = extractNewToken(response);

    if (!response.ok) {
      const body = await response.text();
      console.error(`[linuxdo] scrape.do body=${body.slice(0, 500)}`);
      return { post: null, newCookie };
    }
    const text = await response.text();
    console.log(`[linuxdo] scrape.do responseLen=${text.length} preview=${text.slice(0, 200)}`);
    const data = JSON.parse(text) as LinuxdoApiResponse;
    return { post: parseLinuxdoResponse(data), newCookie };
  } catch (error) {
    console.error("[linuxdo] scrape.do error:", error);
    return { post: null };
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
  const images = extractImages(rawHtml);
  const content = stripHtml(rawHtml);

  if (!title && !content) return null;

  return { title, author, content, images };
}

/** Extract image URLs from Discourse cooked HTML.
 *  Only use img src (not lightbox href which may lack extension).
 *  Filter out emoji, avatar, and extensionless URLs. Max 10 (Telegram limit). */
function extractImages(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const imgRe = /<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    // Skip emoji and avatar images
    if (/\/images\/emoji\//i.test(url)) continue;
    if (/\/user_avatar\//i.test(url)) continue;
    if (/\/letter_avatar/i.test(url)) continue;
    // Must have image extension for Telegram to recognize
    if (!/\.(jpe?g|png|gif|webp)/i.test(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls.slice(0, 10);
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

  const post = await fetchLinuxdoPost(jsonUrl, env);
  if (!post) {
    await sendMessage(env, message.chat.id, "❌ 无法获取 Linux.do 帖子内容");
    return true;
  }

  const formattedMessage = formatPostMessage(post, originalUrl);
  await sendMessage(env, message.chat.id, formattedMessage, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  // Send images as album if available
  if (post.images.length > 0) {
    console.log(`[linuxdo] sending ${post.images.length} images as album:`, post.images);
    try {
      await sendMediaGroup(env, message.chat.id, post.images);
    } catch (e) {
      console.error("[linuxdo] sendMediaGroup failed:", e);
    }
  } else {
    console.log("[linuxdo] no images extracted from post");
  }

  return true;
}

