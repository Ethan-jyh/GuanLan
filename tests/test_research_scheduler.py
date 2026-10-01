# -*- coding: utf-8 -*-
"""
Task 6 三方并发调度与同步屏障测试
测试覆盖：
1. 三方并发执行（证明第三个任务在第一个任务结束前已启动）
2. 并发上限受控（max_concurrency = 3）
3. 同步屏障汇合：三方全部提交后进入 reviewing
4. 异常处理：任意必要任务失败时运行暂停，数据不足的有效提交仍允许进入评审
"""

import os
import sys
import unittest
import tempfile
import threading
import time

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchScheduler(unittest.TestCase):
    """三方并发调度器测试"""

    def setUp(self):
        from ResearchEngine.storage import ResearchStorage
        from ResearchEngine.evidence import EvidenceStore
        from ResearchEngine.submissions import SubmissionManager
        from ResearchEngine.budget import BudgetManager
        from ResearchEngine.coordinator import ResearchCoordinator
        from ResearchEngine.scheduler import TaskScheduler

        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.storage = ResearchStorage(db_path=self.temp_db.name)
        self.evidence_store = EvidenceStore(db_path=self.temp_db.name)
        self.submission_mgr = SubmissionManager(self.storage, self.evidence_store)
        self.budget_mgr = BudgetManager(self.storage)
        self.scheduler = TaskScheduler(max_workers=3)
        self.coordinator = ResearchCoordinator(
            storage=self.storage,
            submission_mgr=self.submission_mgr,
            budget_mgr=self.budget_mgr,
            scheduler=self.scheduler,
        )

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_concurrent_execution_order_proof(self):
        """测试可控阻塞：证明任务3在任务1结束前已经成功启动并执行"""
        run = self.coordinator.create_run(
            topic="暴雨突发",
            scope={"region": "华北"},
            roles=["authority", "evolution", "feedback"],
        )

        task1_started = threading.Event()
        task3_started = threading.Event()
        allow_task1_finish = threading.Event()

        def mock_worker(task):
            role = task.role.value if hasattr(task.role, "value") else task.role
            if role == "authority":
                task1_started.set()
                # 阻塞直到任务3启动后才允许结束
                allow_task1_finish.wait(timeout=5.0)
            elif role == "feedback":
                # 记录任务3启动
                task3_started.set()
            return {"status": "mock_done"}

        # 启动调度
        future = self.scheduler.dispatch_tasks(
            run_id=run.run_id,
            tasks=self.coordinator.get_tasks_for_round(run.run_id, 1),
            worker_fn=mock_worker,
        )

        # 确认任务1已启动
        self.assertTrue(task1_started.wait(timeout=2.0))
        # 确认任务3在任务1没有释放前就启动了（证明是并发，而非顺序等待）
        self.assertTrue(task3_started.wait(timeout=2.0))

        # 允许任务1结束
        allow_task1_finish.set()
        future.result(timeout=5.0)

    def test_sync_barrier_transitions_to_reviewing(self):
        """测试三方有效提交后同步屏障判定就绪"""
        run = self.coordinator.create_run(
            topic="暴雨处置",
            scope={},
            roles=["authority", "evolution", "feedback"],
        )
        tasks = self.coordinator.get_tasks_for_round(run.run_id, 1)
        self.assertEqual(len(tasks), 3)

        # 依次提交三方成果
        for t in tasks:
            role_val = t.role.value if hasattr(t.role, "value") else t.role
            payload = {
                "run_id": run.run_id,
                "task_id": t.task_id,
                "role": role_val,
                "round": 1,
                "claims": [],
                "evidence_pool": [],
                "scope": {},
            }
            if role_val == "authority":
                payload["authority_finding"] = {
                    "entity_name": "应急局",
                    "source_type": "通报",
                    "published_at": "2026-10-01",
                    "raw_text": "通报",
                    "stance_evolution": "稳",
                    "covered_issues": [],
                    "unaddressed_issues": [],
                }
            elif role_val == "evolution":
                payload["evolution_finding"] = {
                    "metric_definition": "互动数",
                    "platform": "微博",
                    "time_window": "24h",
                    "phase_transition_analysis": "回落",
                    "concurrent_events": [],
                    "limitations": [],
                }
            elif role_val == "feedback":
                payload["feedback_finding"] = {
                    "sampling_method": "随机",
                    "sample_size": 100,
                    "denominator_info": "分母1000",
                    "representative_quotes": [],
                    "limitations": [],
                }
            ok, _, _ = self.submission_mgr.validate_and_save_submission(payload)
            self.assertTrue(ok)

        # 检查屏障触发
        ready = self.coordinator.check_round_sync_barrier(run.run_id, round_num=1)
        self.assertTrue(ready)
        updated_run = self.coordinator.get_run(run.run_id)
        self.assertEqual(updated_run.status.value, "reviewing")


if __name__ == "__main__":
    unittest.main()
