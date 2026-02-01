"""
定时任务管理模块
使用 APScheduler 实现定时消息总结任务
"""
import logging
from datetime import datetime
from typing import Optional, Callable, Dict, Any, Union

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

try:
    from ..storage import BotDatabase, GroupConfig
except ImportError:
    from storage import BotDatabase, GroupConfig


logger = logging.getLogger(__name__)


class TaskManager:
    """定时任务管理器"""
    
    def __init__(self, db: BotDatabase):
        """
        初始化任务管理器
        
        Args:
            db: 数据库实例
        """
        self.db = db
        self.scheduler = AsyncIOScheduler()
        self._summary_callback: Optional[Callable] = None
        self._running = False
    
    def set_summary_callback(self, callback: Callable) -> None:
        """
        设置总结回调函数
        
        Args:
            callback: 异步回调函数，签名为 async def callback(group_id: int) -> None
        """
        self._summary_callback = callback
    
    async def start(self) -> None:
        """启动调度器并加载所有已启用的任务"""
        if self._running:
            return
        
        # 加载所有已启用的群组任务
        enabled_groups = await self.db.get_all_enabled_groups()
        for config in enabled_groups:
            self._add_job(config)
        
        self.scheduler.start()
        self._running = True
        logger.info(f"任务调度器已启动，已加载 {len(enabled_groups)} 个定时任务")
    
    async def stop(self) -> None:
        """停止调度器"""
        if self._running:
            self.scheduler.shutdown(wait=False)
            self._running = False
            logger.info("任务调度器已停止")
    
    def _add_job(self, config: GroupConfig) -> None:
        """添加定时任务"""
        if not self._summary_callback:
            logger.warning("未设置总结回调函数，无法添加任务")
            return
        
        job_id = f"summary_{config.group_id}"
        
        # 移除已存在的任务
        if self.scheduler.get_job(job_id):
            self.scheduler.remove_job(job_id)
        
        # 解析调度表达式
        trigger = self._parse_schedule(config.schedule)
        if trigger is None:
            logger.error(f"无效的调度表达式: {config.schedule}")
            return
        
        # 添加任务
        self.scheduler.add_job(
            self._summary_callback,
            trigger=trigger,
            id=job_id,
            args=[config.group_id],
            name=f"Summary for {config.group_name or config.group_id}",
            replace_existing=True,
        )
        logger.info(f"已添加定时任务: group_id={config.group_id}, schedule={config.schedule}")
    
    def _parse_schedule(self, schedule: str) -> Optional[Union[CronTrigger, IntervalTrigger]]:
        """
        解析调度表达式
        
        支持格式：
        - Cron 表达式: "0 * * * *" (每小时)
        - 间隔表达式: "30m" (每30分钟), "2h" (每2小时), "1d" (每天)
        """
        schedule = schedule.strip()
        
        # 尝试解析为间隔表达式
        if schedule.endswith('m'):
            try:
                minutes = int(schedule[:-1])
                return IntervalTrigger(minutes=minutes)
            except ValueError:
                pass
        elif schedule.endswith('h'):
            try:
                hours = int(schedule[:-1])
                return IntervalTrigger(hours=hours)
            except ValueError:
                pass
        elif schedule.endswith('d'):
            try:
                days = int(schedule[:-1])
                return IntervalTrigger(days=days)
            except ValueError:
                pass
        
        # 尝试解析为 Cron 表达式
        try:
            parts = schedule.split()
            if len(parts) == 5:
                return CronTrigger(
                    minute=parts[0],
                    hour=parts[1],
                    day=parts[2],
                    month=parts[3],
                    day_of_week=parts[4],
                )
        except Exception as e:
            logger.error(f"解析 Cron 表达式失败: {e}")
        
        return None
    
    async def add_group_task(self, config: GroupConfig) -> bool:
        """
        添加或更新群组的定时任务
        
        Args:
            config: 群组配置
            
        Returns:
            是否成功
        """
        if not config.enabled:
            return self.remove_group_task(config.group_id)
        
        self._add_job(config)
        return True
    
    def remove_group_task(self, group_id: int) -> bool:
        """
        移除群组的定时任务
        
        Args:
            group_id: 群组 ID
            
        Returns:
            是否成功
        """
        job_id = f"summary_{group_id}"
        job = self.scheduler.get_job(job_id)
        if job:
            self.scheduler.remove_job(job_id)
            logger.info(f"已移除定时任务: group_id={group_id}")
            return True
        return False
    
    def get_job_info(self, group_id: int) -> Optional[Dict[str, Any]]:
        """获取任务信息"""
        job_id = f"summary_{group_id}"
        job = self.scheduler.get_job(job_id)
        if job:
            return {
                'job_id': job.id,
                'name': job.name,
                'next_run_time': job.next_run_time,
                'trigger': str(job.trigger),
            }
        return None

