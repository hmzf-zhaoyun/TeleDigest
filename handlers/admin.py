"""
管理员命令处理器
处理机器人主人的管理命令
"""
import logging
from functools import wraps
from typing import Callable, TYPE_CHECKING

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, CommandHandler, CallbackQueryHandler, Application

if TYPE_CHECKING:
    try:
        from ..bot import TelegramBot
    except ImportError:
        from bot import TelegramBot


logger = logging.getLogger(__name__)

# 全局机器人实例引用
_bot_instance: "TelegramBot" = None

# 回调数据前缀
CALLBACK_GROUP_SELECT = "grp_sel:"      # 选择群组
CALLBACK_GROUP_ENABLE = "grp_en:"       # 启用群组
CALLBACK_GROUP_DISABLE = "grp_dis:"     # 禁用群组
CALLBACK_GROUP_SCHEDULE = "grp_sch:"    # 设置定时
CALLBACK_GROUP_SUMMARY = "grp_sum:"     # 手动总结
CALLBACK_GROUPS_LIST = "grp_list"       # 返回群组列表


def set_bot_instance(bot: "TelegramBot") -> None:
    """设置机器人实例"""
    global _bot_instance
    _bot_instance = bot


def owner_only(func: Callable) -> Callable:
    """仅主人可用的命令装饰器"""
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        user_id = update.effective_user.id
        if not _bot_instance or not _bot_instance.config.is_owner(user_id):
            await update.message.reply_text("⛔ 您没有权限执行此命令")
            return
        return await func(update, context)
    return wrapper


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /start 命令"""
    user = update.effective_user
    is_owner = _bot_instance and _bot_instance.config.is_owner(user.id)

    welcome_text = f"""👋 你好，{user.first_name}！

我是消息总结机器人，可以定时读取群组消息并生成总结。

"""
    if is_owner:
        welcome_text += """✅ 您是机器人主人，可以使用以下命令：

/groups - 📋 交互式群组管理（推荐）
/status - 查看所有群组状态
/help - 查看帮助信息

💡 使用 /groups 可以通过点击按钮管理群组，无需手动输入群组ID"""
    else:
        welcome_text += "ℹ️ 请联系机器人主人进行配置。"

    await update.message.reply_text(welcome_text)


@owner_only
async def enable_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /enable <群组ID> 命令，无参数时显示群组选择列表"""
    if not context.args:
        # 无参数时显示未启用的群组列表供选择
        groups = await _bot_instance.db.get_all_groups()
        disabled_groups = [g for g in groups if not g.enabled]
        if not disabled_groups:
            await update.message.reply_text("📋 没有可启用的群组（所有群组都已启用，或暂无记录的群组）")
            return
        keyboard = []
        for config in disabled_groups:
            group_name = config.group_name or f"群组 {config.group_id}"
            if len(group_name) > 25:
                group_name = group_name[:22] + "..."
            keyboard.append([
                InlineKeyboardButton(
                    f"⭕ {group_name}",
                    callback_data=f"{CALLBACK_GROUP_ENABLE}{config.group_id}"
                )
            ])
        await update.message.reply_text(
            "📋 **选择要启用的群组：**",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='Markdown'
        )
        return

    try:
        group_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ 群组ID必须是数字")
        return

    # 获取或创建群组配置
    from ..storage import GroupConfig
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        config = GroupConfig(group_id=group_id)

    config.enabled = True
    await _bot_instance.db.save_group_config(config)
    await _bot_instance.task_manager.add_group_task(config)

    await update.message.reply_text(f"✅ 已启用群组 {group_id} 的消息总结功能\n定时: {config.schedule}")


