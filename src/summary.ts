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
    "请对以下群组聊天消息进行总结，提取关键信息和重要讨论点：\n\n" +
    joined +
    "\n\n请用简洁的语言总结以上内容，包括：\n" +
    "1. 主要讨论话题\n" +
    "2. 重要结论或决定\n" +
    "3. 值得关注的信息\n\n总结："
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
