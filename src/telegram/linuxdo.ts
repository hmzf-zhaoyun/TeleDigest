import type { Env, TelegramMessage } from "../types";
import { sendMessage, sendMediaGroup } from "./api";
import { Resvg } from "@cf-wasm/resvg";
import { escapeHtml } from "../utils";
import { getGroupConfig, getGlobalLinuxdoToken, setGlobalLinuxdoToken, getScrapeGeoCode, getScrapeSuper } from "../db";

const LINUXDO_URL_PATTERN = /https?:\/\/linux\.do\/t\/topic\/(\d+)(?:\/(\d+))?/i;

export interface LinuxdoPost {
  title: string;
  author: string;
  rawHtml: string;
  markdown: string;
  content: string;
  // Telegram fallback media group images (max 10)
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

type TelegraphNode = string | {
  tag: string;
  attrs?: Record<string, string>;
  children?: TelegraphNode[];
};

function isTelegraphElement(node: TelegraphNode | undefined): node is Exclude<TelegraphNode, string> {
  return !!node && typeof node !== "string";
}

interface TelegraphCreatePageResponse {
  ok: boolean;
  error?: string;
  result?: {
    url?: string;
  };
}

interface TelegraphUploadResponseItem {
  src?: string;
  error?: string;
}

interface ParsedMarkdownTable {
  rows: string[][];
  headerRowIndex: number | null;
  columnCount: number;
}

const TELEGRAPH_TABLE_FONT_URL =
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-sc@latest/chinese-simplified-500-normal.ttf";
const TELEGRAPH_TABLE_FONT_FAMILY = "Noto Sans SC";
const TELEGRAPH_TABLE_FONT_SIZE = 22;
const TELEGRAPH_TABLE_LINE_HEIGHT = 32;
const TELEGRAPH_TABLE_CELL_PAD_X = 18;
const TELEGRAPH_TABLE_CELL_PAD_Y = 14;
const TELEGRAPH_TABLE_MIN_COL_WIDTH = 140;
const TELEGRAPH_TABLE_MAX_COL_WIDTH = 420;
const TELEGRAPH_TABLE_MAX_WIDTH = 1400;

let telegraphTableFontCache: Uint8Array | null = null;

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
  const markdown = convertCookedToMarkdown(rawHtml);
  const images = extractImages(rawHtml).slice(0, 10);
  const content = stripMarkdownForTelegram(markdown);

  if (!title && !content) return null;

  return { title, author, rawHtml, markdown, content, images };
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
  const mixedRe = /<a\b[^>]*\blightbox\b[^>]*\shref="([^"]+)"[^>]*>[\s\S]*?<\/a>|<img[^>]+src="([^"]+)"[^>]*>/gi;
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

function renderMarkdownImage(rawUrl: string, seen: Set<string>): string {
  const normalized = normalizeLinuxdoImageUrl(rawUrl);
  if (!isValidPostImageUrl(normalized)) return "\n";
  if (seen.has(normalized)) return "\n";
  seen.add(normalized);
  return `\n\n![image](${normalized})\n\n`;
}

function normalizeMarkdownWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function convertQuoteMarkersToMarkdown(text: string): string {
  let result = text;
  let previous = "";
  while (result !== previous) {
    previous = result;
    result = result.replace(
      /\[QUOTE\]\s*([\s\S]*?)\s*\[\/QUOTE\]/g,
      (_m, inner) => {
        const lines = normalizeMarkdownWhitespace(inner)
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (!lines.length) return "";
        return `\n\n${lines.map((line) => `> ${line}`).join("\n")}\n\n`;
      }
    );
  }
  return result;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function extractAttributeValue(html: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}="([^"]+)"`, "i").exec(html);
  return match?.[1] || null;
}

function normalizeLinkUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl, "https://linux.do").toString();
  } catch {
    return rawUrl;
  }
}

function extractHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl, "https://linux.do").hostname.replace(/^www\./i, "");
  } catch {
    return rawUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0] || rawUrl;
  }
}

function textFromInlineHtml(html: string): string {
  return decodeHtmlEntities(stripTags(html))
    .replace(/\s+/g, " ")
    .trim();
}

function convertOneboxToMarkdown(html: string): string {
  const normalizedHtml = html.replace(/\n+/g, " ");
  const headingLinkMatch = /<h[1-6][^>]*>\s*<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h[1-6]>/i.exec(normalizedHtml);
  const sourceLinkMatch = /<header\b[^>]*class="[^"]*\bsource\b[^"]*"[\s\S]*?<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(normalizedHtml);
  const href = normalizeLinkUrl(headingLinkMatch?.[1] || sourceLinkMatch?.[1] || "");
  const title = (() => {
    const text = textFromInlineHtml(headingLinkMatch?.[2] || sourceLinkMatch?.[2] || "");
    return text || href;
  })();
  const sourceHost = href ? extractHostname(href) : "";

  const text = decodeHtmlEntities(
    normalizedHtml
      .replace(/<img[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<h[1-6][^>]*>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  const uniqueLines: string[] = [];
  for (const line of text) {
    if (title && line === title) continue;
    if (href && line === href) continue;
    if (sourceHost && line.replace(/^www\./i, "").toLowerCase() === sourceHost.toLowerCase()) continue;
    if (uniqueLines[uniqueLines.length - 1] === line) continue;
    uniqueLines.push(line);
  }
  const summary = uniqueLines
    .slice(0, 2)
    .join(" ")
    .replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "")
    .trim();
  const header = href ? `> 预览: [${title}](${href})` : `> 预览: ${title}`;
  return summary ? `${header}\n> ${summary}\n\n` : `${header}\n\n`;
}

function shouldDropAnchorLink(anchorHtml: string, normalizedHref: string, text: string): boolean {
  const className = extractAttributeValue(anchorHtml, "class") || "";
  if (/\banchor\b/i.test(className)) {
    return true;
  }
  if (text) {
    return false;
  }
  if (/^https?:\/\/linux\.do\/#/.test(normalizedHref)) {
    return true;
  }
  return false;
}

function convertTableToMarkdown(tableHtml: string): string {
  const rows: string[][] = [];
  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRegex = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      const cellText = textFromInlineHtml(cellMatch[2]);
      cells.push(cellText);
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return "\n";

  const lines = rows.map((cells) => `| ${cells.join(" | ")} |`);
  const firstRowHasHeader = /<th\b/i.test(rows.length > 0 ? tableHtml.split(/<\/tr>/i)[0] || "" : "");
  if (firstRowHasHeader && rows[0].length > 0) {
    lines.splice(1, 0, `| ${rows[0].map(() => "---").join(" | ")} |`);
  }

  return `\n\n[TABLE]\n${lines.join("\n")}\n[/TABLE]\n\n`;
}

function extractTopLevelListItems(innerHtml: string): string[] {
  const items: string[] = [];
  const openLiRegex = /<li\b[^>]*>/gi;
  let openMatch: RegExpExecArray | null;

  while ((openMatch = openLiRegex.exec(innerHtml)) !== null) {
    const contentStart = openMatch.index + openMatch[0].length;
    const closeLiRegex = /<\/?li\b[^>]*>/gi;
    closeLiRegex.lastIndex = contentStart;
    let depth = 1;
    let closeMatch: RegExpExecArray | null;

    while ((closeMatch = closeLiRegex.exec(innerHtml)) !== null) {
      if (/^<\/li/i.test(closeMatch[0])) {
        depth -= 1;
      } else {
        depth += 1;
      }
      if (depth === 0) {
        items.push(innerHtml.slice(contentStart, closeMatch.index));
        openLiRegex.lastIndex = closeLiRegex.lastIndex;
        break;
      }
    }
  }

  return items;
}

function findMatchingListBlockEnd(html: string, startIndex: number, openTagLength: number): number {
  const listRegex = /<\/?(ol|ul)\b[^>]*>/gi;
  listRegex.lastIndex = startIndex + openTagLength;
  let depth = 1;
  let match: RegExpExecArray | null;

  while ((match = listRegex.exec(html)) !== null) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth === 0) {
      return listRegex.lastIndex;
    }
  }

  return html.length;
}

