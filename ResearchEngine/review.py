# -*- coding: utf-8 -*-
"""
ResearchEngine HOST 阶段评审、定向补查与放行管理 (ReviewManager)
实现三轮评审决策流转、定向派单、未分派角色成果自动沿用 (carry-forward)、
第 3 轮强制收敛与放行门禁检验。
"""

import uuid
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple

from .schema import (
    ResearchRole,
    RunStatus,
    TaskStatus,
    DecisionType,
    HostReviewDecision,
    DirectiveItem,
    ResearchResult,
)
from .storage import ResearchStorage
from .submissions import SubmissionManager
from .coordinator import ResearchCoordinator


class ReviewManager:
    """HOST 评审与生命周期放行管理器"""

    REQUIRED_ROLES = [
        ResearchRole.AUTHORITY.value,
        ResearchRole.EVOLUTION.value,
        ResearchRole.FEEDBACK.value,
    ]

    def __init__(
        self,
        storage: ResearchStorage,
        coordinator: ResearchCoordinator,
        submission_mgr: SubmissionManager,
    ):
        self.storage = storage
        self.coordinator = coordinator
        self.submission_mgr = submission_mgr

    def submit_review_decision(
        self,
        run_id: str,
        decision: HostReviewDecision,
    ) -> HostReviewDecision:
        """
        提交并持久化 HOST 会商评审决定。
        具有事务与幂等性保障：
        1. 若当前轮次已存在决策记录，幂等返回既有决策。
        2. 第 3 轮强制收敛：禁止下发 REVISE，必须放行或带未决放行。
        3. APPROVE / FINALIZE_WITH_UNRESOLVED 将运行状态原子推进为 APPROVED。
        4. REVISE 进入下一轮，仅针对收到指令的角色派发新任务，其余角色成果沿用。
        """
        run = self.coordinator.get_run(run_id)
        if not run:
            raise ValueError(f"Run {run_id} not found")

        # 1. 幂等性检查：若已有记录直接反序列化返回
        existing = self.storage.get_review_decision(run_id, decision.round)
        if existing:
            return HostReviewDecision(
                task_id=existing["task_id"],
                round=existing["round"],
                decision=DecisionType(existing["decision"]),
                rationale=existing["rationale"],
                directives=[
                    DirectiveItem(**d) if isinstance(d, dict) else d
                    for d in existing.get("directives", [])
                ],
                unresolved_issues=existing.get("unresolved_issues", []),
            )

        # 2. 第 3 轮强制收敛规则
        if decision.round >= 3 and decision.decision == DecisionType.REVISE:
            raise ValueError(
                "Round 3 cannot issue REVISE. Must APPROVE or FINALIZE_WITH_UNRESOLVED."
            )

        now_iso = datetime.now(timezone.utc).isoformat()

        # 3. 持久化存储决策
        decision_dict = {
            "task_id": decision.task_id,
            "round": decision.round,
            "decision": decision.decision.value,
            "rationale": decision.rationale,
            "directives": [
                d.model_dump() if hasattr(d, "model_dump") else d.dict()
                for d in decision.directives
            ],
            "unresolved_issues": decision.unresolved_issues,
        }
        self.storage.save_review_decision(run_id, decision_dict)

        # 4. 状态跃迁与定向派发
        with self.storage._get_connection() as conn:
            if decision.decision in (DecisionType.APPROVE, DecisionType.FINALIZE_WITH_UNRESOLVED):
                # 评审通过或带未决放行 -> 跃迁为 APPROVED
                conn.execute(
                    """
                    UPDATE runs
                    SET status = ?, updated_at = ?
                    WHERE run_id = ?;
                    """,
                    (RunStatus.APPROVED.value, now_iso, run_id),
                )
            elif decision.decision == DecisionType.REVISE:
                next_round = decision.round + 1
                conn.execute(
                    """
                    UPDATE runs
                    SET status = ?, current_round = ?, updated_at = ?
                    WHERE run_id = ?;
                    """,
                    (RunStatus.RESEARCHING.value, next_round, now_iso, run_id),
                )

                # 仅为收到定向指令的角色创建新一轮子任务
                for directive in decision.directives:
                    target_role = (
                        directive.target_role.value
                        if hasattr(directive.target_role, "value")
                        else str(directive.target_role)
                    )
                    task_id = f"task-{target_role}-r{next_round}-{uuid.uuid4().hex[:6]}"
                    conn.execute(
                        """
                        INSERT INTO tasks (
                            task_id, run_id, role, round, question, scope, status,
                            budget_allocated, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                        """,
                        (
                            task_id,
                            run_id,
                            target_role,
                            next_round,
                            directive.question,
                            json.dumps(
                                {
                                    "directive_id": directive.directive_id,
                                    "related_claim_or_issue": directive.related_claim_or_issue,
                                    "completion_criteria": directive.completion_criteria,
                                },
                                ensure_ascii=False,
                            ),
                            TaskStatus.PENDING.value,
                            10,
                            now_iso,
                        ),
                    )
            conn.commit()

        return decision

    def get_effective_submissions(
        self,
        run_id: str,
        round_num: int,
    ) -> Dict[str, ResearchResult]:
        """
        获取指定轮次下的有效研究成果（含沿用 carry-forward）。
        若某角色在本轮有处于 PENDING 或 RUNNING 状态的补查任务，说明其补查尚未完成，不返回旧成果；
        若某角色本轮未被指派补查任务，则沿用其在先前轮次提交的最新有效成果。
        """
        current_tasks = self.coordinator.get_tasks_for_round(run_id, round_num)
        pending_or_running_roles = {
            t.role.value if hasattr(t.role, "value") else str(t.role)
            for t in current_tasks
            if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING)
        }

        effective: Dict[str, ResearchResult] = {}

        for role in self.REQUIRED_ROLES:
            if role in pending_or_running_roles:
                # 正在执行定向补查，本轮尚无完成成果
                continue

            # 逆向寻找最近轮次完成的成果
            for r in range(round_num, 0, -1):
                sub = self.submission_mgr.get_latest_submission_for_role(run_id, role, r)
                if sub:
                    effective[role] = sub
                    break

        return effective

    def check_release_gate(self, run_id: str) -> Tuple[bool, str]:
        """
        专报放行合规检查：
        1. 检查是否存在未完成的子任务；
        2. 检查必要研究角色成果是否已覆盖；
        """
        run = self.coordinator.get_run(run_id)
        if not run:
            return False, f"Run {run_id} not found"

        tasks = self.coordinator.get_tasks_for_round(run_id, run.current_round)
        active_tasks = [
            t.task_id
            for t in tasks
            if t.status in (TaskStatus.PENDING, TaskStatus.RUNNING)
        ]
        if active_tasks:
            return False, f"Tasks {active_tasks} are still pending or running"

        effective_subs = self.get_effective_submissions(run_id, run.current_round)
        missing_roles = [r for r in self.REQUIRED_ROLES if r not in effective_subs]
        if missing_roles:
            return False, f"Missing required deliverables for roles: {missing_roles}"

        return True, "Release gate check passed"
