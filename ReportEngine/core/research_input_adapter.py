# -*- coding: utf-8 -*-
"""
ReportEngine 研究成果与 IR 契约适配器 (ResearchInputAdapter)
将 ResearchEngine 产出的标准化三方成果与 ReportJudgment，
转化为符合 Document IR 1.0 契约规范的结构化章节与区块。
"""

from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

from ..ir import IR_VERSION
from .stitcher import DocumentComposer
from ResearchEngine.schema import ReportJudgment


class ResearchInputAdapter:
    """研究成果向 Document IR 转换的结构化适配器"""

    def __init__(self):
        self.composer = DocumentComposer()

    def convert_to_document_ir(
        self,
        report_id: str,
        report_input: Dict[str, Any],
        judgment: ReportJudgment,
    ) -> Dict[str, Any]:
        """
        核心适配方法：将综合研判与各角色结果转换为 Document IR
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        topic = report_input.get("topic", "专项研判报告")
        findings = report_input.get("findings", {})

        chapters: List[Dict[str, Any]] = []

        # ---------------- 章节 1: 报告摘要与综合研判 ----------------
        ch1_blocks: List[Dict[str, Any]] = [
            {
                "type": "heading",
                "level": 2,
                "text": "一、报告摘要与综合定性研判",
                "anchor": "summary-and-synthesis",
            },
            {
                "type": "paragraph",
                "inlines": [{"text": judgment.overall_interpretation}],
            },
        ]

        if judgment.applicability_conditions:
            cond_items = [
                [{"type": "paragraph", "inlines": [{"text": f"适用条件：{c}"}]}]
                for c in judgment.applicability_conditions
            ]
            ch1_blocks.append({
                "type": "heading",
                "level": 3,
                "text": "研判适用范围与条件",
                "anchor": "applicability-conditions",
            })
            ch1_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": cond_items,
            })

        if judgment.uncertainties:
            unc_items = [
                [{"type": "paragraph", "inlines": [{"text": f"不确定性与局限：{u}"}]}]
                for u in judgment.uncertainties
            ]
            ch1_blocks.append({
                "type": "heading",
                "level": 3,
                "text": "情报不确定性说明",
                "anchor": "uncertainties",
            })
            ch1_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": unc_items,
            })

        chapters.append({
            "chapterId": "C1",
            "title": "报告摘要与综合研判",
            "anchor": "section-summary",
            "order": 1,
            "blocks": ch1_blocks,
        })

        # ---------------- 章节 2: 权威口径与定调演化 ----------------
        auth_data = findings.get("authority", {})
        auth_finding = auth_data.get("authority_finding") or {}
        ch2_blocks: List[Dict[str, Any]] = [
            {
                "type": "heading",
                "level": 2,
                "text": "二、官方权威口径与定调演化",
                "anchor": "authority-stance",
            },
            {
                "type": "paragraph",
                "inlines": [
                    {
                        "text": f"表态主体：{auth_finding.get('entity_name', '主管部门')}；发布类别：{auth_finding.get('source_type', '公开通报')}；态势定调：{auth_finding.get('stance_evolution', '平稳有序')}。"
                    }
                ],
            },
            {
                "type": "paragraph",
                "inlines": [
                    {
                        "text": f"通报核心原文摘录：“{auth_finding.get('raw_text', '暂无详细通报引述')}”"
                    }
                ],
            },
        ]

        covered = auth_finding.get("covered_issues", [])
        if covered:
            ch2_blocks.append({
                "type": "heading",
                "level": 3,
                "text": "官方通报正面回应事项",
                "anchor": "covered-issues",
            })
            ch2_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": [[{"type": "paragraph", "inlines": [{"text": issue}]}] for issue in covered],
            })

        chapters.append({
            "chapterId": "C2",
            "title": "权威口径与定调演化",
            "anchor": "section-authority",
            "order": 2,
            "blocks": ch2_blocks,
        })

        # ---------------- 章节 3: 舆情传播与热度走势 ----------------
        evo_data = findings.get("evolution", {})
        evo_finding = evo_data.get("evolution_finding") or {}
        ch3_blocks: List[Dict[str, Any]] = [
            {
                "type": "heading",
                "level": 2,
                "text": "三、舆情传播热度与生命周期走势",
                "anchor": "evolution-dynamics",
            },
            {
                "type": "paragraph",
                "inlines": [
                    {
                        "text": f"监测时间窗口：{evo_finding.get('time_window', '全周期')}；指标定义：{evo_finding.get('metric_definition', '热度指数')}；生命周期判定：{evo_finding.get('phase_transition_analysis', '平稳期')}。"
                    }
                ],
            },
        ]

        data_points = evo_finding.get("data_points", [])
        if data_points:
            point_items = [
                [{"type": "paragraph", "inlines": [{"text": str(dp)}]}]
                for dp in data_points[:5]
            ]
            ch3_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": point_items,
            })

        chapters.append({
            "chapterId": "C3",
            "title": "舆情传播与热度走势",
            "anchor": "section-evolution",
            "order": 3,
            "blocks": ch3_blocks,
        })

        # ---------------- 章节 4: 公众关切与情绪诉求 ----------------
        feed_data = findings.get("feedback", {})
        feed_finding = feed_data.get("feedback_finding") or {}
        ch4_blocks: List[Dict[str, Any]] = [
            {
                "type": "heading",
                "level": 2,
                "text": "四、公众关切与情绪诉求分布",
                "anchor": "public-feedback",
            },
            {
                "type": "paragraph",
                "inlines": [
                    {
                        "text": f"抽样方法：{feed_finding.get('sampling_method', '抽样分析')}；有效样本量：{feed_finding.get('sample_size', 0)}条；分母说明：{feed_finding.get('denominator_info', '基于有效样本统计')}。"
                    }
                ],
            },
        ]

        demands = feed_finding.get("demands_summary", [])
        if demands:
            ch4_blocks.append({
                "type": "heading",
                "level": 3,
                "text": "高频关切与利益诉求提炼",
                "anchor": "demands-summary",
            })
            ch4_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": [[{"type": "paragraph", "inlines": [{"text": d}]}] for d in demands],
            })

        chapters.append({
            "chapterId": "C4",
            "title": "公众关切与情绪诉求",
            "anchor": "section-feedback",
            "order": 4,
            "blocks": ch4_blocks,
        })

        # ---------------- 章节 5: 风险评估与应对策略 ----------------
        ch5_blocks: List[Dict[str, Any]] = [
            {
                "type": "heading",
                "level": 2,
                "text": "五、研判风险点与针对性应对策略",
                "anchor": "risks-and-strategies",
            },
        ]

        if judgment.risks:
            risk_items = [
                [
                    {
                        "type": "paragraph",
                        "inlines": [
                            {
                                "text": f"【风险点 {r.get('risk_id', idx+1)}】{r.get('title', '')}：{r.get('description', '')}（等级：{r.get('severity', '中')}）"
                            }
                        ],
                    }
                ]
                for idx, r in enumerate(judgment.risks)
            ]
            ch5_blocks.append({
                "type": "heading",
                "level": 3,
                "text": "主要风险隐患",
                "anchor": "risk-points",
            })
            ch5_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": risk_items,
            })

        if judgment.recommendations:
            rec_items = [
                [
                    {
                        "type": "paragraph",
                        "inlines": [
                            {
                                "text": f"【建议 {rec.get('rec_id', idx+1)}】{rec.get('title', '')}：{rec.get('action', '')}（针对风险：{rec.get('target_risk', '整体态势')}）"
                            }
                        ],
                    }
                ]
                for idx, rec in enumerate(judgment.recommendations)
            ]
            ch5_blocks.append({
                "type": "heading",
                "level": 3,
                "text": "具体应对举措",
                "anchor": "action-recommendations",
            })
            ch5_blocks.append({
                "type": "list",
                "listType": "bullet",
                "items": rec_items,
            })

        chapters.append({
            "chapterId": "C5",
            "title": "风险评估与应对策略",
            "anchor": "section-risks-recommendations",
            "order": 5,
            "blocks": ch5_blocks,
        })

        metadata = {
            "title": topic,
            "reportId": report_id,
            "runId": report_input.get("run_id"),
            "generatedAt": now_iso,
            "researchVersions": report_input.get("research_versions", {}),
        }

        # 借助 DocumentComposer 进行锚点消重与全局元数据装订
        return self.composer.build_document(
            report_id=report_id,
            metadata=metadata,
            chapters=chapters,
        )
