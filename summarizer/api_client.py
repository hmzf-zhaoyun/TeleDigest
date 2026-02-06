"""
LLM API 客户端模块
支持多种 LLM 提供商（OpenAI、Claude、Gemini 等）
"""
import os
import logging
import asyncio
import aiohttp
from abc import ABC, abstractmethod
from typing import Optional, List
from dataclasses import dataclass

try:
    from ..config import LLMConfig
except ImportError:
    from config import LLMConfig


logger = logging.getLogger(__name__)

# API 请求超时时间（秒）
API_TIMEOUT = 120

def _get_proxy() -> Optional[str]:
    """
    获取代理设置
    支持标准 HTTP_PROXY 环境变量和 TG_PROXY_* 格式
    """
    # 优先使用标准环境变量
    proxy = os.getenv('HTTPS_PROXY') or os.getenv('HTTP_PROXY') or os.getenv('https_proxy') or os.getenv('http_proxy')
    if proxy:
        return proxy

    # 使用 TG_PROXY_* 格式
    proxy_type = os.getenv('TG_PROXY_TYPE', '').lower()
    proxy_host = os.getenv('TG_PROXY_HOST')
    proxy_port = os.getenv('TG_PROXY_PORT')

    if proxy_type and proxy_host and proxy_port:
        proxy_user = os.getenv('TG_PROXY_USERNAME', '')
        proxy_pass = os.getenv('TG_PROXY_PASSWORD', '')

        if proxy_user and proxy_pass:
            return f"{proxy_type}://{proxy_user}:{proxy_pass}@{proxy_host}:{proxy_port}"
        else:
            return f"{proxy_type}://{proxy_host}:{proxy_port}"

    return None


@dataclass
class SummaryResult:
    """总结结果"""
    content: str
    tokens_used: int = 0
    model: str = ""
    success: bool = True
    error: Optional[str] = None


class BaseLLMClient(ABC):
    """LLM 客户端基类"""
    
    def __init__(self, config: LLMConfig):
        self.config = config
    
    @abstractmethod
    async def summarize(self, messages: List[str], prompt: Optional[str] = None) -> SummaryResult:
        """
        对消息列表进行总结
        
        Args:
            messages: 消息列表
            prompt: 自定义提示词
            
        Returns:
            SummaryResult 总结结果
        """
        pass
    
    def _build_default_prompt(self, messages: List[str]) -> str:
        """构建默认的总结提示词"""
        messages_text = "\n".join(messages)
        return f"""请对以下群组聊天消息进行总结，提取关键信息和重要讨论点：

{messages_text}

请用简洁的语言总结以上内容，包括：
1. 主要讨论话题
2. 重要结论或决定
3. 值得关注的信息

重要约束：
- 输出将通过 Telegram 单条消息发送，请将最终总结控制在 3200 个中文字符以内（包含标点和换行）。
- 如果内容过多，请主动压缩表达、合并同类项，保留关键结论与高价值信息。

总结："""


class OpenAIClient(BaseLLMClient):
    """OpenAI API 客户端"""
    
    async def summarize(self, messages: List[str], prompt: Optional[str] = None) -> SummaryResult:
        """使用 OpenAI API 进行总结"""
        if not self.config.api_key:
            return SummaryResult(content="", success=False, error="OpenAI API Key 未配置")
        
        api_base = self.config.api_base or "https://api.openai.com/v1"
        url = f"{api_base}/chat/completions"
        
        user_content = prompt or self._build_default_prompt(messages)
        
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        
        payload = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": "你是一个专业的消息总结助手。"},
                {"role": "user", "content": user_content}
            ],
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
        }
        
        try:
            proxy = _get_proxy()
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers, json=payload, timeout=API_TIMEOUT, proxy=proxy) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        return SummaryResult(content="", success=False, error=f"API 错误: {error_text}")

                    data = await resp.json()
                    choice0 = (data.get("choices") or [{}])[0]
                    message0 = choice0.get("message") or {}
                    content = message0.get("content") or ""
                    finish_reason = choice0.get("finish_reason")

                    usage = data.get("usage", {}) or {}
                    tokens = usage.get("total_tokens", 0)

                    if finish_reason and finish_reason != "stop":
                        logger.warning(f"OpenAI 总结可能被截断: finish_reason={finish_reason}, max_tokens={self.config.max_tokens}")

                    return SummaryResult(
                        content=content,
                        tokens_used=tokens,
                        model=self.config.model,
                        success=True
                    )
        except asyncio.TimeoutError:
            return SummaryResult(content="", success=False, error="API 请求超时")
        except Exception as e:
            logger.error(f"OpenAI API 调用失败: {e}")
            return SummaryResult(content="", success=False, error=str(e))


