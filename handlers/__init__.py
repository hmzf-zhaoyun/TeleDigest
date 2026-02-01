"""
命令处理器模块
提供机器人命令处理功能
"""

try:
    from .admin import (
        start_command,
        enable_command,
        disable_command,
        set_schedule_command,
        status_command,
        summary_command,
        help_command,
        groups_command,
        callback_query_handler,
        register_handlers,
    )
except ImportError:
    from admin import (
        start_command,
        enable_command,
        disable_command,
        set_schedule_command,
        status_command,
        summary_command,
        help_command,
        groups_command,
        callback_query_handler,
        register_handlers,
    )

__all__ = [
    "start_command",
    "enable_command",
    "disable_command",
    "set_schedule_command",
    "status_command",
    "summary_command",
    "help_command",
    "groups_command",
    "callback_query_handler",
    "register_handlers",
]

