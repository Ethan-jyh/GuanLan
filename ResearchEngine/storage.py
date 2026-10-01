# -*- coding: utf-8 -*-
"""
ResearchEngine SQLite 持久化存储
管理 Runs, Tasks, Budget Ledger, Submissions 与幂等记录
"""

import os
import sqlite3
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional, Tuple


class ResearchStorage:
    """研究状态与预算账本存储"""

    def __init__(self, db_path: str = "data/research.sqlite3"):
        self.db_path = db_path
        if db_path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
        self._init_db()

    def _get_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        return conn

    def _init_db(self):
        with self._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS runs (
                    run_id TEXT PRIMARY KEY,
                    topic TEXT NOT NULL,
                    scope TEXT,
                    status TEXT NOT NULL,
                    current_round INTEGER NOT NULL DEFAULT 1,
                    max_rounds INTEGER NOT NULL DEFAULT 3,
                    budget_total INTEGER NOT NULL DEFAULT 50,
                    budget_used INTEGER NOT NULL DEFAULT 0,
                    execution_version INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS tasks (
                    task_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    round INTEGER NOT NULL DEFAULT 1,
                    question TEXT NOT NULL,
                    scope TEXT,
                    status TEXT NOT NULL,
                    assigned_to TEXT,
                    budget_allocated INTEGER NOT NULL DEFAULT 12,
                    created_at TEXT NOT NULL,
                    completed_at TEXT
                );
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS budget_ledger (
                    ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    reservation_id TEXT UNIQUE NOT NULL,
                    run_id TEXT NOT NULL,
                    task_id TEXT,
                    call_type TEXT NOT NULL,
                    units_reserved INTEGER NOT NULL DEFAULT 0,
                    units_used INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL, -- 'reserved', 'settled', 'cancelled'
                    cost_estimate REAL,
                    idempotency_key TEXT,
                    created_at TEXT NOT NULL,
                    settled_at TEXT
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_budget_run ON budget_ledger(run_id);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_budget_idem ON budget_ledger(idempotency_key);")

            conn.execute("""
                CREATE TABLE IF NOT EXISTS submissions (
                    submission_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    round INTEGER NOT NULL,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            """)

            conn.execute("""
                CREATE TABLE IF NOT EXISTS idempotency_records (
                    idempotency_key TEXT PRIMARY KEY,
                    call_id TEXT NOT NULL,
                    response_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            """)
            conn.commit()

    # ---------------- 预算事务操作 ----------------
    def reserve_budget_atomic(
        self,
        run_id: str,
        task_id: str,
        units: int,
        call_type: str,
        idempotency_key: Optional[str],
        max_allowed: int,
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        原子预留预算配额。
        返回: (is_success, reservation_id, error_message)
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        reservation_id = f"res-{datetime.now().strftime('%Y%m%d%H%M%S%f')}"

        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE;")

            # 1. 幂等性检查
            if idempotency_key:
                cursor.execute(
                    "SELECT reservation_id, status FROM budget_ledger WHERE idempotency_key = ?",
                    (idempotency_key,),
                )
                existing = cursor.fetchone()
                if existing:
                    conn.commit()
                    return True, existing["reservation_id"], None

            # 2. 统计当前已消耗 + 已预留额度
            cursor.execute(
                """
                SELECT 
                    COALESCE(SUM(units_used), 0) AS total_used,
                    COALESCE(SUM(CASE WHEN status = 'reserved' THEN units_reserved ELSE 0 END), 0) AS total_reserved
                FROM budget_ledger
                WHERE run_id = ? AND status IN ('reserved', 'settled');
                """,
                (run_id,),
            )
            stats = cursor.fetchone()
            used_so_far = stats["total_used"] + stats["total_reserved"]

            if used_so_far + units > max_allowed:
                conn.rollback()
                return (
                    False,
                    None,
                    f"Budget quota exceeded: used/reserved={used_so_far}, requesting={units}, max_allowed={max_allowed}",
                )

            # 3. 写入预留记录
            cursor.execute(
                """
                INSERT INTO budget_ledger (
                    reservation_id, run_id, task_id, call_type, units_reserved,
                    units_used, status, idempotency_key, created_at
                ) VALUES (?, ?, ?, ?, ?, 0, 'reserved', ?, ?);
                """,
                (reservation_id, run_id, task_id, call_type, units, idempotency_key, now_iso),
            )
            conn.commit()
            return True, reservation_id, None

    def settle_budget_atomic(
        self,
        reservation_id: str,
        actual_units: int,
        cost_estimate: Optional[float] = None,
    ):
        """结算预算预留"""
        now_iso = datetime.now(timezone.utc).isoformat()
        with self._get_connection() as conn:
            conn.execute(
                """
                UPDATE budget_ledger
                SET status = 'settled',
                    units_used = ?,
                    units_reserved = 0,
                    cost_estimate = ?,
                    settled_at = ?
                WHERE reservation_id = ?;
                """,
                (actual_units, cost_estimate, now_iso, reservation_id),
            )
            conn.commit()

    def get_run_budget_usage(self, run_id: str) -> Dict[str, int]:
        """获取已结算和当前冻结预留的预算用量"""
        with self._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT 
                    COALESCE(SUM(units_used), 0) AS total_used,
                    COALESCE(SUM(CASE WHEN status = 'reserved' THEN units_reserved ELSE 0 END), 0) AS total_reserved
                FROM budget_ledger
                WHERE run_id = ? AND status IN ('reserved', 'settled');
                """,
                (run_id,),
            )
            row = cursor.fetchone()
            return {
                "used": row["total_used"],
                "reserved": row["total_reserved"],
                "committed": row["total_used"] + row["total_reserved"],
            }
