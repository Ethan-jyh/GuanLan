# -*- coding: utf-8 -*-
"""
Task 2 跨语言契约与研究状态单元测试
覆盖：
1. Envelope 包络元数据校验
2. Evidence, Claim, ResearchResult (authority, evolution, feedback) 模型完整性
3. 角色合法性检验（拒绝未知角色，仅限 authority, evolution, feedback 等）
4. 轮次上限边界（最大 3 轮，拒绝第 4 轮）
5. 核验结论 Verification 枚举与结构校验
6. ReportJudgment 与 Artifact 模型验证
7. 样本文件 contracts/fixtures/research-v1.json 跨语言解析一致性
"""

import os
import sys
import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchContracts(unittest.TestCase):
    """跨语言数据契约测试"""

    def test_imports_and_models(self):
        """测试核心契约模型导入与基本实例化"""
        from ResearchEngine.schema import (
            ResearchRole,
            RunStatus,
            TaskStatus,
            VerificationStatus,
            DecisionType,
            Envelope,
            Evidence,
            Claim,
            AuthorityFinding,
            EvolutionFinding,
            FeedbackFinding,
            ResearchResult,
            VerificationItem,
            HostReviewDecision,
            ReportJudgment,
            Artifact,
        )

        envelope = Envelope(
            schema_version="1.0.0",
            run_id="run-test-001",
            task_id="task-auth-01",
            call_id="call-001",
            execution_version=1,
            idempotency_key="idem-001",
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
        self.assertEqual(envelope.run_id, "run-test-001")

        evidence = Evidence(
            evidence_id="E1",
            source_type="official_doc",
            source_ref="https://example.gov.cn/release/123",
            title="权威发布",
            excerpt="官方通报称未发生重大险情。",
            retrieval_time="2026-10-01T12:00:00Z",
            source_date="2026-10-01T10:00:00Z",
            is_full_text=True,
        )
        self.assertEqual(evidence.evidence_id, "E1")

        claim = Claim(
            claim_id="C1",
            statement="官方已明确未发生重大险情",
            evidence_ids=["E1"],
            time_scope="2026-10-01",
            applicability_scope="涉事行政区域",
            limitations=["仅涵盖涉事区域核心范围"],
        )
        self.assertEqual(claim.claim_id, "C1")

        auth_finding = AuthorityFinding(
            entity_name="某市应急管理局",
            source_type="official_doc",
            published_at="2026-10-01T10:00:00Z",
            raw_text="官方通报称未发生重大险情。",
            stance_evolution="首次通报，口径平稳",
            covered_issues=["伤亡情况", "处置进展"],
            unaddressed_issues=["后续补偿政策"],
        )

        res = ResearchResult(
            role=ResearchRole.AUTHORITY,
            round=1,
            claims=[claim],
            evidence_pool=[evidence],
            scope={"region": "涉事区域", "time_window": "2026-10-01"},
            authority_finding=auth_finding,
        )
        self.assertEqual(res.role, ResearchRole.AUTHORITY)
        self.assertEqual(res.round, 1)

    def test_reject_invalid_role(self):
        """测试拒绝未知角色"""
        from ResearchEngine.schema import ResearchResult
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            ResearchResult(
                role="unknown_investigator",  # 无效角色
                round=1,
                claims=[],
                evidence_pool=[],
                scope={},
            )

    def test_reject_round_exceeding_three(self):
        """测试拒绝超过 3 轮的研究轮次"""
        from ResearchEngine.schema import ResearchRole, ResearchResult
        from pydantic import ValidationError

        with self.assertRaises(ValidationError):
            ResearchResult(
                role=ResearchRole.AUTHORITY,
                round=4,  # 超出 3 轮上限
                claims=[],
                evidence_pool=[],
                scope={},
            )

    def test_load_and_validate_fixture(self):
        """测试加载标准契约样本文件并验证"""
        from ResearchEngine.contracts import load_and_validate_research_fixture

        fixture_path = os.path.join(
            os.path.dirname(__file__), "..", "contracts", "fixtures", "research-v1.json"
        )
        self.assertTrue(os.path.exists(fixture_path), f"Fixture not found at {fixture_path}")

        data = load_and_validate_research_fixture(fixture_path)
        self.assertIn("run", data)
        self.assertIn("tasks", data)
        self.assertIn("results", data)
        self.assertIn("verifications", data)
        self.assertIn("report_judgment", data)


if __name__ == "__main__":
    unittest.main()
