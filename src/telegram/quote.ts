/**
 * 消息截图模块：回复消息时生成 Telegram 风格透明贴纸
 * 使用 Twemoji SVG 内联渲染 Emoji，确保跨平台显示一致
 */
import { Resvg } from "@cf-wasm/resvg";
import type { Env, TelegramMessage, TelegramUser } from "../types";
import {
  getUserAvatarFileId,
  downloadTelegramFile,
  sendSticker,
  sendPhoto,
  sendMessage,
  telegramApi,
} from "./api";

/* ── 字体 ── */
const FONT_URL =
  "https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-sc@latest/chinese-simplified-500-normal.ttf";

let fontCache: Uint8Array | null = null;

async function loadFont(): Promise<Uint8Array> {
  if (fontCache) return fontCache;
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error(`Font fetch failed: ${res.status}`);
  fontCache = new Uint8Array(await res.arrayBuffer());
  return fontCache;
}

/* ── Twemoji 内联渲染 ── */
const TWEMOJI_BASE =
  "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/";
const emojiSvgCache = new Map<string, string | null>();

function emojiToTwemojiCode(emoji: string): string {
  return [...emoji]
    .map((c) => c.codePointAt(0)!)
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16))
    .join("-");
}

async function fetchEmojiDataUri(emoji: string): Promise<string | null> {
  const code = emojiToTwemojiCode(emoji);
  if (emojiSvgCache.has(code)) return emojiSvgCache.get(code)!;
  try {
    const res = await fetch(`${TWEMOJI_BASE}${code}.svg`);
    if (!res.ok) {
      emojiSvgCache.set(code, null);
      return null;
    }
    const svgText = await res.text();
    const b64 = btoa(svgText);
    emojiSvgCache.set(code, `data:image/svg+xml;base64,${b64}`);
    return emojiSvgCache.get(code)!;
  } catch {
    emojiSvgCache.set(code, null);
    return null;
  }
}

/** 预取文本中所有 emoji 的 Twemoji SVG */
const EMOJI_REGEX =
  /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

async function prefetchEmojis(text: string): Promise<Map<string, string>> {
  const unique = new Set<string>();
  for (const m of text.matchAll(EMOJI_REGEX)) unique.add(m[0]);
  const map = new Map<string, string>();
  await Promise.all(
    [...unique].map(async (emoji) => {
      const uri = await fetchEmojiDataUri(emoji);
      if (uri) map.set(emoji, uri);
    }),
  );
  return map;
}

type Segment =
  | { type: "text"; content: string }
  | { type: "emoji"; content: string; dataUri: string };

function segmentLine(
  line: string,
  emojiMap: Map<string, string>,
): Segment[] {
  const segments: Segment[] = [];
  let lastIdx = 0;
  for (const m of line.matchAll(EMOJI_REGEX)) {
    if (m.index! > lastIdx) {
      segments.push({ type: "text", content: line.slice(lastIdx, m.index!) });
    }
    const uri = emojiMap.get(m[0]);
    if (uri) {
      segments.push({ type: "emoji", content: m[0], dataUri: uri });
    } else {
      segments.push({ type: "text", content: m[0] });
    }
    lastIdx = m.index! + m[0].length;
  }
  if (lastIdx < line.length) {
    segments.push({ type: "text", content: line.slice(lastIdx) });
  }
  return segments;
}

/* ── 布局常量 ── */
const CARD_MAX_WIDTH = 580;
const FONT_SIZE_NAME = 26;
const FONT_SIZE_TEXT = 28;
const FONT_SIZE_TIME = 18;
const LINE_HEIGHT = 42;
const AVATAR_SIZE = 64;
const BUBBLE_RADIUS = 18;
const BUBBLE_PAD_X = 20;
const BUBBLE_PAD_Y = 18;
const GAP_AVATAR_BUBBLE = 14;
const PADDING = 16;
const MAX_BUBBLE_TEXT_WIDTH = 420;

/* ── 字符宽度测量 ── */

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
    (code >= 0x1f300 && code <= 0x1f9ff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0x1fa00 && code <= 0x1faff) ||
    (code >= 0x200d && code <= 0x200d) ||
    (code >= 0xe0020 && code <= 0xe007f)
  );
}

function charWidth(char: string, fontSize: number): number {
  const code = char.codePointAt(0) || 0;
  if (isWide(code)) return fontSize;
  if (isEmojiCp(code)) return fontSize * 1.2;
  return fontSize * 0.55;
}

function measureText(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, fontSize);
  return w;
}

