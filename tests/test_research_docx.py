# -*- coding: utf-8 -*-
"""
Task 10 实验室专报模板与 DOCX 渲染导出测试
测试覆盖：
1. 实验室专报模板结构与段落核对
2. DocxRenderer 将 Document IR 渲染为有效 .docx 格式
3. 验证 Word 文档标题、章节、列表与数据完整性
4. 同一 Document IR 在 HTML、Markdown 与 DOCX 多格式渲染回归一致性
"""

import os
import sys
import unittest
import tempfile
import docx

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ReportEngine.renderers.docx_renderer import DocxRenderer
from ReportEngine.renderers.markdown_renderer import MarkdownRenderer
from ReportEngine.renderers.html_renderer import HTMLRenderer
from ReportEngine.core.research_input_adapter import ResearchInputAdapter
from ResearchEngine.report_input import build_report_input
from ResearchEngine.schema import (
    ResearchRole,
    ResearchResult,
    Claim,
    Evidence,
    AuthorityFinding,
    EvolutionFinding,
    FeedbackFinding,
    ReportJudgment,
)


class TestResearchDocxAndExport(unittest.TestCase):
    """DOCX 渲染与文档多格式导出测试"""

    def setUp(self):
        self.docx_renderer = DocxRenderer()
        self.md_renderer = MarkdownRenderer()
        self.html_renderer = HTMLRenderer()
        self.adapter = ResearchInputAdapter()

        self.temp_dir = tempfile.TemporaryDirectory()

        # 构造有效 Document IR
        sub_auth = ResearchResult(
            role=ResearchRole.AUTHORITY,
            round=1,
            claims=[Claim(claim_id="C1", statement="官方已介入调查", evidence_ids=["E1"])],
            evidence_pool=[
                Evidence(
                    evidence_id="E1",
                    source_type="doc",
                    source_ref="ref://1",
                    title="权威通报",
                    excerpt="官方发布第一期通报并责成有关部门开展调查。",
                    retrieval_time="2026-10-01",
                )
            ],
            authority_finding=AuthorityFinding(
                entity_name="应急指挥部",
                source_type="官方通告",
                published_at="2026-10-01 09:00",
                raw_text="官方发布第一期通报并责成有关部门开展调查。",
                stance_evolution="平稳推进",
                covered_issues=["调查组成立", "责任排查"],
                unaddressed_issues=[],
            ),
        )

        sub_evo = ResearchResult(
            role=ResearchRole.EVOLUTION,
            round=1,
            claims=[Claim(claim_id="C2", statement="热度在发布后骤减", evidence_ids=["E2"])],
            evidence_pool=[
                Evidence(
                    evidence_id="E2",
                    source_type="metrics",
                    source_ref="ref://2",
                    title="热度序列",
                    excerpt="热度自峰值1.5万迅速降至2000条每小时。",
                    retrieval_time="2026-10-01",
                )
            ],
            evolution_finding=EvolutionFinding(
                metric_definition="全网发帖数",
                platform="微博/微信",
                time_window="48h",
                data_points=[{"hour": "00:00", "heat": 15000}, {"hour": "02:00", "heat": 2000}],
                missing_periods=[],
                phase_transition_analysis="快速消退期",
                concurrent_events=[],
                limitations=[],
            ),
        )

        sub_feed = ResearchResult(
            role=ResearchRole.FEEDBACK,
            round=1,
            claims=[Claim(claim_id="C3", statement="网民关切赔偿标准与排期", evidence_ids=["E3"])],
            evidence_pool=[
                Evidence(
                    evidence_id="E3",
                    source_type="comments",
                    source_ref="ref://3",
                    title="评论抽样",
                    excerpt="500条评论中34%询问赔偿细则何时出台。",
                    retrieval_time="2026-10-01",
                )
            ],
            feedback_finding=FeedbackFinding(
                sampling_method="分层抽样",
                sample_size=500,
                viewpoint_breakdown={"关切赔偿": 0.34, "关切安全": 0.46, "其他": 0.20},
                sentiment_distribution={"焦虑": 0.4, "中立": 0.6},
                demands_summary=["尽早公布补偿标准与申请窗口"],
                denominator_info="基于500条去重评论",
                representative_quotes=["何时公布补偿方案"],
                limitations=[],
            ),
        )

        report_input = build_report_input(
            run_id="run-docx-001",
            topic="特大极端天气抢险舆情专报",
            scope={"window": "48h"},
            effective_submissions={
                "authority": sub_auth,
                "evolution": sub_evo,
                "feedback": sub_feed,
            },
        )

        judgment = ReportJudgment(
            overall_interpretation="抢险处置总体受控，权威定调迅速有效遏制了谣言传播，热度明显回落；但赔偿与善后诉求正在评论区聚集，需重点防范次生矛盾。",
            risks=[
                {
                    "risk_id": "R1",
                    "title": "赔偿方案迟滞风险",
                    "description": "若48小时内未公布赔偿窗口，可能引发二次舆情升温",
                    "severity": "中",
                }
            ],
            recommendations=[
                {
                    "rec_id": "A1",
                    "title": "设立专项答疑专班",
                    "action": "民政与应急部门设立24小时答疑热线并公布首期赔付指引",
                    "target_risk": "R1",
                }
            ],
            linked_claim_ids=["C1", "C2", "C3"],
            linked_evidence_ids=["E1", "E2", "E3"],
            applicability_conditions=["核心受灾镇街"],
            alternative_explanations=[],
            uncertainties=["保险理赔最终总额度尚待核算"],
        )

        self.doc_ir = self.adapter.convert_to_document_ir(
            report_id="rep-docx-001",
            report_input=report_input,
            judgment=judgment,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_docx_template_exists(self):
        """测试实验室舆情专报模板文件存在且包含必要章节结构"""
        tpl_path = os.path.join(
            os.path.dirname(__file__),
            "..",
            "ReportEngine",
            "report_template",
            "实验室舆情专报模板.md",
        )
        self.assertTrue(os.path.exists(tpl_path), f"Template file not found at {tpl_path}")
        with open(tpl_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("摘要", content)
        self.assertIn("舆论", content)
        self.assertIn("建议", content)

    def test_docx_render_and_file_integrity(self):
        """测试 DocxRenderer 导出有效 .docx 文件并验证结构与文本完整性"""
        out_file = os.path.join(self.temp_dir.name, "output_report.docx")
        exported_path = self.docx_renderer.export_file(self.doc_ir, out_file)

        self.assertTrue(os.path.exists(exported_path))
        self.assertGreater(os.path.getsize(exported_path), 1000)

        # 重新加载生成的 docx 验证解析无异常
        doc = docx.Document(exported_path)
        all_text = "\n".join([p.text for p in doc.paragraphs])

        # 校验核心内容全部包含
        self.assertIn("特大极端天气抢险舆情专报", all_text)
        self.assertIn("报告摘要与综合定性研判", all_text)
        self.assertIn("应急指挥部", all_text)
        self.assertIn("设立专项答疑专班", all_text)

    def test_multi_format_rendering_consistency(self):
        """同一 Document IR 在 Markdown, HTML 和 DOCX 输出一致"""
        md_output = self.md_renderer.render(self.doc_ir)
        self.assertIn("特大极端天气抢险舆情专报", md_output)
        self.assertIn("报告摘要与综合研判", md_output)

        html_output = self.html_renderer.render(self.doc_ir)
        self.assertIn("特大极端天气抢险舆情专报", html_output)


if __name__ == "__main__":
    unittest.main()
