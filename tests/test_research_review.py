# -*- coding: utf-8 -*-
"""
Task 8 三轮评审、定向补查与放行机制单元测试
测试覆盖：
1. 首轮提前放行 (approve) -> 运行直接流转至 APPROVED
2. 定向补查 (revise, 轮次 1-2) -> 仅为收到指令的角色创建新一轮任务，其余角色成果沿用 (carry-forward)
3. 第 3 轮强制收敛 -> 禁止再次下发 revise，保留未决事项并以 finalize_with_unresolved 放行
4. 幂等性评审 -> 重复评审请求返回同一决定，不重复推进轮次
5. 放行合规门禁 -> 校验成果完整性与未决任务阻断
"""

import os
import sys
import unittest
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ResearchEngine.schema import (
    ResearchRole,
    RunStatus,
    TaskStatus,
    DecisionType,
    HostReviewDecision,
    DirectiveItem,
    ResearchResult,
    Claim,
    Evidence,
    AuthorityFinding,
    EvolutionFinding,
    FeedbackFinding,
)
from ResearchEngine.storage import ResearchStorage
from ResearchEngine.evidence import EvidenceStore
from ResearchEngine.submissions import SubmissionManager
from ResearchEngine.budget import BudgetManager
from ResearchEngine.coordinator import ResearchCoordinator
from ResearchEngine.review import ReviewManager


