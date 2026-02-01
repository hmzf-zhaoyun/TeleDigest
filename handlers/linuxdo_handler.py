"""
Linux.do 论坛文章截图处理器
识别 Linux.do 链接并截图发送到 Telegram
"""
import re
import logging
import asyncio
from typing import Optional, TYPE_CHECKING

from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, filters, CommandHandler, Application

if TYPE_CHECKING:
    try:
        from ..bot import TelegramBot
    except ImportError:
        from bot import TelegramBot


logger = logging.getLogger(__name__)

# 全局机器人实例引用
_bot_instance: "TelegramBot" = None

# Linux.do URL 正则匹配
LINUXDO_URL_PATTERN = re.compile(
    r'https?://(?:www\.)?linux\.do/(?:t|p)/[^\s<>\[\]()]+',
    re.IGNORECASE
)


def set_linuxdo_bot_instance(bot: "TelegramBot") -> None:
    """设置机器人实例"""
    global _bot_instance
    _bot_instance = bot


async def _take_screenshot(url: str, token: Optional[str] = None) -> Optional[bytes]:
    """
    使用 Playwright 对 Linux.do 页面截图

    Args:
        url: 页面 URL
        token: Linux.do API Token（用于登录态访问）

    Returns:
        截图的 PNG 字节数据，失败返回 None
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("Playwright 未安装，请运行: pip install playwright && playwright install chromium")
        return None

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)

            # 创建浏览器上下文
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            )

            # 如果有 Token，设置 Cookie
            if token:
                await context.add_cookies([{
                    'name': '_t',
                    'value': token,
                    'domain': 'linux.do',
                    'path': '/',
                }])

            page = await context.new_page()

            # 访问页面
            await page.goto(url, wait_until='networkidle', timeout=30000)

            # 等待内容加载
            await asyncio.sleep(1)

            # 尝试隐藏一些干扰元素
            await page.evaluate('''
                () => {
                    // 隐藏顶部导航栏的固定定位，避免遮挡
                    const header = document.querySelector('header.d-header');
                    if (header) header.style.position = 'absolute';
                    // 隐藏底部悬浮元素
                    const footer = document.querySelector('.footer-message');
                    if (footer) footer.style.display = 'none';
                }
            ''')

            # 截图
            screenshot = await page.screenshot(full_page=True, type='png')

            await browser.close()
            logger.info(f"截图成功: {url}")
            return screenshot

    except Exception as e:
        logger.error(f"截图失败 {url}: {e}")
        return None


async def _handle_linuxdo_url(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理包含 Linux.do 链接的消息"""
    if not _bot_instance:
        return

    message = update.effective_message
    chat = update.effective_chat
    user = update.effective_user

    if not message or not message.text:
        return

    # 检查全局功能开关
    if not _bot_instance.config.linuxdo.enabled:
        return

    # 检查群组功能开关
    if chat and chat.type in ['group', 'supergroup']:
        config = await _bot_instance.db.get_group_config(chat.id)
        if config and not config.linuxdo_enabled:
            return

    # 提取 URL
    urls = LINUXDO_URL_PATTERN.findall(message.text)
    if not urls:
        return

    # 获取 Token（优先用户 Token，其次全局 Token）
    token = None
    if user:
        token = await _bot_instance.db.get_user_token(user.id)
    if not token:
        token = _bot_instance.config.linuxdo.api_token

    # 发送处理中提示
    processing_msg = await message.reply_text("📸 正在截图 Linux.do 文章...")

    # 处理每个 URL
    for url in urls[:3]:  # 最多处理 3 个链接
        screenshot = await _take_screenshot(url, token)

        if screenshot:
            try:
                await message.reply_photo(
                    photo=screenshot,
                    caption=f"📄 {url}",
                    reply_to_message_id=message.message_id
                )
            except Exception as e:
                logger.error(f"发送截图失败: {e}")
                await message.reply_text(f"❌ 发送截图失败: {e}")
        else:
            await message.reply_text(f"❌ 截图失败: {url}")

    # 删除处理中提示
    try:
        await processing_msg.delete()
    except Exception:
        pass


async def set_token_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /set_linuxdo_token 命令"""
    user = update.effective_user
    message = update.effective_message

    if not user or not message:
        return

    if not context.args:
        await message.reply_text(
            "❌ 用法: `/set_linuxdo_token <your_token>`\n\n"
            "💡 Token 获取方式:\n"
            "1. 登录 linux.do\n"
            "2. 打开浏览器开发者工具 (F12)\n"
            "3. 在 Application > Cookies 中找到 `_t` 的值",
            parse_mode='Markdown'
        )
        return

    token = context.args[0]

    # 保存 Token
    if _bot_instance:
        await _bot_instance.db.save_user_token(user.id, token)
        # 删除包含 Token 的消息（安全考虑）
        try:
            await message.delete()
        except Exception:
            pass
        await update.effective_chat.send_message(
            f"✅ Token 已保存！\n\n"
            f"💡 为了安全，包含 Token 的消息已被删除。\n"
            f"现在发送 Linux.do 链接将使用你的账号访问。"
        )
    else:
        await message.reply_text("❌ 机器人未初始化")


async def delete_token_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /delete_linuxdo_token 命令"""
    user = update.effective_user
    message = update.effective_message

    if not user or not message:
        return

    if _bot_instance:
        deleted = await _bot_instance.db.delete_user_token(user.id)
        if deleted:
            await message.reply_text("✅ 你的 Linux.do Token 已删除")
        else:
            await message.reply_text("ℹ️ 你没有保存过 Token")
    else:
        await message.reply_text("❌ 机器人未初始化")


async def toggle_linuxdo_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /toggle_linuxdo 命令（仅主人可用，控制群组开关）"""
    user = update.effective_user
    chat = update.effective_chat
    message = update.effective_message

    if not user or not chat or not message:
        return

    # 权限检查
    if not _bot_instance or not _bot_instance.config.is_owner(user.id):
        await message.reply_text("⛔ 您没有权限执行此命令")
        return

    # 只能在群组中使用
    if chat.type not in ['group', 'supergroup']:
        await message.reply_text("❌ 此命令只能在群组中使用")
        return

    # 获取当前配置
    config = await _bot_instance.db.get_group_config(chat.id)
    if not config:
        await message.reply_text("❌ 群组未配置，请先发送消息让机器人记录群组")
        return

    # 切换状态
    new_status = not config.linuxdo_enabled
    await _bot_instance.db.set_group_linuxdo_enabled(chat.id, new_status)

    status_text = "✅ 已启用" if new_status else "⭕ 已禁用"
    await message.reply_text(f"📸 Linux.do 截图功能: {status_text}")


def register_linuxdo_handlers(app: Application) -> None:
    """注册 Linux.do 相关处理器"""
    # URL 消息处理器（优先级较低，让其他处理器先处理）
    app.add_handler(MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.Regex(LINUXDO_URL_PATTERN),
        _handle_linuxdo_url
    ), group=10)

    # 命令处理器
    app.add_handler(CommandHandler("set_linuxdo_token", set_token_command))
    app.add_handler(CommandHandler("delete_linuxdo_token", delete_token_command))
    app.add_handler(CommandHandler("toggle_linuxdo", toggle_linuxdo_command))
