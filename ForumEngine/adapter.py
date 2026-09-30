# -*- coding: utf-8 -*-
"""
论坛阶段评审 Agent 适配器与状态桥接器（ForumAgentAdapter）
负责：
1. 将各个 Agent 内部的 state.paragraphs 与搜索历史转换为合规的 AgentSubmission；
2. 执行定向 HOST Directives（动作下发、补充检索、段落增量修订与回复生成）；
3. 管理任务隔离目录下的检查点持久化（logs/checkpoints/{task_id}/{agent_id}_r{round}.json）。
"""

import os
import json
import re
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional, Tuple
from loguru import logger

from .schema import (
    AgentSubmission,
    ParagraphSubmission,
    EvidenceItem,
    GuidanceItem,
    GuidanceResponse,
    HostDecision,
    TaskStatus,
)


CHECKPOINT_BASE_DIR = Path("logs") / "checkpoints"


class ForumAgentAdapter:
    """Agent 状态与协作契约的桥接转换器"""

    @staticmethod
    def get_checkpoint_path(task_id: str, agent_id: str, round_num: int) -> Path:
        p = CHECKPOINT_BASE_DIR / task_id
        p.mkdir(parents=True, exist_ok=True)
        return p / f"{agent_id}_round{round_num}.json"

    @staticmethod
    def save_checkpoint(agent_instance: Any, task_id: str, agent_id: str, round_num: int) -> str:
        """原子保存当前 Agent 的完整研究状态快照"""
        chk_path = ForumAgentAdapter.get_checkpoint_path(task_id, agent_id, round_num)
        data = {
            "task_id": task_id,
            "agent_id": agent_id,
            "round": round_num,
            "timestamp": datetime.now().isoformat(),
            "state": agent_instance.state.to_dict()
        }
        temp_path = chk_path.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        temp_path.replace(chk_path)
        logger.info(f"Agent [{agent_id}] 检查点已保存: {chk_path}")
        return str(chk_path)

    @staticmethod
    def build_submission(
        agent_instance: Any,
        task_id: str,
        agent_id: str,
        round_num: int,
        checkpoint_path: Optional[str] = None,
        guidance_responses: Optional[List[GuidanceResponse]] = None
    ) -> AgentSubmission:
        """从 Agent 的当前 state 组装标准的 AgentSubmission"""
        paragraphs_sub = []
        evidence_map: Dict[str, EvidenceItem] = {}
        source_type = "webpage" if agent_id == "query" else ("media_card" if agent_id == "media" else "db_record")

        for idx, p in enumerate(agent_instance.state.paragraphs, 1):
            p_id = f"P{idx}"
            summary_text = getattr(p.research, "latest_summary", "") or getattr(p, "content", "")
            
            # 提取关键论点（按句号/顿号或标号切分前几条主张）
            claims = []
            raw_lines = [line.strip().lstrip("*-0123456789. ") for line in summary_text.splitlines() if line.strip()]
            claims = [line[:80] for line in raw_lines[:3]]
            if not claims and summary_text:
                claims = [summary_text[:80]]

            # 收集该段落的证据
            p_ev_ids = []
            for s_idx, s in enumerate(getattr(p.research, "search_history", []), 1):
                ev_id = f"E_{agent_id}_{idx}_{s_idx}"
                p_ev_ids.append(ev_id)
                if ev_id not in evidence_map:
                    # 区分检索时间与来源日期
                    retrieval_t = getattr(s, "timestamp", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
                    source_d = getattr(s, "published_date", None)
                    s_url = getattr(s, "url", "") or f"query://{getattr(s, 'query', '')}"
                    evidence_map[ev_id] = EvidenceItem(
                        evidence_id=ev_id,
                        source_type=source_type,
                        source_ref=s_url,
                        title=getattr(s, "title", "") or getattr(s, "query", f"证据 {ev_id}"),
                        excerpt=getattr(s, "content", "")[:400] if getattr(s, "content", "") else "无文字摘录",
                        retrieval_time=retrieval_t,
                        source_date=source_d
                    )

            paragraphs_sub.append(ParagraphSubmission(
                paragraph_id=p_id,
                title=getattr(p, "title", f"段落 {idx}"),
                summary=summary_text,
                key_claims=claims,
                evidence_ids=p_ev_ids
            ))

        return AgentSubmission(
            task_id=task_id,
            agent_id=agent_id,
            round=round_num,
            submission_id=f"sub_{agent_id}_r{round_num}_{int(datetime.now().timestamp())}",
            checkpoint_path=checkpoint_path,
            paragraphs=paragraphs_sub,
            evidence_list=list(evidence_map.values()),
            open_questions=[],
            guidance_responses=guidance_responses or []
        )

    @staticmethod
    def execute_directives(
        agent_instance: Any,
        directives: List[GuidanceItem],
        agent_id: str,
        round_num: int
    ) -> Tuple[List[GuidanceResponse], List[str]]:
        """
        针对发给自身的 HOST 指令，真正调用专属搜索工具进行核实，
        并将新证据追加回段落并生成回复
        """
        responses = []
        modified_paragraphs = []

        for d in directives:
            logger.info(f"[{agent_id.upper()}] 正在执行 HOST 补充指令 [{d.guidance_id}]: {d.question}")
            action_desc = d.suggested_action or d.question
            new_evidence = []
            result_summary = ""
            unresolved = None

            # 1. 提取或生成具体的检索 query
            search_query = action_desc
            # 过滤掉指令中的描述性文字，提取关键词
            m = re.search(r'["“](.+?)["”]', action_desc)
            if m:
                search_query = m.group(1)

            # 2. 调用该 Agent 的原生工具执行检索
            try:
                if agent_id == "query":
                    tool_resp = agent_instance.execute_search_tool("basic_search_news", search_query)
                    webpages = getattr(tool_resp, "webpages", [])
                    for i, w in enumerate(webpages[:3], 1):
                        ev = EvidenceItem(
                            evidence_id=f"E_sup_{agent_id}_{round_num}_{d.guidance_id}_{i}",
                            source_type="webpage",
                            source_ref=w.url,
                            title=w.name,
                            excerpt=w.snippet[:300],
                            retrieval_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            source_date=w.date_last_crawled
                        )
                        new_evidence.append(ev)
                    result_summary = f"通过公网补充检索《{search_query}》，获取到 {len(new_evidence)} 条事实佐证。"

                elif agent_id == "media":
                    tool_resp = agent_instance.execute_search_tool("comprehensive_search", search_query)
                    webpages = getattr(tool_resp, "webpages", [])
                    for i, w in enumerate(webpages[:3], 1):
                        ev = EvidenceItem(
                            evidence_id=f"E_sup_{agent_id}_{round_num}_{d.guidance_id}_{i}",
                            source_type="media_card",
                            source_ref=w.url,
                            title=w.name,
                            excerpt=w.snippet[:300],
                            retrieval_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            source_date=w.date_last_crawled
                        )
                        new_evidence.append(ev)
                    result_summary = f"通过多模态社媒检索《{search_query}》，获取到 {len(new_evidence)} 条动态。"

                elif agent_id == "insight":
                    tool_resp = agent_instance.execute_search_tool("search_topic_globally", search_query)
                    results = getattr(tool_resp, "results", [])
                    for i, r in enumerate(results[:3], 1):
                        ev = EvidenceItem(
                            evidence_id=f"E_sup_{agent_id}_{round_num}_{d.guidance_id}_{i}",
                            source_type="db_record",
                            source_ref=getattr(r, "url", f"db://{getattr(r, 'platform', 'comment')}"),
                            title=f"评论数据: {getattr(r, 'title_or_content', '')[:30]}",
                            excerpt=getattr(r, "title_or_content", "")[:300],
                            retrieval_time=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            source_date=str(getattr(r, "publish_time", "")) if getattr(r, "publish_time", None) else None
                        )
                        new_evidence.append(ev)
                    result_summary = f"下钻本地舆情数据库《{search_query}》，检索到 {len(new_evidence)} 条相关网民互动记录。"

                if not new_evidence:
                    unresolved = "经定向检索，未在相关信息源中发现更多公开确凿依据。"
                    result_summary = f"已核查《{search_query}》，未发现直接佐证。"

            except Exception as e:
                logger.error(f"执行补充检索失败: {e}")
                unresolved = f"检索执行异常: {str(e)}"
                result_summary = "执行核查发生异常，未能获取有效补充证据。"

            # 3. 将新发现追加至匹配段落的总结末尾
            target_p = None
            for p in agent_instance.state.paragraphs:
                if d.related_paragraph_or_claim in p.title or p.title in d.related_paragraph_or_claim:
                    target_p = p
                    break
            if not target_p and agent_instance.state.paragraphs:
                target_p = agent_instance.state.paragraphs[0]

            if target_p:
                sup_text = f"\n\n【针对 HOST 问询 [{d.guidance_id}] 的核查补充】: {result_summary}"
                target_p.research.latest_summary = (getattr(target_p.research, "latest_summary", "") + sup_text).strip()
                modified_paragraphs.append(target_p.title)

            responses.append(GuidanceResponse(
                guidance_id=d.guidance_id,
                actions_taken=f"调用工具执行核查检索: {search_query}",
                new_evidence=new_evidence,
                modified_paragraphs=list(set(modified_paragraphs)),
                result_summary=result_summary,
                unresolved_reason=unresolved
            ))

        return responses, list(set(modified_paragraphs))

    @staticmethod
    def collaborate_and_review(
        agent_instance: Any,
        task_id: str,
        agent_id: str,
        client: Optional[Any] = None,
        status_callback: Optional[Any] = None
    ) -> Optional[HostDecision]:
        """
        阶段评审协作主循环：
        1. 保存第 1 轮初始研究检查点并提交成果，进入同步屏障
        2. 短轮询等待 HOST 会商决定
        3. 若需补充研究（round=2/3），执行派单任务、更新段落、重新提交
        4. 获批放行（APPROVED_FOR_REPORT）后退出循环，继续生成最终报告
        """
        import time
        from .client import ForumReviewClient

        collab_client = client or ForumReviewClient()
        round_num = 1
        last_guidance_responses: List[GuidanceResponse] = []
        final_decision: Optional[HostDecision] = None

        def notify(msg: str):
            logger.info(f"[{agent_id.upper()}] {msg}")
            if status_callback and callable(status_callback):
                try:
                    status_callback(msg)
                except Exception:
                    pass

        while True:
            notify(f"正在保存第 {round_num} 轮检查点并向协调器提交成果...")
            chk_path = ForumAgentAdapter.save_checkpoint(agent_instance, task_id, agent_id, round_num)
            submission = ForumAgentAdapter.build_submission(
                agent_instance=agent_instance,
                task_id=task_id,
                agent_id=agent_id,
                round_num=round_num,
                checkpoint_path=chk_path,
                guidance_responses=last_guidance_responses
            )

            ok, msg = collab_client.submit_stage_result(
                task_id=task_id,
                agent_id=agent_id,
                round_num=round_num,
                paragraphs=submission.paragraphs,
                evidence_list=submission.evidence_list,
                open_questions=submission.open_questions,
                guidance_responses=submission.guidance_responses,
                checkpoint_path=chk_path,
                submission_id=submission.submission_id
            )
            if not ok:
                raise RuntimeError(f"提交阶段成果失败: {msg}")

            notify(f"第 {round_num} 轮成果已提交，等待三方同步屏障及 HOST 会商评审...")
            status, directives, decision = collab_client.poll_for_decision(task_id, agent_id)
            final_decision = decision

            if status in [TaskStatus.APPROVED_FOR_REPORT.value, TaskStatus.FINAL_REPORTS_READY.value]:
                dec_type = decision.decision.value if decision else "approved"
                notify(f"HOST 评审已放行（{dec_type}），开始进入最终报告撰写阶段")
                break

            elif status == TaskStatus.SUPPLEMENTAL_RESEARCH.value:
                if directives:
                    notify(f"收到 HOST 第 {round_num} 轮核查指令 ({len(directives)} 条)，开始执行针对性补充检索...")
                    responses, modified = ForumAgentAdapter.execute_directives(
                        agent_instance=agent_instance,
                        directives=directives,
                        agent_id=agent_id,
                        round_num=round_num
                    )
                    last_guidance_responses = responses
                    round_num += 1
                else:
                    time.sleep(2)
            else:
                notify(f"收到协作状态: {status}，退出协作循环")
                break

        return final_decision

