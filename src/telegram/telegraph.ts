import type { Env } from "../types";

export type TelegraphNode = string | {
  tag: string;
  attrs?: Record<string, string>;
  children?: TelegraphNode[];
};

type TelegraphElement = Exclude<TelegraphNode, string>;

interface TelegraphCreatePageResponse {
  ok: boolean;
  error?: string;
  result?: {
    url?: string;
  };
}

const TELEGRAPH_API_CREATE_PAGE = "https://api.telegra.ph/createPage";
const TELEGRAPH_TITLE_LIMIT = 256;
const TELEGRAPH_SUMMARY_LIMIT = 50_000;

export async function createSummaryTelegraphPage(
  env: Env,
  groupName: string,
  summary: string,
): Promise<string | null> {
  const title = truncateForTelegraph(`${groupName || "群组"} 消息总结`, TELEGRAPH_TITLE_LIMIT);
  const content = buildSummaryContent(groupName, summary);
  return createTelegraphPage(env, title, content, "summary");
}

export async function createTelegraphPage(
  env: Env,
  title: string,
  content: TelegraphNode[],
  logPrefix = "telegraph",
): Promise<string | null> {
  const accessToken = env.TELEGRAPH_ACCESS_TOKEN;
  if (!accessToken) return null;

  const body = new URLSearchParams({
    access_token: accessToken,
    title: truncateForTelegraph(title.trim() || "TeleDigest", TELEGRAPH_TITLE_LIMIT),
    author_name: "TeleDigest",
    content: JSON.stringify(content),
    return_content: "false",
  });

  try {
    const response = await fetch(TELEGRAPH_API_CREATE_PAGE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[${logPrefix}] telegraph status=${response.status} body=${text.slice(0, 500)}`);
      return null;
    }

    const data = await response.json() as TelegraphCreatePageResponse;
    if (!data.ok || !data.result?.url) {
      console.error(`[${logPrefix}] telegraph api error:`, data.error || "unknown");
      return null;
    }
    return data.result.url;
  } catch (error) {
    console.error(`[${logPrefix}] telegraph request failed:`, error);
    return null;
  }
}

function buildSummaryContent(groupName: string, summary: string): TelegraphNode[] {
  const limitedSummary = truncateForTelegraph(summary, TELEGRAPH_SUMMARY_LIMIT);
  return [
    { tag: "p", children: ["群组：", { tag: "strong", children: [groupName || "未知群组"] }] },
    ...markdownToTelegraphNodes(limitedSummary),
  ];
}

function markdownToTelegraphNodes(markdown: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let currentList: { tag: "ul" | "ol"; children: TelegraphElement[] } | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) {
      nodes.push({ tag: "p", children: parseInlineMarkdown(text) });
    }
    paragraph = [];
  };

  const flushList = () => {
    if (currentList && currentList.children.length) {
      nodes.push(currentList);
    }
    currentList = null;
  };

  const appendListItem = (tag: "ul" | "ol", text: string) => {
    flushParagraph();
    if (!currentList || currentList.tag !== tag) {
      flushList();
      currentList = { tag, children: [] };
    }
    currentList.children.push({ tag: "li", children: parseInlineMarkdown(text.trim()) });
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      nodes.push({
        tag: heading[1].length <= 2 ? "h3" : "h4",
        children: parseInlineMarkdown(heading[2].trim()),
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      appendListItem("ul", bullet[1]);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      appendListItem("ol", ordered[1]);
      continue;
    }

    const activeList = currentList as { tag: "ul" | "ol"; children: TelegraphElement[] } | null;
    if (activeList && /^\s+/.test(line)) {
      const last = activeList.children[activeList.children.length - 1];
      if (last) {
        last.children = [...(last.children || []), { tag: "br" }, ...parseInlineMarkdown(trimmed)];
        continue;
      }
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  return nodes.length ? nodes : [{ tag: "p", children: [markdown] }];
}

function parseInlineMarkdown(text: string): TelegraphNode[] {
  const nodes: TelegraphNode[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const last = nodes[nodes.length - 1];
    if (typeof last === "string") {
      nodes[nodes.length - 1] = last + value;
      return;
    }
    nodes.push(value);
  };

  while (cursor < text.length) {
    const rest = text.slice(cursor);

    const link = /^\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/.exec(rest);
    if (link) {
      nodes.push({ tag: "a", attrs: { href: link[2] }, children: parseInlineMarkdown(link[1]) });
      cursor += link[0].length;
      continue;
    }

    if (rest.startsWith("**")) {
      const end = rest.indexOf("**", 2);
      if (end > 2) {
        nodes.push({ tag: "strong", children: parseInlineMarkdown(rest.slice(2, end)) });
        cursor += end + 2;
        continue;
      }
    }

    if (rest.startsWith("`")) {
      const end = rest.indexOf("`", 1);
      if (end > 1) {
        nodes.push({ tag: "code", children: [rest.slice(1, end)] });
        cursor += end + 1;
        continue;
      }
    }

    if (rest.startsWith("*")) {
      const end = rest.indexOf("*", 1);
      if (end > 1) {
        nodes.push({ tag: "em", children: parseInlineMarkdown(rest.slice(1, end)) });
        cursor += end + 1;
        continue;
      }
    }

    pushText(text[cursor]);
    cursor += 1;
  }

  return nodes;
}

function truncateForTelegraph(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 12)).trimEnd()}\n\n（已截断）`;
}
