# -*- coding: utf-8 -*-
"""
ResearchEngine 崩溃恢复与版本并发保护 (RecoveryManager)
负责系统重启时将未决运行安全置为 paused；
管理 resume / cancel 时的 execution_version 递增，
拦截迟到的过期请求，防止脑裂与重复提交。
"""

from datetime import datetime, timezone
from typing import List, Optional
from .schema import ResearchRun, RunStatus
from .storage import ResearchStorage
from .coordinator import ResearchCoordinator


class RecoveryManager:
    """运行恢复与版本并发管理器"""

    def __init__(self, storage: ResearchStorage, coordinator: ResearchCoordinator):
        self.storage = storage
        self.coordinator = coordinator

    def auto_pause_unended_runs_on_startup(self) -> List[str]:
        """
        服务重启时调用：检测所有未正常终止或放行的活跃任务，
        将其原子置为 PAUSED 状态，等待管理员显式确认恢复或重试。
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        paused_ids: List[str] = []

        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT run_id FROM runs
                WHERE status IN ('planning', 'researching', 'reviewing');
                """
            )
            rows = cursor.fetchall()
            for r in rows:
                paused_ids.append(r["run_id"])

            if paused_ids:
                placeholders = ",".join(["?"] * len(paused_ids))
                conn.execute(
                    f"""
                    UPDATE runs
                    SET status = ?, updated_at = ?
                    WHERE run_id IN ({placeholders});
                    """,
                    (RunStatus.PAUSED.value, now_iso, *paused_ids),
                )
                conn.commit()

        return paused_ids

    def resume_run(self, run_id: str) -> ResearchRun:
        """
        恢复暂停的研究任务：
        - 递增 execution_version（使先前挂起或超时的迟到请求彻底失效）
        - 状态重置为 researching
        - 沿用已有预算消耗与已提交材料，不刷新重置额度
        """
        run = self.coordinator.get_run(run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")
        if run.status != RunStatus.PAUSED:
            raise ValueError(f"Cannot resume run in status '{run.status.value}', expected 'paused'")

        now_iso = datetime.now(timezone.utc).isoformat()
        new_version = run.execution_version + 1

        with self.storage._get_connection() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, execution_version = ?, updated_at = ?
                WHERE run_id = ?;
                """,
                (RunStatus.RESEARCHING.value, new_version, now_iso, run_id),
            )
            conn.commit()

        return self.coordinator.get_run(run_id)

    def cancel_run(self, run_id: str, reason: str = "User cancelled") -> ResearchRun:
        """
        取消研究任务：
        - 递增 execution_version
        - 状态置为 cancelled
        """
        run = self.coordinator.get_run(run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")

        now_iso = datetime.now(timezone.utc).isoformat()
        new_version = run.execution_version + 1

        with self.storage._get_connection() as conn:
            conn.execute(
                """
                UPDATE runs
                SET status = ?, execution_version = ?, updated_at = ?
                WHERE run_id = ?;
                """,
                (RunStatus.CANCELLED.value, new_version, now_iso, run_id),
            )
            conn.commit()

        return self.coordinator.get_run(run_id)

    def validate_execution_version(self, run_id: str, client_version: int) -> bool:
        """
        校验客户端携带的调度执行版本。
        若 client_version < 当前运行版本，说明为迟到过期请求，应予拒绝。
        """
        run = self.coordinator.get_run(run_id)
        if not run:
            return False
        return client_version >= run.execution_version
