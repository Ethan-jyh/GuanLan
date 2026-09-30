# -*- coding: utf-8 -*-
"""
论坛阶段评审协作客户端（ForumReviewClient）
供各业务 Agent（Query, Media, Insight）与主进程协调器通信：
提交阶段成果、短轮询等待决策、接收定向派单、保存检查点及登记最终报告
"""

import json
import time
import uuid
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
import requests
from loguru import logger

from .schema import (
    AgentSubmission,
    ParagraphSubmission,
    EvidenceItem,
    GuidanceItem,
    GuidanceResponse,
    HostDecision,
    DecisionType,
    TaskStatus,
)


class ForumReviewClient:
    """Agent 与协调器通信的标准客户端"""

    def __init__(self, base_url: str = "http://localhost:5000/api/forum"):
        self.base_url = base_url.rstrip("/")

    # ==================== 接口交互 ====================

    def submit_stage_result(
        self,
        task_id: str,
        agent_id: str,
        round_num: int,
        paragraphs: List[ParagraphSubmission],
        evidence_list: List[EvidenceItem],
        open_questions: Optional[List[str]] = None,
        guidance_responses: Optional[List[GuidanceResponse]] = None,
        checkpoint_path: Optional[str] = None,
        submission_id: Optional[str] = None
    ) -> Tuple[bool, str]:
        """提交本轮阶段成果"""
        sub_id = submission_id or f"sub_{agent_id}_r{round_num}_{uuid.uuid4().hex[:8]}"
        submission = AgentSubmission(
            task_id=task_id,
            agent_id=agent_id,
            round=round_num,
            submission_id=sub_id,
            checkpoint_path=checkpoint_path,
            paragraphs=paragraphs,
            evidence_list=evidence_list,
            open_questions=open_questions or [],
            guidance_responses=guidance_responses or []
        )

        try:
            url = f"{self.base_url}/tasks/{task_id}/submissions"
            resp = requests.post(url, json=submission.model_dump(), timeout=15)
            if resp.status_code == 200:
                data = resp.json()
                return True, data.get("message", "提交成功")
            else:
                return False, f"提交失败 (HTTP {resp.status_code}): {resp.text}"
        except Exception as e:
            return False, f"网络请求异常: {str(e)}"

    def poll_for_decision(
        self,
        task_id: str,
        agent_id: str,
        poll_interval: float = 2.0,
        timeout: float = 1800.0
    ) -> Tuple[str, List[GuidanceItem], Optional[HostDecision]]:
        """
        短轮询等待 HOST 评审决定：
        返回: (status, directives_for_me, latest_decision)
        - status 为 'approved_for_report': 可以直接生成最终报告
        - status 为 'supplemental_research': 需执行返回的 directives
        - 抛出异常: 任务暂停、取消或超时
        """
        start_time = time.time()
        url = f"{self.base_url}/tasks/{task_id}/agents/{agent_id}/decision"

        while time.time() - start_time < timeout:
            try:
                resp = requests.get(url, timeout=10)
                if resp.status_code == 200:
                    data = resp.json()
                    status = data.get("task_status")
                    directives_data = data.get("directives", [])
                    directives = [GuidanceItem.model_validate(d) for d in directives_data]
                    decision_data = data.get("latest_decision")
                    decision = HostDecision.model_validate(decision_data) if decision_data else None

                    # 1. 任务暂停处理
                    if status == TaskStatus.PAUSED.value:
                        reason = data.get("paused_reason", "未知原因")
                        logger.warning(f"协作任务 [{task_id}] 已处于暂停状态: {reason}，等待恢复...")
                        time.sleep(poll_interval * 2)
                        continue

                    # 2. 任务取消处理
                    if status == TaskStatus.CANCELLED.value:
                        raise RuntimeError(f"协作任务 [{task_id}] 已被取消")

                    # 3. 允许生成最终报告（通过或带疑点放行）
                    if status in [TaskStatus.APPROVED_FOR_REPORT.value, TaskStatus.FINAL_REPORTS_READY.value]:
                        return status, [], decision

                    # 4. 处于补充研究阶段
                    if status == TaskStatus.SUPPLEMENTAL_RESEARCH.value:
                        if directives:
                            # 自身有补充任务
                            return status, directives, decision
                        else:
                            # 自身无补充任务（成果已由协调器自动沿用），继续等待其他人完成直到 APPROVED_FOR_REPORT
                            logger.debug(f"Agent [{agent_id}] 本轮无补充任务，成果已沿用，静待其他成员...")
                            time.sleep(poll_interval)
                            continue

                time.sleep(poll_interval)
            except requests.RequestException as e:
                logger.warning(f"轮询接口异常: {e}，将在 {poll_interval}s 后重试")
                time.sleep(poll_interval)

        raise TimeoutError(f"等待 HOST 评审超时 ({timeout}s)")

    def register_final_report(self, task_id: str, agent_id: str, report_path: str) -> bool:
        """向协调器登记最终生成的完整研究报告路径"""
        url = f"{self.base_url}/tasks/{task_id}/reports"
        try:
            resp = requests.post(url, json={"agent_id": agent_id, "report_path": str(report_path)}, timeout=10)
            if resp.status_code == 200:
                logger.info(f"最终报告登记成功: {report_path}")
                return True
            else:
                logger.error(f"最终报告登记失败: {resp.text}")
                return False
        except Exception as e:
            logger.error(f"登记报告网络异常: {e}")
            return False
