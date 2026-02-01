"""
Telegram 机器人主类
整合所有功能模块，提供统一的机器人接口

架构说明：
- 使用 Bot API (python-telegram-bot) 接收群组消息并存储到数据库
- 定时任务从数据库读取未总结的消息进行总结
- 不依赖 MTProto 客户端，消息获取与用户个人账号已读状态完全独立
"""
import logging
import asyncio
from typing import Optional, List
from datetime import datetime

from telegram import Update, Bot, BotCommand, Message
from telegram.ext import Application, ContextTypes, MessageHandler, filters

try:
    from .config import BotConfig, get_bot_config
    from .storage import BotDatabase, GroupConfig, GroupMessage
    from .scheduler import TaskManager
    from .summarizer import create_llm_client, SummaryResult
    from .handlers.admin import set_bot_instance, register_handlers
    from .handlers.linuxdo_handler import set_linuxdo_bot_instance, register_linuxdo_handlers
except ImportError:
    from config import BotConfig, get_bot_config
    from storage import BotDatabase, GroupConfig, GroupMessage
    from scheduler import TaskManager
    from summarizer import create_llm_client, SummaryResult
    from handlers.admin import set_bot_instance, register_handlers
    from handlers.linuxdo_handler import set_linuxdo_bot_instance, register_linuxdo_handlers


logger = logging.getLogger(__name__)


# 机器人命令列表定义
BOT_COMMANDS = [
    BotCommand("start", "启动机器人"),
    BotCommand("help", "显示帮助信息"),
    BotCommand("groups", "查看群组列表（交互式管理）"),
    BotCommand("enable", "启用群组总结 - /enable <群组ID>"),
    BotCommand("disable", "禁用群组总结 - /disable <群组ID>"),
    BotCommand("setschedule", "设置定时任务 - /setschedule <群组ID> <表达式>"),
    BotCommand("status", "查看所有群组状态"),
    BotCommand("summary", "手动触发总结 - /summary <群组ID>"),
    BotCommand("set_linuxdo_token", "设置 Linux.do Token"),
    BotCommand("delete_linuxdo_token", "删除 Linux.do Token"),
    BotCommand("toggle_linuxdo", "开关群组 Linux.do 截图功能"),
]