@owner_only
async def disable_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /disable <群组ID> 命令，无参数时显示群组选择列表"""
    if not context.args:
        # 无参数时显示已启用的群组列表供选择
        groups = await _bot_instance.db.get_all_groups()
        enabled_groups = [g for g in groups if g.enabled]
        if not enabled_groups:
            await update.message.reply_text("📋 没有可禁用的群组（所有群组都未启用）")
            return
        keyboard = []
        for config in enabled_groups:
            group_name = config.group_name or f"群组 {config.group_id}"
            if len(group_name) > 25:
                group_name = group_name[:22] + "..."
            keyboard.append([
                InlineKeyboardButton(
                    f"✅ {group_name}",
                    callback_data=f"{CALLBACK_GROUP_DISABLE}{config.group_id}"
                )
            ])
        await update.message.reply_text(
            "📋 **选择要禁用的群组：**",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='Markdown'
        )
        return

    try:
        group_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ 群组ID必须是数字")
        return

    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await update.message.reply_text(f"❌ 群组 {group_id} 未配置")
        return

    config.enabled = False
    await _bot_instance.db.save_group_config(config)
    _bot_instance.task_manager.remove_group_task(group_id)

    await update.message.reply_text(f"✅ 已禁用群组 {group_id} 的消息总结功能")


@owner_only
async def set_schedule_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /setschedule <群组ID> <cron表达式或时间间隔> 命令"""
    if len(context.args) < 2:
        await update.message.reply_text(
            "❌ 用法: /setschedule <群组ID> <表达式>\n\n"
            "支持的格式:\n"
            "• Cron: 0 * * * * (每小时)\n"
            "• 间隔: 30m (每30分钟), 2h (每2小时), 1d (每天)"
        )
        return
    
    try:
        group_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ 群组ID必须是数字")
        return
    
    schedule = " ".join(context.args[1:])
    
    from ..storage import GroupConfig
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        config = GroupConfig(group_id=group_id)
    
    config.schedule = schedule
    await _bot_instance.db.save_group_config(config)
    
    if config.enabled:
        await _bot_instance.task_manager.add_group_task(config)
    
    await update.message.reply_text(f"✅ 已设置群组 {group_id} 的定时: {schedule}")


@owner_only
async def status_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /status 命令"""
    groups = await _bot_instance.db.get_all_groups()

    if not groups:
        await update.message.reply_text("📋 暂无配置的群组")
        return

    status_text = "📋 **群组配置状态**\n\n"
    for config in groups:
        status_emoji = "✅" if config.enabled else "❌"
        job_info = _bot_instance.task_manager.get_job_info(config.group_id)
        next_run = job_info['next_run_time'].strftime('%Y-%m-%d %H:%M') if job_info else "未调度"

        status_text += (
            f"{status_emoji} **{config.group_name or config.group_id}**\n"
            f"   ID: `{config.group_id}`\n"
            f"   定时: `{config.schedule}`\n"
            f"   下次执行: {next_run}\n\n"
        )

    await update.message.reply_text(status_text, parse_mode='Markdown')


@owner_only
async def summary_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /summary <群组ID> 命令 - 手动触发总结，无参数时显示群组选择列表"""
    if not context.args:
        # 无参数时显示群组列表供选择
        groups = await _bot_instance.db.get_all_groups()
        if not groups:
            await update.message.reply_text("📋 暂无记录的群组")
            return
        keyboard = []
        for config in groups:
            status_emoji = "✅" if config.enabled else "⭕"
            group_name = config.group_name or f"群组 {config.group_id}"
            if len(group_name) > 25:
                group_name = group_name[:22] + "..."
            keyboard.append([
                InlineKeyboardButton(
                    f"{status_emoji} {group_name}",
                    callback_data=f"{CALLBACK_GROUP_SUMMARY}{config.group_id}"
                )
            ])
        await update.message.reply_text(
            "📋 **选择要总结的群组：**",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode='Markdown'
        )
        return

    try:
        group_id = int(context.args[0])
    except ValueError:
        await update.message.reply_text("❌ 群组ID必须是数字")
        return

    await update.message.reply_text(f"⏳ 正在为群组 {group_id} 生成总结...")

    try:
        await _bot_instance.run_summary(group_id)
        await update.message.reply_text(f"✅ 群组 {group_id} 的总结已完成")
    except Exception as e:
        await update.message.reply_text(f"❌ 总结失败: {e}")


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /help 命令"""
    user = update.effective_user
    is_owner = _bot_instance and _bot_instance.config.is_owner(user.id)

    help_text = """📖 **帮助信息**

**基础命令:**
/start - 启动机器人
/help - 显示此帮助信息

"""
    if is_owner:
        help_text += """**管理命令 (仅主人可用):**
/groups - 📋 交互式群组管理（推荐）
/status - 查看所有群组的配置状态