function convertListBlocksToMarkdown(html: string): string {
  const listRegex = /<(ol|ul)\b[^>]*>/gi;
  let result = "";
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = listRegex.exec(html)) !== null) {
    result += html.slice(cursor, match.index);
    const blockEnd = findMatchingListBlockEnd(html, match.index, match[0].length);
    const blockHtml = html.slice(match.index, blockEnd);
    const lines = renderListBlockMarkdown(blockHtml);
    result += lines.length > 0 ? `\n${lines.join("\n")}\n` : "\n";
    cursor = blockEnd;
    listRegex.lastIndex = blockEnd;
  }

  result += html.slice(cursor);
  return result;
}

function splitItemIntoListAwareSegments(itemHtml: string): Array<{ type: "html" | "list"; value: string }> {
  const segments: Array<{ type: "html" | "list"; value: string }> = [];
  const listRegex = /<(ol|ul)\b[^>]*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = listRegex.exec(itemHtml)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: "html", value: itemHtml.slice(cursor, match.index) });
    }
    const blockEnd = findMatchingListBlockEnd(itemHtml, match.index, match[0].length);
    segments.push({ type: "list", value: itemHtml.slice(match.index, blockEnd) });
    cursor = blockEnd;
    listRegex.lastIndex = blockEnd;
  }

  if (cursor < itemHtml.length) {
    segments.push({ type: "html", value: itemHtml.slice(cursor) });
  }

  return segments;
}

function splitHtmlIntoTelegraphSegments(html: string): Array<{ type: "html" | "block"; value: string }> {
  const segments: Array<{ type: "html" | "block"; value: string }> = [];
  const blockRegex = /<(table|details|pre|blockquote|ul|ol)\b[^>]*>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    if (match.index > cursor) {
      segments.push({ type: "html", value: html.slice(cursor, match.index) });
    }
    const blockEnd = findMatchingTagEnd(html, match.index, match[1]);
    segments.push({ type: "block", value: html.slice(match.index, blockEnd) });
    cursor = blockEnd;
    blockRegex.lastIndex = blockEnd;
  }

  if (cursor < html.length) {
    segments.push({ type: "html", value: html.slice(cursor) });
  }

  return segments;
}

function renderListBlockMarkdown(listBlockHtml: string, indentLevel = 0): string[] {
  const ordered = /^<ol\b/i.test(listBlockHtml);
  const innerHtml = listBlockHtml.replace(/^<(?:ol|ul)\b[^>]*>/i, "").replace(/<\/(?:ol|ul)>$/i, "");
  const items = extractTopLevelListItems(innerHtml);
  const lines: string[] = [];

  items.forEach((itemHtml, index) => {
    const segments = splitItemIntoListAwareSegments(itemHtml);
    const textParts: string[] = [];
    const continuationLines: string[] = [];
    const childBlocks: string[] = [];

    for (const segment of segments) {
      if (segment.type === "html") {
        const lines = normalizeMarkdownWhitespace(convertCookedToMarkdown(segment.value))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (lines.length > 0) {
          if (textParts.length === 0) {
            textParts.push(lines[0]);
            continuationLines.push(...lines.slice(1));
          } else {
            continuationLines.push(...lines);
          }
        }
      } else {
        childBlocks.push(segment.value);
      }
    }

    const prefix = ordered ? `${index + 1}. ` : "- ";
    const line = `${"   ".repeat(indentLevel)}${prefix}${textParts.join(" ").trim()}`.trimEnd();
    if (line.trim()) {
      lines.push(line);
    }
    for (const continuationLine of continuationLines) {
      lines.push(`${"   ".repeat(indentLevel + 1)}${continuationLine}`);
    }
    for (const childBlock of childBlocks) {
      lines.push(...renderListBlockMarkdown(childBlock, indentLevel + 1));
    }
  });

  return lines;
}

function flattenListItemToInlineText(itemHtml: string): string {
  const lines = renderListBlockMarkdown(`<ul><li>${itemHtml}</li></ul>`);
  const firstLine = lines[0] || "";
  return firstLine.replace(/^- /, "").trim();
}

function convertOrderedListToMarkdown(innerHtml: string): string {
  const lines = renderListBlockMarkdown(`<ol>${innerHtml}</ol>`);
  if (lines.length === 0) return "\n";
  return `\n${lines.join("\n")}\n`;
}

function convertDetailsToMarkdown(innerHtml: string): string {
  const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(innerHtml);
  const summary = summaryMatch ? textFromInlineHtml(summaryMatch[1]) : "展开内容";
  const bodyHtml = summaryMatch ? innerHtml.replace(summaryMatch[0], "") : innerHtml;
  const bodyMarkdown = convertCookedToMarkdown(bodyHtml);
  return bodyMarkdown
    ? `\n\n[DETAILS] ${summary}\n${bodyMarkdown}\n[/DETAILS]\n\n`
    : `\n\n[DETAILS] ${summary}\n[/DETAILS]\n\n`;
}

