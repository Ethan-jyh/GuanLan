# -*- coding: utf-8 -*-
"""
ResearchEngine 证据存储与去重管理
依据 2026-10-01 设计：
1. 来源发布时间与抓取时间独立存储
2. 搜索摘要与完整正文区分标记 (is_full_text)
3. 同源内容指纹去重，不同 run_id 严格隔离
"""

import os
import sqlite3
import hashlib
import json
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any

from .schema import Evidence


class EvidenceStore:
    """持久化证据池"""

    def __init__(self, db_path: str = "data/research_evidence.sqlite3"):
        self.db_path = db_path
        if db_path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS evidence (
                    evidence_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_ref TEXT NOT NULL,
                    title TEXT NOT NULL,
                    excerpt TEXT NOT NULL,
                    retrieval_time TEXT NOT NULL,
                    source_date TEXT,
                    is_full_text INTEGER NOT NULL DEFAULT 0,
                    coverage_scope TEXT,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (run_id, evidence_id),
                    UNIQUE (run_id, fingerprint)
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);")
            conn.commit()

    @staticmethod
    def _compute_fingerprint(source_ref: str, excerpt: str) -> str:
        raw = f"{source_ref.strip()}::{excerpt.strip()}".encode("utf-8")
        return hashlib.sha256(raw).hexdigest()

    def add_evidence(
        self,
        run_id: str,
        source_type: str,
        source_ref: str,
        title: str,
        excerpt: str,
        retrieval_time: Optional[str] = None,
        source_date: Optional[str] = None,
        is_full_text: bool = False,
        coverage_scope: Optional[Dict[str, Any]] = None,
    ) -> Evidence:
        """添加证据。同 run_id 下相同来源与内容自动复用已分配的 evidence_id"""
        now_iso = datetime.now(timezone.utc).isoformat()
        r_time = retrieval_time or now_iso
        fp = self._compute_fingerprint(source_ref, excerpt)

        with self._get_connection() as conn:
            # 1. 检查是否存在已有相同指纹
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM evidence WHERE run_id = ? AND fingerprint = ?",
                (run_id, fp),
            )
            row = cursor.fetchone()
            if row:
                scope_dict = json.loads(row["coverage_scope"]) if row["coverage_scope"] else {}
                return Evidence(
                    evidence_id=row["evidence_id"],
                    source_type=row["source_type"],
                    source_ref=row["source_ref"],
                    title=row["title"],
                    excerpt=row["excerpt"],
                    retrieval_time=row["retrieval_time"],
                    source_date=row["source_date"],
                    is_full_text=bool(row["is_full_text"]),
                    coverage_scope=scope_dict,
                )

            # 2. 生成新 evidence_id: E-<序号>
            cursor.execute(
                "SELECT COUNT(*) AS cnt FROM evidence WHERE run_id = ?",
                (run_id,),
            )
            count = cursor.fetchone()["cnt"] + 1
            evidence_id = f"E-{count:03d}"

            scope_json = json.dumps(coverage_scope or {}, ensure_ascii=False)
            cursor.execute(
                """
                INSERT INTO evidence (
                    evidence_id, run_id, fingerprint, source_type, source_ref,
                    title, excerpt, retrieval_time, source_date, is_full_text,
                    coverage_scope, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    evidence_id,
                    run_id,
                    fp,
                    source_type,
                    source_ref,
                    title,
                    excerpt,
                    r_time,
                    source_date,
                    1 if is_full_text else 0,
                    scope_json,
                    now_iso,
                ),
            )
            conn.commit()

        return Evidence(
            evidence_id=evidence_id,
            source_type=source_type,
            source_ref=source_ref,
            title=title,
            excerpt=excerpt,
            retrieval_time=r_time,
            source_date=source_date,
            is_full_text=is_full_text,
            coverage_scope=coverage_scope or {},
        )

    def list_evidence(self, run_id: str) -> List[Evidence]:
        """获取指定 run_id 的全部证据"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM evidence WHERE run_id = ? ORDER BY evidence_id ASC",
                (run_id,),
            )
            rows = cursor.fetchall()
            results = []
            for r in rows:
                scope_dict = json.loads(r["coverage_scope"]) if r["coverage_scope"] else {}
                results.append(
                    Evidence(
                        evidence_id=r["evidence_id"],
                        source_type=r["source_type"],
                        source_ref=r["source_ref"],
                        title=r["title"],
                        excerpt=r["excerpt"],
                        retrieval_time=r["retrieval_time"],
                        source_date=r["source_date"],
                        is_full_text=bool(r["is_full_text"]),
                        coverage_scope=scope_dict,
                    )
                )
            return results

    def get_evidence(self, run_id: str, evidence_id: str) -> Optional[Evidence]:
        """按 ID 获取单条证据"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "SELECT * FROM evidence WHERE run_id = ? AND evidence_id = ?",
                (run_id, evidence_id),
            )
            r = cursor.fetchone()
            if not r:
                return None
            scope_dict = json.loads(r["coverage_scope"]) if r["coverage_scope"] else {}
            return Evidence(
                evidence_id=r["evidence_id"],
                source_type=r["source_type"],
                source_ref=r["source_ref"],
                title=r["title"],
                excerpt=r["excerpt"],
                retrieval_time=r["retrieval_time"],
                source_date=r["source_date"],
                is_full_text=bool(r["is_full_text"]),
                coverage_scope=scope_dict,
            )
