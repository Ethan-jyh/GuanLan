# -*- coding: utf-8 -*-
"""
Task 4 预算账本与原子配额管理测试
测试覆盖：
1. 预算原子预留 (reserve) 与结算 (settle)
2. 并发/超额预算抢占拦截（两个实例争抢最后 1 次配额时仅 1 个成功）
3. 写作与终稿审查保底配额预留
4. 幂等性控制：相同 idempotency_key 重复请求不重复扣减
"""

import os
import sys
import unittest
import tempfile
import threading

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchBudget(unittest.TestCase):
    """预算账本原子性与配额控制测试"""

    def setUp(self):
        from ResearchEngine.storage import ResearchStorage
        from ResearchEngine.budget import BudgetManager

        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.storage = ResearchStorage(db_path=self.temp_db.name)
        self.budget_mgr = BudgetManager(self.storage, total_tool_limit=15, reserved_for_writing=5)
        # 可用于前期研究的有效额度为 15 - 5 = 10 次

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_reserve_and_settle(self):
        """测试正常预留与结算流程"""
        run_id = "run-budget-001"
        ok, res_id = self.budget_mgr.reserve_budget(
            run_id=run_id,
            task_id="task-1",
            units=2,
            idempotency_key="req-001",
        )
        self.assertTrue(ok)
        self.assertIsNotNone(res_id)

        # 结算
        self.budget_mgr.settle_budget(res_id, actual_units=2)
        remaining = self.budget_mgr.get_remaining_research_budget(run_id)
        self.assertEqual(remaining, 8)  # 10 - 2 = 8

    def test_idempotent_reservation(self):
        """测试相同 idempotency_key 重复预留不重复扣额"""
        run_id = "run-budget-002"
        ok1, res_id1 = self.budget_mgr.reserve_budget(
            run_id=run_id,
            task_id="task-1",
            units=3,
            idempotency_key="same-key-123",
        )
        self.assertTrue(ok1)

        # 重复调用
        ok2, res_id2 = self.budget_mgr.reserve_budget(
            run_id=run_id,
            task_id="task-1",
            units=3,
            idempotency_key="same-key-123",
        )
        self.assertTrue(ok2)
        self.assertEqual(res_id1, res_id2)

        remaining = self.budget_mgr.get_remaining_research_budget(run_id)
        self.assertEqual(remaining, 7)  # 只扣减一次 3

    def test_budget_exhaustion_blocks_further_reservation(self):
        """测试当可用额度耗尽时阻断新调用"""
        run_id = "run-budget-003"
        # 预留 10 次（全部可用额度）
        ok, res_id = self.budget_mgr.reserve_budget(
            run_id=run_id,
            task_id="task-1",
            units=10,
            idempotency_key="full-reserve",
        )
        self.assertTrue(ok)

        # 尝试再预留 1 次，应被拦截拒绝
        ok_next, err = self.budget_mgr.reserve_budget(
            run_id=run_id,
            task_id="task-2",
            units=1,
            idempotency_key="overflow-reserve",
        )
        self.assertFalse(ok_next)
        self.assertIn("exceeded", err.lower())

    def test_concurrent_reservation_only_one_wins_last_quota(self):
        """并发测试：当仅剩 1 个额度时，两个线程争抢只有 1 个成功"""
        run_id = "run-budget-004"
        # 先用掉 9 个额度，只剩 1 个
        self.budget_mgr.reserve_budget(
            run_id=run_id,
            task_id="task-1",
            units=9,
            idempotency_key="initial-9",
        )

        results = []

        def worker(idx):
            ok, _ = self.budget_mgr.reserve_budget(
                run_id=run_id,
                task_id=f"task-worker-{idx}",
                units=1,
                idempotency_key=f"worker-race-{idx}",
            )
            results.append(ok)

        t1 = threading.Thread(target=worker, args=(1,))
        t2 = threading.Thread(target=worker, args=(2,))
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        # 严格验证：两个线程中必须恰好有 1 个 True，1 个 False
        self.assertEqual(results.count(True), 1)
        self.assertEqual(results.count(False), 1)


if __name__ == "__main__":
    unittest.main()
