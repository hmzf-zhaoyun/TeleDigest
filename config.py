"""
机器人配置管理模块
负责从环境变量读取机器人相关配置
"""
import os
from pathlib import Path
from typing import Optional, List
from dataclasses import dataclass, field
from dotenv import load_dotenv


@dataclass
class LLMConfig:
    """LLM API 配置"""
    provider: str = "openai"  # openai, claude, custom
    api_key: str = ""
    api_base: str = ""
    model: str = "gpt-3.5-turbo"
    max_tokens: int = 1000
    temperature: float = 0.7


@dataclass
class LinuxDoConfig:
    """Linux.do 配置"""
    api_token: str = ""  # 全局默认 Token（可选）
    enabled: bool = True  # 功能总开关


@dataclass
class BotConfig:
    """机器人配置类"""

    # 机器人基础配置
    bot_token: str = ""
    owner_ids: List[int] = field(default_factory=list)

    # LLM 配置
    llm: LLMConfig = field(default_factory=LLMConfig)

    # Linux.do 配置
    linuxdo: LinuxDoConfig = field(default_factory=LinuxDoConfig)

    # 数据库配置
    db_path: Path = field(default_factory=lambda: Path("data/bot.db"))

    # 项目基础目录
    base_dir: Path = field(default_factory=lambda: Path(__file__).resolve().parent.parent)
    
    def __post_init__(self):
        """初始化后处理"""
        # 确保数据库目录存在
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
    
    def is_owner(self, user_id: int) -> bool:
        """检查用户是否是机器人主人"""
        return user_id in self.owner_ids
    
    def __repr__(self) -> str:
        return (
            f"BotConfig(owner_ids={self.owner_ids}, "
            f"llm_provider={self.llm.provider}, "
            f"db_path={self.db_path})"
        )


def _parse_owner_ids(value: Optional[str]) -> List[int]:
    """解析主人 ID 列表（支持逗号分隔的多个 ID）"""
    if not value:
        return []
    try:
        return [int(uid.strip()) for uid in value.split(",") if uid.strip()]
    except ValueError:
        raise ValueError("TG_BOT_OWNER_ID 必须是整数或逗号分隔的整数列表")


def load_bot_config(env_file: Optional[str] = None) -> BotConfig:
    """
    从环境变量加载机器人配置
    
    Args:
        env_file: .env 文件路径
        
    Returns:
        BotConfig 实例
    """
    # 确定 .env 文件路径（支持多个位置）
    current_dir = Path(__file__).resolve().parent  # TeleDigest 目录
    parent_dir = current_dir.parent  # 父目录

    if env_file is None:
        # 优先查找当前目录（TeleDigest），然后查找父目录
        if (current_dir / '.env').exists():
            env_file = current_dir / '.env'
            base_dir = current_dir
        elif (parent_dir / '.env').exists():
            env_file = parent_dir / '.env'
            base_dir = parent_dir
        else:
            # 默认使用当前目录
            env_file = current_dir / '.env'
            base_dir = current_dir
    else:
        env_file = Path(env_file)
        base_dir = env_file.parent

    # 加载环境变量
    if env_file.exists():
        load_dotenv(env_file)
    
    # 读取机器人 Token
    bot_token = os.getenv('TG_BOT_TOKEN', '')
    if not bot_token:
        raise ValueError(
            "TG_BOT_TOKEN 未设置。请在环境变量或 .env 文件中设置。\n"
            "获取方式: 通过 @BotFather 创建机器人获取 Token"
        )
    
    # 读取主人 ID
    owner_ids = _parse_owner_ids(os.getenv('TG_BOT_OWNER_ID'))
    if not owner_ids:
        raise ValueError(
            "TG_BOT_OWNER_ID 未设置。请在环境变量或 .env 文件中设置机器人主人的 Telegram User ID"
        )
    
    # 读取 LLM 配置
    llm_config = LLMConfig(
        provider=os.getenv('LLM_PROVIDER', 'openai'),
        api_key=os.getenv('LLM_API_KEY', ''),
        api_base=os.getenv('LLM_API_BASE', ''),
        model=os.getenv('LLM_MODEL', 'gpt-3.5-turbo'),
        max_tokens=int(os.getenv('LLM_MAX_TOKENS', '1000')),
        temperature=float(os.getenv('LLM_TEMPERATURE', '0.7')),
    )
    
    # 数据库路径
    db_path = Path(os.getenv('TG_BOT_DB_PATH', str(base_dir / 'data' / 'bot.db')))

    # Linux.do 配置
    linuxdo_config = LinuxDoConfig(
        api_token=os.getenv('LINUXDO_API_TOKEN', ''),
        enabled=os.getenv('LINUXDO_ENABLED', 'true').lower() in ('true', '1', 'yes'),
    )

    return BotConfig(
        bot_token=bot_token,
        owner_ids=owner_ids,
        llm=llm_config,
        linuxdo=linuxdo_config,
        db_path=db_path,
        base_dir=base_dir,
    )


# 全局配置实例
_bot_config: Optional[BotConfig] = None


def get_bot_config(env_file: Optional[str] = None) -> BotConfig:
    """
    获取机器人配置实例（单例模式）
    
    Args:
        env_file: .env 文件路径
        
    Returns:
        BotConfig 实例
    """
    global _bot_config
    if _bot_config is None:
        _bot_config = load_bot_config(env_file)
    return _bot_config

