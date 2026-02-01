"""
机器人启动入口
支持命令行启动:
  - 在项目目录内: python -m TeleDigest
  - 在父目录: python -m TeleDigest
"""
import asyncio
import logging
import sys
from pathlib import Path

# 将项目根目录添加到 Python 路径（支持从父目录运行）
project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(project_root))

# 同时支持从项目目录内运行（相对导入）
try:
    from TeleDigest.bot import TelegramBot
    from TeleDigest.config import get_bot_config
except ImportError:
    # 从项目目录内运行时使用相对导入
    from bot import TelegramBot
    from config import get_bot_config


def setup_logging(level: int = logging.INFO) -> None:
    """配置日志"""
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S',
        handlers=[
            logging.StreamHandler(sys.stdout),
        ]
    )
    
    # 降低第三方库的日志级别
    logging.getLogger('httpx').setLevel(logging.WARNING)
    logging.getLogger('telegram').setLevel(logging.WARNING)
    logging.getLogger('apscheduler').setLevel(logging.WARNING)
    logging.getLogger('telethon').setLevel(logging.WARNING)


async def main() -> None:
    """主函数"""
    setup_logging()
    logger = logging.getLogger(__name__)
    
    try:
        # 加载配置
        config = get_bot_config()
        logger.info("配置加载成功")
        
        # 创建并启动机器人
        bot = TelegramBot(config)
        await bot.run_forever()
        
    except ValueError as e:
        logger.error(f"配置错误: {e}")
        sys.exit(1)
    except KeyboardInterrupt:
        logger.info("收到中断信号，正在退出...")
    except Exception as e:
        logger.exception(f"机器人运行出错: {e}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())