**传统命令（支持直接输入群组ID）:**
/enable <群组ID> - 启用群组的消息总结功能
/disable <群组ID> - 禁用群组的消息总结功能
/setschedule <群组ID> <表达式> - 设置定时任务
/summary <群组ID> - 手动触发一次总结

**定时表达式格式:**
• Cron 格式: `分 时 日 月 周`
  例: `0 * * * *` (每小时整点)
  例: `0 9 * * *` (每天9点)
• 间隔格式:
  例: `30m` (每30分钟)
  例: `2h` (每2小时)
  例: `1d` (每天)

💡 **推荐使用 /groups 进行交互式管理，无需手动输入群组ID**
"""

    await update.message.reply_text(help_text, parse_mode='Markdown')


@owner_only
async def groups_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /groups 命令 - 显示群组列表并提供交互式管理"""
    groups = await _bot_instance.db.get_all_groups()

    if not groups:
        await update.message.reply_text(
            "📋 暂无记录的群组\n\n"
            "💡 将机器人添加到群组并发送消息后，群组会自动记录。"
        )
        return

    # 构建群组列表键盘
    keyboard = _build_groups_keyboard(groups)

    await update.message.reply_text(
        "📋 **群组列表**\n\n点击群组查看详情和管理选项：",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode='Markdown'
    )


def _build_groups_keyboard(groups) -> list:
    """构建群组列表的 InlineKeyboard"""
    keyboard = []
    for config in groups:
        status_emoji = "✅" if config.enabled else "⭕"
        group_name = config.group_name or f"群组 {config.group_id}"
        # 截断过长的群组名称
        if len(group_name) > 25:
            group_name = group_name[:22] + "..."

        keyboard.append([
            InlineKeyboardButton(
                f"{status_emoji} {group_name}",
                callback_data=f"{CALLBACK_GROUP_SELECT}{config.group_id}"
            )
        ])
    return keyboard


async def _handle_group_select(query, group_id: int) -> None:
    """处理群组选择回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await query.answer("❌ 群组不存在", show_alert=True)
        return

    # 获取任务信息
    job_info = _bot_instance.task_manager.get_job_info(group_id)
    next_run = job_info['next_run_time'].strftime('%Y-%m-%d %H:%M') if job_info else "未调度"

    # 构建详情文本
    status_text = "✅ 已启用" if config.enabled else "⭕ 未启用"
    group_name = config.group_name or f"群组 {group_id}"

    detail_text = f"""📋 **群组详情**

**名称:** {group_name}
**ID:** `{group_id}`
**状态:** {status_text}
**定时:** `{config.schedule}`
**下次执行:** {next_run}
"""
    if config.last_summary_time:
        detail_text += f"**上次总结:** {config.last_summary_time.strftime('%Y-%m-%d %H:%M')}\n"

    # 构建操作按钮
    keyboard = []

    # 启用/禁用按钮
    if config.enabled:
        keyboard.append([
            InlineKeyboardButton("⭕ 禁用总结", callback_data=f"{CALLBACK_GROUP_DISABLE}{group_id}")
        ])
    else:
        keyboard.append([
            InlineKeyboardButton("✅ 启用总结", callback_data=f"{CALLBACK_GROUP_ENABLE}{group_id}")
        ])

    # 设置定时和手动总结按钮
    keyboard.append([
        InlineKeyboardButton("⏰ 设置定时", callback_data=f"{CALLBACK_GROUP_SCHEDULE}{group_id}"),
        InlineKeyboardButton("📝 立即总结", callback_data=f"{CALLBACK_GROUP_SUMMARY}{group_id}")
    ])

    # 返回列表按钮
    keyboard.append([
        InlineKeyboardButton("« 返回列表", callback_data=CALLBACK_GROUPS_LIST)
    ])

    await query.edit_message_text(
        detail_text,
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode='Markdown'
    )


async def _handle_group_enable(query, group_id: int) -> None:
    """处理启用群组回调"""
    from ..storage import GroupConfig as GC
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        config = GC(group_id=group_id)

    config.enabled = True
    await _bot_instance.db.save_group_config(config)
    await _bot_instance.task_manager.add_group_task(config)

    await query.answer("✅ 已启用群组总结")
    await _handle_group_select(query, group_id)


async def _handle_group_disable(query, group_id: int) -> None:
    """处理禁用群组回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    if config is None:
        await query.answer("❌ 群组不存在", show_alert=True)
        return

    config.enabled = False
    await _bot_instance.db.save_group_config(config)
    _bot_instance.task_manager.remove_group_task(group_id)

    await query.answer("⭕ 已禁用群组总结")
    await _handle_group_select(query, group_id)