class TestResearchReview(unittest.TestCase):
    """三轮评审与定向补查测试"""

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
        self.review_mgr = ReviewManager(
            storage=self.storage,
            coordinator=self.coordinator,
            submission_mgr=self.submission_mgr,
        )

    def tearDown(self):
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def _submit_mock_results(self, run_id: str, round_num: int, roles=None):
        """为指定角色模拟合规的研究成果提交"""
        active_roles = roles or ["authority", "evolution", "feedback"]
        for role in active_roles:
            ev = self.evidence_store.add_evidence(
                run_id=run_id,
                source_type="doc",
                source_ref=f"ref://{role}",
                title=f"{role} 证据",
                excerpt=f"{role} 摘录内容",
            )
            claim = Claim(
                claim_id=f"C-{role}-R{round_num}",
                statement=f"{role} 论断声明",
                evidence_ids=[ev.evidence_id],
            )
            auth_finding = None
            evo_finding = None
            feed_finding = None

            if role == "authority":
                auth_finding = AuthorityFinding(
                    entity_name="通报单位",
                    source_type="发布会",
                    published_at="2026-10-01",
                    raw_text="通报原文",
                    stance_evolution="平稳",
                    covered_issues=["主要事实"],
                    unaddressed_issues=[],
                )
            elif role == "evolution":
                evo_finding = EvolutionFinding(
                    metric_definition="热度指数",
                    platform="社交媒体",
                    time_window="24h",
                    data_points=[{"t": 1, "v": 100}],
                    missing_periods=[],
                    phase_transition_analysis="回落期",
                    concurrent_events=[],
                    limitations=[],
                )
            elif role == "feedback":
                feed_finding = FeedbackFinding(
                    sampling_method="随机抽样",
                    sample_size=200,
                    viewpoint_breakdown={"支持": 0.6, "质疑": 0.4},
                    sentiment_distribution={"积极": 0.5, "中立": 0.3, "负面": 0.2},
                    demands_summary=["公开调查细节"],
                    denominator_info="基于200条评论样本",
                    representative_quotes=["希望公布细节"],
                    limitations=[],
                )

            tasks = self.coordinator.get_tasks_for_round(run_id, round_num)
            task = next((t for t in tasks if t.role.value == role or str(t.role) == role), None)
            task_id = task.task_id if task else f"mock-task-{role}-r{round_num}"

            res = ResearchResult(
                role=ResearchRole(role),
                round=round_num,
                claims=[claim],
                evidence_pool=[ev],
                authority_finding=auth_finding,
                evolution_finding=evo_finding,
                feedback_finding=feed_finding,
            )
            payload = res.model_dump()
            payload["run_id"] = run_id
            payload["task_id"] = task_id
            ok, sub_id, err = self.submission_mgr.validate_and_save_submission(payload)
            assert ok, f"Submission failed for {role}: {err}"


    def test_early_approval_round_1(self):
        """测试第 1 轮材料充分时，HOST 提前放行 (approve) 直接进入 APPROVED 状态"""
        run = self.coordinator.create_run(topic="某突发事件研判")
        self._submit_mock_results(run.run_id, round_num=1)

        # 汇合屏障通过，进入 reviewing
        ready = self.coordinator.check_round_sync_barrier(run.run_id, 1)
        self.assertTrue(ready)

        decision = HostReviewDecision(
            task_id="host-review-r1",
            round=1,
            decision=DecisionType.APPROVE,
            rationale="三方材料翔实自洽，官方口径、热度及反馈均已闭环，准予提前放行。",
            directives=[],
            unresolved_issues=[],
        )

        saved = self.review_mgr.submit_review_decision(run.run_id, decision)
        self.assertEqual(saved.decision, DecisionType.APPROVE)

        updated_run = self.coordinator.get_run(run.run_id)
        self.assertEqual(updated_run.status, RunStatus.APPROVED)

    def test_targeted_revision_rounds_1_and_2_with_carry_forward(self):
        """
        测试定向补查：
        第 1 轮仅针对 feedback 下发定向指令；
        第 2 轮只为 feedback 创建新任务，authority 和 evolution 成果自动沿用；
        第三个任务不需要重跑。
        """
        run = self.coordinator.create_run(topic="复杂热点事件研判")
        self._submit_mock_results(run.run_id, round_num=1)
        self.coordinator.check_round_sync_barrier(run.run_id, 1)

        # HOST 决定对 feedback 进行定向补查
        directive = DirectiveItem(
            directive_id="dir-001",
            target_role=ResearchRole.FEEDBACK,
            related_claim_or_issue="评论质疑焦点",
            question="需细化对抢修细节的质疑具体诉求分布",
            suggested_action="增加抽样至500条评论并去重",
            completion_criteria="输出具体三类利益诉求占比",
        )

        decision = HostReviewDecision(
            task_id="host-review-r1",
            round=1,
            decision=DecisionType.REVISE,
            rationale="公众诉求颗粒度不足，需公众反馈专家补充下沉抽样。",
            directives=[directive],
            unresolved_issues=["质疑诉求分布细节未明"],
        )

        saved = self.review_mgr.submit_review_decision(run.run_id, decision)
        self.assertEqual(saved.decision, DecisionType.REVISE)

        # 检查 Run 进入第 2 轮 researching
        updated_run = self.coordinator.get_run(run.run_id)
        self.assertEqual(updated_run.current_round, 2)
        self.assertEqual(updated_run.status, RunStatus.RESEARCHING)

        # 检查第 2 轮子任务：仅有 feedback 角色，authority 和 evolution 不创建多余任务
        round2_tasks = self.coordinator.get_tasks_for_round(run.run_id, 2)
        self.assertEqual(len(round2_tasks), 1)
        self.assertEqual(round2_tasks[0].role, ResearchRole.FEEDBACK)

        # 检查成果沿用：获取第 2 轮有效成果时，authority 和 evolution 返回第 1 轮结果
        active_subs = self.review_mgr.get_effective_submissions(run.run_id, round_num=2)
        self.assertEqual(len(active_subs), 2)  # authority 和 evolution 已就绪
        self.assertIn("authority", active_subs)
        self.assertIn("evolution", active_subs)
        self.assertNotIn("feedback", active_subs)  # feedback 还在第2轮做

    def test_round_3_convergence_prohibits_revise(self):
        """测试第 3 轮强制收敛：禁止下发 revise，必须放行或带未解决事项放行"""
        run = self.coordinator.create_run(topic="多轮争端事件研判")
        # 模拟进入第 3 轮
        with self.storage._get_connection() as conn:
            conn.execute(
                "UPDATE runs SET current_round = 3, status = 'reviewing' WHERE run_id = ?",
                (run.run_id,),
            )
            conn.commit()

        # 尝试在第 3 轮发出 revise 决定
        directive = DirectiveItem(
            directive_id="dir-r3",
            target_role=ResearchRole.AUTHORITY,
            related_claim_or_issue="持续调查",
            question="追加调查",
            suggested_action="重新检索",
            completion_criteria="无",
        )
        invalid_decision = HostReviewDecision(
            task_id="host-review-r3",
            round=3,
            decision=DecisionType.REVISE,
            rationale="仍需深入调查",
            directives=[directive],
            unresolved_issues=["尚未查明核心原因"],
        )

        with self.assertRaises(ValueError):
            self.review_mgr.submit_review_decision(run.run_id, invalid_decision)

        # 正常使用 finalize_with_unresolved 放行
        valid_decision = HostReviewDecision(
            task_id="host-review-r3",
            round=3,
            decision=DecisionType.FINALIZE_WITH_UNRESOLVED,
            rationale="第3轮调查结束，保留未决事项并放行成稿",
            directives=[],
            unresolved_issues=["核心原因仍在技术鉴定中"],
        )
        saved = self.review_mgr.submit_review_decision(run.run_id, valid_decision)
        self.assertEqual(saved.decision, DecisionType.FINALIZE_WITH_UNRESOLVED)

        updated_run = self.coordinator.get_run(run.run_id)
        self.assertEqual(updated_run.status, RunStatus.APPROVED)

    def test_idempotent_review_submission(self):
        """测试评审幂等性：重复提交同一轮次决策返回相同结果，不重复生成任务"""
        run = self.coordinator.create_run(topic="幂等测试")
        self._submit_mock_results(run.run_id, round_num=1)
        self.coordinator.check_round_sync_barrier(run.run_id, 1)

        decision = HostReviewDecision(
            task_id="host-review-r1",
            round=1,
            decision=DecisionType.APPROVE,
            rationale="放行",
            directives=[],
            unresolved_issues=[],
        )

        res1 = self.review_mgr.submit_review_decision(run.run_id, decision)
        res2 = self.review_mgr.submit_review_decision(run.run_id, decision)

        self.assertEqual(res1.task_id, res2.task_id)
        self.assertEqual(res1.decision, res2.decision)

    def test_release_gate_blocks_if_pending_tasks_exist(self):
        """测试放行门禁：若存在仍在执行的必要子任务，阻断放行"""
        run = self.coordinator.create_run(topic="门禁测试")
        # 任务刚创建，处于 PENDING 状态
        passed, msg = self.review_mgr.check_release_gate(run.run_id)
        self.assertFalse(passed)
        self.assertIn("still pending or running", msg)

        # 提交全部三方成果后，门禁通过
        self._submit_mock_results(run.run_id, round_num=1)
        passed2, msg2 = self.review_mgr.check_release_gate(run.run_id)
        self.assertTrue(passed2)
        self.assertIn("passed", msg2)


if __name__ == "__main__":
    unittest.main()

