# -*- coding: utf-8 -*-
"""
论坛阶段评审 SQLite 仓储层
管理 data/forum_review.sqlite3 的表结构初始化、幂等写入、状态转移与版本审计
"""

import json
import sqlite3
from pathlib import Path
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple
from loguru import logger

from .schema import (
    TaskStatus,
    DecisionType,
    AgentSubmission,
    HostDecision,
    GuidanceItem,
    TaskState,
)


DB_DIR = Path("data")
DB_PATH = DB_DIR / "forum_review.sqlite3"


class ForumReviewStorage:
    """基于 SQLite 的线程安全持久化仓储"""

    def __init__(self, db_path: Optional[Any] = None):
        self.db_path = Path(db_path) if db_path else DB_PATH
        self._ensure_db_dir()
        self._init_tables()

    def _ensure_db_dir(self):
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path), timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA foreign_keys=ON;")
        return conn

    def _init_tables(self):
        """初始化 5 张核心持久化表"""
        with self._get_connection() as conn:
            cursor = conn.cursor()

            # 1. 任务主表
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                topic TEXT NOT NULL,
                status TEXT NOT NULL,
                current_round INTEGER NOT NULL DEFAULT 1,
                max_rounds INTEGER NOT NULL DEFAULT 3,
                waiting_agents TEXT NOT NULL,
                paused_reason TEXT,
                paused_stage TEXT,
                op_version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """)

            # 2. Agent 阶段性提交表（严格按 task_id + agent_id + round 唯一约束）
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS submissions (
                submission_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                checkpoint_path TEXT,
                data_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
                UNIQUE (task_id, agent_id, round)
            );
            """)

            # 3. HOST 评审决定表（严格按 task_id + round 唯一约束）
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                decision TEXT NOT NULL,
                overall_rationale TEXT NOT NULL,
                unresolved_issues TEXT NOT NULL,
                decision_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
                UNIQUE (task_id, round)
            );
            """)

            # 4. 定向指导下发项表
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS guidances (
                guidance_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                round INTEGER NOT NULL,
                target_agent TEXT NOT NULL,
                related_claim TEXT NOT NULL,
                question TEXT NOT NULL,
                suggested_action TEXT NOT NULL,
                completion_criteria TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
            );
            """)

            # 5. 最终研报登记表（三方全部登记后放行）
            cursor.execute("""
            CREATE TABLE IF NOT EXISTS reports (
                task_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                report_path TEXT NOT NULL,
                file_size INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, agent_id),
                FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
            );
            """)

            conn.commit()

    # ==================== 任务管理 ====================

    def create_task(self, task_id: str, topic: str, max_rounds: int = 3) -> TaskState:
        """创建新任务，确保第一版单活跃任务限制"""
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._get_connection() as conn:
            cursor = conn.cursor()
            # 检查是否有未结束的活跃任务
            cursor.execute(
                "SELECT task_id, status FROM tasks WHERE status NOT IN (?, ?);",
                (TaskStatus.FINAL_REPORTS_READY.value, TaskStatus.CANCELLED.value)
            )
            active = cursor.fetchone()
            if active:
                raise ValueError(f"已存在活跃任务 {active['task_id']} (状态: {active['status']})，不能启动新任务")

            waiting = json.dumps(["query", "media", "insight"])
            cursor.execute("""
                INSERT INTO tasks (task_id, topic, status, current_round, max_rounds, waiting_agents, op_version, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?);
            """, (task_id, topic, TaskStatus.INITIAL_RESEARCH.value, 1, max_rounds, waiting, now, now))
            conn.commit()

        return self.get_task(task_id)

    def get_task(self, task_id: str) -> Optional[TaskState]:
        """获取任务状态"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT * FROM tasks WHERE task_id = ?;", (task_id,))
            row = cursor.fetchone()
            if not row:
                return None

            cursor.execute("SELECT agent_id, report_path FROM reports WHERE task_id = ?;", (task_id,))
            reports = {r["agent_id"]: r["report_path"] for r in cursor.fetchall()}

            return TaskState(
                task_id=row["task_id"],
                topic=row["topic"],
                status=TaskStatus(row["status"]),
                current_round=row["current_round"],
                max_rounds=row["max_rounds"],
                waiting_agents=json.loads(row["waiting_agents"]),
                paused_reason=row["paused_reason"],
                paused_stage=row["paused_stage"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                registered_reports=reports,
            )

    def get_active_task(self) -> Optional[TaskState]:
        """获取当前活跃任务（如果有）"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT task_id FROM tasks WHERE status NOT IN (?, ?) ORDER BY created_at DESC LIMIT 1;",
                (TaskStatus.FINAL_REPORTS_READY.value, TaskStatus.CANCELLED.value)
            )
            row = cursor.fetchone()
            if not row:
                return None
            return self.get_task(row["task_id"])

    def get_latest_task(self) -> Optional[TaskState]:
        """获取最新的协作任务（包括已就绪状态）"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1;")
            row = cursor.fetchone()
            if not row:
                return None
            return self.get_task(row["task_id"])

    def update_task_status(
        self,
        task_id: str,
        status: Optional[TaskStatus] = None,
        current_round: Optional[int] = None,
        waiting_agents: Optional[List[str]] = None,
        paused_reason: Optional[str] = None,
        paused_stage: Optional[str] = None,
    ) -> bool:
        """更新任务状态及版本号"""
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT op_version FROM tasks WHERE task_id = ?;", (task_id,))
            row = cursor.fetchone()
            if not row:
                return False
            new_version = row["op_version"] + 1

            updates = ["op_version = ?", "updated_at = ?"]
            params: List[Any] = [new_version, now]

            if status is not None:
                updates.append("status = ?")
                params.append(status.value)

            if current_round is not None:
                updates.append("current_round = ?")
                params.append(current_round)
            if waiting_agents is not None:
                updates.append("waiting_agents = ?")
                params.append(json.dumps(waiting_agents))
            if paused_reason is not None:
                updates.append("paused_reason = ?")
                params.append(paused_reason)
            if paused_stage is not None:
                updates.append("paused_stage = ?")
                params.append(paused_stage)

            params.append(task_id)
            cursor.execute(f"UPDATE tasks SET {', '.join(updates)} WHERE task_id = ?;", params)
            conn.commit()
            return True

    # ==================== 阶段成果提交与校验 ====================

    def save_submission(self, submission: AgentSubmission) -> Tuple[bool, str]:
        """
        保存 Agent 的提交成果，严格支持幂等：
        - 若 submission_id 相同且内容完全一致，返回成功；
        - 若已存在同任务同轮次同Agent但 submission_id 或内容不同，拒绝；
        - 正常写入并更新任务的 waiting_agents 列表。
        """
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        serialized = submission.model_dump_json()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # 1. 校验任务状态
            cursor.execute("SELECT status, current_round, waiting_agents FROM tasks WHERE task_id = ?;", (submission.task_id,))
            task_row = cursor.fetchone()
            if not task_row:
                return False, f"任务 {submission.task_id} 不存在"

            current_status = TaskStatus(task_row["status"])
            if current_status in [TaskStatus.PAUSED, TaskStatus.CANCELLED, TaskStatus.FINAL_REPORTS_READY]:
                return False, f"任务处于 {current_status.value} 状态，拒绝新提交"

            if submission.round != task_row["current_round"]:
                return False, f"提交轮次 {submission.round} 与当前任务轮次 {task_row['current_round']} 不匹配"

            # 2. 检查是否已有提交
            cursor.execute("""
                SELECT submission_id, data_json FROM submissions
                WHERE task_id = ? AND agent_id = ? AND round = ?;
            """, (submission.task_id, submission.agent_id, submission.round))
            existing = cursor.fetchone()

            if existing:
                if existing["submission_id"] == submission.submission_id:
                    # 幂等返回
                    return True, "已成功接收相同提交（幂等响应）"
                else:
                    return False, f"{submission.agent_id} 在第 {submission.round} 轮已有已确认提交，不可重复覆盖"

            # 3. 插入新提交
            cursor.execute("""
                INSERT INTO submissions (submission_id, task_id, agent_id, round, checkpoint_path, data_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?);
            """, (
                submission.submission_id,
                submission.task_id,
                submission.agent_id,
                submission.round,
                submission.checkpoint_path,
                serialized,
                now
            ))

            # 4. 从 waiting_agents 中移除该 Agent
            waiting: List[str] = json.loads(task_row["waiting_agents"])
            if submission.agent_id in waiting:
                waiting.remove(submission.agent_id)
                cursor.execute(
                    "UPDATE tasks SET waiting_agents = ?, updated_at = ? WHERE task_id = ?;",
                    (json.dumps(waiting), now, submission.task_id)
                )

            conn.commit()

        return True, "提交保存成功"

    def get_submissions_for_round(self, task_id: str, round_num: int) -> List[AgentSubmission]:
        """获取某一轮已完成提交的列表"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT data_json FROM submissions
                WHERE task_id = ? AND round = ?;
            """, (task_id, round_num))
            rows = cursor.fetchall()
            return [AgentSubmission.model_validate_json(r["data_json"]) for r in rows]

    def get_agent_submission(self, task_id: str, agent_id: str, round_num: int) -> Optional[AgentSubmission]:
        """获取指定 Agent 某轮的提交"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT data_json FROM submissions
                WHERE task_id = ? AND agent_id = ? AND round = ?;
            """, (task_id, agent_id, round_num))
            row = cursor.fetchone()
            if not row:
                return None
            return AgentSubmission.model_validate_json(row["data_json"])

    # ==================== HOST 决策与指令管理 ====================

    def save_host_decision(self, decision: HostDecision) -> Tuple[bool, str]:
        """
        保存 HOST 评审决定，严格控制一轮仅能成功一次评审
        同时将 directives 插入 guidances 表
        """
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        serialized = decision.model_dump_json()

        with self._get_connection() as conn:
            cursor = conn.cursor()

            # 检查该轮是否已存在评审
            cursor.execute("SELECT id FROM reviews WHERE task_id = ? AND round = ?;", (decision.task_id, decision.round))
            if cursor.fetchone():
                return False, f"任务 {decision.task_id} 第 {decision.round} 轮已存在 HOST 决定"

            # 插入 review
            cursor.execute("""
                INSERT INTO reviews (task_id, round, decision, overall_rationale, unresolved_issues, decision_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?);
            """, (
                decision.task_id,
                decision.round,
                decision.decision.value,
                decision.overall_rationale,
                json.dumps(decision.unresolved_issues, ensure_ascii=False),
                serialized,
                now
            ))

            # 插入 guidances
            for item in decision.directives:
                cursor.execute("""
                    INSERT OR REPLACE INTO guidances (guidance_id, task_id, round, target_agent, related_claim, question, suggested_action, completion_criteria, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                """, (
                    item.guidance_id,
                    decision.task_id,
                    decision.round,
                    item.target_agent,
                    item.related_paragraph_or_claim,
                    item.question,
                    item.suggested_action,
                    item.completion_criteria,
                    now
                ))

            conn.commit()

        return True, "HOST 决定保存成功"

    def get_host_decision(self, task_id: str, round_num: int) -> Optional[HostDecision]:
        """获取指定轮次的 HOST 决定"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT decision_json FROM reviews WHERE task_id = ? AND round = ?;", (task_id, round_num))
            row = cursor.fetchone()
            if not row:
                return None
            return HostDecision.model_validate_json(row["decision_json"])

    def get_latest_host_decision(self, task_id: str) -> Optional[HostDecision]:
        """获取最新的 HOST 决定"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT decision_json FROM reviews WHERE task_id = ? ORDER BY round DESC LIMIT 1;", (task_id,))
            row = cursor.fetchone()
            if not row:
                return None
            return HostDecision.model_validate_json(row["decision_json"])

    def get_directives_for_agent(self, task_id: str, agent_id: str, round_num: int) -> List[GuidanceItem]:
        """查询指定轮次下发给指定 Agent 的全部指令"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                SELECT * FROM guidances
                WHERE task_id = ? AND target_agent = ? AND round = ?;
            """, (task_id, agent_id, round_num))
            rows = cursor.fetchall()
            return [
                GuidanceItem(
                    guidance_id=r["guidance_id"],
                    target_agent=r["target_agent"],
                    related_paragraph_or_claim=r["related_claim"],
                    question=r["question"],
                    suggested_action=r["suggested_action"],
                    completion_criteria=r["completion_criteria"]
                )
                for r in rows
            ]

    # ==================== 最终研报登记 ====================

    def register_report(self, task_id: str, agent_id: str, report_path: str) -> bool:
        """登记某个 Agent 最终生成的报告路径"""
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        p = Path(report_path)
        file_size = p.stat().st_size if p.exists() else 0

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT OR REPLACE INTO reports (task_id, agent_id, report_path, file_size, created_at)
                VALUES (?, ?, ?, ?, ?);
            """, (task_id, agent_id, report_path, file_size, now))

            # 检查三方是否都已登记报告
            cursor.execute("SELECT COUNT(DISTINCT agent_id) as cnt FROM reports WHERE task_id = ?;", (task_id,))
            count = cursor.fetchone()["cnt"]
            if count >= 3:
                cursor.execute("""
                    UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?;
                """, (TaskStatus.FINAL_REPORTS_READY.value, now, task_id))

            conn.commit()
            return True

    def get_registered_reports(self, task_id: str) -> Dict[str, str]:
        """获取任务下已登记的三方最终报告"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT agent_id, report_path FROM reports WHERE task_id = ?;", (task_id,))
            return {r["agent_id"]: r["report_path"] for r in cursor.fetchall()}
