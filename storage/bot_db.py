"""
机器人数据库模块
使用 SQLite 存储群组配置、消息和定时任务信息
"""
import logging
import aiosqlite
import base64
import hashlib
from pathlib import Path
from datetime import datetime
from typing import Optional, List
from dataclasses import dataclass, field


logger = logging.getLogger(__name__)


@dataclass
class GroupConfig:
    """群组配置数据模型"""
    group_id: int
    group_name: str = ""
    enabled: bool = False
    schedule: str = "0 * * * *"  # 默认每小时整点
    target_chat_id: Optional[int] = None  # 总结发送目标，None 表示发送到群组本身
    last_summary_time: Optional[datetime] = None
    last_message_id: int = 0  # 上次总结时的最后消息 ID
    linuxdo_enabled: bool = True  # Linux.do 截图功能开关
    spoiler_enabled: bool = False  # 剧透模式开关
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            'group_id': self.group_id,
            'group_name': self.group_name,
            'enabled': self.enabled,
            'schedule': self.schedule,
            'target_chat_id': self.target_chat_id,
            'last_summary_time': self.last_summary_time.isoformat() if self.last_summary_time else None,
            'last_message_id': self.last_message_id,
            'linuxdo_enabled': self.linuxdo_enabled,
            'spoiler_enabled': self.spoiler_enabled,
            'created_at': self.created_at.isoformat(),
            'updated_at': self.updated_at.isoformat(),
        }


@dataclass
class GroupMessage:
    """群组消息数据模型"""
    message_id: int
    group_id: int
    sender_id: int
    sender_name: str
    content: str
    message_date: datetime
    has_media: bool = False
    media_type: Optional[str] = None
    is_summarized: bool = False  # 是否已被总结
    created_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        """转换为字典"""
        return {
            'message_id': self.message_id,
            'group_id': self.group_id,
            'sender_id': self.sender_id,
            'sender_name': self.sender_name,
            'content': self.content,
            'message_date': self.message_date.isoformat(),
            'has_media': self.has_media,
            'media_type': self.media_type,
            'is_summarized': self.is_summarized,
            'created_at': self.created_at.isoformat(),
        }


