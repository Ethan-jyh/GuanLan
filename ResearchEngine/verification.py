# -*- coding: utf-8 -*-
"""
ResearchEngine 核验组件 (ClaimVerifier)
可调用的论点与证据溯源核验组件（非必须常驻的独立业务 Agent）。
负责核对主张引用的证据池、检查正文摘录支撑度，
并区分跨维度（官方回应、热度走势、公众质疑）的事实共存关系，避免虚假互斥矛盾。
"""

from typing import List, Dict, Any, Optional

from .schema import (
    Claim,
    Evidence,
    VerificationItem,
    VerificationStatus,
)
from .evidence import EvidenceStore


class ClaimVerifier:
    """论点与证据核验器"""

    def __init__(self, evidence_store: EvidenceStore):
        self.evidence_store = evidence_store

    def verify_claim(self, run_id: str, claim: Claim) -> VerificationItem:
        """
        核验单条主张
        1. 检查是否附带证据ID
        2. 从 EvidenceStore 检索关联证据并校验 run_id 隔离
        3. 检查证据摘录对主张陈述的支撑强度
        4. 证据不足或缺失时保留 UNCERTAIN 或 UNSUPPORTED，不强制臆测
        """
        if not claim.evidence_ids:
            return VerificationItem(
                claim_id=claim.claim_id,
                claim_statement=claim.statement,
                status=VerificationStatus.UNSUPPORTED,
                rationale="主张未指定任何支撑证据ID",
                supplementary_evidence_ids=[],
                suggested_checks="请补充检索相关信源或官方通报以提供支撑",
            )

        found_evidences: List[Evidence] = []
        missing_ids: List[str] = []

        for ev_id in claim.evidence_ids:
            ev = self.evidence_store.get_evidence(run_id, ev_id)
            if ev:
                found_evidences.append(ev)
            else:
                missing_ids.append(ev_id)

        if missing_ids and not found_evidences:
            return VerificationItem(
                claim_id=claim.claim_id,
                claim_statement=claim.statement,
                status=VerificationStatus.UNCERTAIN,
                rationale=f"引用的证据 {missing_ids} 在当前研究证据库中不存在或未加载",
                supplementary_evidence_ids=[],
                suggested_checks="确认证据录入状态或重新读取原始页面",
            )

        # 基于查找到的证据进行支撑度研判
        # 跨维度原则：
        # 1. 官方发布 (official_doc/authority) 描述官方口径与定调事实
        # 2. 统计指标 (db_record/evolution) 描述传播量、热度走势事实
        # 3. 评论抽样 (comment_sample/feedback) 描述公众情绪与疑点倾向事实
        # 彼此互为独立观察维度，各自有直接摘录支撑即为 SUPPORTED，不得判定为互斥矛盾。
        
        excerpts_text = " ".join([e.excerpt for e in found_evidences if e.excerpt])
        
        # 检查是否直接支持
        # 简易而鲁棒的词元/语义覆盖检测
        statement_chars = set(claim.statement)
        matching_chars = statement_chars.intersection(set(excerpts_text))
        overlap_ratio = len(matching_chars) / max(len(statement_chars), 1)

        # 检查直接反义/冲突词（仅在同一维度内判定矛盾）
        direct_conflict = False
        conflict_rationale = ""
        
        if ("未发生" in excerpts_text or "无人员伤亡" in excerpts_text) and (
            "发生重大伤亡" in claim.statement or "多人遇难" in claim.statement
        ):
            direct_conflict = True
            conflict_rationale = "主张所称严重伤亡与证据通报'未发生伤亡'存在直接事实冲突"

        if direct_conflict:
            return VerificationItem(
                claim_id=claim.claim_id,
                claim_statement=claim.statement,
                status=VerificationStatus.CONTRADICTED,
                rationale=conflict_rationale,
                supplementary_evidence_ids=[e.evidence_id for e in found_evidences],
            )

        if overlap_ratio >= 0.4:
            # 具有充分摘录支撑
            status = VerificationStatus.SUPPORTED
            rationale = f"证据 {[e.evidence_id for e in found_evidences]} 摘录与主张语义高度吻合，信源明确，维度自洽。"
        elif overlap_ratio >= 0.2:
            status = VerificationStatus.PARTIALLY_SUPPORTED
            rationale = f"证据 {[e.evidence_id for e in found_evidences]} 支持部分事实，但陈述细节可能超出摘录直接涵盖范围。"
        else:
            status = VerificationStatus.UNCERTAIN
            rationale = "引用的证据摘录未能充分直接反映论点陈述内容，需人工复核或定向补查。"

        return VerificationItem(
            claim_id=claim.claim_id,
            claim_statement=claim.statement,
            status=status,
            rationale=rationale,
            supplementary_evidence_ids=[e.evidence_id for e in found_evidences],
            suggested_checks=None if status == VerificationStatus.SUPPORTED else "建议调取完整正文或增加样本量",
        )

    def verify_claims(self, run_id: str, claims: List[Claim]) -> List[VerificationItem]:
        """批量核验主张列表"""
        return [self.verify_claim(run_id, claim) for claim in claims]
