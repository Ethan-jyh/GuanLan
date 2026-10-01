# -*- coding: utf-8 -*-
"""
Task 9 Report 综合研判、Document IR 与终稿检查测试
测试覆盖：
1. report_input 构造：显式记录各角色成果版本，杜绝扫盘与隐式双重写作
2. research_input_adapter 适配器：将多角色研判结构化转换为合规 Document IR，通过 IRValidator 严格校验
3. final_check 终稿门禁：检查建议与风险对证据主张的穿透溯源，拦截泛化套话
"""

import os
import sys
import unittest
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ResearchEngine.schema import (
    ResearchRole,
    ResearchResult,
    Claim,
    Evidence,
    AuthorityFinding,
    EvolutionFinding,
    FeedbackFinding,
    VerificationItem,
    VerificationStatus,
    ReportJudgment,
)
from ResearchEngine.report_input import build_report_input
from ResearchEngine.final_check import FinalChecker
from ReportEngine.core.research_input_adapter import ResearchInputAdapter
from ReportEngine.ir.validator import IRValidator


class TestResearchReport(unittest.TestCase):
    """Report Agent 综合研判与 IR 适配测试"""

    def setUp(self):
        self.validator = IRValidator()
        self.checker = FinalChecker()
        self.adapter = ResearchInputAdapter()

        # 模拟有效成果数据
        self.ev_auth = Evidence(
            evidence_id="E-AUTH-01",
            source_type="official_doc",
            source_ref="https://gov.example.com/notices/101",
            title="应急管理局通报",
            excerpt="官方确认已启动二级响应，无人员伤亡。",
            retrieval_time="2026-10-01T10:00:00Z",
            is_full_text=True,
        )
        self.sub_auth = ResearchResult(
            role=ResearchRole.AUTHORITY,
            round=1,
            claims=[
                Claim(
                    claim_id="C-AUTH-01",
                    statement="官方通报启动二级响应且未发生伤亡",
                    evidence_ids=["E-AUTH-01"],
                )
            ],
            evidence_pool=[self.ev_auth],
            authority_finding=AuthorityFinding(
                entity_name="应急管理局",
                source_type="发布会",
                published_at="2026-10-01",
                raw_text="通报原文",
                stance_evolution="平稳",
                covered_issues=["响应等级"],
                unaddressed_issues=[],
            ),
        )

        self.ev_evo = Evidence(
            evidence_id="E-EVO-01",
            source_type="db_record",
            source_ref="db://metrics/hotness",
            title="热度序列",
            excerpt="通报后发帖热度下降85%。",
            retrieval_time="2026-10-01T10:00:00Z",
            is_full_text=True,
        )
        self.sub_evo = ResearchResult(
            role=ResearchRole.EVOLUTION,
            round=1,
            claims=[
                Claim(
                    claim_id="C-EVO-01",
                    statement="通报后公众发帖热度呈断崖式下降",
                    evidence_ids=["E-EVO-01"],
                )
            ],
            evidence_pool=[self.ev_evo],
            evolution_finding=EvolutionFinding(
                metric_definition="小时发帖量",
                platform="全平台",
                time_window="24h",
                data_points=[{"hour": 1, "count": 1000}],
                missing_periods=[],
                phase_transition_analysis="回落期",
                concurrent_events=[],
                limitations=[],
            ),
        )

        self.ev_feed = Evidence(
            evidence_id="E-FEED-01",
            source_type="comment_sample",
            source_ref="db://comments/sample",
            title="评论抽样",
            excerpt="300条样本中28%对抢修工期存在质疑。",
            retrieval_time="2026-10-01T10:00:00Z",
            is_full_text=True,
        )
        self.sub_feed = ResearchResult(
            role=ResearchRole.FEEDBACK,
            round=2,  # 经历过定向补查，成果版本为第2轮
            claims=[
                Claim(
                    claim_id="C-FEED-01",
                    statement="28%网民对抢修工期与隐患排查进度表达担忧",
                    evidence_ids=["E-FEED-01"],
                )
            ],
            evidence_pool=[self.ev_feed],
            feedback_finding=FeedbackFinding(
                sampling_method="分层抽样",
                sample_size=300,
                viewpoint_breakdown={"关切工期": 0.28, "认可处置": 0.72},
                sentiment_distribution={"焦虑": 0.3, "中立": 0.7},
                demands_summary=["公开每日抢修排期表"],
                denominator_info="基于300条评论",
                representative_quotes=["何时通车"],
                limitations=[],
            ),
        )

        self.effective_submissions = {
            "authority": self.sub_auth,
            "evolution": self.sub_evo,
            "feedback": self.sub_feed,
        }

    def test_report_input_records_explicit_versions(self):
        """测试构造 Report 输入：显式锁定各角色成果版本，杜绝动态扫盘"""
        report_input = build_report_input(
            run_id="run-test-report-001",
            topic="强对流暴雨应急处置专项研判",
            scope={"region": "华南", "window": "72h"},
            effective_submissions=self.effective_submissions,
            verifications=[
                VerificationItem(
                    claim_id="C-AUTH-01",
                    claim_statement="官方通报启动二级响应",
                    status=VerificationStatus.SUPPORTED,
                    rationale="证据确凿",
                )
            ],
            unresolved_issues=["地下管网排查明细尚未公布"],
        )

        self.assertEqual(report_input["run_id"], "run-test-report-001")
        self.assertEqual(report_input["research_versions"]["authority"], 1)
        self.assertEqual(report_input["research_versions"]["feedback"], 2)
        self.assertIn("authority", report_input["findings"])
        self.assertIn("evolution", report_input["findings"])
        self.assertIn("feedback", report_input["findings"])

    def test_research_input_adapter_produces_valid_ir(self):
        """测试适配器将成果转换为标准 Document IR，并通过 IR 校验器"""
        judgment = ReportJudgment(
            overall_interpretation="本次强对流暴雨应急处置总体迅速，官方权威定调明确，全网热度快速回落，但受影响区域群众对复工复课及抢险工期透明度仍有集中诉求。",
            risks=[
                {
                    "risk_id": "R1",
                    "title": "次生排期透明度风险",
                    "description": "抢修工期若不透明可能引发第二轮舆情次生发酵",
                    "severity": "中",
                }
            ],
            recommendations=[
                {
                    "rec_id": "A1",
                    "title": "每日定时公布抢修进度日历",
                    "action": "应急管理部门联动交通部门每日9点与17点公布分路段抢通预计时间",
                    "target_risk": "R1",
                }
            ],
            linked_claim_ids=["C-AUTH-01", "C-EVO-01", "C-FEED-01"],
            linked_evidence_ids=["E-AUTH-01", "E-EVO-01", "E-FEED-01"],
            applicability_conditions=["暴雨核心影响区与沿线交通网"],
            alternative_explanations=[],
            uncertainties=["后续是否有新增强降雨云团尚未完全明确"],
        )

        report_input = build_report_input(
            run_id="run-test-report-001",
            topic="强对流暴雨应急处置专项研判",
            scope={"region": "华南", "window": "72h"},
            effective_submissions=self.effective_submissions,
            verifications=[],
            unresolved_issues=[],
        )

        doc_ir = self.adapter.convert_to_document_ir(
            report_id="rep-001",
            report_input=report_input,
            judgment=judgment,
        )

        self.assertIn("chapters", doc_ir)
        self.assertGreater(len(doc_ir["chapters"]), 0)

        # 校验每个章节必须完全符合 IRValidator
        for chapter in doc_ir["chapters"]:
            ok, errors = self.validator.validate_chapter(chapter)
            self.assertTrue(ok, f"Chapter {chapter.get('chapterId')} failed validation: {errors}")

    def test_final_checker_enforces_evidence_traceability(self):
        """测试终稿检查器：拦截无依据的空泛建议与脱节推断"""
        # 1. 具有完备跨三方依据的研判 -> 通过
        valid_judgment = ReportJudgment(
            overall_interpretation="全景态势良好，局部存在工期沟通阻滞",
            risks=[
                {
                    "risk_id": "R1",
                    "title": "工期透明度风险",
                    "severity": "中",
                }
            ],
            recommendations=[
                {
                    "rec_id": "A1",
                    "title": "发布排期日历",
                    "target_risk": "R1",
                }
            ],
            linked_claim_ids=["C-AUTH-01", "C-FEED-01"],
            linked_evidence_ids=["E-AUTH-01", "E-FEED-01"],
            applicability_conditions=["受灾城区"],
            alternative_explanations=[],
            uncertainties=["降雨持续时间未知"],
        )
        passed, issues = self.checker.check_report_quality(
            valid_judgment,
            available_claims=["C-AUTH-01", "C-EVO-01", "C-FEED-01"],
            available_evidences=["E-AUTH-01", "E-EVO-01", "E-FEED-01"],
        )
        self.assertTrue(passed, f"Valid judgment should pass final check: {issues}")

        # 2. 悬空引用（引用的 claim_id 不在已知主张中） -> 拒绝
        unsupported_judgment = ReportJudgment(
            overall_interpretation="某脱离材料的推论",
            risks=[{"risk_id": "R2", "title": "虚假风险"}],
            recommendations=[{"rec_id": "A2", "title": "泛化口号：加强舆论引导"}],
            linked_claim_ids=["C-GHOST-999"],  # 不存在
            linked_evidence_ids=[],
            applicability_conditions=[],
            alternative_explanations=[],
            uncertainties=[],
        )
        passed2, issues2 = self.checker.check_report_quality(
            unsupported_judgment,
            available_claims=["C-AUTH-01", "C-EVO-01", "C-FEED-01"],
            available_evidences=["E-AUTH-01", "E-EVO-01", "E-FEED-01"],
        )
        self.assertFalse(passed2)
        self.assertTrue(any("C-GHOST-999" in err or "依据" in err for err in issues2))


if __name__ == "__main__":
    unittest.main()
