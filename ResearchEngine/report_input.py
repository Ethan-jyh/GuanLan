# -*- coding: utf-8 -*-
"""
ResearchEngine 专报输入构建器 (report_input)
使用显式成果版本构造 Report 写作输入包，记录确切的轮次 Artifact 版本，
杜绝动态扫描文件目录导致的多重写作与版本竞态。
"""

from typing import Dict, Any, List, Optional
from .schema import ResearchResult, VerificationItem


def build_report_input(
    run_id: str,
    topic: str,
    scope: Dict[str, Any],
    effective_submissions: Dict[str, ResearchResult],
    verifications: Optional[List[VerificationItem]] = None,
    unresolved_issues: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """
    构造供 Report 综合研判与 Document IR 生成的标准化输入数据结构。
    """
    verifications = verifications or []
    unresolved_issues = unresolved_issues or []

    # 1. 显式提取各角色所属轮次版本
    research_versions: Dict[str, int] = {}
    findings_data: Dict[str, Any] = {}
    all_claims: List[Dict[str, Any]] = []
    all_evidences: List[Dict[str, Any]] = []

    for role_name, sub in effective_submissions.items():
        sub_model = ResearchResult.model_validate(sub) if isinstance(sub, dict) else sub
        research_versions[role_name] = sub_model.round
        sub_dict = sub_model.model_dump() if hasattr(sub_model, "model_dump") else sub_model.dict()
        findings_data[role_name] = sub_dict

        for c in sub_model.claims:
            all_claims.append(c.model_dump() if hasattr(c, "model_dump") else c.dict())
        for e in sub_model.evidence_pool:
            all_evidences.append(e.model_dump() if hasattr(e, "model_dump") else e.dict())


    return {
        "run_id": run_id,
        "topic": topic,
        "scope": scope,
        "research_versions": research_versions,
        "findings": findings_data,
        "claims": all_claims,
        "evidence_pool": all_evidences,
        "verifications": [
            v.model_dump() if hasattr(v, "model_dump") else v.dict() for v in verifications
        ],
        "unresolved_issues": unresolved_issues,
    }
