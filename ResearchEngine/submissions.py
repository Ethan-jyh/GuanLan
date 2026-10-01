# -*- coding: utf-8 -*-
"""
ResearchEngine 成果提交校验与持久化管理
依据设计：校验成果结构、必要证据字段、证据池引用合法性，更新任务状态
"""

import json
import uuid
from datetime import datetime, timezone
from typing import Dict, Any, Tuple, Optional

from .schema import ResearchResult, ResearchRole, TaskStatus
from .storage import ResearchStorage
from .evidence import EvidenceStore


class SubmissionManager:
    """研究员成果提交管理器"""

    def __init__(self, storage: ResearchStorage, evidence_store: Optional[EvidenceStore] = None):
        self.storage = storage
        self.evidence_store = evidence_store

    def validate_and_save_submission(
        self, payload: Dict[str, Any]
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        校验并持久化研究成果。
        返回: (is_success, submission_id, error_message)
        """
        run_id = payload.get("run_id")
        task_id = payload.get("task_id")
        if not run_id or not task_id:
            return False, None, "Missing run_id or task_id in submission payload"

        # 1. Pydantic 模型校验
        try:
            result_model = ResearchResult.model_validate(payload)
        except Exception as e:
            return False, None, f"Schema validation error: {str(e)}"

        # 2. 证据引用完整性校验：所有 claims 引用的 evidence_id 必须在 evidence_pool 或已入库
        known_evidence_ids = {e.evidence_id for e in result_model.evidence_pool}
        for claim in result_model.claims:
            for eid in claim.evidence_ids:
                if eid not in known_evidence_ids:
                    # 检查是否已存在于持久化 evidence_store
                    if not self.evidence_store or not self.evidence_store.get_evidence(run_id, eid):
                        return (
                            False,
                            None,
                            f"Claim '{claim.claim_id}' references unknown evidence '{eid}'. Must be included in evidence_pool or stored.",
                        )

        # 3. 角色成果对齐检查
        role_str = str(result_model.role.value if hasattr(result_model.role, "value") else result_model.role)
        if role_str == ResearchRole.AUTHORITY.value and not result_model.authority_finding:
            return False, None, "Authority finding is required for authority role submission"
        elif role_str == ResearchRole.EVOLUTION.value and not result_model.evolution_finding:
            return False, None, "Evolution finding is required for evolution role submission"
        elif role_str == ResearchRole.FEEDBACK.value and not result_model.feedback_finding:
            return False, None, "Feedback finding is required for feedback role submission"

        # 4. 若传入证据池，自动将新证据沉淀至 evidence_store
        if self.evidence_store:
            for ev in result_model.evidence_pool:
                self.evidence_store.add_evidence(
                    run_id=run_id,
                    source_type=ev.source_type,
                    source_ref=ev.source_ref,
                    title=ev.title,
                    excerpt=ev.excerpt,
                    retrieval_time=ev.retrieval_time,
                    source_date=ev.source_date,
                    is_full_text=ev.is_full_text,
                    coverage_scope=ev.coverage_scope,
                )

        # 5. 写入 submissions 表并更新任务状态
        now_iso = datetime.now(timezone.utc).isoformat()
        submission_id = f"sub-{uuid.uuid4().hex[:12]}"
        data_json = json.dumps(result_model.model_dump(), ensure_ascii=False)

        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                INSERT INTO submissions (
                    submission_id, run_id, task_id, role, round, data_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?);
                """,
                (
                    submission_id,
                    run_id,
                    task_id,
                    role_str,
                    result_model.round,
                    data_json,
                    now_iso,
                ),
            )
            # 更新 tasks 状态
            cursor.execute(
                """
                UPDATE tasks
                SET status = ?, completed_at = ?
                WHERE task_id = ?;
                """,
                (TaskStatus.SUBMITTED.value, now_iso, task_id),
            )
            conn.commit()

        return True, submission_id, None

    def get_submission(self, submission_id: str) -> Optional[Dict[str, Any]]:
        """获取已提交的成果数据"""
        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM submissions WHERE submission_id = ?",
                (submission_id,),
            )
            row = cursor.fetchone()
            if not row:
                return None
            data = json.loads(row["data_json"])
            data["submission_id"] = row["submission_id"]
            return data

    def get_latest_submission_for_role(
        self, run_id: str, role: str, round_num: Optional[int] = None
    ) -> Optional[Dict[str, Any]]:
        """查询指定角色在某轮或最新一轮的有效成果"""
        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            if round_num is not None:
                cursor.execute(
                    """
                    SELECT * FROM submissions 
                    WHERE run_id = ? AND role = ? AND round = ?
                    ORDER BY created_at DESC LIMIT 1;
                    """,
                    (run_id, role, round_num),
                )
            else:
                cursor.execute(
                    """
                    SELECT * FROM submissions 
                    WHERE run_id = ? AND role = ?
                    ORDER BY round DESC, created_at DESC LIMIT 1;
                    """,
                    (run_id, role),
                )
            row = cursor.fetchone()
            if not row:
                return None
            data = json.loads(row["data_json"])
            data["submission_id"] = row["submission_id"]
            return data
