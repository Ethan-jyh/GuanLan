# -*- coding: utf-8 -*-
"""
论坛 HOST 阶段评审单元与端到端集成测试
测试覆盖：
1. Schema 模型定义与序列化验证
2. SQLite 状态持久化、幂等性提交与并发版本控制
3. 三方同步屏障（Sync Barrier）与状态机流转
4. 定向派单与未分派 Agent 成果自动沿用（Carry-forward）
5. 第 3 轮强制收敛（禁止 revise，必须 approve 或 finalize_with_unresolved）
6. 最终报告登记与 ReportEngine 就绪判定联动
"""

import os
import sys
import unittest
import tempfile
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from ForumEngine.schema import (
    TaskStatus,
    DecisionType,
    EvidenceItem,
    ParagraphSubmission,
    GuidanceResponse,
    AgentSubmission,
    GuidanceItem,
    HostDecision,
    TaskState,
)
from ForumEngine.storage import ForumReviewStorage
from ForumEngine.coordinator import ForumReviewCoordinator
from ForumEngine.adapter import ForumAgentAdapter


class TestForumStageReview(unittest.TestCase):
    """阶段评审核心逻辑测试"""

    def setUp(self):
        # 使用独立的临时数据库进行隔离测试
        self.temp_db = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.temp_db.close()
        self.db_path = self.temp_db.name
        self.storage = ForumReviewStorage(db_path=self.db_path)
        self.coordinator = ForumReviewCoordinator(storage=self.storage)

    def tearDown(self):
        if os.path.exists(self.db_path):
            try:
                os.remove(self.db_path)
            except Exception:
                pass

    def _create_dummy_submission(self, task_id: str, agent_id: str, round_num: int) -> AgentSubmission:
        """构建模拟阶段成果提交"""
        return AgentSubmission(
            task_id=task_id,
            agent_id=agent_id,
            round=round_num,
            submission_id=f"sub_{agent_id}_r{round_num}_{int(time.time() * 1000)}",
            checkpoint_path=f"logs/checkpoints/{task_id}/{agent_id}_round{round_num}.json",
            paragraphs=[
                ParagraphSubmission(
                    paragraph_id=f"P1",
                    title=f"关于{agent_id}的分析段落",
                    summary=f"这是 {agent_id} 在第 {round_num} 轮的核心结论",
                    key_claims=[f"主张1: {agent_id} 发现重要线索"],
                    evidence_ids=[f"E_{agent_id}_1"]
                )
            ],
            evidence_list=[
                EvidenceItem(
                    evidence_id=f"E_{agent_id}_1",
                    source_type="webpage" if agent_id == "query" else ("media_card" if agent_id == "media" else "db_record"),
                    source_ref="http://example.com/source",
                    title="权威发布",
                    excerpt="某权威机构发布的通报内容摘录",
                    retrieval_time="2026-09-30 14:00:00",
                    source_date="2026-09-29"
                )
            ]
        )

    def test_01_schema_validation(self):
        """测试数据模型定义与字段校验"""
        sub = self._create_dummy_submission("task_test_01", "query", 1)
        self.assertEqual(sub.task_id, "task_test_01")
        self.assertEqual(sub.agent_id, "query")
        self.assertEqual(len(sub.paragraphs), 1)
        self.assertEqual(len(sub.evidence_list), 1)

        decision = HostDecision(
            task_id="task_test_01",
            round=1,
            decision=DecisionType.REVISE,
            overall_rationale="证据不足，需补充调查",
            directives=[
                GuidanceItem(
                    guidance_id="G1",
                    target_agent="query",
                    related_paragraph_or_claim="P1",
                    question="官方通报的具体发布时间是什么？",
                    suggested_action="检索官方微博发布记录",
                    completion_criteria="获取精确到分钟的发布时间"
                )
            ],
            unresolved_issues=[]
        )
        self.assertEqual(decision.decision, DecisionType.REVISE)
        self.assertEqual(len(decision.directives), 1)
        self.assertEqual(decision.directives[0].target_agent, "query")

    def test_02_storage_and_idempotency(self):
        """测试 SQLite 持久化与提交幂等性"""
        task = self.storage.create_task("task_test_02", "测试舆情事件", max_rounds=3)
        self.assertEqual(task.status, TaskStatus.INITIAL_RESEARCH)
        self.assertEqual(task.current_round, 1)

        sub = self._create_dummy_submission("task_test_02", "query", 1)
        ok, msg = self.storage.save_submission(sub)
        self.assertTrue(ok)

        # 幂等性：同一 submission_id 再次提交应成功
        ok_dup, msg_dup = self.storage.save_submission(sub)
        self.assertTrue(ok_dup)

        # 同一任务、同一 Agent、同一轮次但换了 submission_id 且内容冲突时应拒绝
        sub_conflict = sub.model_copy(update={"submission_id": "sub_conflict_123"})
        ok_bad, msg_bad = self.storage.save_submission(sub_conflict)
        self.assertFalse(ok_bad)
        self.assertIn("已有已确认提交", msg_bad)

    def test_03_sync_barrier_and_state_machine(self):
        """测试三方同步屏障：仅当 query, media, insight 全到齐时才进入 HOST_REVIEWING"""
        task_id = "task_sync_03"
        task = self.coordinator.create_task("测试同步屏障", max_rounds=3, task_id=task_id)

        # 1. 提交 query
        sub_query = self._create_dummy_submission(task_id, "query", 1)
        self.coordinator.submit_agent_result(sub_query)
        task_state = self.coordinator.get_task_state(task_id)
        # 尚未齐，仍处于 WAITING_SUBMISSIONS 或 INITIAL_RESEARCH
        self.assertIn(task_state.status, [TaskStatus.INITIAL_RESEARCH, TaskStatus.WAITING_SUBMISSIONS])

        # 2. 提交 media
        sub_media = self._create_dummy_submission(task_id, "media", 1)
        self.coordinator.submit_agent_result(sub_media)
        task_state = self.coordinator.get_task_state(task_id)
        self.assertIn(task_state.status, [TaskStatus.INITIAL_RESEARCH, TaskStatus.WAITING_SUBMISSIONS])

        # 3. 提交 insight，此时三方齐全，触发同步屏障
        # 我们 mock _run_host_review_worker 避免真实调用外部 LLM API
        with patch.object(self.coordinator, '_run_host_review_worker') as mock_worker:
            sub_insight = self._create_dummy_submission(task_id, "insight", 1)
            self.coordinator.submit_agent_result(sub_insight)
            task_state = self.coordinator.get_task_state(task_id)
            self.assertEqual(task_state.status, TaskStatus.HOST_REVIEWING)
            mock_worker.assert_called_once_with(task_id, 1)

    def test_04_targeted_guidance_and_carry_forward(self):
        """测试定向派单与未分派 Agent 成果自动沿用（Carry-forward）"""
        task_id = "task_carry_04"
        self.coordinator.create_task("测试成果沿用", max_rounds=3, task_id=task_id)

        # 三方提交第 1 轮
        sub_q1 = self._create_dummy_submission(task_id, "query", 1)
        sub_m1 = self._create_dummy_submission(task_id, "media", 1)
        sub_i1 = self._create_dummy_submission(task_id, "insight", 1)

        self.storage.save_submission(sub_q1)
        self.storage.save_submission(sub_m1)
        self.storage.save_submission(sub_i1)

        # 模拟 HOST 第 1 轮评审：下发 revise 且仅给 query 派单
        mock_decision = HostDecision(
            task_id=task_id,
            round=1,
            decision=DecisionType.REVISE,
            overall_rationale="Query 缺少关键时间戳，Media 和 Insight 已完备",
            directives=[
                GuidanceItem(
                    guidance_id="G_Q1",
                    target_agent="query",
                    related_paragraph_or_claim="P1",
                    question="核查确切发布时间",
                    suggested_action="检索官方通报时间",
                    completion_criteria="获得精确时间"
                )
            ],
            unresolved_issues=[]
        )

        with patch("ForumEngine.coordinator.review_stage_submissions", return_value=mock_decision):
            self.coordinator._run_host_review_worker(task_id, round_num=1)

        task_after_r1 = self.coordinator.get_task_state(task_id)
        # 任务进入第 2 轮补充研究
        self.assertEqual(task_after_r1.status, TaskStatus.SUPPLEMENTAL_RESEARCH)
        self.assertEqual(task_after_r1.current_round, 2)
        self.assertEqual(task_after_r1.waiting_agents, ["query"])

        # 验证 Media 和 Insight 是否被自动沿用至第 2 轮
        m2_sub = self.storage.get_agent_submission(task_id, "media", 2)
        i2_sub = self.storage.get_agent_submission(task_id, "insight", 2)
        self.assertIsNotNone(m2_sub)
        self.assertIsNotNone(i2_sub)
        self.assertEqual(m2_sub.carried_forward_from, 1)
        self.assertEqual(i2_sub.carried_forward_from, 1)

        # 验证指令查询：Query 查到指令，Media 查不到指令
        status_q, dir_q = self.coordinator.get_agent_directives(task_id, "query")
        self.assertEqual(status_q, TaskStatus.SUPPLEMENTAL_RESEARCH.value)
        self.assertEqual(len(dir_q), 1)
        self.assertEqual(dir_q[0].guidance_id, "G_Q1")

        status_m, dir_m = self.coordinator.get_agent_directives(task_id, "media")
        self.assertEqual(len(dir_m), 0)

        # Query 补充研究后提交第 2 轮
        sub_q2 = self._create_dummy_submission(task_id, "query", 2)
        sub_q2.guidance_responses = [
            GuidanceResponse(
                guidance_id="G_Q1",
                actions_taken="检索官方通报时间",
                new_evidence=[],
                modified_paragraphs=["P1"],
                result_summary="已确认官方通报为 09:30"
            )
        ]

        with patch.object(self.coordinator, '_run_host_review_worker') as mock_worker2:
            self.coordinator.submit_agent_result(sub_q2)
            # 因为 Media 和 Insight 已自动沿用，Query 提交后直接满足三方齐全，触发第 2 轮 HOST 评审！
            task_state_r2 = self.coordinator.get_task_state(task_id)
            self.assertEqual(task_state_r2.status, TaskStatus.HOST_REVIEWING)
            mock_worker2.assert_called_once_with(task_id, 2)

    def test_05_round_3_mandatory_finalization(self):
        """测试第 3 轮强制收敛：禁止 revise，必须 finalize_with_unresolved 或 approve"""
        task_id = "task_final_05"
        self.coordinator.create_task("第3轮收敛测试", max_rounds=3, task_id=task_id)

        # 推进到第 3 轮
        self.storage.update_task_status(task_id=task_id, status=TaskStatus.HOST_REVIEWING, current_round=3)

        for ag in ["query", "media", "insight"]:
            sub = self._create_dummy_submission(task_id, ag, 3)
            self.storage.save_submission(sub)

        # 如果第 3 轮 Host 模型返回了 finalize_with_unresolved
        decision_r3 = HostDecision(
            task_id=task_id,
            round=3,
            decision=DecisionType.FINALIZE_WITH_UNRESOLVED,
            overall_rationale="已达最大评审轮次，存在部分未证实争议点",
            directives=[],
            unresolved_issues=["争议点：资金具体去向尚存各方分歧"]
        )

        with patch("ForumEngine.coordinator.review_stage_submissions", return_value=decision_r3):
            self.coordinator._run_host_review_worker(task_id, round_num=3)

        task_done = self.coordinator.get_task_state(task_id)
        # 放行生成最终研报
        self.assertEqual(task_done.status, TaskStatus.APPROVED_FOR_REPORT)

    def test_06_report_registration_and_report_engine_readiness(self):
        """测试最终研报登记与 ReportEngine 严格核验联动"""
        task_id = "task_report_06"
        self.coordinator.create_task("研报就绪联动测试", max_rounds=3, task_id=task_id)

        # 将任务状态置为 APPROVED_FOR_REPORT
        self.storage.update_task_status(task_id=task_id, status=TaskStatus.APPROVED_FOR_REPORT)

        # 创建真实的临时报告文件
        temp_files = {}
        for ag in ["query", "media", "insight"]:
            tf = tempfile.NamedTemporaryFile(suffix=".md", delete=False)
            tf.write(f"# {ag.upper()} 深度研究报告\n这是真实的研究结论内容。".encode("utf-8"))
            tf.close()
            temp_files[ag] = tf.name

        try:
            # 1. 仅登记 query 和 media
            self.coordinator.register_final_report(task_id, "query", temp_files["query"])
            self.coordinator.register_final_report(task_id, "media", temp_files["media"])

            ready, reports = self.coordinator.are_reports_ready_for_report_engine(task_id)
            self.assertFalse(ready)

            # 2. 登记 insight
            self.coordinator.register_final_report(task_id, "insight", temp_files["insight"])

            # 此时任务状态应自动跃迁为 FINAL_REPORTS_READY
            task_state = self.coordinator.get_task_state(task_id)
            self.assertEqual(task_state.status, TaskStatus.FINAL_REPORTS_READY)

            ready, reports = self.coordinator.are_reports_ready_for_report_engine(task_id)
            self.assertTrue(ready)
            self.assertEqual(len(reports), 3)
            self.assertEqual(reports["query"], temp_files["query"])
            self.assertEqual(reports["media"], temp_files["media"])
            self.assertEqual(reports["insight"], temp_files["insight"])

        finally:
            for p in temp_files.values():
                if os.path.exists(p):
                    try:
                        os.remove(p)
                    except Exception:
                        pass

    def test_agent_display_names(self):
        """验证方案 B 智库专家命名映射函数"""
        from ForumEngine.schema import get_agent_display_name, AGENT_DISPLAY_NAMES

        self.assertIn("事实调查员", get_agent_display_name("query"))
        self.assertIn("舆情分析员", get_agent_display_name("media"))
        self.assertIn("深度研判员", get_agent_display_name("insight"))
        self.assertIn("首席审议官", get_agent_display_name("host"))
        self.assertIn("研报主编", get_agent_display_name("report"))

        # 大写兼容
        self.assertEqual(get_agent_display_name("QUERY"), AGENT_DISPLAY_NAMES["query"])
        # 未知 agent_id 回退自身
        self.assertEqual(get_agent_display_name("unknown_bot"), "unknown_bot")


if __name__ == "__main__":
    unittest.main()
