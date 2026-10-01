# -*- coding: utf-8 -*-
"""
ResearchEngine 契约加载、校验与 JSON Schema 生成
"""

import json
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field

from .schema import (
    ResearchRun,
    ResearchTask,
    ResearchResult,
    VerificationItem,
    HostReviewDecision,
    ReportJudgment,
    Artifact,
)


class ResearchBundle(BaseModel):
    """跨语言交互完整的阶段/终态数据集合包"""
    run: ResearchRun
    tasks: List[ResearchTask] = Field(default_factory=list)
    results: List[ResearchResult] = Field(default_factory=list)
    verifications: List[VerificationItem] = Field(default_factory=list)
    host_decisions: List[HostReviewDecision] = Field(default_factory=list)
    report_judgment: Optional[ReportJudgment] = None
    artifact: Optional[Artifact] = None


def load_and_validate_research_fixture(fixture_path: str) -> Dict[str, Any]:
    """读取并严格按 Pydantic 校验标准研究样本"""
    with open(fixture_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    bundle = ResearchBundle.model_validate(data)
    return bundle.model_dump()


def export_json_schema() -> Dict[str, Any]:
    """导出标准的完整 JSON Schema"""
    return ResearchBundle.model_json_schema()
