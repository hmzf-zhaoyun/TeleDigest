import {
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_TEMPERATURE,
  LLM_TIMEOUT_MS,
  MAX_MESSAGES_PER_SUMMARY,
} from "./constants";
import type { Env, GroupMessageRow, LlmProvider, SummaryResult } from "./types";
import { parseNumberEnv } from "./utils";
import {
  getGroupConfig,
  getUnsummarizedMessages,
  markMessagesSummarized,
  updateGroupAfterSummary,
} from "./db";
import { sendSummary } from "./telegram/api";

export async function runSummaryForGroup(env: Env, groupId: number): Promise<SummaryResult> {
  const config = await getGroupConfig(env, groupId);
  if (!config) {
    return { success: false, content: "", error: "群组配置不存在" };
  }

  const messages = await getUnsummarizedMessages(env, groupId, MAX_MESSAGES_PER_SUMMARY);
  if (!messages.length) {
    return { success: true, content: "" };
  }

  const formatted = formatMessages(messages);
  const summary = await summarizeMessages(formatted, env);
  if (!summary.success) {
    return summary;
  }

  const targetChat = config.target_chat_id ?? groupId;
  await sendSummary(env, targetChat, config.group_name || String(groupId), summary.content);

  const maxMessageId = Math.max(...messages.map((msg) => msg.message_id));
  await markMessagesSummarized(env, groupId, maxMessageId);
  await updateGroupAfterSummary(env, groupId, maxMessageId);

  return summary;
}

function formatMessages(messages: GroupMessageRow[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    const time = formatTime(message.message_date);
    const sender = message.sender_name || "Unknown";
    let content = message.content || "";
    if (message.has_media && message.media_type) {
      content = content ? `[${message.media_type}] ${content}` : `[${message.media_type}]`;
    }
    lines.push(`[${time}] ${sender}: ${content}`);
  }
  return lines;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "--:--";
  }
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

async function summarizeMessages(messages: string[], env: Env): Promise<SummaryResult> {
  const provider = normalizeProvider(env.LLM_PROVIDER);
  const apiKey = env.LLM_API_KEY || "";
  const model = env.LLM_MODEL || defaultModel(provider);
  const maxTokens = Math.trunc(
    parseNumberEnv(env.LLM_MAX_TOKENS, DEFAULT_LLM_MAX_TOKENS, { min: 1 }),
  );
  const temperature = parseNumberEnv(env.LLM_TEMPERATURE, DEFAULT_LLM_TEMPERATURE, {
    min: 0,
    max: 2,
  });

  if (!apiKey) {
    return { success: false, content: "", error: "LLM API Key 未配置" };
  }

  const prompt = buildDefaultPrompt(messages);

  try {
    if (provider === "openai-responses") {
      return await callOpenAIResponses(prompt, apiKey, model, maxTokens, temperature, env.LLM_API_BASE);
    }
    if (provider === "claude") {
      return await callClaude(prompt, apiKey, model, maxTokens, env.LLM_API_BASE);
    }
    if (provider === "gemini") {
      return await callGemini(prompt, apiKey, model, maxTokens, temperature, env.LLM_API_BASE);
    }
    return await callOpenAI(prompt, apiKey, model, maxTokens, temperature, env.LLM_API_BASE);
  } catch (error) {
    const message = error instanceof Error ? error.message : "LLM 调用失败";
    return { success: false, content: "", error: message };
  }
}

