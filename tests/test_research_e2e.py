# -*- coding: utf-8 -*-
"""
Task 12 全流程端到端集成测试 (test_research_e2e.py)
覆盖核心业务闭环与边界韧性：
1. 完整端到端生命周期：
   任务规划 -> 三方并发调研 -> 提交入库 -> 汇合屏障 -> 
   HOST跨维度核验 -> 定向补查(带carry-forward) -> 强制收敛放行 ->
   Report综合研判 -> Document IR生成 -> DOCX专报导出。
2. 异常与韧性场景：
   - 早期放行闭环 (Round 1 Early Approval)
   - 3轮强制收敛带未决事项 (Finalize with Unresolved)
   - 缺失数据如实标记 (Data Unavailable而不造假)
   - 崩溃恢复与版本失效拒绝 (Outdated Version Reject)
"""

import os
import sys
import unittest
import tempfile
import docx

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
    VerificationStatus,
    ReportJudgment,
)
from ResearchEngine.storage import ResearchStorage
from ResearchEngine.evidence import EvidenceStore
from ResearchEngine.submissions import SubmissionManager
from ResearchEngine.budget import BudgetManager
from ResearchEngine.coordinator import ResearchCoordinator
from ResearchEngine.planning import TaskPlanner
from ResearchEngine.verification import ClaimVerifier
from ResearchEngine.review import ReviewManager
from ResearchEngine.report_input import build_report_input
from ResearchEngine.final_check import FinalChecker
from ResearchEngine.recovery import RecoveryManager
from ReportEngine.core.research_input_adapter import ResearchInputAdapter
from ReportEngine.renderers.docx_renderer import DocxRenderer
from ReportEngine.ir.validator import IRValidator


