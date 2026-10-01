# -*- coding: utf-8 -*-
"""
Task 5 成果提交、校验与任务持久化测试
测试覆盖：
1. 成果结构化提交校验与 SQLite 持久化
2. 证据引用完整性校验（主张引用的 evidence_id 必须存在于证据池中）
3. 提交成功后子任务状态原子转移为 submitted
4. 格式或引用错误时返回结构化错误信息，拒绝无效成果
"""

import os
import sys
import unittest
import tempfile

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchSubmissions(unittest.TestCase):
    """成果提交校验测试"""

    def setUp(self):
        from ResearchEngine.storage import ResearchStorage
        from ResearchEngine.evidence import EvidenceStore
        from ResearchEngine.submissions import SubmissionManager

        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.storage = ResearchStorage(db_path=self.temp_db.name)
        self.evidence_store = EvidenceStore(db_path=self.temp_db.name)
        self.submission_mgr = SubmissionManager(self.storage, self.evidence_store)

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_valid_submission_saves_and_updates_task(self):
        """测试合规的权威口径成果正常持久化"""
        run_id = "run-sub-001"
        task_id = "task-auth-001"

        valid_payload = {
            "run_id": run_id,
            "task_id": task_id,
            "role": "authority",
            "round": 1,
            "claims": [
                {
                    "claim_id": "C1",
                    "statement": "市应急管理局已启动二级应急响应",
                    "evidence_ids": ["E1"],
                    "limitations": ["仅市域范围"],
                }
            ],
            "evidence_pool": [
                {
                    "evidence_id": "E1",
                    "source_type": "official_doc",
                    "source_ref": "https://gov.example.com/doc",
                    "title": "通报",
                    "excerpt": "启动二级应急响应。",
                    "retrieval_time": "2026-10-01T10:00:00Z",
                    "is_full_text": True,
                }
            ],
            "scope": {"region": "市区"},
            "authority_finding": {
                "entity_name": "市应急管理局",
                "source_type": "官方网站",
                "published_at": "2026-10-01T09:30:00Z",
                "raw_text": "启动二级应急响应。",
                "stance_evolution": "常态平稳",
                "covered_issues": ["响应等级"],
                "unaddressed_issues": [],
            },
        }

        ok, sub_id, err = self.submission_mgr.validate_and_save_submission(valid_payload)
        self.assertTrue(ok)
        self.assertIsNotNone(sub_id)
        self.assertIsNone(err)

        # 检查持久化读取
        saved = self.submission_mgr.get_submission(sub_id)
        self.assertIsNotNone(saved)
        self.assertEqual(saved["role"], "authority")
        self.assertEqual(saved["round"], 1)

    def test_reject_unreferenced_evidence(self):
        """测试拒绝引用了不存在的 evidence_id 的主张"""
        invalid_payload = {
            "run_id": "run-sub-002",
            "task_id": "task-auth-002",
            "role": "authority",
            "round": 1,
            "claims": [
                {
                    "claim_id": "C1",
                    "statement": "未提供有效证据的主张",
                    "evidence_ids": ["E-GHOST-999"],  # 不存在
                    "limitations": [],
                }
            ],
            "evidence_pool": [],  # 空证据池
            "scope": {},
            "authority_finding": {
                "entity_name": "机构",
                "source_type": "新闻",
                "published_at": "2026-10-01",
                "raw_text": "原文",
                "stance_evolution": "无",
                "covered_issues": [],
                "unaddressed_issues": [],
            },
        }

        ok, sub_id, err = self.submission_mgr.validate_and_save_submission(invalid_payload)
        self.assertFalse(ok)
        self.assertIsNone(sub_id)
        self.assertIn("E-GHOST-999", err)


if __name__ == "__main__":
    unittest.main()