async def _handle_group_schedule(query, group_id: int) -> None:
    """处理设置定时回调 - 提示用户使用命令"""
    config = await _bot_instance.db.get_group_config(group_id)
    group_name = config.group_name if config else f"群组 {group_id}"

    await query.answer()
    await query.message.reply_text(
        f"⏰ **设置定时任务 - {group_name}**\n\n"
        f"请发送以下命令设置定时：\n"
        f"`/setschedule {group_id} <表达式>`\n\n"
        f"**支持的格式：**\n"
        f"• Cron: `0 * * * *` (每小时)\n"
        f"• 间隔: `30m` / `2h` / `1d`\n\n"
        f"**示例：**\n"
        f"`/setschedule {group_id} 1h` - 每小时\n"
        f"`/setschedule {group_id} 0 9 * * *` - 每天9点",
        parse_mode='Markdown'
    )


async def _handle_group_summary(query, group_id: int) -> None:
    """处理手动总结回调"""
    config = await _bot_instance.db.get_group_config(group_id)
    group_name = config.group_name if config else f"群组 {group_id}"

    await query.answer("⏳ 正在生成总结...")

    try:
        await _bot_instance.run_summary(group_id)
        await query.message.reply_text(f"✅ {group_name} 的总结已完成")
    except Exception as e:
        await query.message.reply_text(f"❌ 总结失败: {e}")


async def _handle_groups_list(query) -> None:
    """处理返回群组列表回调"""
    groups = await _bot_instance.db.get_all_groups()

    if not groups:
        await query.edit_message_text("📋 暂无记录的群组")
        return

    keyboard = _build_groups_keyboard(groups)

    await query.edit_message_text(
        "📋 **群组列表**\n\n点击群组查看详情和管理选项：",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode='Markdown'
    )


async def callback_query_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理所有 InlineKeyboard 回调"""
    query = update.callback_query
    user_id = query.from_user.id

    # 权限检查
    if not _bot_instance or not _bot_instance.config.is_owner(user_id):
        await query.answer("⛔ 您没有权限执行此操作", show_alert=True)
        return

    data = query.data

    try:
        if data.startswith(CALLBACK_GROUP_SELECT):
            group_id = int(data[len(CALLBACK_GROUP_SELECT):])
            await _handle_group_select(query, group_id)

        elif data.startswith(CALLBACK_GROUP_ENABLE):
            group_id = int(data[len(CALLBACK_GROUP_ENABLE):])
            await _handle_group_enable(query, group_id)

        elif data.startswith(CALLBACK_GROUP_DISABLE):
            group_id = int(data[len(CALLBACK_GROUP_DISABLE):])
            await _handle_group_disable(query, group_id)

        elif data.startswith(CALLBACK_GROUP_SCHEDULE):
            group_id = int(data[len(CALLBACK_GROUP_SCHEDULE):])
            await _handle_group_schedule(query, group_id)

        elif data.startswith(CALLBACK_GROUP_SUMMARY):
            group_id = int(data[len(CALLBACK_GROUP_SUMMARY):])
            await _handle_group_summary(query, group_id)

        elif data == CALLBACK_GROUPS_LIST:
            await _handle_groups_list(query)

        else:
            await query.answer("未知操作")

    except Exception as e:
        logger.error(f"处理回调失败: {e}")
        await query.answer(f"❌ 操作失败: {e}", show_alert=True)


def register_handlers(app: Application) -> None:
    """注册所有命令处理器"""
    # 命令处理器
    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("groups", groups_command))
    app.add_handler(CommandHandler("enable", enable_command))
    app.add_handler(CommandHandler("disable", disable_command))
    app.add_handler(CommandHandler("setschedule", set_schedule_command))
    app.add_handler(CommandHandler("status", status_command))
    app.add_handler(CommandHandler("summary", summary_command))

    # 回调查询处理器
    app.add_handler(CallbackQueryHandler(callback_query_handler))

