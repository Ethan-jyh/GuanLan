# -*- coding: utf-8 -*-
"""
ResearchEngine 契约与核心领域模型
依据 2026-10-01 主从子智能体研究架构设计方案实现
"""

from enum import Enum
from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field, field_validator


class ResearchRole(str, Enum):
    """研究角色枚举"""
    AUTHORITY = "authority"   # 权威口径 Agent
    EVOLUTION = "evolution"   # 舆情演化 Agent
    FEEDBACK = "feedback"     # 公众反馈 Agent
    HOST = "host"             # 首席审议与调度 HOST
    REPORT = "report"         # 专报主编 Report Agent
    VERIFIER = "verifier"     # 核验组件


class RunStatus(str, Enum):
    """全任务运行状态"""
    PLANNING = "planning"           # 规划阶段
    RESEARCHING = "researching"     # 研究进行中
    REVIEWING = "reviewing"         # HOST 评审核验中
    APPROVED = "approved"           # 评审通过，放行成稿
    WRITING = "writing"             # 报告撰写中
    FINAL_CHECK = "final_check"     # 终稿审查
    COMPLETED = "completed"         # 交付完成
    PAUSED = "paused"               # 异常或预算耗尽暂停
    CANCELLED = "cancelled"         # 用户取消


class TaskStatus(str, Enum):
    """子任务状态"""
    PENDING = "pending"
    RUNNING = "running"
    SUBMITTED = "submitted"
    FAILED = "failed"
    CANCELLED = "cancelled"


class VerificationStatus(str, Enum):
    """核验状态"""
    SUPPORTED = "supported"                     # 指定范围内有充分证据支持
    PARTIALLY_SUPPORTED = "partially_supported" # 证据支持部分范围或措辞
    UNSUPPORTED = "unsupported"                 # 现有材料不足以支持
    CONTRADICTED = "contradicted"               # 存在直接冲突事实
    UNCERTAIN = "uncertain"                     # 无法比较或数据不可得


class DecisionType(str, Enum):
    """HOST 决策类型"""
    APPROVE = "approve"                                    # 通过并放行
    REVISE = "revise"                                      # 需定向补查（最多前两轮）
    FINALIZE_WITH_UNRESOLVED = "finalize_with_unresolved"  # 带未解决事项放行（第3轮或提前）


class Envelope(BaseModel):
    """跨语言交互请求/响应元数据包络"""
    schema_version: str = Field(default="1.0.0", description="契约协议版本")
    run_id: str = Field(..., description="全流程研究运行唯一标识")
    task_id: str = Field(..., description="当前步骤对应的任务ID")
    call_id: str = Field(..., description="调用ID")
    execution_version: int = Field(default=1, ge=1, description="调度执行版本，用于并发失效控制")
    idempotency_key: str = Field(..., description="幂等性键")
    timestamp: str = Field(..., description="ISO 8601 带时区时间戳")


class Evidence(BaseModel):
    """证据与溯源模型"""
    evidence_id: str = Field(..., description="证据编号，如 E1, E2")
    source_type: str = Field(..., description="来源类型：official_doc, webpage, db_record, media_card, comment_sample 等")
    source_ref: str = Field(..., description="URL或内部数据库检索标识")
    title: str = Field(..., description="证据标题或信源名称")
    excerpt: str = Field(..., description="支撑主张的关键摘录内容")
    retrieval_time: str = Field(..., description="系统抓取/检索时间")
    source_date: Optional[str] = Field(None, description="来源内容实际发布日期（未知可为空）")
    is_full_text: bool = Field(default=False, description="是否经过完整正文核查，而非仅凭摘要")
    coverage_scope: Optional[Dict[str, Any]] = Field(default_factory=dict, description="覆盖范围元数据")


class Claim(BaseModel):
    """结构化论点/主张模型"""
    claim_id: str = Field(..., description="主张编号，如 C1, C2")
    statement: str = Field(..., description="具体论断陈述")
    evidence_ids: List[str] = Field(default_factory=list, description="所引用的证据编号列表")
    time_scope: Optional[str] = Field(None, description="时间范围")
    applicability_scope: Optional[str] = Field(None, description="适用地区或对象范围")
    limitations: List[str] = Field(default_factory=list, description="研究员标记的边界限制与不确定性")


