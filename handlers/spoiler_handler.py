"""剧透模式处理器"""
from __future__ import annotations

import logging
import re
from html import escape
from typing import Optional

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters

try:
    from ..bot import Bot
except ImportError:  # pragma: no cover - 兼容直接运行
    from bot import Bot

logger = logging.getLogger(__name__)
_bot_instance: Optional[Bot] = None


def set_spoiler_bot_instance(bot_instance: Bot) -> None:
    """设置全局 Bot 实例"""
    global _bot_instance
    _bot_instance = bot_instance


def _wrap_spoiler_html(text: str) -> str:
    """包装为 Telegram 剧透格式（HTML）"""
    return f'<span class="tg-spoiler">{escape(text)}</span>'


async def _is_admin_or_owner(chat, user) -> bool:
    """判断是否为群组管理员或机器人主人"""
    if not chat or not user:
        return False
    if _bot_instance and _bot_instance.config.is_owner(user.id):
        return True
    try:
        member = await chat.get_member(user.id)
        return member.status in ("administrator", "creator")
    except Exception:
        return False


def _is_forwarded_message(message) -> bool:
    """判断消息是否为转发"""
    if not message:
        return False
    if getattr(message, "forward_origin", None):
        return True
    return bool(getattr(message, "forward_from", None) or getattr(message, "forward_from_chat", None))


def _has_nsfw_tag(message) -> bool:
    """判断消息是否包含 #nsfw 标签（不区分大小写）"""
    if not message:
        return False
    text = message.text or message.caption or ""
    return bool(re.search(r"(?i)#nsfw", text))


def _get_forward_origin_info(message) -> Optional[str]:
    """提取转发来源信息，返回带链接的 HTML 格式字符串"""
    if not message:
        return None

    # 优先使用 forward_origin（Bot API 7.0+）
    origin = getattr(message, "forward_origin", None)
    if origin:
        origin_type = getattr(origin, "type", None)
        if origin_type == "channel":
            chat = getattr(origin, "chat", None)
            if chat:
                title = escape(chat.title or "频道")
                username = getattr(chat, "username", None)
                msg_id = getattr(origin, "message_id", None)
                if username and msg_id:
                    return f'📤 转发自: <a href="https://t.me/{username}/{msg_id}">{title}</a>'
                elif username:
                    return f'📤 转发自: <a href="https://t.me/{username}">{title}</a>'
                return f"📤 转发自: {title}"
        elif origin_type == "chat":
            chat = getattr(origin, "sender_chat", None)
            if chat:
                title = escape(chat.title or "群组")
                username = getattr(chat, "username", None)
                if username:
                    return f'📤 转发自: <a href="https://t.me/{username}">{title}</a>'
                return f"📤 转发自: {title}"
        elif origin_type == "user":
            user = getattr(origin, "sender_user", None)
            if user:
                name = escape(user.full_name or "用户")
                username = getattr(user, "username", None)
                if username:
                    return f'📤 转发自: <a href="https://t.me/{username}">{name}</a>'
                return f"📤 转发自: {name}"
        elif origin_type == "hidden_user":
            name = getattr(origin, "sender_user_name", None)
            if name:
                return f"📤 转发自: {escape(name)}"
        return None

    # 兼容旧版 Bot API（forward_from_chat / forward_from）
    forward_chat = getattr(message, "forward_from_chat", None)
    if forward_chat:
        title = escape(forward_chat.title or "频道")
        username = getattr(forward_chat, "username", None)
        msg_id = getattr(message, "forward_from_message_id", None)
        if username and msg_id:
            return f'📤 转发自: <a href="https://t.me/{username}/{msg_id}">{title}</a>'
        elif username:
            return f'📤 转发自: <a href="https://t.me/{username}">{title}</a>'
        return f"📤 转发自: {title}"

    forward_from = getattr(message, "forward_from", None)
    if forward_from:
        name = escape(forward_from.full_name or "用户")
        username = getattr(forward_from, "username", None)
        if username:
            return f'📤 转发自: <a href="https://t.me/{username}">{name}</a>'
        return f"📤 转发自: {name}"

    return None


async def _handle_forwarded_spoiler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理转发或 #nsfw 标签消息的剧透转换"""
    if not _bot_instance:
        return

    message = update.effective_message
    chat = update.effective_chat
    user = update.effective_user

    if not message or not chat or chat.type not in ("group", "supergroup"):
        return
    if not _is_forwarded_message(message) and not _has_nsfw_tag(message):
        return
    if not await _is_admin_or_owner(chat, user):
        return

    config = await _bot_instance.db.get_group_config(chat.id)
    if not config or not config.spoiler_enabled:
        return

    text = message.text or message.caption or ""
    spoiler_text = _wrap_spoiler_html(text) if text else ""

    # 提取转发来源信息
    forward_info = _get_forward_origin_info(message)

    # 构建最终消息文本
    if forward_info and spoiler_text:
        final_text = f"{forward_info}\n\n{spoiler_text}"
    elif forward_info:
        final_text = forward_info
    else:
        final_text = spoiler_text

    try:
        if message.photo:
            await chat.send_photo(
                photo=message.photo[-1].file_id,
                caption=final_text if final_text else None,
                parse_mode="HTML" if final_text else None,
                has_spoiler=True,
            )
        else:
            if not final_text:
                return
            await chat.send_message(
                text=final_text,
                parse_mode="HTML",
            )

        # 使用群组配置的 spoiler_auto_delete 开关
        if config.spoiler_auto_delete:
            try:
                await message.delete()
            except Exception:
                pass
    except Exception:
        logger.exception("剧透模式转换失败")
        try:
            await chat.send_message("❌ 转换失败，请稍后重试")
        except Exception:
            pass


