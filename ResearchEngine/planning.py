# -*- coding: utf-8 -*-
"""
ResearchEngine HOST 任务规划器 (TaskPlanner)
负责验证 HOST 规划的任务参数、预算配额、角色有效性与依赖图无环性，
并将验证通过的任务原子写入持久化数据库。
"""

import uuid
import json
from datetime import datetime, timezone
from typing import List, Dict, Any, Tuple, Optional

from .schema import ResearchRole, ResearchTask, TaskStatus
from .storage import ResearchStorage


class TaskPlanner:
    """HOST 任务规划组件"""

    ALLOWED_RESEARCH_ROLES = {
        ResearchRole.AUTHORITY.value,
        ResearchRole.EVOLUTION.value,
        ResearchRole.FEEDBACK.value,
    }

    def __init__(self, storage: ResearchStorage):
        self.storage = storage

    def validate_planned_tasks(
        self,
        planned_tasks: List[Dict[str, Any]],
        max_budget_per_task: int = 15,
        total_available_budget: Optional[int] = None,
    ) -> Tuple[bool, str]:
        """
        验证规划的任务列表合法性：
        1. 列表非空
        2. 角色在允许的研究角色内
        3. 单任务预算 > 0 且 <= max_budget_per_task
        4. 总体预算不超出 total_available_budget（若指定）
        5. 完成标准与核心问题非空
        6. 任务依赖无循环依赖
        """
        if not planned_tasks:
            return False, "Planned tasks list cannot be empty"

        total_budget = 0
        task_roles = set()

        for idx, item in enumerate(planned_tasks):
            role = item.get("role")
            if not role or role not in self.ALLOWED_RESEARCH_ROLES:
                return False, f"Invalid role '{role}' at index {idx}. Must be one of {sorted(self.ALLOWED_RESEARCH_ROLES)}"

            task_roles.add(role)

            budget = item.get("budget_allocated", 0)
            if not isinstance(budget, int) or budget <= 0:
                return False, f"Invalid budget_allocated '{budget}' for role '{role}'. Must be a positive integer."
            if budget > max_budget_per_task:
                return False, f"Budget allocated {budget} exceeds maximum allowed budget per task ({max_budget_per_task})"
            total_budget += budget

            question = item.get("question", "").strip()
            if not question:
                return False, f"Missing question for role '{role}'"

            completion_criteria = item.get("completion_criteria", "").strip()
            if not completion_criteria:
                return False, f"Missing completion_criteria for role '{role}'"

        if total_available_budget is not None and total_budget > total_available_budget:
            return False, f"Total planned budget {total_budget} exceeds available budget {total_available_budget}"

        # 依赖图无环性校验 (DAG check)
        task_id_map = {t.get("task_id", t.get("role")): t for t in planned_tasks}
        visited = {}  # 0: unvisited, 1: visiting, 2: visited

        def has_cycle(node_id: str) -> bool:
            visited[node_id] = 1
            node = task_id_map.get(node_id)
            if node:
                deps = node.get("dependencies", [])
                for dep in deps:
                    if dep in task_id_map:
                        if visited.get(dep, 0) == 1:
                            return True
                        if visited.get(dep, 0) == 0 and has_cycle(dep):
                            return True
            visited[node_id] = 2
            return False

        for node_id in task_id_map:
            if visited.get(node_id, 0) == 0:
                if has_cycle(node_id):
                    return False, "Cyclic dependency detected in planned tasks"

        return True, ""

    def create_planned_tasks(
        self,
        run_id: str,
        round_num: int,
        planned_tasks: List[Dict[str, Any]],
        max_budget_per_task: int = 15,
        total_available_budget: Optional[int] = None,
    ) -> List[ResearchTask]:
        """
        校验并通过持久化存储创建子任务
        """
        ok, err = self.validate_planned_tasks(
            planned_tasks,
            max_budget_per_task=max_budget_per_task,
            total_available_budget=total_available_budget,
        )
        if not ok:
            raise ValueError(f"Task plan validation failed: {err}")

        now_iso = datetime.now(timezone.utc).isoformat()
        created_tasks: List[ResearchTask] = []

        with self.storage._get_connection() as conn:
            for item in planned_tasks:
                task_id = item.get("task_id") or f"task-{item['role']}-{uuid.uuid4().hex[:8]}"
                role = item["role"]
                question = item["question"]
                scope = item.get("scope", {})
                budget_allocated = item.get("budget_allocated", 12)

                task = ResearchTask(
                    task_id=task_id,
                    run_id=run_id,
                    role=ResearchRole(role),
                    round=round_num,
                    question=question,
                    scope=scope,
                    status=TaskStatus.PENDING,
                    budget_allocated=budget_allocated,
                    created_at=now_iso,
                )

                conn.execute(
                    """
                    INSERT INTO tasks (
                        task_id, run_id, role, round, question, scope, status,
                        budget_allocated, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        task.task_id,
                        task.run_id,
                        task.role.value,
                        task.round,
                        task.question,
                        json.dumps(task.scope, ensure_ascii=False),
                        task.status.value,
                        task.budget_allocated,
                        task.created_at,
                    ),
                )
                created_tasks.append(task)
            conn.commit()

        return created_tasks