function convertCookedToMarkdown(html: string): string {
  const seen = new Set<string>();
  const text = convertListBlocksToMarkdown(
    html
    .replace(/\r\n?/g, "\n")
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => convertTableToMarkdown(table))
    .replace(
      /<(?:aside|article)\b[^>]*\b(?:onebox|quote-onebox)\b[^>]*>[\s\S]*?<\/(?:aside|article)>/gi,
      (block) => convertOneboxToMarkdown(block)
    )
    .replace(
      /<details\b[^>]*>([\s\S]*?)<\/details>/gi,
      (_m, inner) => convertDetailsToMarkdown(inner)
    )
  )
    .replace(
      /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
      (_m, code) => {
        const decodedCode = decodeHtmlEntities(stripTags(code)).replace(/\n+$/g, "");
        return decodedCode ? `\n\n\`\`\`\n${decodedCode}\n\`\`\`\n\n` : "\n";
      }
    )
    .replace(
      /<a\b[^>]*\blightbox\b[^>]*\shref="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi,
      (_m, href) => renderMarkdownImage(href, seen)
    )
    .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, (_m, src) => renderMarkdownImage(src, seen))
    .replace(/<blockquote[^>]*>/gi, "\n\n[QUOTE]\n")
    .replace(/<\/blockquote>/gi, "\n[/QUOTE]\n\n")
    .replace(/<h([1-6])[^>]*>/gi, (_m, level) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<hr[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<ul[^>]*>|<ol[^>]*>/gi, "\n")
    .replace(/<\/ul>|<\/ol>/gi, "\n")
    .replace(
      /<a\b[^>]*\bclass="[^"]*\bmention\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
      (anchor, inner) => {
        const original = extractAttributeValue(anchor, "data-original-mention");
        const text = textFromInlineHtml(inner);
        if (original) return `@${original}`;
        return text || "@unknown";
      }
    )
    .replace(
      /<a\b[^>]*\bclass="[^"]*\b(?:mention-group|hashtag-cooked)\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi,
      (_anchor, inner) => textFromInlineHtml(inner)
    )
    .replace(
      /<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      (anchorHtml, href, inner) => {
        const text = textFromInlineHtml(inner);
        const normalizedHref = normalizeLinkUrl(href);
        if (shouldDropAnchorLink(anchorHtml, normalizedHref, text)) return "";
        if (!text) return normalizedHref;
        return `[${text}](${normalizedHref})`;
      }
    )
    .replace(/<(?:strong|b)[^>]*>/gi, "**")
    .replace(/<\/(?:strong|b)>/gi, "**")
    .replace(/<(?:em|i)[^>]*>/gi, "*")
    .replace(/<\/(?:em|i)>/gi, "*")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, code) => {
      const text = textFromInlineHtml(code);
      return text ? `\`${text}\`` : "";
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<div[^>]*>/gi, "\n")
    .replace(/<p[^>]*>|<span[^>]*>|<\/span>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\b\w*\d+×\d+\s+[\d.]+\s*[KMG]?B\b/gi, "");

  return normalizeMarkdownWhitespace(convertQuoteMarkersToMarkdown(decodeHtmlEntities(text)));
}

function stripMarkdownForTelegram(markdown: string): string {
  let markerIndex = 0;
  return normalizeMarkdownWhitespace(
    markdown
      .replace(/^\[DETAILS\]\s*(.+)$/gm, "【展开】 $1")
      .replace(/^\[\/DETAILS\]$/gm, "")
      .replace(/^\[TABLE\]$/gm, "【表格】")
      .replace(/^\[\/TABLE\]$/gm, "")
      .replace(/^!\[[^\]]*]\([^)]+\)$/gm, () => `[IMG#${++markerIndex}]`)
      .replace(/!\[[^\]]*]\([^)]+\)/g, () => `[IMG#${++markerIndex}]`)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^---$/gm, "")
      .replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => `\n${code.trim()}\n`)
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*\n]+)\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/_(.+?)_/g, "$1")
  );
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

function findMatchingTagEnd(html: string, startIndex: number, tagName: string): number {
  const tagRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tagRegex.lastIndex = startIndex;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    if (/^<\//.test(match[0])) {
      depth -= 1;
    } else {
      depth += 1;
    }
    if (depth === 0) {
      return tagRegex.lastIndex;
    }
  }

  return html.length;
}

function stripOuterTag(blockHtml: string, tagName: string): string {
  return blockHtml
    .replace(new RegExp(`^<${tagName}\\b[^>]*>`, "i"), "")
    .replace(new RegExp(`</${tagName}>$`, "i"), "");
}

function buildInlineChildrenFromMarkdown(markdown: string): TelegraphNode[] {
  const cleanedMarkdown = markdown
    // Remove dangling strong markers leaked from imperfect HTML->Markdown conversion.
    .replace(/\*\*(?=\s|$|[.,!?;:，。！？；：、)\]}>»”])/g, "")
    .replace(/(^|[\s([{<“‘«])\*\*/g, "$1");

  const lines = normalizeMarkdownWhitespace(cleanedMarkdown)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const children: TelegraphNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      children.push({ tag: "br" });
    }
    children.push(...parseInlineMarkdown(line));
  });
  return children;
}

function buildInlineChildrenFromHtml(html: string): TelegraphNode[] {
  return buildInlineChildrenFromMarkdown(convertCookedToMarkdown(html));
}

