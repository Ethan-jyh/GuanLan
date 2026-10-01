# -*- coding: utf-8 -*-
"""
ResearchEngine 有序持久化事件流 (EventManager)
提供带单调递增序号 (event_seq) 的事件发布与拉取功能，
保证网络重连或页面刷新时可根据最新已知序号断点续传。
"""

import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from .storage import ResearchStorage


class EventManager:
    """研究运行事件日志管理器"""

    def __init__(self, storage: ResearchStorage):
        self.storage = storage
        self._init_table()

    def _init_table(self):
        with self.storage._get_connection() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS research_events (
                    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id TEXT NOT NULL,
                    event_seq INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_events_run_seq 
                ON research_events(run_id, event_seq);
            """)
            conn.commit()

    def publish_event(
        self,
        run_id: str,
        event_type: str,
        payload: Dict[str, Any],
    ) -> int:
        """
        原子发布新事件，分配连续自增的 event_seq 序号并持久化
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        payload_json = json.dumps(payload, ensure_ascii=False)

        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("BEGIN IMMEDIATE;")
            cursor.execute(
                "SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM research_events WHERE run_id = ?",
                (run_id,),
            )
            next_seq = cursor.fetchone()["next_seq"]

            cursor.execute(
                """
                INSERT INTO research_events (run_id, event_seq, event_type, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?);
                """,
                (run_id, next_seq, event_type, payload_json, now_iso),
            )
            conn.commit()
            return next_seq

    def get_events(self, run_id: str, after_seq: int = 0) -> List[Dict[str, Any]]:
        """
        根据 offset/after_seq 增量读取指定运行的事件列表
        """
        with self.storage._get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(
                """
                SELECT * FROM research_events
                WHERE run_id = ? AND event_seq > ?
                ORDER BY event_seq ASC;
                """,
                (run_id, after_seq),
            )
            rows = cursor.fetchall()
            events: List[Dict[str, Any]] = []
            for r in rows:
                events.append({
                    "event_id": r["event_id"],
                    "run_id": r["run_id"],
                    "event_seq": r["event_seq"],
                    "event_type": r["event_type"],
                    "payload": json.loads(r["payload_json"]),
                    "created_at": r["created_at"],
                })
            return events
