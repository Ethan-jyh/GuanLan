# -*- coding: utf-8 -*-
"""
ResearchEngine 核心协调器 (Coordinator)
管理全局运行生命周期、三方角色任务分配、轮次同步屏障与状态流转
"""

import uuid
import json
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

from .schema import (
    ResearchRun,
    ResearchTask,
    ResearchRole,
    RunStatus,
    TaskStatus,
)
from .storage import ResearchStorage
from .submissions import SubmissionManager
from .budget import BudgetManager
from .scheduler import TaskScheduler


class ResearchCoordinator:
    """研究会商协调器"""

    def __init__(
        self,
        storage: ResearchStorage,
        submission_mgr: SubmissionManager,
        budget_mgr: BudgetManager,
        scheduler: Optional[TaskScheduler] = None,
        runtime_client=None,
    ):
        self.storage = storage
        self.submission_mgr = submission_mgr
        self.budget_mgr = budget_mgr
        self.scheduler = scheduler or TaskScheduler(max_workers=3)
        self.runtime_client = runtime_client

    def create_run(
        self,
        topic: str,
        scope: Optional[Dict[str, Any]] = None,
        roles: Optional[List[str]] = None,
        budget_total: int = 50,
    ) -> ResearchRun:
        """创建新的多智能体研究会商运行，并初始化首轮任务"""
        now_iso = datetime.now(timezone.utc).isoformat()
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        active_roles = roles or [
            ResearchRole.AUTHORITY.value,
            ResearchRole.EVOLUTION.value,
            ResearchRole.FEEDBACK.value,
        ]

        run = ResearchRun(
            run_id=run_id,
            topic=topic,
            scope=scope or {},
            status=RunStatus.RESEARCHING,
            current_round=1,
            max_rounds=3,
            budget_total=budget_total,
            budget_used=0,
            created_at=now_iso,
            updated_at=now_iso,
        )

        with self.storage._get_connection() as conn:
            conn.execute(
                """
                INSERT INTO runs (
                    run_id, topic, scope, status, current_round, max_rounds,
                    budget_total, budget_used, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                """,
                (
                    run.run_id,
                    run.topic,
                    json.dumps(run.scope, ensure_ascii=False),
                    run.status.value,
                    run.current_round,
                    run.max_rounds,
                    run.budget_total,
                    run.budget_used,
                    run.created_at,
                    run.updated_at,
                ),
            )

            # 为选定的每个角色创建第 1 轮初始子任务
            for role_name in active_roles:
                task_id = f"task-{role_name}-{uuid.uuid4().hex[:8]}"
                question = f"针对主题【{topic}】开展【{role_name}】方向的第一轮基础事实与数据调研"
                conn.execute(
                    """
                    INSERT INTO tasks (
                        task_id, run_id, role, round, question, scope, status,
                        budget_allocated, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        task_id,
                        run.run_id,
                        role_name,
                        1,
                        question,
                        json.dumps(run.scope, ensure_ascii=False),
                        TaskStatus.PENDING.value,
                        12,
                        now_iso,
                    ),
                )
            conn.commit()

        return run

    def get_run(self, run_id: str) -> Optional[ResearchRun]:
        """获取 Run 实体"""
        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM runs WHERE run_id = ?", (run_id,))
            row = cursor.fetchone()
            if not row:
                return None
            return ResearchRun(
                run_id=row["run_id"],
                topic=row["topic"],
                scope=json.loads(row["scope"]) if row["scope"] else {},
                status=RunStatus(row["status"]),
                current_round=row["current_round"],
                max_rounds=row["max_rounds"],
                budget_total=row["budget_total"],
                budget_used=row["budget_used"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )

    def get_tasks_for_round(self, run_id: str, round_num: int) -> List[ResearchTask]:
        """获取指定运行在特定轮次的全部子任务"""
        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM tasks WHERE run_id = ? AND round = ? ORDER BY task_id ASC",
                (run_id, round_num),
            )
            rows = cursor.fetchall()
            tasks = []
            for r in rows:
                tasks.append(
                    ResearchTask(
                        task_id=r["task_id"],
                        run_id=r["run_id"],
                        role=ResearchRole(r["role"]),
                        round=r["round"],
                        question=r["question"],
                        scope=json.loads(r["scope"]) if r["scope"] else {},
                        status=TaskStatus(r["status"]),
                        assigned_to=r["assigned_to"],
                        budget_allocated=r["budget_allocated"],
                        created_at=r["created_at"],
                        completed_at=r["completed_at"],
                    )
                )
            return tasks

    def check_round_sync_barrier(self, run_id: str, round_num: int) -> bool:
        """
        三方同步屏障校验：
        检查本轮所有派发任务是否均已完成有效结构化提交。
        若全部提交，将运行状态原子跃迁为 REVIEWING。
        """
        tasks = self.get_tasks_for_round(run_id, round_num)
        if not tasks:
            return False

        for t in tasks:
            role_val = t.role.value if hasattr(t.role, "value") else str(t.role)
            sub = self.submission_mgr.get_latest_submission_for_role(run_id, role_val, round_num)
            if not sub:
                return False

        # 全部到齐，状态流转为 REVIEWING
        now_iso = datetime.now(timezone.utc).isoformat()
        with self.storage._get_connection() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, updated_at = ?
                WHERE run_id = ?;
                """,
                (RunStatus.REVIEWING.value, now_iso, run_id),
            )
            conn.commit()

        return True

    def pause_run(self, run_id: str, reason: str):
        """异常、超时或预算耗尽时暂停任务"""
        now_iso = datetime.now(timezone.utc).isoformat()
        with self.storage._get_connection() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, updated_at = ?
                WHERE run_id = ?;
                """,
                (RunStatus.PAUSED.value, now_iso, run_id),
            )
            conn.commit()
