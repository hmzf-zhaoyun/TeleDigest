import { sendMessage, sendMediaGroup } from "./api";
import { escapeHtml } from "../utils";
import { getGroupConfig, getGlobalLinuxdoToken, setGlobalLinuxdoToken, getScrapeGeoCode, getScrapeSuper } from "../db";
const LINUXDO_URL_PATTERN = /https?:\/\/linux\.do\/t\/topic\/(\d+)(?:\/(\d+))?/i;
export function extractLinuxdoUrl(text) {
    const match = LINUXDO_URL_PATTERN.exec(text);
    if (!match)
        return null;
    const topicId = match[1];
    const postNumber = match[2] || "1";
    return `https://linux.do/t/topic/${topicId}/${postNumber}.json`;
}
/**
 * Normalize cookie value: if it already looks like a full cookie string
 * (contains "="), use as-is; otherwise treat as a bare _t token value.
 */
function buildCookieString(raw) {
    return raw.includes("=") ? raw : `_t=${raw}`;
}
/**
 * Extract new _t token from scrape.do response headers.
 * scrape.do may forward Set-Cookie via Scrape.do-Set-Cookie or standard Set-Cookie header.
 */
function extractNewToken(response) {
    // Scrape.do returns cookies via custom header: Scrape.do-Cookies
    for (const headerName of ["Scrape.do-Cookies", "set-cookie"]) {
        const raw = response.headers.get(headerName);
        if (!raw)
            continue;
        const match = /_t=([^;]+)/.exec(raw);
        if (match) {
            console.log(`[linuxdo] found new _t token in ${headerName}`);
            return match[1];
        }
    }
    return null;
}
export async function fetchLinuxdoPost(jsonUrl, env) {
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
            }
            catch (e) {
                console.error(`[linuxdo] failed to save renewed token:`, e);
            }
        }
        if (result.post)
            return result.post;
    }
    // 策略2: cookie 直连降级（Workers 出口可能被 CF 拦截）
    if (cookie) {
        const result = await fetchDirect(jsonUrl, cookie);
        console.log(`[linuxdo] direct result=${!!result}`);
        if (result)
            return result;
    }
    return null;
}
async function fetchViaScrapeProxy(jsonUrl, token, cookie, geoCode, superMode) {
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
        const data = JSON.parse(text);
        return { post: parseLinuxdoResponse(data), newCookie };
    }
    catch (error) {
        console.error("[linuxdo] scrape.do error:", error);
        return { post: null };
    }
}
async function fetchDirect(jsonUrl, cookie) {
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
        const data = await response.json();
        return parseLinuxdoResponse(data);
    }
    catch (error) {
        console.error("[linuxdo] direct error:", error);
        return null;
    }
}
function parseLinuxdoResponse(data) {
    const title = data.title || data.fancy_title || "";
    const firstPost = data.post_stream?.posts?.[0];
    if (!firstPost)
        return null;
    const author = firstPost.name || firstPost.username || "未知";
    const rawHtml = firstPost.cooked || "";
    const markdown = convertCookedToMarkdown(rawHtml);
    const images = extractImages(rawHtml).slice(0, 10);
    const content = stripMarkdownForTelegram(markdown);
    if (!title && !content)
        return null;
    return { title, author, rawHtml, markdown, content, images };
}
function isValidPostImageUrl(url) {
    if (/\/images\/emoji\//i.test(url))
        return false;
    if (/\/user_avatar\//i.test(url))
        return false;
    if (/\/letter_avatar/i.test(url))
        return false;
    return /\.(jpe?g|png|gif|webp)/i.test(url);
}
function normalizeLinuxdoImageUrl(rawUrl) {
    try {
        const url = new URL(rawUrl, "https://linux.do");
        if (url.hostname !== "linux.do")
            return rawUrl;
        if (!/\/uploads\/default\/(?:optimized|original)\//i.test(url.pathname))
            return rawUrl;
        url.pathname = url.pathname.replace(/\/uploads\/default\/optimized\//i, "/uploads/default/original/");
        url.pathname = url.pathname.replace(/_(\d+)_\d+[xX]\d+(?=\.(?:jpe?g|png|gif|webp)$)/i, "");
        return url.toString();
    }
    catch {
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
function extractImages(html) {
    const urls = [];
    const seen = new Set();
    const mixedRe = /<a\b[^>]*\blightbox\b[^>]*\shref="([^"]+)"[^>]*>[\s\S]*?<\/a>|<img[^>]+src="([^"]+)"[^>]*>/gi;
    let m;
    while ((m = mixedRe.exec(html)) !== null) {
        const rawUrl = m[1] || m[2];
        if (!rawUrl)
            continue;
        const url = normalizeLinuxdoImageUrl(rawUrl);
        if (seen.has(url))
            continue;
        if (!isValidPostImageUrl(url))
            continue;
        seen.add(url);
        urls.push(url);
    }
    return urls;
}
function renderMarkdownImage(rawUrl, seen) {
    const normalized = normalizeLinuxdoImageUrl(rawUrl);
    if (!isValidPostImageUrl(normalized))
        return "\n";
    if (seen.has(normalized))
        return "\n";
    seen.add(normalized);
    return `\n\n![image](${normalized})\n\n`;
}
function normalizeMarkdownWhitespace(text) {
    return text
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
function convertQuoteMarkersToMarkdown(text) {
    let result = text;
    let previous = "";
    while (result !== previous) {
        previous = result;
        result = result.replace(/\[QUOTE\]\s*([\s\S]*?)\s*\[\/QUOTE\]/g, (_m, inner) => {
            const lines = normalizeMarkdownWhitespace(inner)
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
            if (!lines.length)
                return "";
            return `\n\n${lines.map((line) => `> ${line}`).join("\n")}\n\n`;
        });
    }
    return result;
}
function decodeHtmlEntities(text) {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'");
}
function stripTags(text) {
    return text.replace(/<[^>]+>/g, "");
}
function textFromInlineHtml(html) {
    return decodeHtmlEntities(stripTags(html))
        .replace(/\s+/g, " ")
        .trim();
}
function convertCookedToMarkdown(html) {
    const seen = new Set();
    const text = html
        .replace(/\r\n?/g, "\n")
        .replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code) => {
        const decodedCode = decodeHtmlEntities(stripTags(code)).replace(/\n+$/g, "");
        return decodedCode ? `\n\n\`\`\`\n${decodedCode}\n\`\`\`\n\n` : "\n";
    })
        .replace(/<a\b[^>]*\blightbox\b[^>]*\shref="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi, (_m, href) => renderMarkdownImage(href, seen))
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
        .replace(/<a\b[^>]*\shref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
        const text = textFromInlineHtml(inner);
        if (!text)
            return href;
        return `[${text}](${href})`;
    })
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
        .replace(/<p[^>]*>|<div[^>]*>|<span[^>]*>|<\/span>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\b\w*\d+×\d+\s+[\d.]+\s*[KMG]?B\b/gi, "");
    return normalizeMarkdownWhitespace(convertQuoteMarkersToMarkdown(decodeHtmlEntities(text)));
}
function stripMarkdownForTelegram(markdown) {
    let markerIndex = 0;
    return normalizeMarkdownWhitespace(markdown
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
        .replace(/_(.+?)_/g, "$1"));
}
function formatPostMessage(post, originalUrl) {
    const maxContentLength = 2000;
    let content = post.content;
    if (content.length > maxContentLength) {
        content = content.slice(0, maxContentLength) + "...";
    }
    const escapedTitle = escapeHtml(post.title);
    const escapedAuthor = escapeHtml(post.author);
    let escapedContent = escapeHtml(content);
    escapedContent = escapedContent.replace(/\[IMG#(\d+)\]/g, (_m, rawIndex) => {
        const index = Number(rawIndex) - 1;
        const url = post.images[index];
        if (!url)
            return "";
        return `🖼 <a href="${url.replace(/&/g, "&amp;")}">查看图片 ${rawIndex}</a>`;
    });
    return (`📝 <b>${escapedTitle}</b>\n\n` +
        `👤 作者: ${escapedAuthor}\n\n` +
        `<blockquote expandable>${escapedContent}</blockquote>\n\n` +
        `🔗 <a href="${originalUrl}">查看原帖</a>`);
}
function truncateForTelegraph(text, maxLength) {
    if (text.length <= maxLength)
        return text;
    return `${text.slice(0, maxLength)}...`;
}
function parseInlineMarkdown(text) {
    const nodes = [];
    const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            nodes.push(text.slice(lastIndex, match.index));
        }
        if (match[1] && match[2]) {
            nodes.push({ tag: "a", attrs: { href: match[2] }, children: [match[1]] });
        }
        else if (match[3]) {
            nodes.push({ tag: "code", children: [match[3]] });
        }
        else if (match[4]) {
            nodes.push({ tag: "strong", children: [match[4]] });
        }
        else if (match[5]) {
            nodes.push({ tag: "em", children: [match[5]] });
        }
        lastIndex = pattern.lastIndex;
    }
    if (lastIndex < text.length) {
        nodes.push(text.slice(lastIndex));
    }
    return nodes.length > 0 ? nodes : [text];
}
function buildTelegraphContent(post, originalUrl) {
    const nodes = [];
    const text = truncateForTelegraph(post.markdown, 20000);
    const lines = text.split("\n");
    nodes.push({ tag: "p", children: [`作者：${post.author || "未知"}`] });
    nodes.push({
        tag: "p",
        children: [{ tag: "a", attrs: { href: originalUrl }, children: ["查看原帖"] }],
    });
    for (let i = 0; i < lines.length; i++) {
        const rawLine = lines[i];
        const line = rawLine.trim();
        if (!line)
            continue;
        const imageMatch = /^!\[[^\]]*]\((https?:\/\/\S+)\)$/i.exec(line);
        if (imageMatch) {
            const imageUrl = normalizeLinuxdoImageUrl(imageMatch[1].replace(/[),.;!?]+$/, ""));
            if (!isValidPostImageUrl(imageUrl))
                continue;
            nodes.push({
                tag: "figure",
                children: [{ tag: "img", attrs: { src: imageUrl } }],
            });
            continue;
        }
        if (/^```/.test(line)) {
            const codeLines = [];
            i += 1;
            while (i < lines.length && !/^```/.test(lines[i].trim())) {
                codeLines.push(lines[i]);
                i += 1;
            }
            const codeText = codeLines.join("\n").trim();
            if (codeText) {
                nodes.push({ tag: "pre", children: [codeText] });
            }
            continue;
        }
        if (line.startsWith(">")) {
            const quoteLines = [line.replace(/^>\s?/, "").trim()];
            while (i + 1 < lines.length && lines[i + 1].trim().startsWith(">")) {
                i += 1;
                quoteLines.push(lines[i].trim().replace(/^>\s?/, "").trim());
            }
            const quoteText = quoteLines.filter((item) => item.length > 0).join("\n");
            if (quoteText) {
                nodes.push({ tag: "blockquote", children: [quoteText] });
            }
            continue;
        }
        if (/^- /.test(line)) {
            const items = [];
            items.push({ tag: "li", children: parseInlineMarkdown(line.slice(2).trim()) });
            while (i + 1 < lines.length && lines[i + 1].trim().startsWith("- ")) {
                i += 1;
                items.push({ tag: "li", children: parseInlineMarkdown(lines[i].trim().slice(2).trim()) });
            }
            nodes.push({ tag: "ul", children: items });
            continue;
        }
        const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
        if (headingMatch) {
            nodes.push({ tag: "p", children: [{ tag: "strong", children: parseInlineMarkdown(headingMatch[2].trim()) }] });
            continue;
        }
        if (line === "---") {
            continue;
        }
        nodes.push({ tag: "p", children: parseInlineMarkdown(rawLine.trim()) });
    }
    return nodes;
}
async function createTelegraphPage(post, originalUrl, env) {
    const accessToken = env.TELEGRAPH_ACCESS_TOKEN;
    if (!accessToken)
        return null;
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
        const data = await response.json();
        if (!data.ok || !data.result?.url) {
            console.error("[linuxdo] telegraph api error:", data.error || "unknown");
            return null;
        }
        return data.result.url;
    }
    catch (error) {
        console.error("[linuxdo] telegraph request failed:", error);
        return null;
    }
}
function formatTelegraphMessage(post, telegraphUrl, originalUrl) {
    const escapedTitle = escapeHtml(post.title || "Linux.do");
    const escapedAuthor = escapeHtml(post.author || "未知");
    return (`📘 <b>${escapedTitle}</b>\n\n` +
        `👤 作者: ${escapedAuthor}\n` +
        `📰 <a href="${telegraphUrl}">Telegraph 阅读</a>\n` +
        `🔗 <a href="${originalUrl}">查看原帖</a>`);
}
export async function handleLinuxdoLink(message, env) {
    const text = message.text || "";
    const match = LINUXDO_URL_PATTERN.exec(text);
    if (!match)
        return false;
    // 群组消息需要检查开关
    if (message.chat.type === "group" || message.chat.type === "supergroup") {
        const config = await getGroupConfig(env, message.chat.id);
        if (!config || Number(config.linuxdo_enabled) !== 1) {
            return false;
        }
    }
    const originalUrl = match[0];
    const jsonUrl = extractLinuxdoUrl(text);
    if (!jsonUrl)
        return false;
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
        }
        catch (e) {
            console.error("[linuxdo] sendMediaGroup failed:", e);
        }
    }
    else {
        console.log("[linuxdo] no images extracted from post");
    }
    return true;
}