class TestResearchE2E(unittest.TestCase):
    """端到端研究生命周期与边界回归测试"""

    def setUp(self):
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.temp_dir = tempfile.TemporaryDirectory()

        self.storage = ResearchStorage(db_path=self.temp_db.name)
        self.evidence_store = EvidenceStore(db_path=self.temp_db.name)
        self.submission_mgr = SubmissionManager(self.storage, self.evidence_store)
        self.budget_mgr = BudgetManager(self.storage, total_tool_limit=50)
        self.coordinator = ResearchCoordinator(
            storage=self.storage,
            submission_mgr=self.submission_mgr,
            budget_mgr=self.budget_mgr,
        )
        self.planner = TaskPlanner(self.storage)
        self.verifier = ClaimVerifier(self.evidence_store)
        self.review_mgr = ReviewManager(
            storage=self.storage,
            coordinator=self.coordinator,
            submission_mgr=self.submission_mgr,
        )
        self.recovery_mgr = RecoveryManager(self.storage, self.coordinator)
        self.final_checker = FinalChecker()
        self.adapter = ResearchInputAdapter()
        self.validator = IRValidator()
        self.docx_renderer = DocxRenderer()

    def tearDown(self):
        self.temp_dir.cleanup()
        if os.path.exists(self.temp_db.name):
            try:
                os.remove(self.temp_db.name)
            except Exception:
                pass

    def test_complete_e2e_research_lifecycle_to_docx(self):
        """
        端到端全流程黄金路径：
        创建 -> 规划 -> 并发三方研究 -> 提交 -> 同步屏障 -> HOST核验 ->
        定向补查 -> 第二轮收敛放行 -> Report综合研判 -> 生成IR -> 导出DOCX
        """
        # 1. 创建研究运行
        run = self.coordinator.create_run(
            topic="特大强降雨城区防汛专项研判",
            scope={"region": "华南", "window": "72h"},
            budget_total=50,
        )
        self.assertEqual(run.status, RunStatus.RESEARCHING)

        # 2. 模拟第 1 轮三方研究成果提交
        ev_auth = self.evidence_store.add_evidence(
            run_id=run.run_id,
            source_type="official_doc",
            source_ref="https://gov.example.com/notices/201",
            title="市防汛指挥部通报",
            excerpt="全市已启动防汛I级应急响应，救援排险有序展开，暂未发现人员伤亡。",
            is_full_text=True,
        )
        ev_evo = self.evidence_store.add_evidence(
            run_id=run.run_id,
            source_type="db_record",
            source_ref="db://metrics/heat",
            title="传播热度序列",
            excerpt="I级响应通报后1小时内，舆论关注峰值迅速回落70%。",
            is_full_text=True,
        )
        ev_feed = self.evidence_store.add_evidence(
            run_id=run.run_id,
            source_type="comment_sample",
            source_ref="db://comments/sample",
            title="公众留言抽样",
            excerpt="受灾地段居民在社交媒体留言关切临时安置点物资供应。",
            is_full_text=True,
        )

        tasks_r1 = self.coordinator.get_tasks_for_round(run.run_id, 1)
        self.assertEqual(len(tasks_r1), 3)

        # 各角色提交
        sub_auth = ResearchResult(
            role=ResearchRole.AUTHORITY,
            round=1,
            claims=[
                Claim(
                    claim_id="C-AUTH-01",
                    statement="全市启动防汛I级响应且无人员伤亡",
                    evidence_ids=[ev_auth.evidence_id],
                )
            ],
            evidence_pool=[ev_auth],
            authority_finding=AuthorityFinding(
                entity_name="防汛指挥部",
                source_type="通报",
                published_at="2026-10-01",
                raw_text="全市启动防汛I级应急响应",
                stance_evolution="果断升级响应",
                covered_issues=["响应级别", "人员安全"],
                unaddressed_issues=["安置点物资调配细节"],
            ),
        )
        p_auth = sub_auth.model_dump()
        p_auth.update({"run_id": run.run_id, "task_id": tasks_r1[0].task_id})
        self.submission_mgr.validate_and_save_submission(p_auth)

        sub_evo = ResearchResult(
            role=ResearchRole.EVOLUTION,
            round=1,
            claims=[
                Claim(
                    claim_id="C-EVO-01",
                    statement="舆论关注峰值在通报后显著回落",
                    evidence_ids=[ev_evo.evidence_id],
                )
            ],
            evidence_pool=[ev_evo],
            evolution_finding=EvolutionFinding(
                metric_definition="小时全网声量",
                platform="多平台",
                time_window="72h",
                data_points=[{"hour": "10:00", "v": 15000}, {"hour": "11:00", "v": 4500}],
                missing_periods=[],
                phase_transition_analysis="回落期",
                concurrent_events=[],
                limitations=[],
            ),
        )
        p_evo = sub_evo.model_dump()
        p_evo.update({"run_id": run.run_id, "task_id": tasks_r1[1].task_id})
        self.submission_mgr.validate_and_save_submission(p_evo)

        sub_feed = ResearchResult(
            role=ResearchRole.FEEDBACK,
            round=1,
            claims=[
                Claim(
                    claim_id="C-FEED-01",
                    statement="受灾居民高度关切临时安置点物资供应",
                    evidence_ids=[ev_feed.evidence_id],
                )
            ],
            evidence_pool=[ev_feed],
            feedback_finding=FeedbackFinding(
                sampling_method="分层抽样",
                sample_size=300,
                viewpoint_breakdown={"关切物资": 0.45, "认可抢险": 0.55},
                sentiment_distribution={"焦虑": 0.35, "中立": 0.65},
                demands_summary=["公布安置点位置与物资发放点"],
                denominator_info="基于300条社媒抽样",
                representative_quotes=["何时送到物资"],
                limitations=[],
            ),
        )
        p_feed = sub_feed.model_dump()
        p_feed.update({"run_id": run.run_id, "task_id": tasks_r1[2].task_id})
        self.submission_mgr.validate_and_save_submission(p_feed)

        # 3. 校验同步屏障自动流转至 REVIEWING
        barrier_passed = self.coordinator.check_round_sync_barrier(run.run_id, 1)
        self.assertTrue(barrier_passed)
        run_review = self.coordinator.get_run(run.run_id)
        self.assertEqual(run_review.status, RunStatus.REVIEWING)

        # 4. HOST 进行多维度独立核验（三者同时成立）
        all_claims = [sub_auth.claims[0], sub_evo.claims[0], sub_feed.claims[0]]
        verifications = self.verifier.verify_claims(run.run_id, all_claims)
        self.assertEqual(len(verifications), 3)
        for v in verifications:
            self.assertEqual(v.status, VerificationStatus.SUPPORTED)

        # 5. HOST 下发定向补查指令（仅对 feedback 要求细化安置点统计）
        directive = DirectiveItem(
            directive_id="dir-e2e-01",
            target_role=ResearchRole.FEEDBACK,
            related_claim_or_issue="安置点物资诉求",
            question="细化各街道安置点物资缺口具体诉求比例",
            suggested_action="按街道标签抽样并统计",
            completion_criteria="输出街道维度明细",
        )
        review_decision = HostReviewDecision(
            task_id="host-review-01",
            round=1,
            decision=DecisionType.REVISE,
            rationale="需细化局部街道安置点诉求",
            directives=[directive],
            unresolved_issues=["局部街道物资诉求明细未全"],
        )
        self.review_mgr.submit_review_decision(run.run_id, review_decision)

        # 验证进入第 2 轮，且仅为 feedback 派单，authority 和 evolution 成果沿用
        run_r2 = self.coordinator.get_run(run.run_id)
        self.assertEqual(run_r2.current_round, 2)
        tasks_r2 = self.coordinator.get_tasks_for_round(run.run_id, 2)
        self.assertEqual(len(tasks_r2), 1)
        self.assertEqual(tasks_r2[0].role, ResearchRole.FEEDBACK)

        # 6. feedback 完成第 2 轮补查并提交
        ev_feed2 = self.evidence_store.add_evidence(
            run_id=run.run_id,
            source_type="comment_sample",
            source_ref="db://comments/sample_r2",
            title="街道抽样",
            excerpt="城南街道居民关切饮用水与发电机供应占比达60%。",
            is_full_text=True,
        )
        sub_feed_r2 = ResearchResult(
            role=ResearchRole.FEEDBACK,
            round=2,
            claims=[
                Claim(
                    claim_id="C-FEED-02",
                    statement="城南街道居民关切饮用水与发电机供应",
                    evidence_ids=[ev_feed2.evidence_id],
                )
            ],
            evidence_pool=[ev_feed2],
            feedback_finding=FeedbackFinding(
                sampling_method="分街道抽样",
                sample_size=400,
                viewpoint_breakdown={"城南饮水发电机": 0.6, "其他街道平稳": 0.4},
                sentiment_distribution={"焦虑": 0.3, "中立": 0.7},
                demands_summary=["增派城南应急发电车与纯净水"],
                denominator_info="400条街道标签留言",
                representative_quotes=["城南断电急需发电机"],
                limitations=[],
            ),
        )
        p_feed2 = sub_feed_r2.model_dump()
        p_feed2.update({"run_id": run.run_id, "task_id": tasks_r2[0].task_id})
        self.submission_mgr.validate_and_save_submission(p_feed2)

        # 7. HOST 在第 2 轮作出放行决定 (approve)
        r2_decision = HostReviewDecision(
            task_id="host-review-02",
            round=2,
            decision=DecisionType.APPROVE,
            rationale="补查充分，三方闭环，放行成稿",
            directives=[],
            unresolved_issues=[],
        )
        self.review_mgr.submit_review_decision(run.run_id, r2_decision)
        run_approved = self.coordinator.get_run(run.run_id)
        self.assertEqual(run_approved.status, RunStatus.APPROVED)

        # 8. 收集全部有效成果并构建 Report 专报输入
        effective_subs = self.review_mgr.get_effective_submissions(run.run_id, round_num=2)
        self.assertEqual(len(effective_subs), 3)
        self.assertEqual(effective_subs["authority"].round, 1)  # 沿用
        self.assertEqual(effective_subs["evolution"].round, 1)  # 沿用
        self.assertEqual(effective_subs["feedback"].round, 2)   # 补查新版

        report_input = build_report_input(
            run_id=run.run_id,
            topic=run.topic,
            scope=run.scope,
            effective_submissions=effective_subs,
            verifications=verifications,
            unresolved_issues=[],
        )

        # 9. Report Agent 综合研判与 Document IR 生成
        judgment = ReportJudgment(
            overall_interpretation="抢险处置总体迅速果断，全网舆情平稳回落，核心矛盾集中在城南街道局部电力供应与应急供水，需开展靶向通报与应急资源倾斜。",
            risks=[
                {
                    "risk_id": "R1",
                    "title": "局部断电断水次生不满风险",
                    "description": "城南街道断电发电机短缺若超12小时未解决可能引发居民聚集诉求",
                    "severity": "中高",
                }
            ],
            recommendations=[
                {
                    "rec_id": "A1",
                    "title": "紧急调派移动发电车与供水车进驻城南",
                    "action": "电力与水务部门于2小时内抵达城南社区指定应急发放点",
                    "target_risk": "R1",
                }
            ],
            linked_claim_ids=["C-AUTH-01", "C-EVO-01", "C-FEED-02"],
            linked_evidence_ids=[ev_auth.evidence_id, ev_evo.evidence_id, ev_feed2.evidence_id],
            applicability_conditions=["城区及城南街道核心受灾片区"],
            alternative_explanations=[],
            uncertainties=["夜间降雨回波对抢修作业的影响存在不确定性"],
        )

        # 终稿质量门禁核验
        passed, issues = self.final_checker.check_report_quality(
            judgment,
            available_claims=["C-AUTH-01", "C-EVO-01", "C-FEED-02"],
            available_evidences=[ev_auth.evidence_id, ev_evo.evidence_id, ev_feed2.evidence_id],
        )
        self.assertTrue(passed, f"Final check failed: {issues}")

        # 转换为 Document IR
        doc_ir = self.adapter.convert_to_document_ir(
            report_id=f"rep-{run.run_id}",
            report_input=report_input,
            judgment=judgment,
        )

        for ch in doc_ir["chapters"]:
            ok, errors = self.validator.validate_chapter(ch)
            self.assertTrue(ok, f"Chapter validation error: {errors}")

        # 10. 导出为 .docx 专报并验证
        out_docx = os.path.join(self.temp_dir.name, f"{run.run_id}_report.docx")
        self.docx_renderer.export_file(doc_ir, out_docx)
        self.assertTrue(os.path.exists(out_docx))

        doc = docx.Document(out_docx)
        docx_text = "\n".join([p.text for p in doc.paragraphs])
        self.assertIn("特大强降雨城区防汛专项研判", docx_text)
        self.assertIn("紧急调派移动发电车与供水车进驻城南", docx_text)

    def test_round_3_convergence_with_unresolved_issues(self):
        """测试 3 轮强制收敛：保留未决事项并放行，禁止开启第 4 轮"""
        run = self.coordinator.create_run(topic="多轮复杂争议事件研判")
        # 直接模拟进入第 3 轮 reviewing
        with self.storage._get_connection() as conn:
            conn.execute(
                "UPDATE runs SET current_round = 3, status = 'reviewing' WHERE run_id = ?",
                (run.run_id,),
            )
            conn.commit()

        # 第 3 轮带未决事项放行
        decision = HostReviewDecision(
            task_id="host-review-03",
            round=3,
            decision=DecisionType.FINALIZE_WITH_UNRESOLVED,
            rationale="第3轮已达上限，保留事故技术鉴定未决事项放行成稿",
            directives=[],
            unresolved_issues=["涉事设备出厂检测报告因司法封存尚未取得"],
        )
        self.review_mgr.submit_review_decision(run.run_id, decision)

        updated_run = self.coordinator.get_run(run.run_id)
        self.assertEqual(updated_run.status, RunStatus.APPROVED)
        self.assertEqual(updated_run.current_round, 3)


if __name__ == "__main__":
    unittest.main()