async function loadTelegraphTableFont(): Promise<Uint8Array> {
  if (telegraphTableFontCache) return telegraphTableFontCache;
  const response = await fetch(TELEGRAPH_TABLE_FONT_URL);
  if (!response.ok) {
    throw new Error(`table font fetch failed: ${response.status}`);
  }
  telegraphTableFontCache = new Uint8Array(await response.arrayBuffer());
  return telegraphTableFontCache;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isWide(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

function isEmojiCp(code: number): boolean {
  return (
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    code === 0x200d
  );
}

function tableCharWidth(char: string, fontSize: number): number {
  const code = char.codePointAt(0) || 0;
  if (isWide(code)) return fontSize;
  if (isEmojiCp(code)) return fontSize * 1.2;
  return fontSize * 0.56;
}

function measureTableText(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    width += tableCharWidth(char, fontSize);
  }
  return width;
}

function wrapTableCellText(text: string, maxWidth: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [""];

  const lines: string[] = [];
  for (const paragraph of normalized.split("\n")) {
    let line = "";
    let lineWidth = 0;
    for (const char of paragraph) {
      const charWidth = tableCharWidth(char, TELEGRAPH_TABLE_FONT_SIZE);
      if (line && lineWidth + charWidth > maxWidth) {
        lines.push(line);
        line = char;
        lineWidth = charWidth;
        continue;
      }
      line += char;
      lineWidth += charWidth;
    }
    lines.push(line || "");
  }
  return lines.length > 0 ? lines : [""];
}

function splitMarkdownSpecialSegments(text: string): Array<{ type: "text" | "table" | "image"; value: string }> {
  const segments: Array<{ type: "text" | "table" | "image"; value: string }> = [];
  const pattern = /\[TABLE\]\s*([\s\S]*?)\s*\[\/TABLE\]|!\[[^\]]*]\((https?:\/\/[^\s)]+)\)/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const before = normalizeMarkdownWhitespace(text.slice(cursor, match.index));
    if (before) {
      segments.push({ type: "text", value: before });
    }

    if (match[1]) {
      const tableText = match[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("\n");
      if (tableText) {
        segments.push({ type: "table", value: tableText });
      }
    } else if (match[2]) {
      segments.push({ type: "image", value: match[2] });
    }

    cursor = match.index + match[0].length;
  }

  const rest = normalizeMarkdownWhitespace(text.slice(cursor));
  if (rest) {
    segments.push({ type: "text", value: rest });
  }
  return segments;
}

function extractTableTextFromMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "[TABLE]" && line !== "[/TABLE]")
    .join("\n");
}

function splitMarkdownTableLine(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isMarkdownSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTable(tableText: string): ParsedMarkdownTable | null {
  const rawRows = tableText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes("|"))
    .map((line) => splitMarkdownTableLine(line))
    .filter((cells) => cells.length > 0);

  if (rawRows.length === 0) return null;

  let headerRowIndex: number | null = null;
  const rows = rawRows.map((cells) => [...cells]);
  if (rows.length > 1 && isMarkdownSeparatorRow(rows[1])) {
    rows.splice(1, 1);
    headerRowIndex = 0;
  }

  const columnCount = rows.reduce((max, cells) => Math.max(max, cells.length), 0);
  if (columnCount === 0) return null;

  const normalizedRows = rows.map((cells) => {
    const padded = [...cells];
    while (padded.length < columnCount) padded.push("");
    return padded.slice(0, columnCount);
  });

  return {
    rows: normalizedRows,
    headerRowIndex,
    columnCount,
  };
}

function buildPlainTableTelegraphNode(tableText: string): TelegraphNode | null {
  const normalized = tableText
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");
  if (!normalized) return null;
  return { tag: "pre", children: [normalized] };
}

function clampTableWidths(preferredWidths: number[], columnCount: number): number[] {
  const minWidth = Math.max(
    72,
    Math.min(TELEGRAPH_TABLE_MIN_COL_WIDTH, Math.floor(TELEGRAPH_TABLE_MAX_WIDTH / Math.max(columnCount, 1)) - 8)
  );
  const widths = preferredWidths.map((width) => Math.max(minWidth, Math.min(TELEGRAPH_TABLE_MAX_COL_WIDTH, width)));
  let totalWidth = widths.reduce((sum, width) => sum + width, 0);
  if (totalWidth <= TELEGRAPH_TABLE_MAX_WIDTH) {
    return widths;
  }

  for (let guard = 0; guard < 8 && totalWidth > TELEGRAPH_TABLE_MAX_WIDTH; guard += 1) {
    const shrinkable = widths
      .map((width, index) => ({ width, index, capacity: width - minWidth }))
      .filter((item) => item.capacity > 0);
    if (shrinkable.length === 0) break;

    const excess = totalWidth - TELEGRAPH_TABLE_MAX_WIDTH;
    const shrinkCapacity = shrinkable.reduce((sum, item) => sum + item.capacity, 0);
    for (const item of shrinkable) {
      const share = Math.ceil(excess * (item.capacity / shrinkCapacity));
      widths[item.index] = Math.max(minWidth, widths[item.index] - share);
    }
    totalWidth = widths.reduce((sum, width) => sum + width, 0);
  }

  return widths;
}

function renderTableSvg(table: ParsedMarkdownTable): { svg: string; width: number } {
  const preferredWidths = Array.from({ length: table.columnCount }, (_, columnIndex) => {
    const maxTextWidth = table.rows.reduce((max, row) => {
      const cellText = row[columnIndex] || "";
      return Math.max(max, measureTableText(cellText || " ", TELEGRAPH_TABLE_FONT_SIZE));
    }, 0);
    return Math.ceil(maxTextWidth + TELEGRAPH_TABLE_CELL_PAD_X * 2);
  });
  const columnWidths = clampTableWidths(preferredWidths, table.columnCount);

  const wrappedRows = table.rows.map((row) =>
    row.map((cell, columnIndex) => {
      const availableWidth = Math.max(32, columnWidths[columnIndex] - TELEGRAPH_TABLE_CELL_PAD_X * 2);
      return wrapTableCellText(cell, availableWidth);
    })
  );

  const rowHeights = wrappedRows.map((row) => {
    const maxLines = row.reduce((max, cellLines) => Math.max(max, cellLines.length), 1);
    return Math.max(
      TELEGRAPH_TABLE_FONT_SIZE + TELEGRAPH_TABLE_CELL_PAD_Y * 2,
      maxLines * TELEGRAPH_TABLE_LINE_HEIGHT + TELEGRAPH_TABLE_CELL_PAD_Y * 2
    );
  });

  const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0);
  const tableHeight = rowHeights.reduce((sum, height) => sum + height, 0);
  const fontFamily = `${escapeXml(TELEGRAPH_TABLE_FONT_FAMILY)}, sans-serif`;

  let currentY = 0;
  const body: string[] = [
    `<rect x="0" y="0" width="${tableWidth}" height="${tableHeight}" rx="16" fill="#FFFFFF"/>`,
  ];

  table.rows.forEach((row, rowIndex) => {
    const rowHeight = rowHeights[rowIndex];
    let currentX = 0;
    const isHeader = table.headerRowIndex === rowIndex;

    row.forEach((_cell, columnIndex) => {
      const columnWidth = columnWidths[columnIndex];
      const fill = isHeader ? "#E8F1FF" : rowIndex % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
      body.push(
        `<rect x="${currentX}" y="${currentY}" width="${columnWidth}" height="${rowHeight}" fill="${fill}" stroke="#D6DEE8" stroke-width="1"/>`
      );

      const lines = wrappedRows[rowIndex][columnIndex];
      lines.forEach((line, lineIndex) => {
        const baselineY = currentY + TELEGRAPH_TABLE_CELL_PAD_Y + TELEGRAPH_TABLE_FONT_SIZE + lineIndex * TELEGRAPH_TABLE_LINE_HEIGHT;
        body.push(
          `<text x="${currentX + TELEGRAPH_TABLE_CELL_PAD_X}" y="${baselineY}" font-size="${TELEGRAPH_TABLE_FONT_SIZE}" font-family="${fontFamily}" font-weight="${isHeader ? 600 : 500}" fill="#16202A">${escapeXml(line)}</text>`
        );
      });

      currentX += columnWidth;
    });

    currentY += rowHeight;
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tableWidth}" height="${tableHeight}" viewBox="0 0 ${tableWidth} ${tableHeight}">${body.join("")}</svg>`;
  return { svg, width: tableWidth };
}

