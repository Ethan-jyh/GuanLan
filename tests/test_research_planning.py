# -*- coding: utf-8 -*-
"""
Task 7 任务规划与核验组件单元测试
测试覆盖：
1. HOST 任务规划参数与预算校验（拒绝未知角色、超限预算、循环依赖）
2. 跨维度主张核验：验证“官方回应了、热度降低、评论仍质疑”三者同时成立，而非误判矛盾
3. 证据不足时保留 uncertain，不强制选边站
"""

import os
import sys
import unittest
import tempfile

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchPlanningAndVerification(unittest.TestCase):
    """任务规划与主张核验测试"""

    def setUp(self):
        from ResearchEngine.storage import ResearchStorage
        from ResearchEngine.evidence import EvidenceStore
        from ResearchEngine.planning import TaskPlanner
        from ResearchEngine.verification import ClaimVerifier

        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.storage = ResearchStorage(db_path=self.temp_db.name)
        self.evidence_store = EvidenceStore(db_path=self.temp_db.name)
        self.planner = TaskPlanner(self.storage)
        self.verifier = ClaimVerifier(self.evidence_store)

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_planner_validates_budget_and_roles(self):
        """测试规划校验：超出预算或非法角色应被拒绝"""
        # 超出单任务预算上限
        invalid_plan = [
            {
                "role": "authority",
                "question": "调查通报",
                "budget_allocated": 9999,  # 超限
                "completion_criteria": "核实发文字号",
            }
        ]
        ok, err = self.planner.validate_planned_tasks(invalid_plan, max_budget_per_task=15)
        self.assertFalse(ok)
        self.assertIn("budget", err.lower())

        # 未知角色
        unknown_role_plan = [
            {
                "role": "unknown_scout",
                "question": "调查",
                "budget_allocated": 10,
                "completion_criteria": "标准",
            }
        ]
        ok2, err2 = self.planner.validate_planned_tasks(unknown_role_plan, max_budget_per_task=15)
        self.assertFalse(ok2)
        self.assertIn("role", err2.lower())

    def test_three_dimensional_claims_coexist_without_contradiction(self):
        """
        核心验收测试：
        主张1：官方通报事故未造成伤亡 (authority)
        主张2：社媒热度在通报后显著降低 (evolution)
        主张3：部分评论仍对处置透明度表达质疑 (feedback)
        三者属于不同维度，有各自证据支撑，必须全部判为 supported，绝不能判为互斥矛盾 (contradicted)。
        """
        from ResearchEngine.schema import Claim, Evidence, VerificationStatus

        run_id = "run-verify-001"

        # 录入三方证据
        ev_auth = self.evidence_store.add_evidence(
            run_id=run_id,
            source_type="official_doc",
            source_ref="https://gov.example.com/notices/1",
            title="官方通报",
            excerpt="官方通报称未发生人员伤亡。",
            is_full_text=True,
        )

        ev_evo = self.evidence_store.add_evidence(
            run_id=run_id,
            source_type="db_record",
            source_ref="db://metrics/hotness",
            title="传播热度序列",
            excerpt="通报发布2小时后，社媒发帖量从每小时1.2万条骤降至1800条。",
            is_full_text=True,
        )

        ev_feed = self.evidence_store.add_evidence(
            run_id=run_id,
            source_type="comment_sample",
            source_ref="db://comments/sample",
            title="评论抽样",
            excerpt="抽样评论中有28%表达对抢修工期与隐患排查细节的关切与质疑。",
            is_full_text=True,
        )

        claims = [
            Claim(
                claim_id="C-AUTH",
                statement="官方通报称未发生人员伤亡",
                evidence_ids=[ev_auth.evidence_id],
            ),
            Claim(
                claim_id="C-EVO",
                statement="社媒热度在通报后显著降低",
                evidence_ids=[ev_evo.evidence_id],
            ),
            Claim(
                claim_id="C-FEED",
                statement="部分评论仍对处置细节表达质疑",
                evidence_ids=[ev_feed.evidence_id],
            ),
        ]

        verifications = self.verifier.verify_claims(run_id, claims)
        self.assertEqual(len(verifications), 3)

        for v in verifications:
            self.assertEqual(
                v.status,
                VerificationStatus.SUPPORTED,
                f"Claim {v.claim_id} should be supported, got {v.status}: {v.rationale}",
            )

    def test_planner_detects_dependency_cycle(self):
        """测试任务规划循环依赖检测"""
        cycle_plan = [
            {
                "task_id": "T1",
                "role": "authority",
                "question": "调查通报",
                "budget_allocated": 10,
                "completion_criteria": "标准",
                "dependencies": ["T2"],
            },
            {
                "task_id": "T2",
                "role": "evolution",
                "question": "调查走势",
                "budget_allocated": 10,
                "completion_criteria": "标准",
                "dependencies": ["T1"],
            },
        ]
        ok, err = self.planner.validate_planned_tasks(cycle_plan)
        self.assertFalse(ok)
        self.assertIn("cyclic", err.lower())

    def test_planner_creates_tasks_in_storage(self):
        """测试任务规划器创建并持久化任务"""
        valid_plan = [
            {
                "task_id": "task-auth-001",
                "role": "authority",
                "question": "调查通报",
                "budget_allocated": 10,
                "completion_criteria": "核实发文字号",
            },
            {
                "task_id": "task-evo-001",
                "role": "evolution",
                "question": "调查走势",
                "budget_allocated": 10,
                "completion_criteria": "统计时间序列",
            },
        ]
        tasks = self.planner.create_planned_tasks("run-test-plan-001", 1, valid_plan)
        self.assertEqual(len(tasks), 2)
        self.assertEqual(tasks[0].task_id, "task-auth-001")
        self.assertEqual(tasks[1].role.value, "evolution")

    def test_verifier_handles_missing_evidence(self):
        """测试证据缺失时返回 UNCERTAIN 而非捏造"""
        from ResearchEngine.schema import Claim, VerificationStatus

        claims = [
            Claim(
                claim_id="C-MISSING",
                statement="某声明内容",
                evidence_ids=["E-NONEXISTENT"],
            )
        ]
        res = self.verifier.verify_claims("run-verify-002", claims)
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0].status, VerificationStatus.UNCERTAIN)


if __name__ == "__main__":
    unittest.main()

