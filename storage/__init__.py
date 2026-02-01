"""
数据存储模块
提供群组配置的持久化存储功能
"""

try:
    from .bot_db import BotDatabase, GroupConfig, GroupMessage
except ImportError:
    from bot_db import BotDatabase, GroupConfig, GroupMessage

__all__ = [
    "BotDatabase",
    "GroupConfig",
    "GroupMessage",
]