async function renderSvgToPng(svg: string, width: number): Promise<Uint8Array> {
  const fontData = await loadTelegraphTableFont();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      fontBuffers: [fontData],
      defaultFontFamily: TELEGRAPH_TABLE_FONT_FAMILY,
    },
  });
  const rendered = resvg.render();
  return rendered.asPng();
}

async function uploadTelegraphImage(png: Uint8Array): Promise<string | null> {
  const formData = new FormData();
  formData.append("file", new Blob([png], { type: "image/png" }), `linuxdo-table-${Date.now()}.png`);

  const response = await fetch("https://telegra.ph/upload", {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    const text = await response.text();
    console.error(`[linuxdo] telegraph upload status=${response.status} body=${text.slice(0, 300)}`);
    return null;
  }

  const data = await response.json() as TelegraphUploadResponseItem[] | TelegraphUploadResponseItem;
  if (Array.isArray(data) && data[0]?.src) {
    return `https://telegra.ph${data[0].src}`;
  }
  if (!Array.isArray(data) && data.src) {
    return `https://telegra.ph${data.src}`;
  }

  console.error("[linuxdo] telegraph upload invalid response:", JSON.stringify(data).slice(0, 300));
  return null;
}

async function buildTableTelegraphNodeFromText(tableText: string): Promise<TelegraphNode | null> {
  const fallbackNode = buildPlainTableTelegraphNode(tableText);
  if (!fallbackNode) return null;

  const parsedTable = parseMarkdownTable(tableText);
  if (!parsedTable) return fallbackNode;

  try {
    const { svg, width } = renderTableSvg(parsedTable);
    const png = await renderSvgToPng(svg, width);
    const uploadedUrl = await uploadTelegraphImage(png);
    if (uploadedUrl) {
      return { tag: "figure", children: [{ tag: "img", attrs: { src: uploadedUrl } }] };
    }
  } catch (error) {
    console.error("[linuxdo] table render/upload failed:", error);
  }

  return fallbackNode;
}

function buildFigureTelegraphNodeFromUrl(rawUrl: string): TelegraphNode | null {
  const imageUrl = normalizeLinuxdoImageUrl(rawUrl);
  if (!imageUrl || !isValidPostImageUrl(imageUrl)) {
    return null;
  }
  return { tag: "figure", children: [{ tag: "img", attrs: { src: imageUrl } }] };
}

async function buildMarkdownBlockTelegraphNodes(markdown: string, textTag: "p" | "h3" | "h4"): Promise<TelegraphNode[]> {
  const segments = splitMarkdownSpecialSegments(markdown);
  if (segments.length === 0) {
    const children = buildInlineChildrenFromMarkdown(markdown);
    return children.length > 0 ? [{ tag: textTag, children }] : [];
  }

  const nodes: TelegraphNode[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      const children = buildInlineChildrenFromMarkdown(segment.value);
      if (children.length > 0) {
        nodes.push({ tag: textTag, children });
      }
      continue;
    }

    if (segment.type === "table") {
      const tableNode = await buildTableTelegraphNodeFromText(segment.value);
      if (tableNode) {
        nodes.push(tableNode);
      }
      continue;
    }

    const figureNode = buildFigureTelegraphNodeFromUrl(segment.value);
    if (figureNode) {
      nodes.push(figureNode);
    }
  }
  return nodes;
}

