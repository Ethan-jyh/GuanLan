# -*- coding: utf-8 -*-
"""
Task 11 运行 API 与状态生命周期测试 (test_research_routes.py)
测试覆盖：
1. POST /api/research/runs 创建研究运行
2. GET /api/research/runs/<run_id> 获取运行详情与任务状态
3. POST /api/research/runs/<run_id>/pause 暂停
4. POST /api/research/runs/<run_id>/resume 恢复并递增执行版本
5. POST /api/research/runs/<run_id>/cancel 取消运行
6. GET /api/research/runs/<run_id>/events 获取持久化有序事件流
"""

import os
import sys
import unittest
import tempfile
import json
from flask import Flask

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ResearchEngine.storage import ResearchStorage
from ResearchEngine.evidence import EvidenceStore
from ResearchEngine.submissions import SubmissionManager
from ResearchEngine.budget import BudgetManager
from ResearchEngine.coordinator import ResearchCoordinator
from ResearchEngine.events import EventManager
from ResearchEngine.recovery import RecoveryManager
from ResearchEngine.flask_routes import create_research_blueprint


class TestResearchRoutes(unittest.TestCase):
    """ResearchEngine REST API 测试"""

    def setUp(self):
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.storage = ResearchStorage(db_path=self.temp_db.name)
        self.evidence_store = EvidenceStore(db_path=self.temp_db.name)
        self.submission_mgr = SubmissionManager(self.storage, self.evidence_store)
        self.budget_mgr = BudgetManager(self.storage, total_tool_limit=50)
        self.coordinator = ResearchCoordinator(
            storage=self.storage,
            submission_mgr=self.submission_mgr,
            budget_mgr=self.budget_mgr,
        )
        self.event_mgr = EventManager(self.storage)
        self.recovery_mgr = RecoveryManager(self.storage, self.coordinator)

        self.app = Flask(__name__)
        bp = create_research_blueprint(
            storage=self.storage,
            coordinator=self.coordinator,
            event_mgr=self.event_mgr,
            recovery_mgr=self.recovery_mgr,
            budget_mgr=self.budget_mgr,
        )
        self.app.register_blueprint(bp, url_prefix="/api/research")
        self.client = self.app.test_client()

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_create_and_get_run(self):
        """测试创建运行与读取详情"""
        res = self.client.post(
            "/api/research/runs",
            json={"topic": "突发火情专项研判", "scope": {"city": "上海"}, "budget_total": 50},
        )
        self.assertEqual(res.status_code, 201)
        data = res.get_json()
        self.assertTrue(data["ok"])
        run_id = data["run"]["run_id"]

        # 读取详情
        get_res = self.client.get(f"/api/research/runs/{run_id}")
        self.assertEqual(get_res.status_code, 200)
        get_data = get_res.get_json()
        self.assertTrue(get_data["ok"])
        self.assertEqual(get_data["run"]["topic"], "突发火情专项研判")
        self.assertEqual(len(get_data["tasks"]), 3)

    def test_pause_resume_cancel_flow(self):
        """测试暂停、恢复、取消的流转与执行版本递增"""
        res = self.client.post("/api/research/runs", json={"topic": "生命周期流转测试"})
        run_id = res.get_json()["run"]["run_id"]

        # 1. 暂停
        p_res = self.client.post(f"/api/research/runs/{run_id}/pause")
        self.assertEqual(p_res.status_code, 200)
        self.assertEqual(p_res.get_json()["run"]["status"], "paused")

        # 2. 恢复
        r_res = self.client.post(f"/api/research/runs/{run_id}/resume")
        self.assertEqual(r_res.status_code, 200)
        self.assertEqual(r_res.get_json()["run"]["status"], "researching")
        self.assertGreaterEqual(r_res.get_json()["run"]["execution_version"], 2)

        # 3. 取消
        c_res = self.client.post(f"/api/research/runs/{run_id}/cancel")
        self.assertEqual(c_res.status_code, 200)
        self.assertEqual(c_res.get_json()["run"]["status"], "cancelled")

    def test_events_stream_ordering(self):
        """测试按序号增量拉取事件"""
        res = self.client.post("/api/research/runs", json={"topic": "事件流测试"})
        run_id = res.get_json()["run"]["run_id"]

        self.event_mgr.publish_event(run_id, "TASK_STARTED", {"task": "auth"})
        self.event_mgr.publish_event(run_id, "TOOL_CALLED", {"tool": "search_web"})
        self.event_mgr.publish_event(run_id, "SUBMISSION_DONE", {"role": "authority"})

        # 拉取全部事件
        ev_res = self.client.get(f"/api/research/runs/{run_id}/events")
        self.assertEqual(ev_res.status_code, 200)
        events = ev_res.get_json()["events"]
        self.assertGreaterEqual(len(events), 3)

        # 验证序号递增
        seqs = [e["event_seq"] for e in events]
        self.assertEqual(seqs, sorted(seqs))

        # 验证 after_seq 过滤
        after_res = self.client.get(f"/api/research/runs/{run_id}/events?after_seq={seqs[0]}")
        after_events = after_res.get_json()["events"]
        self.assertEqual(len(after_events), len(events) - 1)


if __name__ == "__main__":
    unittest.main()
