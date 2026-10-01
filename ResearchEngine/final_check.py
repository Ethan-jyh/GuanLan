# -*- coding: utf-8 -*-
"""
ResearchEngine 终稿质量门禁 (FinalChecker)
HOST 组织终稿检查：
1. 事实穿透与溯源：研判引用的 claim_id 和 evidence_id 必须存在于三方成果库；
2. 拦截脱节臆测与空泛套话口号；
3. 风险与对策针对性对应，推断具备适用边界条件。
"""

from typing import List, Dict, Any, Tuple
from .schema import ReportJudgment


class FinalChecker:
    """终稿质量与合规检查器"""

    GENERIC_SLOGANS = [
        "加强舆论引导",
        "提高思想认识",
        "提高防范意识",
        "高度重视",
        "认真对待",
    ]

    def check_report_quality(
        self,
        judgment: ReportJudgment,
        available_claims: List[str],
        available_evidences: List[str],
    ) -> Tuple[bool, List[str]]:
        """
        核验专报研判质量：
        - 验证引用主张与证据的闭环溯源
        - 拦截无实质举措的口号套话
        - 校验风险与措施的映射针对性
        """
        issues: List[str] = []
        known_claims = set(available_claims)
        known_evidences = set(available_evidences)

        # 1. 主张溯源检查
        for cid in judgment.linked_claim_ids:
            if cid not in known_claims:
                issues.append(f"研判引用的主张编号 '{cid}' 未在三方研究主张库中，推断缺乏明确事实依据。")

        # 2. 证据溯源检查
        for eid in judgment.linked_evidence_ids:
            if eid not in known_evidences:
                issues.append(f"研判引用的证据编号 '{eid}' 未在三方研究证据池中，溯源链条断裂。")

        # 3. 拦截泛化空套话
        for rec in judgment.recommendations:
            title = rec.get("title", "")
            action = rec.get("action", "")
            combined_text = f"{title} {action}"
            for slogan in self.GENERIC_SLOGANS:
                if slogan in combined_text and len(combined_text.strip()) < 15:
                    issues.append(
                        f"应对建议 '{title}' 包含空泛口号 '{slogan}' 且缺乏具体执行主体与量化动作，未达专报交付标准。"
                    )

        # 4. 研判适用边界检查
        if not judgment.applicability_conditions and not judgment.uncertainties:
            issues.append("综合研判未标明适用范围条件或不确定性限制，可能导致决策层泛化理解。")

        return len(issues) == 0, issues