function buildOneboxTelegraphNodes(html: string): TelegraphNode[] {
  const normalizedHtml = html.replace(/\n+/g, " ");
  const headingLinkMatch = /<h[1-6][^>]*>\s*<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h[1-6]>/i.exec(normalizedHtml);
  const sourceLinkMatch = /<header\b[^>]*class="[^"]*\bsource\b[^"]*"[\s\S]*?<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(normalizedHtml);
  const href = normalizeLinkUrl(headingLinkMatch?.[1] || sourceLinkMatch?.[1] || "");
  const title = textFromInlineHtml(headingLinkMatch?.[2] || sourceLinkMatch?.[2] || "") || href;
  const sourceHost = href ? extractHostname(href) : "";

  const textLines = decodeHtmlEntities(
    normalizedHtml
      .replace(/<img[^>]*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<h[1-6][^>]*>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .filter((line, index, array) => {
      if (line === title || line === href) return false;
      if (sourceHost && line.replace(/^www\./i, "").toLowerCase() === sourceHost.toLowerCase()) return false;
      return array.indexOf(line) === index;
    });

  const summary = textLines
    .slice(0, 2)
    .join(" ")
    .replace(new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "")
    .trim();

  const nodes: TelegraphNode[] = [];
  if (href && title) {
    nodes.push({
      tag: "p",
      children: ["预览: ", { tag: "a", attrs: { href }, children: [title] }],
    });
  } else if (title) {
    nodes.push({ tag: "p", children: [title] });
  }
  if (summary) {
    nodes.push({ tag: "blockquote", children: buildInlineChildrenFromMarkdown(summary) });
  }
  return nodes;
}

async function buildTableTelegraphNode(tableHtml: string): Promise<TelegraphNode | null> {
  const markdown = convertTableToMarkdown(tableHtml);
  const tableText = extractTableTextFromMarkdown(markdown);
  return buildTableTelegraphNodeFromText(tableText);
}

function trimTelegraphBreaks(nodes: TelegraphNode[]): TelegraphNode[] {
  const trimmed = [...nodes];
  while (trimmed.length > 0) {
    const first = trimmed[0];
    if (!isTelegraphElement(first) || first.tag !== "br") break;
    trimmed.shift();
  }
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (!isTelegraphElement(last) || last.tag !== "br") break;
    trimmed.pop();
  }
  return trimmed;
}

function cloneTelegraphNode(node: TelegraphNode): TelegraphNode {
  if (typeof node === "string") return node;
  return {
    tag: node.tag,
    attrs: node.attrs ? { ...node.attrs } : undefined,
    children: node.children ? node.children.map((child) => cloneTelegraphNode(child)) : undefined,
  };
}

function flattenListNodeToParagraphNodes(listNode: Exclude<TelegraphNode, string>, baseIndentLevel = 1): TelegraphNode[] {
  const html = `<${listNode.tag}>${(listNode.children || []).map((child) => telegraphNodeToHtml(child)).join("")}</${listNode.tag}>`;
  return buildFlattenedNestedListParagraphNodes(html, baseIndentLevel);
}

function telegraphNodeToHtml(node: TelegraphNode): string {
  if (typeof node === "string") {
    return escapeXml(node);
  }

  const attrs = Object.entries(node.attrs || {})
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
  const children = (node.children || []).map((child) => telegraphNodeToHtml(child)).join("");
  return `<${node.tag}${attrs}>${children}</${node.tag}>`;
}

function appendTelegraphChildrenWithBreak(target: TelegraphNode[], nodes: TelegraphNode[]): void {
  const trimmed = trimTelegraphBreaks(nodes);
  if (trimmed.length === 0) return;
  const last = target[target.length - 1];
  if (target.length > 0 && (!isTelegraphElement(last) || last.tag !== "br")) {
    target.push({ tag: "br" });
  }
  target.push(...trimmed);
}

function mergeSequentialListNodes(nodes: TelegraphNode[]): TelegraphNode[] {
  const merged: TelegraphNode[] = [];

  for (const node of nodes) {
    const current = cloneTelegraphNode(node);
    const last = merged[merged.length - 1];
    const middle = merged[merged.length - 2];

    if (
      isTelegraphElement(current) &&
      current.tag === "ol" &&
      isTelegraphElement(last) &&
      last.tag === "ul" &&
      isTelegraphElement(middle) &&
      middle.tag === "ol"
    ) {
      const previousItems = middle.children || [];
      const lastItem = previousItems[previousItems.length - 1];
      if (isTelegraphElement(lastItem) && lastItem.tag === "li") {
        const listInlineNodes = flattenListNodeToParagraphNodes(last, 1);
        const itemChildren = [...(lastItem.children || [])];
        appendTelegraphChildrenWithBreak(itemChildren, listInlineNodes);
        lastItem.children = itemChildren;
        middle.children = [...previousItems, ...(current.children || [])];
        merged.pop();
        continue;
      }
    }

    if (
      isTelegraphElement(current) &&
      isTelegraphElement(last) &&
      current.tag === "ol" &&
      last.tag === "ol"
    ) {
      last.children = [...(last.children || []), ...(current.children || [])];
      continue;
    }

    if (
      isTelegraphElement(current) &&
      isTelegraphElement(last) &&
      current.tag === "ul" &&
      last.tag === "ul"
    ) {
      last.children = [...(last.children || []), ...(current.children || [])];
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function buildFlattenedNestedListParagraphNodes(listHtml: string, baseIndentLevel = 1): TelegraphNode[] {
  const lines = renderListBlockMarkdown(listHtml, baseIndentLevel);
  const nodes: TelegraphNode[] = [];

  lines.forEach((line, index) => {
    const match = /^(\s*)(-\s+|\d+\.\s+)(.*)$/.exec(line);
    if (!match) {
      const children = trimTelegraphBreaks(buildInlineChildrenFromMarkdown(line.trim()));
      if (children.length > 0) {
        if (index > 0) {
          nodes.push({ tag: "br" });
        }
        nodes.push(...children);
      }
      return;
    }

    const indentLevel = Math.floor(match[1].length / 3);
    const marker = match[2];
    const content = match[3].trim();
    const indentPrefix = "\u00A0\u00A0".repeat(indentLevel);
    const bulletPrefix = marker.startsWith("-") ? `${indentPrefix}• ` : `${indentPrefix}${marker}`;
    if (index > 0) {
      nodes.push({ tag: "br" });
    }
    nodes.push(bulletPrefix, ...parseInlineMarkdown(content));
  });

  return trimTelegraphBreaks(nodes);
}

async function buildListItemTelegraphChildren(itemHtml: string): Promise<TelegraphNode[]> {
  const segments = splitItemIntoListAwareSegments(itemHtml);
  const children: TelegraphNode[] = [];
  const inlineParts: TelegraphNode[][] = [];
  let hasBlockChild = false;

  const pushInlinePart = (nodes: TelegraphNode[]) => {
    const trimmed = trimTelegraphBreaks(nodes);
    if (trimmed.length > 0) {
      inlineParts.push(trimmed);
    }
  };

  const flushInlineParts = () => {
    if (inlineParts.length === 0) return;

    if (hasBlockChild) {
      for (const part of inlineParts) {
        children.push({ tag: "p", children: part });
      }
    } else {
      inlineParts.forEach((part, index) => {
        if (index > 0) {
          children.push({ tag: "br" });
        }
        children.push(...part);
      });
    }
    inlineParts.length = 0;
  };

  for (const segment of segments) {
    if (segment.type === "list") {
      hasBlockChild = true;
      flushInlineParts();
      children.push(...buildFlattenedNestedListParagraphNodes(segment.value));
      continue;
    }

    const htmlSegments = splitHtmlIntoTelegraphSegments(segment.value);
    for (const htmlSegment of htmlSegments) {
      if (htmlSegment.type === "block") {
        hasBlockChild = true;
        flushInlineParts();
        const blockNodes = await buildTelegraphNodesFromCookedHtml(htmlSegment.value);
        for (const blockNode of blockNodes) {
          children.push(blockNode);
        }
        continue;
      }

      const inlineChildren = buildInlineChildrenFromHtml(htmlSegment.value);
      if (inlineChildren.length > 0) {
        pushInlinePart(inlineChildren);
      }
    }
  }

  flushInlineParts();
  return trimTelegraphBreaks(children);
}

async function buildListTelegraphNode(listHtml: string): Promise<TelegraphNode | null> {
  const ordered = /^<ol\b/i.test(listHtml);
  const innerHtml = listHtml.replace(/^<(?:ol|ul)\b[^>]*>/i, "").replace(/<\/(?:ol|ul)>$/i, "");
  const itemHtmls = extractTopLevelListItems(innerHtml);
  const items: TelegraphNode[] = [];

  for (const itemHtml of itemHtmls) {
    const children = await buildListItemTelegraphChildren(itemHtml);
    if (children.length > 0) {
      items.push({ tag: "li", children });
    }
  }

  if (items.length === 0) return null;
  return { tag: ordered ? "ol" : "ul", children: items };
}

function findNextCookedBlockStart(html: string, fromIndex: number): number {
  const pattern = /<(?:aside\b[^>]*\b(?:onebox|quote-onebox)\b|article\b[^>]*\b(?:onebox|quote-onebox)\b|details\b|pre\b|blockquote\b|table\b|ul\b|ol\b|h[1-6]\b|p\b|div\b|a\b[^>]*\blightbox\b|img\b)/gi;
  pattern.lastIndex = fromIndex;
  const match = pattern.exec(html);
  return match ? match.index : -1;
}

async function buildTelegraphNodesFromCookedHtml(html: string): Promise<TelegraphNode[]> {
  const nodes: TelegraphNode[] = [];
  let cursor = 0;
  const source = html.replace(/<a\b[^>]*\bclass="[^"]*\banchor\b[^"]*"[^>]*>\s*<\/a>/gi, "");

  while (cursor < source.length) {
    const remaining = source.slice(cursor);
    if (!remaining.trim()) break;

    const leadingWhitespace = /^\s+/.exec(remaining);
    if (leadingWhitespace) {
      cursor += leadingWhitespace[0].length;
      continue;
    }

    const oneboxStart = /^<(aside|article)\b[^>]*\b(?:onebox|quote-onebox)\b[^>]*>/i.exec(remaining);
    if (oneboxStart) {
      const end = findMatchingTagEnd(source, cursor, oneboxStart[1]);
      nodes.push(...buildOneboxTelegraphNodes(source.slice(cursor, end)));
      cursor = end;
      continue;
    }

    const detailsStart = /^<details\b[^>]*>/i.exec(remaining);
    if (detailsStart) {
      const end = findMatchingTagEnd(source, cursor, "details");
      const block = source.slice(cursor, end);
      const inner = stripOuterTag(block, "details");
      const summaryMatch = /<summary[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
      const summary = textFromInlineHtml(summaryMatch?.[1] || "") || "详情";
      nodes.push({ tag: "p", children: [{ tag: "strong", children: [`展开：${summary}`] }] });
      const bodyHtml = summaryMatch ? inner.replace(summaryMatch[0], "") : inner;
      nodes.push(...await buildTelegraphNodesFromCookedHtml(bodyHtml));
      cursor = end;
      continue;
    }

    const simpleTagMatch = /^<(pre|blockquote|table|ul|ol|h[1-6]|p|div)\b[^>]*>/i.exec(remaining);
    if (simpleTagMatch) {
      const tagName = simpleTagMatch[1].toLowerCase();
      const end = findMatchingTagEnd(source, cursor, tagName);
      const block = source.slice(cursor, end);
      const inner = stripOuterTag(block, tagName);

      if (tagName === "pre") {
        const codeMatch = /<code[^>]*>([\s\S]*?)<\/code>/i.exec(inner);
        const codeText = decodeHtmlEntities(stripTags(codeMatch?.[1] || inner)).trim();
        if (codeText) {
          nodes.push({ tag: "pre", children: [codeText] });
        }
      } else if (tagName === "blockquote") {
        const quoteChildren = await buildTelegraphNodesFromCookedHtml(inner);
        if (quoteChildren.length > 0) {
          nodes.push({ tag: "blockquote", children: quoteChildren });
        }
      } else if (tagName === "table") {
        const tableNode = await buildTableTelegraphNode(block);
        if (tableNode) nodes.push(tableNode);
      } else if (tagName === "ul" || tagName === "ol") {
        const listNode = await buildListTelegraphNode(block);
        if (listNode) nodes.push(listNode);
      } else if (/^h[1-6]$/.test(tagName)) {
        const level = Number(tagName.slice(1));
        const headingMarkdown = convertCookedToMarkdown(inner);
        nodes.push(...await buildMarkdownBlockTelegraphNodes(headingMarkdown, level === 1 ? "h3" : "h4"));
      } else {
        const paragraphMarkdown = convertCookedToMarkdown(inner);
        nodes.push(...await buildMarkdownBlockTelegraphNodes(paragraphMarkdown, "p"));
      }

      cursor = end;
      continue;
    }

    const lightboxStart = /^<a\b[^>]*\blightbox\b[^>]*>/i.exec(remaining);
    if (lightboxStart) {
      const end = findMatchingTagEnd(source, cursor, "a");
      const block = source.slice(cursor, end);
      const href = extractAttributeValue(block, "href");
      const imageUrl = href ? normalizeLinuxdoImageUrl(href) : "";
      if (imageUrl && isValidPostImageUrl(imageUrl)) {
        nodes.push({ tag: "figure", children: [{ tag: "img", attrs: { src: imageUrl } }] });
      }
      cursor = end;
      continue;
    }

    const imageStart = /^<img\b[^>]*src="([^"]+)"[^>]*>/i.exec(remaining);
    if (imageStart) {
      const imageUrl = normalizeLinuxdoImageUrl(imageStart[1]);
      if (isValidPostImageUrl(imageUrl)) {
        nodes.push({ tag: "figure", children: [{ tag: "img", attrs: { src: imageUrl } }] });
      }
      cursor += imageStart[0].length;
      continue;
    }

    if (remaining.startsWith("<")) {
      const nextBlockStart = findNextCookedBlockStart(source, cursor + 1);
      const fragmentEnd = nextBlockStart === -1 ? source.length : nextBlockStart;
      const fragment = source.slice(cursor, fragmentEnd);
      nodes.push(...await buildMarkdownBlockTelegraphNodes(convertCookedToMarkdown(fragment), "p"));
      cursor = fragmentEnd;
      continue;
    }

    const nextBlockStart = findNextCookedBlockStart(source, cursor);
    const fragmentEnd = nextBlockStart === -1 ? source.length : nextBlockStart;
    const fragment = source.slice(cursor, fragmentEnd);
    nodes.push(...await buildMarkdownBlockTelegraphNodes(convertCookedToMarkdown(fragment), "p"));
    cursor = fragmentEnd;
  }

  return nodes;
}

function parseInlineMarkdown(text: string): TelegraphNode[] {
  const source = text;
  const nodes: TelegraphNode[] = [];
  let buffer = "";
  let index = 0;

  const pushBuffer = () => {
    if (buffer) {
      nodes.push(buffer);
      buffer = "";
    }
  };

  while (index < source.length) {
    if (source[index] === "\\" && index + 1 < source.length) {
      buffer += source[index + 1];
      index += 2;
      continue;
    }

    if (source.startsWith("**", index)) {
      const end = source.indexOf("**", index + 2);
      if (end !== -1) {
        pushBuffer();
        const inner = source.slice(index + 2, end);
        nodes.push({ tag: "strong", children: parseInlineMarkdown(inner) });
        index = end + 2;
        continue;
      }
    }

    if (source[index] === "*" && !source.startsWith("**", index)) {
      const end = source.indexOf("*", index + 1);
      if (end !== -1) {
        pushBuffer();
        const inner = source.slice(index + 1, end);
        nodes.push({ tag: "em", children: parseInlineMarkdown(inner) });
        index = end + 1;
        continue;
      }
    }

    if (source[index] === "`") {
      const end = source.indexOf("`", index + 1);
      if (end !== -1) {
        pushBuffer();
        nodes.push({ tag: "code", children: [source.slice(index + 1, end)] });
        index = end + 1;
        continue;
      }
    }

    if (source[index] === "[") {
      const mid = source.indexOf("](", index + 1);
      if (mid !== -1) {
        const end = source.indexOf(")", mid + 2);
        if (end !== -1) {
          pushBuffer();
          const label = source.slice(index + 1, mid);
          const href = source.slice(mid + 2, end);
          nodes.push({ tag: "a", attrs: { href }, children: parseInlineMarkdown(label) });
          index = end + 1;
          continue;
        }
      }
    }

    buffer += source[index];
    index += 1;
  }

  pushBuffer();
  return nodes.length > 0 ? nodes : [text];
}

function getLineIndent(raw: string): number {
  const match = /^ */.exec(raw);
  return match ? match[0].length : 0;
}

function getListLineInfo(raw: string, indent: number): { kind: "ul" | "ol"; text: string } | null {
  if (getLineIndent(raw) !== indent) return null;
  const content = raw.slice(indent);
  if (/^- /.test(content)) {
    return { kind: "ul", text: content.slice(2).trim() };
  }
  const orderedMatch = /^(\d+)\.\s+(.+)$/.exec(content);
  if (orderedMatch) {
    return { kind: "ol", text: orderedMatch[2].trim() };
  }
  return null;
}

function appendContinuationChildren(children: TelegraphNode[], continuationLines: string[]): TelegraphNode[] {
  if (continuationLines.length === 0) return children;
  const nextChildren = [...children];
  for (const continuationLine of continuationLines) {
    nextChildren.push({ tag: "br" });
    nextChildren.push(...parseInlineMarkdown(continuationLine));
  }
  return nextChildren;
}

function parseTelegraphList(lines: string[], startIndex: number, indent: number): { list: TelegraphNode | null; nextIndex: number } {
  let cursor = startIndex;
  const first = getListLineInfo(lines[cursor] || "", indent);
  if (!first) {
    return { list: null, nextIndex: startIndex };
  }

  const listKind = first.kind;
  const items: TelegraphNode[] = [];

  while (cursor < lines.length) {
    const raw = lines[cursor];
    if (!raw.trim()) {
      cursor += 1;
      continue;
    }

    const info = getListLineInfo(raw, indent);
    if (!info || info.kind !== listKind) {
      break;
    }

    let children: TelegraphNode[] = parseInlineMarkdown(info.text);
    cursor += 1;
    const continuationLines: string[] = [];

    while (cursor < lines.length) {
      const nextRaw = lines[cursor];
      if (!nextRaw.trim()) {
        cursor += 1;
        continue;
      }

      const nextIndent = getLineIndent(nextRaw);
      const sameLevelInfo = getListLineInfo(nextRaw, indent);
      if (sameLevelInfo && sameLevelInfo.kind === listKind) {
        break;
      }

      if (nextIndent <= indent) {
        break;
      }

      const nestedList = parseTelegraphList(lines, cursor, nextIndent);
      if (nestedList.list) {
        children = appendContinuationChildren(children, continuationLines);
        continuationLines.length = 0;
        children.push(nestedList.list);
        cursor = nestedList.nextIndex;
        continue;
      }

      continuationLines.push(nextRaw.trim());
      cursor += 1;
    }

    children = appendContinuationChildren(children, continuationLines);
    items.push({ tag: "li", children });
  }

  return {
    list: items.length > 0 ? { tag: listKind, children: items } : null,
    nextIndex: cursor,
  };
}

async function buildTelegraphContent(post: LinuxdoPost, originalUrl: string): Promise<TelegraphNode[]> {
  const nodes: TelegraphNode[] = [];

  nodes.push({ tag: "p", children: [`作者：${post.author || "未知"}`] });
  nodes.push({
    tag: "p",
    children: [{ tag: "a", attrs: { href: originalUrl }, children: ["查看原帖"] }],
  });

  const cookedNodes = await buildTelegraphNodesFromCookedHtml(truncateForTelegraph(post.rawHtml, 40000));
  nodes.push(...mergeSequentialListNodes(cookedNodes));

  return nodes;
}

async function createTelegraphPage(post: LinuxdoPost, originalUrl: string, env: Env): Promise<string | null> {
  const accessToken = env.TELEGRAPH_ACCESS_TOKEN;
  if (!accessToken) return null;
  const content = await buildTelegraphContent(post, originalUrl);

  const body = new URLSearchParams({
    access_token: accessToken,
    title: truncateForTelegraph(post.title?.trim() || "Linux.do", 256),
    author_name: "TeleDigest",
    content: JSON.stringify(content),
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

