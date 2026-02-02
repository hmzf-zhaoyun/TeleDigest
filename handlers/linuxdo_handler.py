"""
Linux.do 论坛文章截图处理器
识别 Linux.do 链接并截图发送到 Telegram
"""
import re
import logging
import asyncio
from typing import Optional, TYPE_CHECKING, List

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


async def _take_screenshot(url: str, token: Optional[str] = None, proxy: Optional[str] = None) -> List[bytes]:
    """
    使用 Playwright 对 Linux.do 页面截图

    Args:
        url: 页面 URL
        token: Linux.do API Token（用于登录态访问）
        proxy: 代理地址，如 http://127.0.0.1:7890

    Returns:
        截图的 PNG 字节数据列表（长内容会分段截图），失败返回空列表
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.error("Playwright 未安装，请运行: pip install playwright && playwright install chromium")
        return []

    try:
        async with async_playwright() as p:
            # 配置浏览器启动参数
            launch_args = {'headless': True}
            if proxy:
                launch_args['proxy'] = {'server': proxy}

            browser = await p.chromium.launch(**launch_args)

            # 创建浏览器上下文
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                device_scale_factor=2,
                user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            )
            context.set_default_timeout(60000)

            # 设置 Cookie
            if token:
                await context.add_cookies([{
                    'name': '_t',
                    'value': token,
                    'domain': 'linux.do',
                    'path': '/',
                }])

            page = await context.new_page()

            # 访问页面
            logger.info(f"正在访问: {url}")
            await page.goto(url, wait_until='domcontentloaded', timeout=60000)

            # 等待内容加载
            try:
                await page.wait_for_selector('article#post_1', timeout=10000)
            except Exception:
                pass

            await asyncio.sleep(1)

            # 隐藏干扰元素并禁用动画
            await page.evaluate('''
                () => {
                    // 禁用动画
                    const style = document.createElement('style');
                    style.textContent = `
                        *, *::before, *::after {
                            animation: none !important;
                            transition: none !important;
                        }
                    `;
                    document.head.appendChild(style);

                    // 隐藏干扰元素
                    const selectors = [
                        '.sidebar-wrapper', '#d-sidebar', 'header.d-header',
                        '.footer-message', '.modal-outer-container', '.topic-footer-buttons',
                        '.signup-cta', '.crawler-page-link', '.post-links-container'
                    ];
                    selectors.forEach(sel => {
                        document.querySelectorAll(sel).forEach(el => el.style.display = 'none');
                    });

                    // 扩展内容区域
                    const main = document.querySelector('#main-outlet');
                    if (main) {
                        main.style.maxWidth = '100%';
                        main.style.padding = '16px';
                    }
                }
            ''')

            # 等待网络空闲
            try:
                await page.wait_for_load_state('networkidle', timeout=10000)
            except Exception:
                pass

            await asyncio.sleep(0.5)

            # 截图
            logger.info("开始截图...")
            screenshots = []

            try:
                post_element = page.locator('article#post_1').first
                await post_element.wait_for(state='visible', timeout=5000)

                # 滚动到元素并获取文档绝对坐标
                element_rect = await post_element.evaluate('''
                    el => {
                        el.scrollIntoView({ block: 'start' });
                        const rect = el.getBoundingClientRect();
                        return {
                            x: rect.x + window.scrollX,
                            y: rect.y + window.scrollY,
                            width: rect.width,
                            height: rect.height
                        };
                    }
                ''')

                await asyncio.sleep(0.3)

                element_height = element_rect['height']
                element_width = element_rect['width']

                logger.info(f"元素尺寸: {element_width}x{element_height}px")

                # 分段阈值
                MAX_SINGLE_HEIGHT = 8000
                SEGMENT_HEIGHT = 4000

                if element_height <= MAX_SINGLE_HEIGHT:
                    # 使用 page.screenshot + clip（Playwright 原生 API，自动处理坐标）
                    screenshot = await page.screenshot(
                        type='png',
                        clip={
                            'x': element_rect['x'],
                            'y': element_rect['y'],
                            'width': element_width,
                            'height': element_height
                        },
                        animations='disabled',
                        timeout=30000
                    )
                    screenshots.append(screenshot)
                    logger.info("截图完成")
                else:
                    # 分段截图
                    num_segments = int((element_height + SEGMENT_HEIGHT - 1) / SEGMENT_HEIGHT)
                    logger.info(f"内容较长，分 {num_segments} 段截图")

                    for i in range(num_segments):
                        seg_y = element_rect['y'] + i * SEGMENT_HEIGHT
                        seg_height = min(SEGMENT_HEIGHT, element_height - i * SEGMENT_HEIGHT)

                        screenshot = await page.screenshot(
                            type='png',
                            clip={
                                'x': element_rect['x'],
                                'y': seg_y,
                                'width': element_width,
                                'height': seg_height
                            },
                            animations='disabled',
                            timeout=30000
                        )
                        screenshots.append(screenshot)

                    logger.info(f"分段截图完成，共 {len(screenshots)} 张")

            except Exception as e:
                logger.warning(f"元素截图失败: {e}，使用全页截图")
                # 降级：全页截图
                screenshot = await page.screenshot(type='png', full_page=True, timeout=30000)
                screenshots.append(screenshot)

            await browser.close()

            if screenshots:
                logger.info(f"截图成功: {len(screenshots)} 张")

            return screenshots

    except Exception as e:
        logger.error(f"截图失败 {url}: {e}")
        return []


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

    # 获取代理配置
    proxy = _bot_instance.config.linuxdo.proxy

    # 处理每个 URL
    for url in urls[:3]:  # 最多处理 3 个链接
        screenshots = await _take_screenshot(url, token, proxy)

        if screenshots:
            try:
                # 依次发送每张截图
                for i, screenshot in enumerate(screenshots):
                    caption = f"📸 Linux.do 截图 ({i+1}/{len(screenshots)})" if len(screenshots) > 1 else None
                    await message.reply_photo(
                        photo=screenshot,
                        caption=caption,
                        reply_to_message_id=message.message_id
                    )
            except Exception as e:
                logger.error(f"发送截图失败: {e}")
                await message.reply_text(f"❌ 发送截图失败: {e}")
        else:
            await message.reply_text(f"❌ 截图失败")

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
