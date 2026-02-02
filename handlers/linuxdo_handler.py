"""
Linux.do 论坛文章截图处理器
识别 Linux.do 链接并截图发送到 Telegram
"""
import re
import logging
import asyncio
import base64
import math
from typing import Optional, TYPE_CHECKING, List

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

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
            device_scale_factor = 2
            context = await browser.new_context(
                viewport={'width': 1280, 'height': 800},
                device_scale_factor=device_scale_factor,
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
            cdp_session = await context.new_cdp_session(page)

            def _normalize_clip(x: float, y: float, width: float, height: float, scale: float) -> dict:
                safe_scale = float(scale) if scale and scale > 0 else 1.0
                return {
                    'x': max(0.0, math.floor(x)),
                    'y': max(0.0, math.floor(y)),
                    'width': max(1.0, math.ceil(width)),
                    'height': max(1.0, math.ceil(height)),
                    'scale': safe_scale
                }

            async def _capture_cdp(clip: Optional[dict] = None) -> bytes:
                params = {
                    'format': 'png',
                    'fromSurface': True,
                    'captureBeyondViewport': True
                }
                if clip:
                    params['clip'] = clip
                result = await cdp_session.send('Page.captureScreenshot', params)
                return base64.b64decode(result['data'])

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
                            x: rect.left + window.scrollX,
                            y: rect.top + window.scrollY,
                            width: rect.width,
                            height: rect.height
                        };
                    }
                ''')

                await asyncio.sleep(0.3)

                element_height = element_rect['height']
                element_width = element_rect['width']
                element_x = element_rect['x']
                element_y = element_rect['y']
                scale_factor = device_scale_factor if device_scale_factor and device_scale_factor > 0 else 1.0

                logger.info("页面已就绪，准备截图")
                logger.info(f"元素尺寸: {element_width}x{element_height}px")

                # 分段阈值（以设备像素为基准，按 scale 换算为 CSS 像素）
                MAX_SINGLE_HEIGHT = 8000
                SEGMENT_HEIGHT = 4000
                safe_scale = scale_factor if scale_factor and scale_factor > 0 else 1.0
                max_single_css_height = MAX_SINGLE_HEIGHT / safe_scale
                segment_css_height = SEGMENT_HEIGHT / safe_scale
                single_css_threshold = min(max_single_css_height, segment_css_height)

                async def _get_scroll() -> dict:
                    return await page.evaluate('() => ({ x: window.scrollX, y: window.scrollY })')

                if element_height <= single_css_threshold:
                    logger.info("截图模式: 单次 CDP")
                    await page.evaluate('y => window.scrollTo(0, y)', element_y)
                    await asyncio.sleep(0.1)
                    scroll = await _get_scroll()
                    clip = _normalize_clip(
                        element_x - scroll['x'],
                        element_y - scroll['y'],
                        element_width,
                        element_height,
                        scale_factor
                    )
                    screenshots.append(await _capture_cdp(clip))
                else:
                    # 分段截图
                    num_segments = int(math.ceil(element_height / segment_css_height))
                    logger.info(f"截图模式: 分段 CDP ({num_segments} 段)")

                    for i in range(num_segments):
                        seg_y = element_y + i * segment_css_height
                        seg_height = min(segment_css_height, element_height - i * segment_css_height)
                        await page.evaluate('y => window.scrollTo(0, y)', seg_y)
                        await asyncio.sleep(0.1)
                        scroll = await _get_scroll()
                        clip = _normalize_clip(
                            element_x - scroll['x'],
                            seg_y - scroll['y'],
                            element_width,
                            seg_height,
                            scale_factor
                        )
                        screenshots.append(await _capture_cdp(clip))

            except Exception as e:
                logger.warning(f"元素截图失败: {e}，使用全页截图")
                # 降级：全页截图
                screenshots.append(await _capture_cdp())

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


CALLBACK_LINUXDO_GROUP_SELECT = "linuxdo_sel:"
CALLBACK_LINUXDO_TOGGLE = "linuxdo_toggle:"
CALLBACK_LINUXDO_LIST = "linuxdo_list"


async def toggle_linuxdo_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /toggle_linuxdo 命令（仅私聊）"""
    if not _bot_instance:
        return

    user = update.effective_user
    chat = update.effective_chat
    message = update.effective_message

    if not user or not chat or not message:
        return

    if not _bot_instance.config.is_owner(user.id):
        await message.reply_text("⛔ 您没有权限执行此命令")
        return

    if chat.type != "private":
        await message.reply_text("请在私聊中使用此命令")
        return

    groups = await _bot_instance.db.get_all_groups()
    if not groups:
        await message.reply_text("📋 暂无记录的群组")
        return

    keyboard = _build_linuxdo_groups_keyboard(groups)
    await message.reply_text(
        "📸 **选择要配置的群组：**",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )


def _build_linuxdo_groups_keyboard(groups) -> list:
    """构建 Linux.do 群组列表键盘"""
    keyboard = []
    for config in groups:
        status_emoji = "✅" if config.linuxdo_enabled else "⭕"
        group_name = config.group_name or f"群组 {config.group_id}"
        if len(group_name) > 25:
            group_name = group_name[:22] + "..."
        keyboard.append([
            InlineKeyboardButton(
                f"{status_emoji} {group_name}",
                callback_data=f"{CALLBACK_LINUXDO_GROUP_SELECT}{config.group_id}",
            )
        ])
    return keyboard


async def _handle_linuxdo_group_select(query, group_id: int) -> None:
    """处理 Linux.do 群组选择回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await query.answer("❌ 群组不存在", show_alert=True)
        return

    status_text = "✅ 已启用" if config.linuxdo_enabled else "⭕ 未启用"
    group_name = config.group_name or f"群组 {group_id}"

    detail_text = f"""📸 **Linux.do 截图设置**

**名称:** {group_name}
**ID:** `{group_id}`
**状态:** {status_text}
"""

    keyboard = []
    if config.linuxdo_enabled:
        keyboard.append([
            InlineKeyboardButton(
                "⭕ 禁用截图",
                callback_data=f"{CALLBACK_LINUXDO_TOGGLE}{group_id}",
            )
        ])
    else:
        keyboard.append([
            InlineKeyboardButton(
                "✅ 启用截图",
                callback_data=f"{CALLBACK_LINUXDO_TOGGLE}{group_id}",
            )
        ])

    keyboard.append([
        InlineKeyboardButton("« 返回列表", callback_data=CALLBACK_LINUXDO_LIST)
    ])

    await query.edit_message_text(
        detail_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )


async def _handle_linuxdo_toggle(query, group_id: int) -> None:
    """处理 Linux.do 开关回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await query.answer("❌ 群组不存在", show_alert=True)
        return

    new_status = not config.linuxdo_enabled
    await _bot_instance.db.set_group_linuxdo_enabled(group_id, new_status)

    status_text = "✅ 已启用" if new_status else "⭕ 已禁用"
    await query.answer(f"📸 Linux.do 截图功能: {status_text}")
    await _handle_linuxdo_group_select(query, group_id)


async def _handle_linuxdo_groups_list(query) -> None:
    """处理 Linux.do 群组列表回调"""
    groups = await _bot_instance.db.get_all_groups()
    if not groups:
        await query.edit_message_text("📋 暂无记录的群组")
        return

    keyboard = _build_linuxdo_groups_keyboard(groups)
    await query.edit_message_text(
        "📸 **选择要配置的群组：**",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )


async def _handle_linuxdo_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 Linux.do 相关回调"""
    if not _bot_instance:
        return

    query = update.callback_query
    if not query:
        return

    user_id = query.from_user.id if query.from_user else None
    if not user_id or not _bot_instance.config.is_owner(user_id):
        await query.answer("⛔ 您没有权限执行此操作", show_alert=True)
        return

    data = query.data or ""

    try:
        if data.startswith(CALLBACK_LINUXDO_GROUP_SELECT):
            group_id = int(data[len(CALLBACK_LINUXDO_GROUP_SELECT):])
            await _handle_linuxdo_group_select(query, group_id)
        elif data.startswith(CALLBACK_LINUXDO_TOGGLE):
            group_id = int(data[len(CALLBACK_LINUXDO_TOGGLE):])
            await _handle_linuxdo_toggle(query, group_id)
        elif data == CALLBACK_LINUXDO_LIST:
            await _handle_linuxdo_groups_list(query)
        else:
            await query.answer("未知操作")
    except Exception as exc:
        logger.error(f"处理 Linux.do 回调失败: {exc}")
        await query.answer("❌ 操作失败", show_alert=True)


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