class ClaudeClient(BaseLLMClient):
    """Claude API 客户端"""

    async def summarize(self, messages: List[str], prompt: Optional[str] = None) -> SummaryResult:
        """使用 Claude API 进行总结"""
        if not self.config.api_key:
            return SummaryResult(content="", success=False, error="Claude API Key 未配置")

        api_base = self.config.api_base or "https://api.anthropic.com/v1"
        url = f"{api_base}/messages"

        user_content = prompt or self._build_default_prompt(messages)

        headers = {
            "x-api-key": self.config.api_key,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
        }

        payload = {
            "model": self.config.model or "claude-3-haiku-20240307",
            "max_tokens": self.config.max_tokens,
            "messages": [{"role": "user", "content": user_content}],
        }

        try:
            proxy = _get_proxy()
            async with aiohttp.ClientSession() as session:
                async with session.post(url, headers=headers, json=payload, timeout=API_TIMEOUT, proxy=proxy) as resp:
                    if resp.status != 200:
                        error_text = await resp.text()
                        return SummaryResult(content="", success=False, error=f"API 错误: {error_text}")

                    data = await resp.json()
                    content_blocks = data.get("content", []) or []
                    parts: List[str] = []
                    for block in content_blocks:
                        if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                            parts.append(block["text"])

                    content = "".join(parts).strip()
                    tokens = data.get("usage", {}).get("input_tokens", 0) + data.get("usage", {}).get("output_tokens", 0)
                    stop_reason = data.get("stop_reason")

                    if stop_reason and stop_reason not in ("end_turn", "stop_sequence"):
                        logger.warning(f"Claude 总结可能被截断: stop_reason={stop_reason}, max_tokens={self.config.max_tokens}")

                    return SummaryResult(
                        content=content,
                        tokens_used=tokens,
                        model=self.config.model,
                        success=True
                    )
        except asyncio.TimeoutError:
            return SummaryResult(content="", success=False, error="API 请求超时")
        except Exception as e:
            logger.error(f"Claude API 调用失败: {e}")
            return SummaryResult(content="", success=False, error=str(e))


class GeminiClient(BaseLLMClient):
    """Google Gemini API 客户端"""

    async def summarize(self, messages: List[str], prompt: Optional[str] = None) -> SummaryResult:
        """使用 Gemini API 进行总结"""
        if not self.config.api_key:
            return SummaryResult(content="", success=False, error="Gemini API Key 未配置")

        model = self.config.model or "gemini-1.5-flash"
        # 移除可能存在的 models/ 前缀，避免重复
        if model.startswith("models/"):
            model = model[7:]

        api_base = self.config.api_base or "https://generativelanguage.googleapis.com/v1beta"
        url = f"{api_base}/models/{model}:generateContent?key={self.config.api_key}"

        user_content = prompt or self._build_default_prompt(messages)

        headers = {
            "Content-Type": "application/json",
        }

        payload = {
            "contents": [
                {
                    "parts": [
                        {"text": user_content}
                    ]
                }
            ],
            "generationConfig": {
                "maxOutputTokens": self.config.max_tokens,
                "temperature": self.config.temperature,
            }
        }

        try:
            proxy = _get_proxy()
            if proxy:
                logger.debug(f"使用代理: {proxy}")

            connector = None
            # 对于 SOCKS5 代理，需要使用 aiohttp_socks
            if proxy and proxy.startswith('socks'):
                try:
                    from aiohttp_socks import ProxyConnector
                    connector = ProxyConnector.from_url(proxy)
                    proxy = None  # 使用 connector 时不需要 proxy 参数
                except ImportError:
                    logger.warning("SOCKS5 代理需要安装 aiohttp-socks: pip install aiohttp-socks")
                    return SummaryResult(content="", success=False, error="SOCKS5 代理需要安装 aiohttp-socks")

            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.post(url, headers=headers, json=payload, timeout=API_TIMEOUT, proxy=proxy) as resp:
                    response_text = await resp.text()

                    if resp.status != 200:
                        logger.error(f"Gemini API 错误 [HTTP {resp.status}]: {response_text[:500]}")
                        return SummaryResult(content="", success=False, error=f"API 错误 [HTTP {resp.status}]: {response_text[:200]}")

                    data = await resp.json(content_type=None)

                    # 检查是否有候选响应
                    candidates = data.get("candidates", [])
                    if not candidates:
                        logger.error(f"Gemini 未返回有效响应: {data}")
                        return SummaryResult(content="", success=False, error=f"Gemini 未返回有效响应: {data.get('error', data)}")

                    candidate0 = candidates[0] if candidates else {}
                    candidate_parts = candidate0.get("content", {}).get("parts", []) or []
                    content = "".join(
                        part.get("text", "")
                        for part in candidate_parts
                        if isinstance(part, dict) and part.get("text")
                    ).strip()

                    finish_reason = candidate0.get("finishReason")
                    if finish_reason and finish_reason not in ("STOP", "FINISH_REASON_UNSPECIFIED"):
                        logger.warning(f"Gemini 总结可能被截断: finish_reason={finish_reason}, max_tokens={self.config.max_tokens}")

                    # Gemini 的 token 统计
                    usage = data.get("usageMetadata", {})
                    tokens = usage.get("promptTokenCount", 0) + usage.get("candidatesTokenCount", 0)

                    return SummaryResult(
                        content=content,
                        tokens_used=tokens,
                        model=model,
                        success=True
                    )
        except asyncio.TimeoutError:
            return SummaryResult(content="", success=False, error=f"API 请求超时 ({API_TIMEOUT}秒)")
        except Exception as e:
            logger.error(f"Gemini API 调用失败: {e}", exc_info=True)
            return SummaryResult(content="", success=False, error=str(e))


def create_llm_client(config: LLMConfig) -> BaseLLMClient:
    """
    根据配置创建 LLM 客户端

    Args:
        config: LLM 配置

    Returns:
        LLM 客户端实例
    """
    provider = config.provider.lower()
    if provider == "openai":
        return OpenAIClient(config)
    elif provider == "claude":
        return ClaudeClient(config)
    elif provider == "gemini":
        return GeminiClient(config)
    else:
        # 默认使用 OpenAI 兼容接口
        return OpenAIClient(config)