CALLBACK_SPOILER_GROUP_SELECT = "spoiler_sel:"
CALLBACK_SPOILER_TOGGLE = "spoiler_toggle:"
CALLBACK_SPOILER_LIST = "spoiler_list"


async def toggle_spoiler_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """开关群组剧透模式（私聊）"""
    if not _bot_instance:
        return

    message = update.effective_message
    chat = update.effective_chat
    user = update.effective_user

    if not message or not chat or not user:
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

    keyboard = _build_spoiler_groups_keyboard(groups)
    await message.reply_text(
        "🫥 **选择要配置的群组：**",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )


def _build_spoiler_groups_keyboard(groups) -> list:
    """构建剧透模式群组列表键盘"""
    keyboard = []
    for config in groups:
        status_emoji = "✅" if config.spoiler_enabled else "⭕"
        group_name = config.group_name or f"群组 {config.group_id}"
        if len(group_name) > 25:
            group_name = group_name[:22] + "..."
        keyboard.append([
            InlineKeyboardButton(
                f"{status_emoji} {group_name}",
                callback_data=f"{CALLBACK_SPOILER_GROUP_SELECT}{config.group_id}",
            )
        ])
    return keyboard


async def _handle_spoiler_group_select(query, group_id: int) -> None:
    """处理剧透群组选择回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await query.answer("❌ 群组不存在", show_alert=True)
        return

    status_text = "✅ 已启用" if config.spoiler_enabled else "⭕ 未启用"
    group_name = config.group_name or f"群组 {group_id}"

    detail_text = f"""🫥 **剧透模式设置**

**名称:** {group_name}
**ID:** `{group_id}`
**状态:** {status_text}
"""

    keyboard = []
    if config.spoiler_enabled:
        keyboard.append([
            InlineKeyboardButton(
                "⭕ 禁用剧透",
                callback_data=f"{CALLBACK_SPOILER_TOGGLE}{group_id}",
            )
        ])
    else:
        keyboard.append([
            InlineKeyboardButton(
                "✅ 启用剧透",
                callback_data=f"{CALLBACK_SPOILER_TOGGLE}{group_id}",
            )
        ])

    keyboard.append([
        InlineKeyboardButton("« 返回列表", callback_data=CALLBACK_SPOILER_LIST)
    ])

    await query.edit_message_text(
        detail_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )


async def _handle_spoiler_toggle(query, group_id: int) -> None:
    """处理剧透开关回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await query.answer("❌ 群组不存在", show_alert=True)
        return

    new_status = not config.spoiler_enabled
    await _bot_instance.db.set_group_spoiler_enabled(group_id, new_status)

    status_text = "✅ 已启用" if new_status else "⭕ 已禁用"
    await query.answer(f"🫥 剧透模式{status_text}")
    await _handle_spoiler_group_select(query, group_id)


async def _handle_spoiler_groups_list(query) -> None:
    """处理剧透群组列表回调"""
    groups = await _bot_instance.db.get_all_groups()
    if not groups:
        await query.edit_message_text("📋 暂无记录的群组")
        return

    keyboard = _build_spoiler_groups_keyboard(groups)
    await query.edit_message_text(
        "🫥 **选择要配置的群组：**",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown",
    )


async def _handle_spoiler_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理剧透相关回调"""
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
        if data.startswith(CALLBACK_SPOILER_GROUP_SELECT):
            group_id = int(data[len(CALLBACK_SPOILER_GROUP_SELECT):])
            await _handle_spoiler_group_select(query, group_id)
        elif data.startswith(CALLBACK_SPOILER_TOGGLE):
            group_id = int(data[len(CALLBACK_SPOILER_TOGGLE):])
            await _handle_spoiler_toggle(query, group_id)
        elif data == CALLBACK_SPOILER_LIST:
            await _handle_spoiler_groups_list(query)
        else:
            await query.answer("未知操作")
    except Exception as exc:
        logger.error(f"处理剧透回调失败: {exc}")
        await query.answer("❌ 操作失败", show_alert=True)


def register_spoiler_handlers(application) -> None:
    """注册剧透处理器"""
    application.add_handler(
        MessageHandler(
            filters.PHOTO | filters.TEXT,
            _handle_forwarded_spoiler,
        ),
        group=9,
    )

