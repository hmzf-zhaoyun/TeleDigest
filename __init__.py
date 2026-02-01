"""
tgbot - Telegram 消息总结机器人

独立的 Telegram 机器人模块，提供定时消息读取与 AI 总结功能。

架构特点：
- 使用 Bot API (python-telegram-bot) 接收群组消息
- 消息存储到本地 SQLite 数据库
- 定时任务从数据库读取消息进行 AI 总结
- 完全独立运行，不依赖 MTProto 客户端或用户账号
"""

__version__ = "1.0.0"
__author__ = "tgbot"

from .bot import TelegramBot
from .config import BotConfig, get_bot_config

__all__ = [
    "TelegramBot",
    "BotConfig",
    "get_bot_config",
]
