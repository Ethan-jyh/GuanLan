# -*- coding: utf-8 -*-
"""
ResearchEngine 预算账本管理器
负责工具调用与模型 Token 的原子预留、保底配额防护与并发拦截
"""

from typing import Tuple, Optional, Dict, Any
from .storage import ResearchStorage


class BudgetManager:
    """预算账本管理器"""

    def __init__(
        self,
        storage: ResearchStorage,
        total_tool_limit: int = 50,
        reserved_for_writing: int = 10,
    ):
        self.storage = storage
        self.total_tool_limit = total_tool_limit
        self.reserved_for_writing = reserved_for_writing

    @property
    def max_research_tool_quota(self) -> int:
        """可用于前期研究阶段的工具调用总上限（扣除预留给报告撰写与终稿审查的保底）"""
        return max(0, self.total_tool_limit - self.reserved_for_writing)

    def reserve_budget(
        self,
        run_id: str,
        task_id: str,
        units: int = 1,
        call_type: str = "tool_call",
        idempotency_key: Optional[str] = None,
        is_writing_phase: bool = False,
    ) -> Tuple[bool, Optional[str]]:
        """
        原子预留预算配额。
        若处于前期研究阶段，上限为 max_research_tool_quota；
        若处于写作阶段，上限为 total_tool_limit。
        返回: (is_success, reservation_id 或 error_message)
        """
        max_allowed = self.total_tool_limit if is_writing_phase else self.max_research_tool_quota

        ok, res_id, err = self.storage.reserve_budget_atomic(
            run_id=run_id,
            task_id=task_id,
            units=units,
            call_type=call_type,
            idempotency_key=idempotency_key,
            max_allowed=max_allowed,
        )
        if ok:
            return True, res_id
        return False, err

    def settle_budget(
        self,
        reservation_id: str,
        actual_units: int = 1,
        cost_estimate: Optional[float] = None,
    ):
        """结算预算预留，按实际用量核销"""
        self.storage.settle_budget_atomic(
            reservation_id=reservation_id,
            actual_units=actual_units,
            cost_estimate=cost_estimate,
        )

    def get_remaining_research_budget(self, run_id: str) -> int:
        """获取前期研究阶段当前剩余可用额度"""
        usage = self.storage.get_run_budget_usage(run_id)
        return max(0, self.max_research_tool_quota - usage["committed"])

    def get_total_remaining_budget(self, run_id: str) -> int:
        """获取全任务总剩余可用额度"""
        usage = self.storage.get_run_budget_usage(run_id)
        return max(0, self.total_tool_limit - usage["committed"])
