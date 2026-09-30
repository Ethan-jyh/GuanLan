# -*- coding: utf-8 -*-
"""
论坛阶段评审协调器（ForumReviewCoordinator）
管理任务状态机、同步屏障（Sync Barrier）、异步调度 HOST 评审、超时控制与多轮流转
"""

import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any, Tuple
from loguru import logger

from .schema import (
    TaskStatus,
    DecisionType,
    AgentSubmission,
    HostDecision,
    GuidanceItem,
    TaskState,
)
from .storage import ForumReviewStorage
from .llm_host import review_stage_submissions


class ForumReviewCoordinator:
    """阶段评审协调器（单例模式）"""

    _instance = None
    _lock = threading.Lock()

    def __new__(cls, *args, **kwargs):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
            return cls._instance

    def __init__(self, storage: Optional[ForumReviewStorage] = None):
        if storage is not None:
            self.storage = storage
        elif not hasattr(self, "storage"):
            self.storage = ForumReviewStorage()

        if not hasattr(self, "_initialized"):
            self._host_review_lock = threading.Lock()
            self._active_timers: Dict[str, float] = {}  # task_id -> stage_start_timestamp
            self._stage_timeout_seconds = 1800  # 30 分钟默认超时
            self._initialized = True

    # ==================== 任务控制 ====================

    def start_task(self, task_id: str, topic: str, max_rounds: int = 3) -> TaskState:
        """启动新的协作评审任务"""
        task = self.storage.create_task(task_id=task_id, topic=topic, max_rounds=max_rounds)
        self._active_timers[task_id] = time.time()
        self._log_to_forum(f"=== 协作任务 [{task_id}] 启动: 《{topic}》 ===", "SYSTEM")
        return task

    def create_task(self, topic: str, max_rounds: int = 3, task_id: Optional[str] = None) -> TaskState:
        """便捷创建协作任务方法"""
        t_id = task_id or f"task_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
        return self.start_task(task_id=t_id, topic=topic, max_rounds=max_rounds)

    def get_task_state(self, task_id: str) -> Optional[TaskState]:
        """获取任务状态并自动检测超时"""
        task = self.storage.get_task(task_id)
        if not task:
            return None

        # 检查超时（仅在等待提交状态）
        if task.status in [TaskStatus.INITIAL_RESEARCH, TaskStatus.WAITING_SUBMISSIONS, TaskStatus.SUPPLEMENTAL_RESEARCH]:
            start_t = self._active_timers.get(task_id)
            if start_t and (time.time() - start_t > self._stage_timeout_seconds):
                reason = f"第 {task.current_round} 轮等待 Agent 提交超时，等待成员: {', '.join(task.waiting_agents)}"
                self.pause_task(task_id, reason=reason, stage=task.status.value)
                return self.storage.get_task(task_id)

        return task

    def get_active_task(self) -> Optional[TaskState]:
        """获取当前活跃的协作任务"""
        return self.storage.get_active_task()

    def get_latest_task(self) -> Optional[TaskState]:
        """获取最新的协作任务（包括已就绪状态）"""
        return self.storage.get_latest_task()

    def pause_task(self, task_id: str, reason: str, stage: Optional[str] = None) -> bool:
        """暂停任务"""
        task = self.storage.get_task(task_id)
        if not task:
            return False
        stage_val = stage or task.status.value
        ok = self.storage.update_task_status(
            task_id=task_id,
            status=TaskStatus.PAUSED,
            paused_reason=reason,
            paused_stage=stage_val
        )
        if ok:
            self._log_to_forum(f"[PAUSED] 任务已暂停 (原阶段: {stage_val})。原因: {reason}", "SYSTEM")
        return ok

    def resume_task(self, task_id: str) -> bool:
        """从暂停状态恢复"""
        task = self.storage.get_task(task_id)
        if not task or task.status != TaskStatus.PAUSED:
            return False

        orig_stage = TaskStatus(task.paused_stage or TaskStatus.WAITING_SUBMISSIONS.value)
        # 恢复计时器
        self._active_timers[task_id] = time.time()
        ok = self.storage.update_task_status(
            task_id=task_id,
            status=orig_stage,
            paused_reason=None,
            paused_stage=None
        )
        if ok:
            self._log_to_forum(f"[RESUME] 任务已恢复执行，回到阶段: {orig_stage.value}", "SYSTEM")
            # 恢复后检查是否恰好可以触发 HOST 评审
            self._check_and_trigger_host_review(task_id, task.current_round)
        return ok

    def cancel_task(self, task_id: str) -> bool:
        """取消任务"""
        ok = self.storage.update_task_status(task_id=task_id, status=TaskStatus.CANCELLED)
        if ok:
            self._active_timers.pop(task_id, None)
            self._log_to_forum(f"[CANCEL] 任务已被用户取消", "SYSTEM")
        return ok

    # ==================== Agent 提交与会商同步屏障 ====================

    def submit_agent_result(self, submission: AgentSubmission) -> Tuple[bool, str]:
        """
        Agent 提交阶段成果：
        1. 幂等校验并存入 SQLite；
        2. 判定三方是否全部到齐；
        3. 若到齐，触发异步工作线程执行 HOST 评审。
        """
        task = self.storage.get_task(submission.task_id)
        if not task:
            return False, f"任务 {submission.task_id} 不存在"

        # 保存提交
        ok, msg = self.storage.save_submission(submission)
        if not ok:
            return False, msg

        # 从 waiting_agents 中移除已提交的 agent
        remaining_waiting = [a for a in task.waiting_agents if a != submission.agent_id]
        if remaining_waiting != task.waiting_agents:
            self.storage.update_task_status(task_id=task.task_id, waiting_agents=remaining_waiting)

        self._log_to_forum(
            f"[{submission.agent_id.upper()}] 提交了第 {submission.round} 轮阶段成果 "
            f"(包含 {len(submission.paragraphs)} 个段落, {len(submission.evidence_list)} 条证据)",
            submission.agent_id.upper()
        )

        # 检查是否三方都已提交
        self._check_and_trigger_host_review(submission.task_id, submission.round)
        return True, "成果提交成功并已记录"

    def _check_and_trigger_host_review(self, task_id: str, round_num: int):
        """检查同步屏障，若三方齐全则切为 HOST_REVIEWING 并启动异步评审"""
        task = self.storage.get_task(task_id)
        if not task or task.status == TaskStatus.PAUSED or task.status == TaskStatus.CANCELLED:
            return

        submissions = self.storage.get_submissions_for_round(task_id, round_num)
        submitted_agents = {s.agent_id for s in submissions}
        required_agents = {"query", "media", "insight"}

        if submitted_agents == required_agents:
            logger.info(f"Task [{task_id}] 第 {round_num} 轮三方成果已全部到齐，触发同步屏障进入 HOST_REVIEWING")
            self.storage.update_task_status(task_id=task_id, status=TaskStatus.HOST_REVIEWING, waiting_agents=[])
            self._log_to_forum(f"=== 第 {round_num} 轮三方调研均已提交，首席分析师 Host 开始会商评审 ===", "HOST")

            # 启动独立工作线程执行 Host 评审，不阻塞调用方与数据库事务
            worker = threading.Thread(
                target=self._run_host_review_worker,
                args=(task_id, round_num),
                daemon=True
            )
            worker.start()

    def _run_host_review_worker(self, task_id: str, round_num: int):
        """异步执行 HOST 评审的模型调用与状态流转"""
        with self._host_review_lock:
            task = self.storage.get_task(task_id)
            if not task or task.status == TaskStatus.CANCELLED:
                return

            try:
                submissions = self.storage.get_submissions_for_round(task_id, round_num)
                prev_decision = self.storage.get_host_decision(task_id, round_num - 1) if round_num > 1 else None

                logger.info(f"HOST 开始执行第 {round_num} 轮会商评审...")
                decision: HostDecision = review_stage_submissions(
                    task_id=task_id,
                    topic=task.topic,
                    round_num=round_num,
                    max_rounds=task.max_rounds,
                    submissions=submissions,
                    previous_decision=prev_decision
                )

                # 持久化决定
                save_ok, save_msg = self.storage.save_host_decision(decision)
                if not save_ok:
                    raise RuntimeError(f"保存 HOST 决定失败: {save_msg}")

                # 输出人类可读的会商日志
                rationale_brief = decision.overall_rationale.replace('\n', ' ')
                self._log_to_forum(
                    f"[HOST 决定]: {decision.decision.value.upper()} | 综述: {rationale_brief[:200]}...",
                    "HOST"
                )
                if decision.directives:
                    for d in decision.directives:
                        self._log_to_forum(
                            f"  ↳ 任务指派给 [{d.target_agent.upper()}]: {d.question} (建议动作: {d.suggested_action})",
                            "HOST"
                        )

                # 根据决定进行状态流转
                if decision.decision == DecisionType.REVISE:
                    next_round = round_num + 1
                    target_agents = list({d.target_agent for d in decision.directives})

                    # 1. 推进任务状态与轮次到第 next_round 轮
                    self.storage.update_task_status(
                        task_id=task_id,
                        status=TaskStatus.SUPPLEMENTAL_RESEARCH,
                        current_round=next_round,
                        waiting_agents=target_agents
                    )
                    self._active_timers[task_id] = time.time()
                    logger.info(f"任务进入第 {next_round} 轮补充研究，等待执行 Agent: {target_agents}")

                    # 2. 对于无需补充研究的 Agent，自动将其上一轮成果沿用到第 next_round 轮
                    all_agents = {"query", "media", "insight"}
                    unassigned_agents = all_agents - set(target_agents)

                    for unassigned in unassigned_agents:
                        prev_sub = self.storage.get_agent_submission(task_id, unassigned, round_num)
                        if prev_sub:
                            carried_sub = AgentSubmission(
                                task_id=task_id,
                                agent_id=unassigned,
                                round=next_round,
                                submission_id=f"auto_carried_{unassigned}_{next_round}_{int(time.time())}",
                                checkpoint_path=prev_sub.checkpoint_path,
                                paragraphs=prev_sub.paragraphs,
                                evidence_list=prev_sub.evidence_list,
                                open_questions=prev_sub.open_questions,
                                carried_forward_from=round_num
                            )
                            saved, s_msg = self.storage.save_submission(carried_sub)
                            if saved:
                                logger.info(f"Agent [{unassigned}] 在第 {next_round} 轮无补充任务，成果已自动沿用第 {round_num} 轮")
                            else:
                                logger.error(f"沿用成果保存失败: {s_msg}")

                else:
                    # APPROVE 或 FINALIZE_WITH_UNRESOLVED -> 放行生成最终研报
                    self.storage.update_task_status(
                        task_id=task_id,
                        status=TaskStatus.APPROVED_FOR_REPORT,
                        waiting_agents=[]
                    )
                    self._active_timers.pop(task_id, None)
                    status_name = "全部通过" if decision.decision == DecisionType.APPROVE else "带未解决疑点放行"
                    self._log_to_forum(f"=== HOST 评审结束 ({status_name})，放行三方生成最终研究报告 ===", "HOST")

            except Exception as e:
                logger.exception(f"HOST 评审生成发生异常: {e}")
                self.pause_task(task_id, reason=f"HOST 评审模型执行异常: {str(e)}", stage=TaskStatus.HOST_REVIEWING.value)

    # ==================== Agent 查询自身指令 ====================

    def get_agent_directives(self, task_id: str, agent_id: str) -> Tuple[Optional[str], List[GuidanceItem]]:
        """
        Agent 轮询查询自己当前所属的指导任务：
        返回: (task_status, guidance_items)
        """
        task = self.storage.get_task(task_id)
        if not task:
            return None, []

        if task.status != TaskStatus.SUPPLEMENTAL_RESEARCH:
            return task.status.value, []

        # 检查是否已提交过当前轮次成果（已提交说明在等待其他人或等待 HOST）
        existing_sub = self.storage.get_agent_submission(task_id, agent_id, task.current_round)
        if existing_sub:
            return task.status.value, []

        # 如果自身不在被等待的 Agent 列表中（例如本轮无补充任务被沿用）
        if agent_id not in task.waiting_agents:
            return task.status.value, []

        directives = self.storage.get_directives_for_agent(task_id, agent_id, task.current_round - 1)
        return task.status.value, directives

    # ==================== 最终报告登记与就绪判断 ====================

    def register_final_report(self, task_id: str, agent_id: str, report_path: str) -> bool:
        """登记最终报告"""
        ok = self.storage.register_report(task_id, agent_id, report_path)
        if ok:
            self._log_to_forum(f"[{agent_id.upper()}] 已登记最终研究报告: {report_path}", agent_id.upper())
            task = self.storage.get_task(task_id)
            if task and task.status == TaskStatus.FINAL_REPORTS_READY:
                self._log_to_forum("=== 三方最终报告已全部就绪，ReportEngine 可开始综合装订 ===", "SYSTEM")
        return ok

    def are_reports_ready_for_report_engine(self, task_id: str) -> Tuple[bool, Dict[str, str]]:
        """
        供 ReportEngine 严格核验本任务是否已达到汇总结算条件：
        必须满足：任务存在、三方报告均已登记且文件在磁盘可读
        """
        task = self.storage.get_task(task_id)
        if not task or task.status != TaskStatus.FINAL_REPORTS_READY:
            return False, {}

        reports = self.storage.get_registered_reports(task_id)
        required = {"query", "media", "insight"}
        if set(reports.keys()) != required:
            return False, {}

        # 检查磁盘文件可读性
        for agent_id, r_path in reports.items():
            p = Path(r_path)
            if not p.exists() or p.stat().st_size == 0:
                logger.warning(f"登记的报告文件不存在或为空: {r_path}")
                return False, {}

        return True, reports

    # ==================== 辅助方法 ====================

    def _log_to_forum(self, message: str, source: str = "SYSTEM"):
        """将重要协作事件写入 forum.log 保证前端控制台实时展示"""
        try:
            log_dir = Path("logs")
            log_dir.mkdir(exist_ok=True)
            forum_log_file = log_dir / "forum.log"
            timestamp = datetime.now().strftime("%H:%M:%S")
            # 将多行换行转义，保持日志行结构稳定
            escaped_msg = message.replace('\r', '').replace('\n', '\\n')
            with open(forum_log_file, "a", encoding="utf-8") as f:
                f.write(f"[{timestamp}] [{source}] {escaped_msg}\n")
        except Exception as e:
            logger.error(f"写入 forum.log 失败: {e}")


# 全局单例协调器
_coordinator = None

def get_coordinator() -> ForumReviewCoordinator:
    global _coordinator
    if _coordinator is None:
        _coordinator = ForumReviewCoordinator()
    return _coordinator