class TelegramBot:
    """Telegram 消息总结机器人"""

    def __init__(self, config: Optional[BotConfig] = None):
        """
        初始化机器人

        Args:
            config: 机器人配置，为 None 时从环境变量加载
        """
        self.config = config or get_bot_config()
        self.db = BotDatabase(self.config.db_path)
        self.task_manager = TaskManager(self.db)
        self.llm_client = create_llm_client(self.config.llm)

        # Bot API 应用
        self._app: Optional[Application] = None
        self._bot: Optional[Bot] = None

        # 设置全局实例引用
        set_bot_instance(self)
        set_linuxdo_bot_instance(self)

        logger.info(f"机器人初始化完成: {self.config}")

    async def start(self) -> None:
        """启动机器人"""
        # 连接数据库
        await self.db.connect()

        # 设置定时任务回调
        self.task_manager.set_summary_callback(self.run_summary)
        await self.task_manager.start()

        # 创建 Bot 应用
        self._app = Application.builder().token(self.config.bot_token).build()
        self._bot = self._app.bot

        # 注册命令处理器
        register_handlers(self._app)

        # 注册 Linux.do 处理器
        register_linuxdo_handlers(self._app)

        # 注册消息处理器（用于存储群组消息）
        self._app.add_handler(MessageHandler(
            filters.ChatType.GROUPS & ~filters.COMMAND,
            self._on_group_message
        ))
        
        # 启动机器人
        logger.info("机器人启动中...")
        await self._app.initialize()
        await self._app.start()
        await self._app.updater.start_polling(allowed_updates=Update.ALL_TYPES)

        # 自动设置 BotFather 命令列表
        await self._setup_bot_commands()

        logger.info("机器人已启动，等待命令...")

    async def _setup_bot_commands(self) -> None:
        """通过 Bot API 自动设置命令列表"""
        try:
            await self._bot.set_my_commands(BOT_COMMANDS)
            logger.info("已自动设置 BotFather 命令列表")
        except Exception as e:
            logger.warning(f"设置命令列表失败: {e}")
    
    async def stop(self) -> None:
        """停止机器人"""
        logger.info("正在停止机器人...")

        # 停止定时任务
        await self.task_manager.stop()

        # 停止 Bot 应用
        if self._app:
            await self._app.updater.stop()
            await self._app.stop()
            await self._app.shutdown()

        # 关闭数据库
        await self.db.close()

        logger.info("机器人已停止")

    async def _on_group_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """
        处理群组消息
        - 更新群组配置信息
        - 将消息内容存储到数据库供后续总结使用
        """
        chat = update.effective_chat
        message = update.effective_message

        if not chat or chat.type not in ['group', 'supergroup']:
            return

        if not message:
            return

        # 更新群组配置
        config = await self.db.get_group_config(chat.id)
        if config is None:
            config = GroupConfig(group_id=chat.id, group_name=chat.title or "")
        else:
            config.group_name = chat.title or config.group_name
        await self.db.save_group_config(config)

        # 存储消息到数据库
        await self._save_message_to_db(message, chat.id)

    async def _save_message_to_db(self, message: Message, group_id: int) -> None:
        """
        将 Telegram 消息保存到数据库

        Args:
            message: Telegram 消息对象
            group_id: 群组 ID
        """
        try:
            # 获取发送者信息
            sender = message.from_user
            sender_id = sender.id if sender else 0
            sender_name = ""
            if sender:
                sender_name = sender.full_name or sender.username or str(sender.id)

            # 获取消息内容
            content = message.text or message.caption or ""

            # 检测媒体类型
            has_media = False
            media_type = None
            if message.photo:
                has_media = True
                media_type = "photo"
            elif message.video:
                has_media = True
                media_type = "video"
            elif message.document:
                has_media = True
                media_type = "document"
            elif message.audio:
                has_media = True
                media_type = "audio"
            elif message.voice:
                has_media = True
                media_type = "voice"
            elif message.sticker:
                has_media = True
                media_type = "sticker"
            elif message.animation:
                has_media = True
                media_type = "animation"

            # 创建消息对象并保存
            group_message = GroupMessage(
                message_id=message.message_id,
                group_id=group_id,
                sender_id=sender_id,
                sender_name=sender_name,
                content=content,
                message_date=message.date or datetime.now(),
                has_media=has_media,
                media_type=media_type,
            )

            await self.db.save_message(group_message)

        except Exception as e:
            logger.error(f"保存消息失败: {e}")
    
    async def run_summary(self, group_id: int) -> None:
        """
        执行消息总结任务

        Args:
            group_id: 群组 ID
        """
        logger.info(f"开始执行群组 {group_id} 的消息总结")

        config = await self.db.get_group_config(group_id)
        if config is None:
            logger.warning(f"群组 {group_id} 配置不存在")
            return

        try:
            # 从数据库获取未总结的消息
            messages = await self.db.get_unsummarized_messages(group_id, limit=500)

            if not messages:
                logger.info(f"群组 {group_id} 没有待总结的消息")
                return

            # 格式化消息
            formatted_messages = self._format_messages(messages)

            # 调用 LLM 生成总结
            result = await self.llm_client.summarize(formatted_messages)

            if not result.success:
                logger.error(f"总结生成失败: {result.error}")
                return

            # 发送总结
            target_chat_id = config.target_chat_id or group_id
            await self._send_summary(target_chat_id, config.group_name, result, len(messages))

            # 标记消息为已总结
            max_message_id = max(m.message_id for m in messages)
            await self.db.mark_messages_summarized(group_id, max_message_id)

            # 更新配置
            config.last_summary_time = datetime.now()
            config.last_message_id = max_message_id
            await self.db.save_group_config(config)

            logger.info(f"群组 {group_id} 总结完成，共处理 {len(messages)} 条消息")

        except Exception as e:
            logger.error(f"群组 {group_id} 总结失败: {e}")
            raise

    def _format_messages(self, messages: List[GroupMessage]) -> List[str]:
        """
        格式化消息列表

        Args:
            messages: GroupMessage 列表

        Returns:
            格式化后的消息字符串列表
        """
        formatted = []
        for msg in messages:
            time_str = msg.message_date.strftime('%H:%M') if msg.message_date else ""
            sender = msg.sender_name or "Unknown"
            content = msg.content or ""

            if msg.has_media:
                content = f"[{msg.media_type}] {content}" if content else f"[{msg.media_type}]"

            formatted.append(f"[{time_str}] {sender}: {content}")

        return formatted

    def _escape_html(self, text: str) -> str:
        """转义 HTML 特殊字符"""
        return (text
                .replace('&', '&amp;')
                .replace('<', '&lt;')
                .replace('>', '&gt;'))

    async def _send_summary(self, chat_id: int, group_name: str, result: SummaryResult, msg_count: int = 0) -> None:
        """发送总结消息到群组"""
        escaped_content = self._escape_html(result.content)
        escaped_group_name = self._escape_html(group_name)

        # 可展开的折叠引用块，标题和内容都在里面
        summary_text = f'<blockquote expandable>📊 {escaped_group_name}\n\n{escaped_content}</blockquote>'

        try:
            await self._bot.send_message(
                chat_id=chat_id,
                text=summary_text,
                parse_mode='HTML'
            )
        except Exception as e:
            logger.error(f"发送总结消息失败: {e}")
            try:
                await self._bot.send_message(chat_id=chat_id, text=f"📊 {group_name}\n\n{result.content}")
            except Exception as e2:
                logger.error(f"发送纯文本也失败: {e2}")

    async def run_forever(self) -> None:
        """运行机器人直到收到停止信号"""
        await self.start()

        # 保持运行
        stop_event = asyncio.Event()

        def signal_handler():
            stop_event.set()

        # 注册信号处理
        import signal
        import sys

        if sys.platform != 'win32':
            # Unix 系统使用 add_signal_handler
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    asyncio.get_event_loop().add_signal_handler(sig, signal_handler)
                except NotImplementedError:
                    pass

        try:
            if sys.platform == 'win32':
                # Windows 上使用简单的无限循环，依赖 KeyboardInterrupt
                while True:
                    await asyncio.sleep(1)
            else:
                await stop_event.wait()
        except KeyboardInterrupt:
            pass
        finally:
            await self.stop()

