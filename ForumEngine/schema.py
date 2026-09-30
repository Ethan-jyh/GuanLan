# -*- coding: utf-8 -*-
"""
论坛 HOST 阶段评审数据契约与模型定义
按照 2026-09-30 规范设计，严格定义状态机、提交物、HOST决策与证据结构
"""

from enum import Enum
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field


class TaskStatus(str, Enum):
    """协作任务状态枚举"""
    INITIAL_RESEARCH = "initial_research"          # 初步研究进行中
    WAITING_SUBMISSIONS = "waiting_submissions"    # 等待三方提交
    HOST_REVIEWING = "host_reviewing"              # HOST 评审中
    SUPPLEMENTAL_RESEARCH = "supplemental_research"# 补充研究进行中
    PAUSED = "paused"                              # 异常/超时暂停中
    APPROVED_FOR_REPORT = "approved_for_report"    # 允许生成最终报告
    FINAL_REPORTS_READY = "final_reports_ready"    # 三方最终报告均已登记就绪
    CANCELLED = "cancelled"                        # 已取消


class DecisionType(str, Enum):
    """HOST 评审决定类型"""
    REVISE = "revise"                              # 需补充研究（仅前两轮允许）
    APPROVE = "approve"                            # 通过，无待办事项
    FINALIZE_WITH_UNRESOLVED = "finalize_with_unresolved"  # 带未解决问题放行（第3轮或提前）


class EvidenceItem(BaseModel):
    """证据及溯源数据项"""
    evidence_id: str = Field(..., description="证据编号，如 E1, E2")
    source_type: str = Field(..., description="来源类型：webpage, db_record, media_card 等")
    source_ref: str = Field(..., description="来源URL或内部数据库查询引用")
    title: str = Field(..., description="证据源标题或主题")
    excerpt: str = Field(..., description="支持主张的具体文字/数据摘录")
    retrieval_time: str = Field(..., description="系统执行检索的时间戳")
    source_date: Optional[str] = Field(None, description="来源内容的实际发布日期（未知时为空）")


class ParagraphSubmission(BaseModel):
    """单个段落阶段性成果"""
    paragraph_id: str = Field(..., description="段落编号，如 P1, P2")
    title: str = Field(..., description="段落标题")
    summary: str = Field(..., description="当前阶段的完整段落总结")
    key_claims: List[str] = Field(default_factory=list, description="关键论点列表")
    evidence_ids: List[str] = Field(default_factory=list, description="关联的证据编号列表")


class GuidanceResponse(BaseModel):
    """对 HOST 某条指导意见的执行回复"""
    guidance_id: str = Field(..., description="关联的 HOST 指导任务编号")
    actions_taken: str = Field(..., description="Agent 实际执行的核查动作")
    new_evidence: List[EvidenceItem] = Field(default_factory=list, description="本次补充获得的新证据")
    modified_paragraphs: List[str] = Field(default_factory=list, description="受影响修改的段落编号列表")
    result_summary: str = Field(..., description="核查结果结论总结")
    unresolved_reason: Optional[str] = Field(None, description="未能解决或未找到证据的具体原因说明")


class AgentSubmission(BaseModel):
    """Agent 单轮提交完整结构"""
    task_id: str = Field(..., description="所属协作任务全局唯一ID")
    agent_id: str = Field(..., description="Agent身份标识：query, media, insight")
    round: int = Field(..., ge=1, le=3, description="当前所属轮次：1, 2, 3")
    submission_id: str = Field(..., description="本次提交的幂等唯一ID")
    checkpoint_path: Optional[str] = Field(None, description="持久化研究检查点路径")
    paragraphs: List[ParagraphSubmission] = Field(default_factory=list, description="段落成果列表")
    evidence_list: List[EvidenceItem] = Field(default_factory=list, description="本次引用或沉淀的证据池")
    open_questions: List[str] = Field(default_factory=list, description="当前尚未完全搞清楚的开放问题")
    guidance_responses: List[GuidanceResponse] = Field(default_factory=list, description="对上轮指导的答复（第1轮为空）")
    carried_forward_from: Optional[int] = Field(None, description="沿用上一轮结果的轮次标记（无需补充时标记）")


class GuidanceItem(BaseModel):
    """HOST 定向下发的单条核查任务"""
    guidance_id: str = Field(..., description="指导编号，如 G1, G2")
    target_agent: str = Field(..., description="目标执行 Agent：query, media, insight")
    related_paragraph_or_claim: str = Field(..., description="关联的具体段落、结论或主张")
    question: str = Field(..., description="需要进一步核查的核心疑点/矛盾问题")
    suggested_action: str = Field(..., description="建议执行的具体动作（如搜索关键词、定向过滤条件）")
    completion_criteria: str = Field(..., description="可检验的完成标准（如核实到具体官方发文字号或原视频发布时间）")


class HostDecision(BaseModel):
    """HOST 评审决定结构"""
    task_id: str = Field(..., description="任务ID")
    round: int = Field(..., ge=1, le=3, description="当前评审轮次")
    decision: DecisionType = Field(..., description="评审决定")
    overall_rationale: str = Field(..., description="整体评审理由与三方观点对比说明")
    directives: List[GuidanceItem] = Field(default_factory=list, description="定向下发的具体补充任务列表")
    unresolved_issues: List[str] = Field(default_factory=list, description="尚未解决或各方仍有争议的事项清单")


class TaskState(BaseModel):
    """协作任务全局状态模型"""
    task_id: str
    topic: str
    status: TaskStatus
    current_round: int = 1
    max_rounds: int = 3
    waiting_agents: List[str] = Field(default_factory=lambda: ["query", "media", "insight"])
    paused_reason: Optional[str] = None
    paused_stage: Optional[str] = None
    created_at: str
    updated_at: str
    registered_reports: Dict[str, str] = Field(default_factory=dict, description="已登记的最终报告路径 agent_id -> path")


AGENT_DISPLAY_NAMES: Dict[str, str] = {
    "query": "事实调查员 (Fact Finder)",
    "media": "舆情分析员 (Sentiment Analyst)",
    "insight": "深度研判员 (Domain Specialist)",
    "host": "首席审议官 (Review Arbiter)",
    "report": "研报主编 (Lead Editor)",
}


def get_agent_display_name(agent_id: str) -> str:
    """获取 Agent 的规范业务中文角色名称"""
    return AGENT_DISPLAY_NAMES.get(agent_id.lower(), agent_id)