class BotDatabase:
    """机器人数据库管理类"""

    def __init__(self, db_path: Path):
        """
        初始化数据库

        Args:
            db_path: 数据库文件路径
        """
        self.db_path = db_path
        self._connection: Optional[aiosqlite.Connection] = None

    async def connect(self) -> None:
        """连接数据库并初始化表结构"""
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = await aiosqlite.connect(str(self.db_path))
        self._connection.row_factory = aiosqlite.Row
        await self._init_tables()
        logger.info(f"数据库已连接: {self.db_path}")

    async def close(self) -> None:
        """关闭数据库连接"""
        if self._connection:
            await self._connection.close()
            self._connection = None
            logger.info("数据库连接已关闭")

    async def _init_tables(self) -> None:
        """初始化数据库表"""
        # 群组配置表
        await self._connection.execute('''
            CREATE TABLE IF NOT EXISTS group_configs (
                group_id INTEGER PRIMARY KEY,
                group_name TEXT DEFAULT '',
                enabled INTEGER DEFAULT 0,
                schedule TEXT DEFAULT '0 * * * *',
                target_chat_id INTEGER,
                last_summary_time TEXT,
                last_message_id INTEGER DEFAULT 0,
                linuxdo_enabled INTEGER DEFAULT 1,
                spoiler_enabled INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # 用户 Token 存储表（加密存储）
        await self._connection.execute('''
            CREATE TABLE IF NOT EXISTS user_tokens (
                user_id INTEGER PRIMARY KEY,
                linuxdo_token TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # 群组消息表（用于存储 Bot API 收到的消息）
        await self._connection.execute('''
            CREATE TABLE IF NOT EXISTS group_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id INTEGER NOT NULL,
                group_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                sender_name TEXT DEFAULT '',
                content TEXT DEFAULT '',
                message_date TEXT NOT NULL,
                has_media INTEGER DEFAULT 0,
                media_type TEXT,
                is_summarized INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, message_id)
            )
        ''')

        # 创建索引以加速查询
        await self._connection.execute('''
            CREATE INDEX IF NOT EXISTS idx_messages_group_summarized
            ON group_messages(group_id, is_summarized)
        ''')
        await self._connection.execute('''
            CREATE INDEX IF NOT EXISTS idx_messages_date
            ON group_messages(message_date)
        ''')

        # 数据库迁移：为旧表添加 linuxdo_enabled 字段
        await self._migrate_add_linuxdo_enabled()

        # 数据库迁移：为旧表添加 spoiler_enabled 字段
        await self._migrate_add_spoiler_enabled()

        await self._connection.commit()

    async def _migrate_add_linuxdo_enabled(self) -> None:
        """迁移：为 group_configs 表添加 linuxdo_enabled 字段"""
        try:
            await self._connection.execute(
                'ALTER TABLE group_configs ADD COLUMN linuxdo_enabled INTEGER DEFAULT 1'
            )
            logger.info("数据库迁移：添加 linuxdo_enabled 字段成功")
        except Exception:
            # 字段已存在，忽略错误
            pass

    async def _migrate_add_spoiler_enabled(self) -> None:
        """迁移：为 group_configs 表添加 spoiler_enabled 字段"""
        try:
            await self._connection.execute(
                'ALTER TABLE group_configs ADD COLUMN spoiler_enabled INTEGER DEFAULT 0'
            )
            logger.info("数据库迁移：添加 spoiler_enabled 字段成功")
        except Exception:
            # 字段已存在，忽略错误
            pass


    async def get_group_config(self, group_id: int) -> Optional[GroupConfig]:
        """获取群组配置"""
        async with self._connection.execute(
            'SELECT * FROM group_configs WHERE group_id = ?',
            (group_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row:
                return self._row_to_config(row)
        return None

    async def get_all_enabled_groups(self) -> List[GroupConfig]:
        """获取所有启用的群组配置"""
        async with self._connection.execute(
            'SELECT * FROM group_configs WHERE enabled = 1'
        ) as cursor:
            rows = await cursor.fetchall()
            return [self._row_to_config(row) for row in rows]

    async def get_all_groups(self) -> List[GroupConfig]:
        """获取所有群组配置"""
        async with self._connection.execute('SELECT * FROM group_configs') as cursor:
            rows = await cursor.fetchall()
            return [self._row_to_config(row) for row in rows]

    async def save_group_config(self, config: GroupConfig) -> None:
        """保存或更新群组配置"""
        config.updated_at = datetime.now()
        await self._connection.execute('''
            INSERT INTO group_configs
                (group_id, group_name, enabled, schedule, target_chat_id,
                 last_summary_time, last_message_id, linuxdo_enabled, spoiler_enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(group_id) DO UPDATE SET
                group_name = excluded.group_name,
                enabled = excluded.enabled,
                schedule = excluded.schedule,
                target_chat_id = excluded.target_chat_id,
                last_summary_time = excluded.last_summary_time,
                last_message_id = excluded.last_message_id,
                linuxdo_enabled = excluded.linuxdo_enabled,
                spoiler_enabled = excluded.spoiler_enabled,
                updated_at = excluded.updated_at
        ''', (
            config.group_id,
            config.group_name,
            int(config.enabled),
            config.schedule,
            config.target_chat_id,
            config.last_summary_time.isoformat() if config.last_summary_time else None,
            config.last_message_id,
            int(config.linuxdo_enabled),
            int(config.spoiler_enabled),
            config.created_at.isoformat(),
            config.updated_at.isoformat()
        ))
        await self._connection.commit()

    async def delete_group_config(self, group_id: int) -> bool:
        """删除群组配置"""
        cursor = await self._connection.execute(
            'DELETE FROM group_configs WHERE group_id = ?', (group_id,)
        )
        await self._connection.commit()
        return cursor.rowcount > 0

    def _row_to_config(self, row: aiosqlite.Row) -> GroupConfig:
        """将数据库行转换为 GroupConfig 对象"""
        # 兼容旧数据库，linuxdo_enabled 可能不存在
        linuxdo_enabled = True
        try:
            linuxdo_enabled = bool(row['linuxdo_enabled'])
        except (KeyError, IndexError):
            pass

        # 兼容旧数据库，spoiler_enabled 可能不存在
        spoiler_enabled = False
        try:
            spoiler_enabled = bool(row['spoiler_enabled'])
        except (KeyError, IndexError):
            pass

        return GroupConfig(
            group_id=row['group_id'],
            group_name=row['group_name'] or '',
            enabled=bool(row['enabled']),
            schedule=row['schedule'] or '0 * * * *',
            target_chat_id=row['target_chat_id'],
            last_summary_time=datetime.fromisoformat(row['last_summary_time']) if row['last_summary_time'] else None,
            last_message_id=row['last_message_id'] or 0,
            linuxdo_enabled=linuxdo_enabled,
            spoiler_enabled=spoiler_enabled,
            created_at=datetime.fromisoformat(row['created_at']) if row['created_at'] else datetime.now(),
            updated_at=datetime.fromisoformat(row['updated_at']) if row['updated_at'] else datetime.now(),
        )

    # ==================== 消息相关方法 ====================

    async def save_message(self, message: GroupMessage) -> None:
        """
        保存一条群组消息（重复则忽略）

        Args:
            message: 消息数据
        """
        await self._connection.execute('''
            INSERT OR IGNORE INTO group_messages
                (message_id, group_id, sender_id, sender_name, content,
                 message_date, has_media, media_type, is_summarized, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            message.message_id, message.group_id, message.sender_id,
            message.sender_name, message.content,
            message.message_date.isoformat(),
            int(message.has_media), message.media_type,
            int(message.is_summarized), message.created_at.isoformat()
        ))
        await self._connection.commit()

    async def get_unsummarized_messages(self, group_id: int, limit: int = 500) -> List[GroupMessage]:
        """
        获取指定群组中尚未被总结的消息

        Args:
            group_id: 群组 ID
            limit: 最大返回条数

        Returns:
            消息列表（按时间正序）
        """
        async with self._connection.execute(
            '''SELECT * FROM group_messages
               WHERE group_id = ? AND is_summarized = 0
               ORDER BY message_date ASC
               LIMIT ?''',
            (group_id, limit)
        ) as cursor:
            rows = await cursor.fetchall()
            return [self._row_to_message(row) for row in rows]

    async def mark_messages_summarized(self, group_id: int, up_to_message_id: int) -> int:
        """
        将指定群组中 message_id <= up_to_message_id 的消息标记为已总结

        Args:
            group_id: 群组 ID
            up_to_message_id: 截止消息 ID（含）

        Returns:
            被标记的消息数量
        """
        cursor = await self._connection.execute(
            '''UPDATE group_messages
               SET is_summarized = 1
               WHERE group_id = ? AND message_id <= ? AND is_summarized = 0''',
            (group_id, up_to_message_id)
        )
        await self._connection.commit()
        return cursor.rowcount

    async def cleanup_old_messages(self, days: int = 7) -> int:
        """
        清理已总结且超过指定天数的旧消息

        Args:
            days: 保留天数

        Returns:
            删除的消息数量
        """
        cutoff = datetime.now().isoformat()
        cursor = await self._connection.execute(
            '''DELETE FROM group_messages
               WHERE is_summarized = 1
               AND julianday(?) - julianday(message_date) > ?''',
            (cutoff, days)
        )
        await self._connection.commit()
        return cursor.rowcount

    async def get_message_count(self, group_id: int, summarized: Optional[bool] = None) -> int:
        """
        获取指定群组的消息数量

        Args:
            group_id: 群组 ID
            summarized: 是否已总结（None 表示不过滤）
        """
        if summarized is None:
            query = 'SELECT COUNT(*) FROM group_messages WHERE group_id = ?'
            params = (group_id,)
        else:
            query = 'SELECT COUNT(*) FROM group_messages WHERE group_id = ? AND is_summarized = ?'
            params = (group_id, int(summarized))

        async with self._connection.execute(query, params) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else 0

    def _row_to_message(self, row: aiosqlite.Row) -> GroupMessage:
        """将数据库行转换为 GroupMessage 对象"""
        return GroupMessage(
            message_id=row['message_id'],
            group_id=row['group_id'],
            sender_id=row['sender_id'],
            sender_name=row['sender_name'] or '',
            content=row['content'] or '',
            message_date=datetime.fromisoformat(row['message_date']),
            has_media=bool(row['has_media']),
            media_type=row['media_type'],
            is_summarized=bool(row['is_summarized']),
            created_at=datetime.fromisoformat(row['created_at']) if row['created_at'] else datetime.now(),
        )

    # ==================== Token 存储方法 ====================

    @staticmethod
    def _simple_encrypt(token: str, user_id: int) -> str:
        """简单加密 Token（基于 user_id 的 XOR 混淆 + base64）"""
        if not token:
            return ""
        # 用 user_id 生成密钥
        key = hashlib.sha256(str(user_id).encode()).digest()
        # XOR 混淆
        encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(token.encode('utf-8')))
        return base64.b64encode(encrypted).decode('ascii')

    @staticmethod
    def _simple_decrypt(encrypted: str, user_id: int) -> str:
        """解密 Token"""
        if not encrypted:
            return ""
        try:
            key = hashlib.sha256(str(user_id).encode()).digest()
            encrypted_bytes = base64.b64decode(encrypted.encode('ascii'))
            decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(encrypted_bytes))
            return decrypted.decode('utf-8')
        except Exception:
            return ""

    async def save_user_token(self, user_id: int, linuxdo_token: str) -> None:
        """保存用户的 Linux.do Token（加密存储）"""
        encrypted_token = self._simple_encrypt(linuxdo_token, user_id)
        await self._connection.execute('''
            INSERT INTO user_tokens (user_id, linuxdo_token, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                linuxdo_token = excluded.linuxdo_token,
                updated_at = excluded.updated_at
        ''', (user_id, encrypted_token, datetime.now().isoformat()))
        await self._connection.commit()
        logger.info(f"用户 {user_id} 的 Token 已保存")

    async def get_user_token(self, user_id: int) -> Optional[str]:
        """获取用户的 Linux.do Token（解密返回）"""
        async with self._connection.execute(
            'SELECT linuxdo_token FROM user_tokens WHERE user_id = ?',
            (user_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if row and row['linuxdo_token']:
                return self._simple_decrypt(row['linuxdo_token'], user_id)
        return None

    async def delete_user_token(self, user_id: int) -> bool:
        """删除用户的 Token"""
        cursor = await self._connection.execute(
            'DELETE FROM user_tokens WHERE user_id = ?', (user_id,)
        )
        await self._connection.commit()
        return cursor.rowcount > 0

    async def set_group_linuxdo_enabled(self, group_id: int, enabled: bool) -> None:
        """设置群组的 Linux.do 功能开关"""
        await self._connection.execute(
            'UPDATE group_configs SET linuxdo_enabled = ?, updated_at = ? WHERE group_id = ?',
            (int(enabled), datetime.now().isoformat(), group_id)
        )
        await self._connection.commit()

    async def set_group_spoiler_enabled(self, group_id: int, enabled: bool) -> None:
        """设置群组的剧透模式开关"""
        await self._connection.execute(
            'UPDATE group_configs SET spoiler_enabled = ?, updated_at = ? WHERE group_id = ?',
            (int(enabled), datetime.now().isoformat(), group_id)
        )
        await self._connection.commit()


