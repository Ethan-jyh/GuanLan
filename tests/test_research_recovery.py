# -*- coding: utf-8 -*-
"""
Task 11 运行恢复、崩溃保护与版本失效测试 (test_research_recovery.py)
测试覆盖：
1. 服务重启时自动暂停所有未结束的运行 (auto_pause_unended_runs_on_startup)
2. 恢复从已提交成果、消息与预算继续，不刷新已消耗额度
3. 取消与恢复提升 execution_version，迟到响应或过期版本的提交被拒绝
"""

import os
import sys
import unittest
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ResearchEngine.schema import RunStatus, TaskStatus
from ResearchEngine.storage import ResearchStorage
from ResearchEngine.evidence import EvidenceStore
from ResearchEngine.submissions import SubmissionManager
from ResearchEngine.budget import BudgetManager
from ResearchEngine.coordinator import ResearchCoordinator
from ResearchEngine.recovery import RecoveryManager


class TestResearchRecovery(unittest.TestCase):
    """运行恢复与版本并发保护测试"""

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
        self.recovery_mgr = RecoveryManager(self.storage, self.coordinator)

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_auto_pause_unended_runs_on_startup(self):
        """测试服务重启时，将处于活跃状态（researching/reviewing）的运行自动安全暂停"""
        run1 = self.coordinator.create_run(topic="活跃任务1")
        run2 = self.coordinator.create_run(topic="活跃任务2")
        # 手动将 run2 置为 reviewing
        with self.storage._get_connection() as conn:
            conn.execute("UPDATE runs SET status = 'reviewing' WHERE run_id = ?", (run2.run_id,))
            conn.commit()

        # 触发启动恢复检查
        paused_ids = self.recovery_mgr.auto_pause_unended_runs_on_startup()
        self.assertIn(run1.run_id, paused_ids)
        self.assertIn(run2.run_id, paused_ids)

        r1 = self.coordinator.get_run(run1.run_id)
        r2 = self.coordinator.get_run(run2.run_id)
        self.assertEqual(r1.status, RunStatus.PAUSED)
        self.assertEqual(r2.status, RunStatus.PAUSED)

    def test_resume_preserves_budget_and_advances_version(self):
        """测试恢复运行：保留已消耗预算，递增执行版本"""
        run = self.coordinator.create_run(topic="预算恢复测试")
        # 模拟产生一些预算消耗
        ok, res_id = self.budget_mgr.reserve_budget(run.run_id, "task-1", units=5)
        self.assertTrue(ok)
        self.budget_mgr.settle_budget(res_id, actual_units=4)

        # 暂停
        self.coordinator.pause_run(run.run_id, reason="人工暂停")

        # 恢复
        resumed_run = self.recovery_mgr.resume_run(run.run_id)
        self.assertEqual(resumed_run.status, RunStatus.RESEARCHING)
        self.assertEqual(resumed_run.execution_version, 2)

        # 预算账本未被刷新重置
        usage = self.budget_mgr.get_usage(run.run_id)
        self.assertEqual(usage["used"], 4)

    def test_reject_late_action_on_version_mismatch(self):
        """测试版本校验：若动作附带的版本滞后于当前运行版本，操作被拒绝"""
        run = self.coordinator.create_run(topic="过期版本测试")
        initial_version = 1

        # 用户取消或重新发起导致版本提升
        self.recovery_mgr.cancel_run(run.run_id)
        updated_run = self.coordinator.get_run(run.run_id)
        self.assertEqual(updated_run.execution_version, 2)

        # 迟到的任务携带旧版本 1 发起请求
        valid = self.recovery_mgr.validate_execution_version(run.run_id, client_version=initial_version)
        self.assertFalse(valid, "Late action with outdated execution_version must be rejected")


if __name__ == "__main__":
    unittest.main()