class AuthorityFinding(BaseModel):
    """权威口径角色专属成果"""
    entity_name: str = Field(..., description="表态主体机构名称")
    source_type: str = Field(..., description="官方发布源类别")
    published_at: str = Field(..., description="发布时间")
    raw_text: str = Field(..., description="表态通报原文或核心引语")
    stance_evolution: str = Field(..., description="相较既往口径的演化与态度定调")
    covered_issues: List[str] = Field(default_factory=list, description="通报中正面回应的问题清单")
    unaddressed_issues: List[str] = Field(default_factory=list, description="公众关切但尚未回应的事项")


class EvolutionFinding(BaseModel):
    """舆情演化角色专属成果"""
    metric_definition: str = Field(..., description="指标定义与统计口径")
    platform: str = Field(..., description="覆盖的主要平台")
    time_window: str = Field(..., description="时间窗口区间")
    data_points: List[Dict[str, Any]] = Field(default_factory=list, description="指标时间序列离散点")
    missing_periods: List[str] = Field(default_factory=list, description="缺失或中断的时间段")
    phase_transition_analysis: str = Field(..., description="生命周期与转折点判定方法依据")
    concurrent_events: List[str] = Field(default_factory=list, description="同期的外部关联事件")
    limitations: List[str] = Field(default_factory=list, description="数据覆盖局限")


class FeedbackFinding(BaseModel):
    """公众反馈角色专属成果"""
    sampling_method: str = Field(..., description="抽样与去重清洗方法")
    sample_size: int = Field(..., ge=0, description="有效抽样样本量")
    viewpoint_breakdown: Dict[str, float] = Field(default_factory=dict, description="观点分类与占比")
    sentiment_distribution: Dict[str, float] = Field(default_factory=dict, description="情绪分类比例")
    demands_summary: List[str] = Field(default_factory=list, description="高频利益诉求提炼")
    denominator_info: str = Field(..., description="样本基数与分母说明，不混淆为全网总量")
    representative_quotes: List[str] = Field(default_factory=list, description="代表性原声引语")
    limitations: List[str] = Field(default_factory=list, description="下沉抽样偏差与局限说明")


class ResearchResult(BaseModel):
    """研究成果统一提交模型"""
    role: ResearchRole = Field(..., description="提交角色")
    round: int = Field(..., ge=1, le=3, description="所属研究轮次（最多3轮）")
    claims: List[Claim] = Field(default_factory=list, description="主张列表")
    evidence_pool: List[Evidence] = Field(default_factory=list, description="证据池")
    scope: Dict[str, Any] = Field(default_factory=dict, description="研究范围边界")
    changes_from_previous_round: Optional[str] = Field(None, description="相对上轮变动说明")
    coverage_list: List[str] = Field(default_factory=list, description="已覆盖的问题清单")
    unresolved_issues: List[str] = Field(default_factory=list, description="本轮未解决疑点")
    tool_call_summary: Optional[Dict[str, int]] = Field(default_factory=dict, description="工具调用耗用统计")
    authority_finding: Optional[AuthorityFinding] = None
    evolution_finding: Optional[EvolutionFinding] = None
    feedback_finding: Optional[FeedbackFinding] = None


class VerificationItem(BaseModel):
    """核验条目模型"""
    claim_id: str = Field(..., description="被核验的主张编号")
    claim_statement: str = Field(..., description="核验时的论点原文")
    status: VerificationStatus = Field(..., description="核验结论")
    rationale: str = Field(..., description="核验分析理由与对比依据")
    supplementary_evidence_ids: List[str] = Field(default_factory=list, description="核验中补充提取的证据编号")
    suggested_checks: Optional[str] = Field(None, description="建议的进一步核查任务说明")


