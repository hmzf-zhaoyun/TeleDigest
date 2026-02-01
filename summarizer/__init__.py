"""
消息总结模块
提供 LLM API 调用和消息总结功能
"""

try:
    from .api_client import (
        BaseLLMClient,
        OpenAIClient,
        ClaudeClient,
        GeminiClient,
        SummaryResult,
        create_llm_client,
    )
except ImportError:
    from api_client import (
        BaseLLMClient,
        OpenAIClient,
        ClaudeClient,
        GeminiClient,
        SummaryResult,
        create_llm_client,
    )

__all__ = [
    "BaseLLMClient",
    "OpenAIClient",
    "ClaudeClient",
    "GeminiClient",
    "SummaryResult",
    "create_llm_client",
]

