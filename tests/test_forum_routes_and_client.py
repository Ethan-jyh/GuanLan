# -*- coding: utf-8 -*-
"""
论坛阶段评审 Flask 接口与 Client 端到端测试
"""

import os
import sys
import unittest
import tempfile
import json
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from flask import Flask
from ForumEngine.flask_routes import forum_review_bp
from ForumEngine.storage import ForumReviewStorage
from ForumEngine.coordinator import ForumReviewCoordinator
from ForumEngine.schema import (
    TaskStatus,
    DecisionType,
    AgentSubmission,
    ParagraphSubmission,
    EvidenceItem,
    HostDecision
)


class TestForumRoutesAndClient(unittest.TestCase):
    """测试 Flask HTTP 路由与协作接口"""

    def setUp(self):
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.db_path = self.temp_db.name
        self.storage = ForumReviewStorage(db_path=self.db_path)
        self.coordinator = ForumReviewCoordinator(storage=self.storage)

        self.app = Flask(__name__)
        self.app.config["TESTING"] = True
        self.app.register_blueprint(forum_review_bp, url_prefix="/api/forum")
        self.client = self.app.test_client()

    def tearDown(self):
        if os.path.exists(self.db_path):
            try:
                os.remove(self.db_path)
            except Exception:
                pass

    def test_01_task_lifecycle_routes(self):
        """测试创建任务、查询状态、暂停恢复与取消"""
        # 1. 创建任务
        resp = self.client.post("/api/forum/tasks", json={"topic": "测试大模型虚假宣传事件", "max_rounds": 3})
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["success"])
        task_id = data["task"]["task_id"]

        # 2. 查询任务状态
        resp_get = self.client.get(f"/api/forum/tasks/{task_id}")
        self.assertEqual(resp_get.status_code, 200)
        task_data = resp_get.get_json()["task"]
        self.assertEqual(task_data["status"], TaskStatus.INITIAL_RESEARCH.value)
        self.assertEqual(task_data["current_round"], 1)

        # 3. 提交阶段成果
        sub_query = {
            "task_id": task_id,
            "agent_id": "query",
            "round": 1,
            "submission_id": "sub_q_test_100",
            "checkpoint_path": "logs/checkpoints/test.json",
            "paragraphs": [
                {
                    "paragraph_id": "P1",
                    "title": "事实核查段落",
                    "summary": "调查发现并未取得相关行政许可",
                    "key_claims": ["未取得行政许可"],
                    "evidence_ids": ["E1"]
                }
            ],
            "evidence_list": [
                {
                    "evidence_id": "E1",
                    "source_type": "webpage",
                    "source_ref": "https://gov.cn/notice/1",
                    "title": "官方公告",
                    "excerpt": "并未核发相关资质",
                    "retrieval_time": "2026-09-30 14:00:00"
                }
            ]
        }
        sub_resp = self.client.post(f"/api/forum/tasks/{task_id}/submissions", json=sub_query)
        self.assertEqual(sub_resp.status_code, 200)
        self.assertTrue(sub_resp.get_json()["success"])

        # 4. Agent 轮询查询自己决定
        dec_resp = self.client.get(f"/api/forum/tasks/{task_id}/agents/query/decision")
        self.assertEqual(dec_resp.status_code, 200)
        dec_data = dec_resp.get_json()
        self.assertTrue(dec_data["success"])

        # 5. 暂停任务
        self.coordinator.pause_task(task_id, reason="人工介入复核")
        resp_paused = self.client.get(f"/api/forum/tasks/{task_id}")
        self.assertEqual(resp_paused.get_json()["task"]["status"], TaskStatus.PAUSED.value)

        # 6. 恢复任务
        resp_resume = self.client.post(f"/api/forum/tasks/{task_id}/resume")
        self.assertEqual(resp_resume.status_code, 200)
        resp_resumed = self.client.get(f"/api/forum/tasks/{task_id}")
        self.assertNotEqual(resp_resumed.get_json()["task"]["status"], TaskStatus.PAUSED.value)

        # 7. 登记报告
        # 先模拟审批放行
        self.storage.update_task_status(task_id, TaskStatus.APPROVED_FOR_REPORT)
        rep_resp = self.client.post(f"/api/forum/tasks/{task_id}/reports", json={
            "agent_id": "query",
            "report_path": "query_engine_streamlit_reports/report_1.md"
        })
        self.assertEqual(rep_resp.status_code, 200)
        self.assertTrue(rep_resp.get_json()["success"])

        # 8. 取消任务
        resp_cancel = self.client.post(f"/api/forum/tasks/{task_id}/cancel")
        self.assertEqual(resp_cancel.status_code, 200)
        resp_cancelled = self.client.get(f"/api/forum/tasks/{task_id}")
        self.assertEqual(resp_cancelled.get_json()["task"]["status"], TaskStatus.CANCELLED.value)


if __name__ == "__main__":
    unittest.main()