function buildDefaultPrompt(messages: string[]): string {
  const joined = messages.join("\n");
  return (
    "请阅读以下群聊记录，生成结构化要点总结。目标：高信息密度、可执行、少废话；不要逐条复述聊天。\n\n" +
    "【聊天记录】\n" +
    joined +
    "\n\n【总结维度】（按优先级；无内容可省略）\n\n" +
    "1. 主要话题\n" +
    "   - 先按聊天顺序划分阶段（阶段1/2/3...），再提炼每阶段主线\n" +
    "   - 输出 3~8 条；若会话跨度长或主题多，可扩展到 12 条\n" +
    "   - 优先保留：目标变化、关键分歧、结论转折、最终共识\n\n" +
    "2. 次要话题\n" +
    "   - 讨论中出现的分支话题或次要议题（每条尽量一句话）\n\n" +
    "3. 技术讨论\n" +
    "   - 涉及的技术问题、解决方案、代码片段与配置\n" +
    "   - 使用“问题 → 方案 → 取舍/结论”结构归纳\n\n" +
    "4. 资源分享\n" +
    "   - 分享的链接、文档、工具、文章等资源\n" +
    "   - 建议格式：资源名称 + 链接 + 用途\n\n" +
    "5. 重要互动\n" +
    "   - 需要跟进的提问、待办事项（TODO）、决策结果（Decision）\n" +
    "   - 聊天未明确的负责人或时间不要猜测\n\n" +
    "6. 零散信息\n" +
    "   - 其他有价值但不属于以上分类的信息\n\n" +
    "7. 时间线梳理\n" +
    "   - 严格按聊天记录出现顺序输出，不要推断真实时间\n" +
    "   - 用“阶段1/阶段2/阶段3...”列出关键进展，每条写“事件 → 影响/下一步”\n\n" +
    "【输出要求】\n" +
    "- 使用 Markdown\n" +
    "- 只输出以上 7 个维度标题及其要点，不要前言/结尾\n" +
    "- 主要话题：3~8 条（长会话可到 12 条）；其余维度最多 5 条\n" +
    "- 全文建议控制在 20~40 条要点\n" +
    "- 按重要性排序，避免重复和冗余\n" +
    "- 不确定内容不要编造，可标注“（未明确）”"
  );
}

function normalizeProvider(raw: string | undefined): LlmProvider {
  const value = (raw || "openai").trim().toLowerCase();
  if (value === "custom") return "openai";
  if (value === "openai-responses" || value === "openai_responses" || value === "openairesponses") {
    return "openai-responses";
  }
  if (value === "claude") return "claude";
  if (value === "gemini") return "gemini";
  return "openai";
}

function defaultModel(provider: LlmProvider): string {
  if (provider === "openai-responses") return "gpt-4.1-mini";
  if (provider === "claude") return "claude-3-haiku-20240307";
  if (provider === "gemini") return "gemini-1.5-flash";
  return "gpt-4o-mini";
}

type OpenAIResponseContent = {
  type?: string;
  text?: string;
};

type OpenAIResponseOutput = {
  content?: OpenAIResponseContent[];
};

type OpenAIResponseBody = {
  output?: OpenAIResponseOutput[];
  output_text?: string;
};

function extractOpenAIResponseText(data: OpenAIResponseBody): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }
  const parts: string[] = [];
  for (const output of data.output || []) {
    for (const content of output.content || []) {
      if (content.type === "output_text" && content.text) {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

async function callOpenAIResponses(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const base = (apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/responses`;
  const payload = {
    model,
    instructions: "你是一个专业的消息总结助手。",
    input: prompt,
    max_output_tokens: maxTokens,
    temperature,
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as OpenAIResponseBody;
  const content = extractOpenAIResponseText(data).trim();
  if (!content) {
    return { success: false, content: "", error: "OpenAI 返回空内容" };
  }
  return { success: true, content };
}

async function callOpenAI(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const base = (apiBase || "https://api.openai.com/v1").replace(/\/$/, "");
  const url = `${base}/chat/completions`;
  const payload = {
    model,
    messages: [
      { role: "system", content: "你是一个专业的消息总结助手。" },
      { role: "user", content: prompt },
    ],
    max_tokens: maxTokens,
    temperature,
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = (data.choices?.[0]?.message?.content || "").trim();
  if (!content) {
    return { success: false, content: "", error: "OpenAI 返回空内容" };
  }
  return { success: true, content };
}

async function callClaude(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const base = (apiBase || "https://api.anthropic.com/v1").replace(/\/$/, "");
  const url = `${base}/messages`;
  const payload = {
    model,
    max_tokens: maxTokens,
    system: "你是一个专业的消息总结助手。",
    messages: [{ role: "user", content: prompt }],
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as {
    content?: { text?: string }[];
  };
  const content = (data.content?.[0]?.text || "").trim();
  if (!content) {
    return { success: false, content: "", error: "Claude 返回空内容" };
  }
  return { success: true, content };
}

async function callGemini(
  prompt: string,
  apiKey: string,
  model: string,
  maxTokens: number,
  temperature: number,
  apiBase?: string,
): Promise<SummaryResult> {
  const normalizedModel = model.startsWith("models/") ? model.slice(7) : model;
  const base = (apiBase || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${base}/models/${normalizedModel}:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    return { success: false, content: "", error: `API 错误: ${text}` };
  }

  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const content = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  if (!content) {
    return { success: false, content: "", error: "Gemini 返回空内容" };
  }
  return { success: true, content };
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = LLM_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