/** 计算单个 segment 的像素宽度 */
function segmentWidth(seg: Segment, fontSize: number): number {
  if (seg.type === "emoji") return fontSize * 1.2;
  return measureText(seg.content, fontSize);
}

/** 按像素宽度自动换行（基于 segment） */
function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const ch of para) {
      const cw = charWidth(ch, FONT_SIZE_TEXT);
      if (lineW + cw > maxWidth && line) {
        lines.push(line);
        line = "";
        lineW = 0;
      }
      line += ch;
      lineW += cw;
    }
    if (line) lines.push(line);
  }
  return lines;
}

/* ── 头像获取 ── */

async function fetchAvatarBase64(
  env: Env,
  user?: TelegramUser,
): Promise<string | null> {
  if (!user) return null;
  try {
    const fileId = await getUserAvatarFileId(env, user.id);
    if (!fileId) return null;
    const buf = await downloadTelegramFile(env, fileId);
    if (!buf) return null;
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch {
    return null;
  }
}

/* ── 工具函数 ── */

function buildDisplayName(user?: TelegramUser): string {
  if (!user) return "未知用户";
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(" ").trim() || String(user.id);
}

function formatTime(timestamp: number): string {
  const d = new Date(timestamp * 1000);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ── SVG 行渲染（支持 Emoji 内联） ── */

function renderLineSegments(
  line: string,
  emojiMap: Map<string, string>,
  baseX: number,
  baselineY: number,
  fontSize: number,
  ff: string,
  fill: string,
): string {
  const segs = segmentLine(line, emojiMap);
  const parts: string[] = [];
  let x = baseX;

  for (const seg of segs) {
    if (seg.type === "text") {
      parts.push(
        `<text x="${x}" y="${baselineY}" font-size="${fontSize}" font-weight="500" fill="${fill}" font-family="${ff}">${escapeXml(seg.content)}</text>`,
      );
      x += measureText(seg.content, fontSize);
    } else {
      const size = fontSize * 1.2;
      const imgY = baselineY - fontSize * 0.85;
      parts.push(
        `<image x="${x}" y="${imgY}" width="${size}" height="${size}" href="${seg.dataUri}"/>`,
      );
      x += size;
    }
  }
  return parts.join("\n    ");
}

/* ── SVG 渲染 ── */


function renderMessageSvg(
  senderName: string,
  text: string,
  time: string,
  isPartial: boolean,
  avatarBase64: string | null,
  emojiMap: Map<string, string>,
  withBackground = false,
): string {
  const layoutMax =
    CARD_MAX_WIDTH - PADDING * 2 - AVATAR_SIZE - GAP_AVATAR_BUBBLE - BUBBLE_PAD_X * 2;
  const maxBubbleContent = Math.min(layoutMax, MAX_BUBBLE_TEXT_WIDTH);
  const lines = wrapText(text, maxBubbleContent);

  const maxLineW = Math.max(
    ...lines.map((l) => measureText(l, FONT_SIZE_TEXT)),
    measureText(senderName, FONT_SIZE_NAME) + 8,
    measureText(time, FONT_SIZE_TIME) + 16,
  );

  const nameLineH = FONT_SIZE_NAME + 8;
  const textBlockH = lines.length * LINE_HEIGHT;
  const timeLineH = FONT_SIZE_TIME + 8;
  const bubbleH = BUBBLE_PAD_Y + nameLineH + textBlockH + timeLineH + BUBBLE_PAD_Y;
  const bubbleW = Math.min(
    maxBubbleContent + BUBBLE_PAD_X * 2,
    Math.max(maxLineW + BUBBLE_PAD_X * 2, 120),
  );

  const cardW = PADDING + AVATAR_SIZE + GAP_AVATAR_BUBBLE + bubbleW + PADDING;
  const cardH = Math.max(bubbleH, AVATAR_SIZE) + PADDING * 2;

  const avatarX = PADDING;
  const avatarY = PADDING;
  const bubbleX = PADDING + AVATAR_SIZE + GAP_AVATAR_BUBBLE;
  const bubbleY = PADDING;

  const FF = "'Noto Sans SC',sans-serif";

  const avatarCx = avatarX + AVATAR_SIZE / 2;
  const avatarCy = avatarY + AVATAR_SIZE / 2;
  const avatarR = AVATAR_SIZE / 2;
  let avatarSvg: string;
  if (avatarBase64) {
    avatarSvg = `
  <defs><clipPath id="ac"><circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}"/></clipPath></defs>
  <image href="data:image/jpeg;base64,${avatarBase64}" x="${avatarX}" y="${avatarY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" clip-path="url(#ac)" preserveAspectRatio="xMidYMid slice"/>`;
  } else {
    const initial = senderName.charAt(0).toUpperCase();
    avatarSvg = `
  <circle cx="${avatarCx}" cy="${avatarCy}" r="${avatarR}" fill="#5B8AF5"/>
  <text x="${avatarCx}" y="${avatarCy + 6}" text-anchor="middle" font-size="20" fill="#FFF" font-family="${FF}" font-weight="600">${escapeXml(initial)}</text>`;
  }

  // 文本行：使用 segment 渲染以支持 emoji 内联
  const textLines = lines
    .map((line, i) => {
      const y = bubbleY + BUBBLE_PAD_Y + nameLineH + i * LINE_HEIGHT + FONT_SIZE_TEXT;
      const x = bubbleX + BUBBLE_PAD_X + (isPartial ? 8 : 0);
      return renderLineSegments(line, emojiMap, x, y, FONT_SIZE_TEXT, FF, "#FFFFFF");
    })
    .join("\n    ");

  const timeY = bubbleY + BUBBLE_PAD_Y + nameLineH + textBlockH + timeLineH;

  const partialBar = isPartial
    ? `<rect x="${bubbleX + BUBBLE_PAD_X}" y="${bubbleY + BUBBLE_PAD_Y + nameLineH - 2}" width="3" height="${textBlockH + 4}" rx="1.5" fill="#8774E1"/>`
    : "";

  // 发送者名称也支持 emoji
  const nameX = bubbleX + BUBBLE_PAD_X;
  const nameY = bubbleY + BUBBLE_PAD_Y + FONT_SIZE_NAME;
  const nameSvg = renderLineSegments(senderName, emojiMap, nameX, nameY, FONT_SIZE_NAME, FF, "#8774E1");

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${cardW}" height="${cardH}">
  ${withBackground ? `<rect width="${cardW}" height="${cardH}" rx="16" fill="#0E1621"/>` : ""}
  ${avatarSvg}
  <rect x="${bubbleX}" y="${bubbleY}" width="${bubbleW}" height="${bubbleH}" rx="${BUBBLE_RADIUS}" fill="#182533"/>
  ${nameSvg}
  ${partialBar}
  ${textLines}
  <text x="${bubbleX + bubbleW - BUBBLE_PAD_X}" y="${timeY}" text-anchor="end" font-size="${FONT_SIZE_TIME}" fill="#AAAAAA" font-family="${FF}">${escapeXml(time)}</text>
</svg>`;
}

/* ── SVG → PNG ── */

/** 渲染到 512px 宽，精确匹配 Telegram 贴纸原生尺寸 */
async function svgToPng(svg: string, width: number): Promise<ArrayBuffer> {
  const fontData = await loadFont();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: 2048 },
    font: {
      fontBuffers: [fontData],
      defaultFontFamily: "Noto Sans SC",
    },
  });
  const rendered = resvg.render();
  const pngData = rendered.asPng();
  return pngData.buffer as ArrayBuffer;
}

/* ── 入口 ── */

export async function handleQuoteCommand(
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const replied = message.reply_to_message;
  if (!replied) {
    await sendMessage(env, message.chat.id, "❌ 请回复一条消息后使用 /q");
    return;
  }

  const quote = message.quote;
  const displayText = quote?.text || replied.text || replied.caption || "";
  if (!displayText) {
    await sendMessage(env, message.chat.id, "❌ 被回复的消息没有文本内容");
    return;
  }

  const sender = replied.from;
  const senderName = buildDisplayName(sender);
  const time = formatTime(replied.date);
  const isPartial = Boolean(quote?.text && quote.is_manual);

  // 并行：获取头像 + 预取 emoji SVG
  const [avatarBase64, emojiMap] = await Promise.all([
    fetchAvatarBase64(env, sender),
    prefetchEmojis(senderName + "\n" + displayText),
  ]);

  const svg = renderMessageSvg(senderName, displayText, time, isPartial, avatarBase64, emojiMap, true);
  const widthMatch = svg.match(/width="(\d+)"/);
  const svgWidth = widthMatch ? Number(widthMatch[1]) : CARD_MAX_WIDTH;

  // 统一用贴纸发送，显示尺寸更大；失败时 fallback 到图片
  const png = await svgToPng(svg, svgWidth);

  // 删除用户的 /q 命令消息
  telegramApi(env, "deleteMessage", {
    chat_id: message.chat.id,
    message_id: message.message_id,
  }).catch(() => {});

  try {
    await sendSticker(env, message.chat.id, png);
  } catch {
    await sendPhoto(env, message.chat.id, png);
  }
}
