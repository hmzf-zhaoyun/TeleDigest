import type { Env, TelegramMessage } from "../types";
import { sendMessage, sendMediaGroup } from "./api";
import { escapeHtml } from "../utils";
import { getGroupConfig, getGlobalLinuxdoToken, setGlobalLinuxdoToken, getScrapeGeoCode, getScrapeSuper } from "../db";

const LINUXDO_URL_PATTERN = /https?:\/\/linux\.do\/t\/topic\/(\d+)(?:\/(\d+))?/i;

export interface LinuxdoPost {
  title: string;
  author: string;
  rawHtml: string;
  content: string;
  // Telegram fallback media group images (max 10)
  images: string[];
  // Telegraph inline images (expanded list)
  telegraphImages: string[];
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

type TelegraphNode = string | {
  tag: string;
  attrs?: Record<string, string>;
  children?: TelegraphNode[];
};

interface TelegraphCreatePageResponse {
  ok: boolean;
  error?: string;
  result?: {
    url?: string;
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

  // 策略1: scrape.do 代理 + cookie（绕 CF 且带认证）
  if (env.SCRAPE_DO_TOKEN) {
    const geoCode = await getScrapeGeoCode(env);
    const superMode = await getScrapeSuper(env);
    const result = await fetchViaScrapeProxy(jsonUrl, env.SCRAPE_DO_TOKEN, cookie, geoCode, superMode);
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

async function fetchViaScrapeProxy(jsonUrl: string, token: string, cookie?: string | null, geoCode?: string | null, superMode?: boolean): Promise<FetchResult> {
  try {
    let proxyUrl = `https://api.scrape.do/?token=${token}&url=${encodeURIComponent(jsonUrl)}&pureCookies=true`;
    if (geoCode) {
      proxyUrl += `&geoCode=${geoCode}`;
    }
    if (superMode) {
      proxyUrl += `&super=true`;
    }
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
  const telegraphImages = extractImages(rawHtml);
  const images = telegraphImages.slice(0, 10);
  const content = stripHtml(rawHtml);

  if (!title && !content) return null;

  return { title, author, rawHtml, content, images, telegraphImages };
}

function isValidPostImageUrl(url: string): boolean {
  if (/\/images\/emoji\//i.test(url)) return false;
  if (/\/user_avatar\//i.test(url)) return false;
  if (/\/letter_avatar/i.test(url)) return false;
  return /\.(jpe?g|png|gif|webp)/i.test(url);
}

function normalizeLinuxdoImageUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, "https://linux.do");
    if (url.hostname !== "linux.do") return rawUrl;
    if (!/\/uploads\/default\/(?:optimized|original)\//i.test(url.pathname)) return rawUrl;
    url.pathname = url.pathname.replace(/\/uploads\/default\/optimized\//i, "/uploads/default/original/");
    url.pathname = url.pathname.replace(
      /_(\d+)_\d+[xX]\d+(?=\.(?:jpe?g|png|gif|webp)$)/i,
      ""
    );
    return url.toString();
  } catch {
    if (!/^(?:https?:)?\/\/linux\.do\/uploads\/default\/(?:optimized|original)\//i.test(rawUrl) && !/^\/uploads\/default\/(?:optimized|original)\//i.test(rawUrl)) {
      return rawUrl;
    }
    return rawUrl
      .replace(/\/uploads\/default\/optimized\//i, "/uploads/default/original/")
      .replace(/_(\d+)_\d+[xX]\d+(?=\.(?:jpe?g|png|gif|webp)(?:[?#]|$))/i, "");
  }
}

/** Extract image URLs from Discourse cooked HTML.
 *  Prefer lightbox href (original image) instead of img src (thumbnail).
 *  Filter out emoji, avatar, and extensionless URLs. */
function extractImages(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const mixedRe = /<a\b[^>]*\blightbox\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>|<img[^>]+src="([^"]+)"[^>]*>/gi;
  let m: RegExpExecArray | null;

  while ((m = mixedRe.exec(html)) !== null) {
    const rawUrl = m[1] || m[2];
    if (!rawUrl) continue;
    const url = normalizeLinuxdoImageUrl(rawUrl);
    if (seen.has(url)) continue;
    if (!isValidPostImageUrl(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function stripHtml(html: string): string {
  const seen = new Set<string>();
  let markerIndex = 0;
  return html
    // Lightbox 图片替换为顺序占位符，不依赖 URL 匹配
    .replace(
      /<a\b[^>]*\blightbox\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi,
      (_m, href) => {
        const normalized = normalizeLinuxdoImageUrl(href);
        if (!isValidPostImageUrl(normalized)) return "\n";
        if (seen.has(normalized)) return "\n";
        seen.add(normalized);
        markerIndex += 1;
        return `\n[IMG#${markerIndex}]\n`;
      }
    )
    // 非 lightbox 的 img 不再保留 URL，避免把 emoji 图片带入正文
    .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, "")
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
  // 将编号占位符转为对应图片链接
  escapedContent = escapedContent.replace(
    /\[IMG#(\d+)\]/g,
    (_m, rawIndex) => {
      const index = Number(rawIndex) - 1;
      const url = post.images[index];
      if (!url) return "";
      return `🖼 <a href="${url.replace(/&/g, "&amp;")}">查看图片 ${rawIndex}</a>`;
    }
  );

  return (
    `📝 <b>${escapedTitle}</b>\n\n` +
    `👤 作者: ${escapedAuthor}\n\n` +
    `<blockquote expandable>${escapedContent}</blockquote>\n\n` +
    `🔗 <a href="${originalUrl}">查看原帖</a>`
  );
}

function truncateForTelegraph(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function buildTelegraphSourceText(post: LinuxdoPost): string {
  const toMarker = (rawUrl: string): string => {
    const normalized = normalizeLinuxdoImageUrl(rawUrl);
    if (!isValidPostImageUrl(normalized)) return "\n";
    return `\n[IMG] ${normalized}\n`;
  };

  const text = post.rawHtml
    .replace(
      /<a\b[^>]*\blightbox\b[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi,
      (_m, href) => toMarker(href)
    )
    .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, (_m, src) => toMarker(src))
    .replace(
      /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_m, code) => `\n[CODE]\n${stripTags(code)}\n[/CODE]\n`
    )
    .replace(/<blockquote[^>]*>/gi, "\n[QUOTE]\n")
    .replace(/<\/blockquote>/gi, "\n[/QUOTE]\n")
    .replace(
      /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href, inner) => {
        const text = decodeHtmlEntities(stripTags(inner)).trim();
        if (!text) return href;
        return `${text} (${href})`;
      }
    )
    .replace(/<img[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\b\w*\d+×\d+\s+[\d.]+\s*[KMG]?B\b/gi, "");

  return decodeHtmlEntities(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildTelegraphContent(post: LinuxdoPost, originalUrl: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const text = truncateForTelegraph(buildTelegraphSourceText(post), 20000);
  const lines = text.split("\n");

  nodes.push({ tag: "p", children: [`作者：${post.author || "未知"}`] });
  nodes.push({
    tag: "p",
    children: [{ tag: "a", attrs: { href: originalUrl }, children: ["查看原帖"] }],
  });

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const markerMatch = /^\[IMG\]\s+(https?:\/\/\S+)$/i.exec(line);
    if (markerMatch) {
      const imageUrl = normalizeLinuxdoImageUrl(markerMatch[1].replace(/[),.;!?]+$/, ""));
      if (!isValidPostImageUrl(imageUrl)) continue;
      nodes.push({
        tag: "figure",
        children: [{ tag: "img", attrs: { src: imageUrl } }],
      });
      continue;
    }

    if (line === "[QUOTE]") {
      const quoteLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "[/QUOTE]") {
        const q = lines[i].trim();
        if (q) quoteLines.push(q);
        i += 1;
      }
      if (quoteLines.length > 0) {
        nodes.push({ tag: "blockquote", children: [quoteLines.join("\n")] });
      }
      continue;
    }

    if (line === "[CODE]") {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== "[/CODE]") {
        codeLines.push(lines[i]);
        i += 1;
      }
      const codeText = codeLines.join("\n").trim();
      if (codeText) {
        nodes.push({ tag: "pre", children: [codeText] });
      }
      continue;
    }

    if (line.startsWith("- ")) {
      const items: TelegraphNode[] = [];
      items.push({ tag: "li", children: [line.slice(2).trim()] });
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith("- ")) {
        i += 1;
        items.push({ tag: "li", children: [lines[i].trim().slice(2).trim()] });
      }
      nodes.push({ tag: "ul", children: items });
      continue;
    }

    nodes.push({ tag: "p", children: [line] });
  }

  return nodes;
}

async function createTelegraphPage(post: LinuxdoPost, originalUrl: string, env: Env): Promise<string | null> {
  const accessToken = env.TELEGRAPH_ACCESS_TOKEN;
  if (!accessToken) return null;

  const body = new URLSearchParams({
    access_token: accessToken,
    title: truncateForTelegraph(post.title?.trim() || "Linux.do", 256),
    author_name: "TeleDigest",
    content: JSON.stringify(buildTelegraphContent(post, originalUrl)),
    return_content: "false",
  });

  try {
    const response = await fetch("https://api.telegra.ph/createPage", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[linuxdo] telegraph status=${response.status} body=${text.slice(0, 500)}`);
      return null;
    }
    const data = await response.json() as TelegraphCreatePageResponse;
    if (!data.ok || !data.result?.url) {
      console.error("[linuxdo] telegraph api error:", data.error || "unknown");
      return null;
    }
    return data.result.url;
  } catch (error) {
    console.error("[linuxdo] telegraph request failed:", error);
    return null;
  }
}

function formatTelegraphMessage(post: LinuxdoPost, telegraphUrl: string, originalUrl: string): string {
  const escapedTitle = escapeHtml(post.title || "Linux.do");
  const escapedAuthor = escapeHtml(post.author || "未知");
  return (
    `📘 <b>${escapedTitle}</b>\n\n` +
    `👤 作者: ${escapedAuthor}\n` +
    `📰 <a href="${telegraphUrl}">Telegraph 阅读</a>\n` +
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

  const telegraphUrl = await createTelegraphPage(post, originalUrl, env);
  if (telegraphUrl) {
    await sendMessage(env, message.chat.id, formatTelegraphMessage(post, telegraphUrl, originalUrl), {
      parse_mode: "HTML",
      disable_web_page_preview: false,
    });
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