class DirectiveItem(BaseModel):
    """HOST 定向下发的补充研究任务"""
    directive_id: str = Field(..., description="指令ID")
    target_role: ResearchRole = Field(..., description="目标执行角色")
    related_claim_or_issue: str = Field(..., description="关联的具体论点或疑点")
    question: str = Field(..., description="需要补充回答的具体问题")
    suggested_action: str = Field(..., description="建议执行的动作或工具检索方案")
    completion_criteria: str = Field(..., description="客观可检验的完成标准")


class HostReviewDecision(BaseModel):
    """HOST 会商评审决定"""
    task_id: str = Field(..., description="评审关联的任务ID")
    round: int = Field(..., ge=1, le=3, description="当前评审轮次")
    decision: DecisionType = Field(..., description="评审决定")
    rationale: str = Field(..., description="三方观点综合对比研判理由")
    directives: List[DirectiveItem] = Field(default_factory=list, description="定向下发补查任务")
    unresolved_issues: List[str] = Field(default_factory=list, description="当前未决疑点列表")


class ReportJudgment(BaseModel):
    """Report Agent 综合研判结论"""
    overall_interpretation: str = Field(..., description="全景解释与定性")
    risks: List[Dict[str, Any]] = Field(default_factory=list, description="研判风险点清单")
    recommendations: List[Dict[str, Any]] = Field(default_factory=list, description="应对处置建议")
    linked_claim_ids: List[str] = Field(default_factory=list, description="支撑研判的核心主张ID")
    linked_evidence_ids: List[str] = Field(default_factory=list, description="关联证据ID")
    applicability_conditions: List[str] = Field(default_factory=list, description="政策/研判适用条件")
    alternative_explanations: List[str] = Field(default_factory=list, description="备选替代假设与反证可能")
    uncertainties: List[str] = Field(default_factory=list, description="不可知或不确定性限制")


class Artifact(BaseModel):
    """专报最终交付成果物"""
    artifact_id: str = Field(..., description="成果物ID")
    run_id: str = Field(..., description="所属运行ID")
    version: int = Field(default=1, ge=1, description="成稿版本号")
    research_versions: Dict[str, int] = Field(default_factory=dict, description="引用的各角色成果版本")
    judgment_version: int = Field(default=1, description="研判版本")
    final_check_passed: bool = Field(default=False, description="终稿质量合规检查是否通过")
    ir_content: Dict[str, Any] = Field(default_factory=dict, description="Document IR 结构化表达")
    output_file_paths: Dict[str, str] = Field(default_factory=dict, description="各渲染格式输出文件路径")


class ResearchRun(BaseModel):
    """运行实例持久化数据"""
    run_id: str = Field(..., description="运行ID")
    topic: str = Field(..., description="研究主题")
    scope: Dict[str, Any] = Field(default_factory=dict, description="时间与主体范围")
    status: RunStatus = Field(default=RunStatus.PLANNING, description="运行状态")
    current_round: int = Field(default=1, ge=1, le=3, description="当前轮次")
    max_rounds: int = Field(default=3, description="最大允许轮次")
    budget_total: int = Field(default=50, description="总工具调用预算")
    budget_used: int = Field(default=0, description="已消耗工具调用数")
    created_at: str = Field(..., description="创建时间")
    updated_at: str = Field(..., description="更新时间")


class ResearchTask(BaseModel):
    """子任务持久化数据"""
    task_id: str = Field(..., description="任务ID")
    run_id: str = Field(..., description="运行ID")
    role: ResearchRole = Field(..., description="执行角色")
    round: int = Field(default=1, ge=1, le=3, description="所属轮次")
    question: str = Field(..., description="研究问题")
    scope: Dict[str, Any] = Field(default_factory=dict, description="特定范围限制")
    status: TaskStatus = Field(default=TaskStatus.PENDING, description="任务状态")
    assigned_to: Optional[str] = Field(None, description="执行实例标识")
    budget_allocated: int = Field(default=12, description="分配的工具预算")
    created_at: str = Field(..., description="创建时间")
    completed_at: Optional[str] = Field(None, description="完成时间")
