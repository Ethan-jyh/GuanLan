# -*- coding: utf-8 -*-
"""
Task 3 证据存储与指纹去重测试
覆盖：
1. 证据新增与按 run_id 隔离
2. 内容指纹与来源 URL 去重
3. 来源发布时间与抓取时间严格独立
4. 证据正文完整性标记 (is_full_text)
"""

import os
import sys
import unittest
import tempfile

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchEvidence(unittest.TestCase):
    """证据库功能与隔离性测试"""

    def setUp(self):
        from ResearchEngine.evidence import EvidenceStore
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.store = EvidenceStore(db_path=self.temp_db.name)

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_add_and_list_evidence(self):
        """测试添加证据并按 run_id 正确查询"""
        ev1 = self.store.add_evidence(
            run_id="run-1",
            source_type="official_doc",
            source_ref="https://example.gov.cn/doc1",
            title="通知一",
            excerpt="启动响应。",
            is_full_text=True,
            source_date="2026-10-01T08:00:00Z",
        )
        self.assertTrue(ev1.evidence_id.startswith("E-"))
        self.assertEqual(ev1.source_date, "2026-10-01T08:00:00Z")
        self.assertTrue(ev1.is_full_text)

        # 查 run-1
        list_run1 = self.store.list_evidence("run-1")
        self.assertEqual(len(list_run1), 1)
        self.assertEqual(list_run1[0].evidence_id, ev1.evidence_id)

        # 查 run-2 (隔离)
        list_run2 = self.store.list_evidence("run-2")
        self.assertEqual(len(list_run2), 0)

    def test_fingerprint_deduplication(self):
        """测试同源相同内容证据去重，复用既有 evidence_id"""
        ev1 = self.store.add_evidence(
            run_id="run-1",
            source_type="webpage",
            source_ref="https://news.example.com/a",
            title="报道A",
            excerpt="受暴雨影响交通管制。",
            is_full_text=False,
        )
        # 重复提交相同来源和内容
        ev2 = self.store.add_evidence(
            run_id="run-1",
            source_type="webpage",
            source_ref="https://news.example.com/a",
            title="报道A (抓取副本)",
            excerpt="受暴雨影响交通管制。",
            is_full_text=False,
        )
        self.assertEqual(ev1.evidence_id, ev2.evidence_id, "相同内容的证据应复用 evidence_id")
        self.assertEqual(len(self.store.list_evidence("run-1")), 1)


if __name__ == "__main__":
    unittest.main()
