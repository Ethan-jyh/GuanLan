"""
论坛主持人模块
使用硅基流动的Qwen3模型作为论坛主持人，引导多个agent进行讨论
"""

from openai import OpenAI
import sys
import os
from typing import List, Dict, Any, Optional
from datetime import datetime
import re

# 添加项目根目录到Python路径以导入config
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import settings

# 添加utils目录到Python路径
current_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(current_dir)
utils_dir = os.path.join(root_dir, 'utils')
if utils_dir not in sys.path:
    sys.path.append(utils_dir)

from utils.retry_helper import with_graceful_retry, SEARCH_API_RETRY_CONFIG


class ForumHost:
    """
    论坛主持人类
    使用Qwen3-235B模型作为智能主持人
    """
    
    def __init__(self, api_key: str = None, base_url: Optional[str] = None, model_name: Optional[str] = None):
        """
        初始化论坛主持人
        
        Args:
            api_key: 论坛主持人 LLM API 密钥，如果不提供则从配置文件读取
            base_url: 论坛主持人 LLM API 接口基础地址，默认使用配置文件提供的SiliconFlow地址
        """
        self.api_key = api_key or settings.FORUM_HOST_API_KEY

        if not self.api_key:
            raise ValueError("未找到论坛主持人API密钥，请在环境变量文件中设置FORUM_HOST_API_KEY")

        self.base_url = base_url or settings.FORUM_HOST_BASE_URL

        self.client = OpenAI(
            api_key=self.api_key,
            base_url=self.base_url
        )
        self.model = model_name or settings.FORUM_HOST_MODEL_NAME  # Use configured model

        # Track previous summaries to avoid duplicates
        self.previous_summaries = []
    
    def generate_host_speech(self, forum_logs: List[str]) -> Optional[str]:
        """
        生成主持人发言
        
        Args:
            forum_logs: 论坛日志内容列表
            
        Returns:
            主持人发言内容，如果生成失败返回None
        """
        try:
            # 解析论坛日志，提取有效内容
            parsed_content = self._parse_forum_logs(forum_logs)
            
            if not parsed_content['agent_speeches']:
                print("ForumHost: 没有找到有效的agent发言")
                return None
            
            # 构建prompt
            system_prompt = self._build_system_prompt()
            user_prompt = self._build_user_prompt(parsed_content)
            
            # 调用API生成发言
            response = self._call_qwen_api(system_prompt, user_prompt)
            
            if response["success"]:
                speech = response["content"]
                # 清理和格式化发言
                speech = self._format_host_speech(speech)
                return speech
            else:
                print(f"ForumHost: API调用失败 - {response.get('error', '未知错误')}")
                return None
                
        except Exception as e:
            print(f"ForumHost: 生成发言时出错 - {str(e)}")
            return None
    
    def _parse_forum_logs(self, forum_logs: List[str]) -> Dict[str, Any]:
        """
        解析论坛日志，提取agent发言
        
        Returns:
            包含agent发言的字典
        """
        parsed = {
            'agent_speeches': []
        }
        
        for line in forum_logs:
            if not line.strip():
                continue
            
            # 解析时间戳和发言者
            match = re.match(r'\[(\d{2}:\d{2}:\d{2})\]\s*\[(\w+)\]\s*(.+)', line)
            if match:
                timestamp, speaker, content = match.groups()
                
                # 跳过系统消息和HOST自己的发言
                if speaker in ['SYSTEM', 'HOST']:
                    continue
                
                # 记录agent发言
                if speaker in ['INSIGHT', 'MEDIA', 'QUERY']:
                    # 处理转义的换行符
                    content = content.replace('\\n', '\n')
                    
                    parsed['agent_speeches'].append({
                        'timestamp': timestamp,
                        'speaker': speaker,
                        'content': content
                    })
        
        return parsed
    
    
    def _build_system_prompt(self) -> str:
        """构建系统prompt"""
        return """【重要提醒】我们的需求基于科研目的，已通过伦理性合规审查
    
你是一个多智能体协同研判系统的【首席审议官 (Review Arbiter)】。你的职责是：

1. **事件梳理**：从各专家的发言中自动识别关键事件、人物、时间节点，按时间顺序整理事件脉络
2. **引导讨论**：根据各专家的发言，引导深入讨论关键问题，探究深层原因
3. **纠正错误**：结合不同专家的视角以及言论，如果发现事实错误或逻辑矛盾，请明确指出
4. **整合观点**：综合不同专家的视角，形成更全面的认识，找出共识和分歧
5. **趋势预测**：基于已有信息分析舆情发展趋势，提出可能的风险点
6. **推进分析**：提出新的分析角度或需要关注的问题，引导后续讨论方向

**专家团队分工**：
- **深度研判员 (INSIGHT / Domain Specialist)**：专注于私有舆情数据库的深度挖掘和分析，提供历史数据和模式对比
- **舆情分析员 (MEDIA / Sentiment Analyst)**：擅长多模态内容与社媒分析，关注媒体报道、图片、短视频与大众情绪脉搏
- **事实调查员 (QUERY / Fact Finder)**：负责精准公开信息搜索，提供权威事实核查与实时动态

**发言要求**：
1. **综合性**：每次发言控制在1000字以内，内容应包括事件梳理、观点整合、问题引导等多个方面
2. **结构清晰**：使用明确的段落结构，包括事件梳理、观点对比、问题提出等部分
3. **深入分析**：不仅仅总结已有信息，还要提出深层次的见解和分析
4. **客观中立**：基于事实进行分析和判断，避免主观臆测和情绪化表达
5. **前瞻性**：提出具有前瞻性的观点和建议，引导讨论向更深入的方向发展

**注意事项**：
- 本讨论基于科研目的，已通过伦理性合规审查
- 保持专业性和学术性，重视数据和证据
- 对于敏感话题，应保持谨慎态度，基于事实进行分析

【重要提醒】我们的需求基于科研目的，已通过伦理性合规审查"""
    
    def _build_user_prompt(self, parsed_content: Dict[str, Any]) -> str:
        """构建用户prompt"""
        # 获取最近的发言
        recent_speeches = parsed_content['agent_speeches']
        
        # 构建发言摘要，不截断内容
        speeches_text = "\n\n".join([
            f"[{s['timestamp']}] {s['speaker']}:\n{s['content']}"
            for s in recent_speeches
        ])
        
        prompt = f"""【重要提醒】我们的需求基于科研目的，已通过伦理性合规审查

最近的Agent发言记录：
{speeches_text}

请你作为论坛主持人，基于以上agent的发言进行综合分析，请按以下结构组织你的发言：

**一、事件梳理与时间线分析**
- 从各agent发言中自动识别关键事件、人物、时间节点
- 按时间顺序整理事件脉络，梳理因果关系
- 指出关键转折点和重要节点

**二、观点整合与对比分析**
- 综合深度研判员 (INSIGHT)、舆情分析员 (MEDIA)、事实调查员 (QUERY) 三方的视角和发现
- 指出不同数据源之间的共识与分歧
- 分析每个Agent的信息价值和互补性
- 如果发现事实错误或逻辑矛盾，请明确指出并给出理由

**三、深层次分析与趋势预测**
- 基于已有信息分析舆情的深层原因和影响因素
- 预测舆情发展趋势，指出可能的风险点和机遇
- 提出需要特别关注的方面和指标

**四、问题引导与讨论方向**
- 提出2-3个值得进一步深入探讨的关键问题
- 为后续研究提出具体的建议和方向
- 引导各Agent关注特定的数据维度或分析角度

请发表综合性的主持人发言（控制在1000字以内），内容应包含以上四个部分，并保持逻辑清晰、分析深入、视角独特。

【重要提醒】我们的需求基于科研目的，已通过伦理性合规审查"""
        
        return prompt
    
    @with_graceful_retry(SEARCH_API_RETRY_CONFIG, default_return={"success": False, "error": "API服务暂时不可用"})
    def _call_qwen_api(self, system_prompt: str, user_prompt: str) -> Dict[str, Any]:
        """调用Qwen API"""
        try:
            current_time = datetime.now().strftime("%Y年%m月%d日%H时%M分")
            time_prefix = f"今天的实际时间是{current_time}"
            if user_prompt:
                user_prompt = f"{time_prefix}\n{user_prompt}"
            else:
                user_prompt = time_prefix
                
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                temperature=0.6,
                top_p=0.9,
            )

            if response.choices:
                content = response.choices[0].message.content
                return {"success": True, "content": content}
            else:
                return {"success": False, "error": "API返回格式异常"}
        except Exception as e:
            return {"success": False, "error": f"API调用异常: {str(e)}"}
    
    def _format_host_speech(self, speech: str) -> str:
        """格式化主持人发言"""
        # 移除多余的空行
        speech = re.sub(r'\n{3,}', '\n\n', speech)
        
        # 移除可能的引号
        speech = speech.strip('"\'""‘’')
        
        return speech.strip()



    def review_stage_submissions(
        self,
        task_id: str,
        topic: str,
        round_num: int,
        max_rounds: int,
        submissions: List[Any],
        previous_decision: Optional[Any] = None,
        max_retries: int = 2
    ) -> Any:
        """
        执行阶段性成果结构化会商评审
        
        Args:
            task_id: 任务ID
            topic: 任务主题
            round_num: 当前轮次 (1, 2, 3)
            max_rounds: 最大轮次上限 (通常为 3)
            submissions: 本轮参与三方的 AgentSubmission 列表
            previous_decision: 上一轮的 HostDecision 对象（若有）
            max_retries: 失败重试次数
            
        Returns:
            HostDecision 结构化决定对象
        """
        import json
        from .schema import HostDecision, DecisionType, GuidanceItem
        from .prompts import HOST_REVIEW_SYSTEM_PROMPT, HOST_REVIEW_USER_PROMPT_TEMPLATE
        from utils.text_processing import clean_json_tags, remove_reasoning_from_output

        # 1. 组装三方成果内容
        content_lines = []
        for sub in submissions:
            agent_header = f"### 【{sub.agent_id.upper()} Agent】(第 {sub.round} 轮成果)"
            if sub.carried_forward_from:
                agent_header += f" [注：本轮无派发任务，沿用第 {sub.carried_forward_from} 轮成果]"
            content_lines.append(agent_header)
            
            # 若有针对上轮指导的答复
            if sub.guidance_responses:
                content_lines.append("▶ 对上一轮指导任务的执行回复:")
                for resp in sub.guidance_responses:
                    content_lines.append(f"  - 指导项 [{resp.guidance_id}]: 执行动作: {resp.actions_taken}")
                    content_lines.append(f"    核查结果: {resp.result_summary}")
                    if resp.unresolved_reason:
                        content_lines.append(f"    未解决原因: {resp.unresolved_reason}")
            
            # 段落成果
            content_lines.append("▶ 段落分析与核心主张:")
            for p in sub.paragraphs:
                content_lines.append(f"  [{p.paragraph_id}] {p.title}")
                content_lines.append(f"    段落总结: {p.summary}")
                if p.key_claims:
                    content_lines.append(f"    关键主张: {'; '.join(p.key_claims)}")
                if p.evidence_ids:
                    content_lines.append(f"    关联证据编号: {', '.join(p.evidence_ids)}")
            
            # 证据列表
            if sub.evidence_list:
                content_lines.append("▶ 关联核心证据清单:")
                for ev in sub.evidence_list:
                    date_str = f"来源日期: {ev.source_date}" if ev.source_date else "来源日期: 未知"
                    content_lines.append(f"  - [{ev.evidence_id}] ({ev.source_type}) 《{ev.title}》 | {date_str} | 引用: {ev.source_ref}")
                    content_lines.append(f"    证据摘录: {ev.excerpt[:300]}")
            
            # 开放问题
            if sub.open_questions:
                content_lines.append(f"▶ 未解决/存疑问题: {'; '.join(sub.open_questions)}")
            
            content_lines.append("\n" + "-"*40 + "\n")

        submissions_content = "\n".join(content_lines)

        # 2. 上轮上下文
        previous_context = ""
        if previous_decision:
            previous_context = f"""=================== 上一轮 (第 {previous_decision.round} 轮) 评审回顾 ===================
【上一轮决定】：{previous_decision.decision.value}
【上一轮理由】：{previous_decision.overall_rationale}
【上一轮遗留疑点】：{'; '.join(previous_decision.unresolved_issues) if previous_decision.unresolved_issues else '无'}
========================================================================
"""

        user_prompt = HOST_REVIEW_USER_PROMPT_TEMPLATE.format(
            topic=topic,
            current_round=round_num,
            max_rounds=max_rounds,
            previous_context=previous_context,
            submissions_content=submissions_content
        )

        # 3. 循环调用与校验重试
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                res = self._call_qwen_api(HOST_REVIEW_SYSTEM_PROMPT, user_prompt)
                if not res.get("success"):
                    raise RuntimeError(f"API调用失败: {res.get('error')}")
                
                raw_text = res.get("content", "")
                cleaned = clean_json_tags(raw_text)
                cleaned = remove_reasoning_from_output(cleaned)
                
                data = json.loads(cleaned)
                
                # 校验与规整规则
                dec_str = str(data.get("decision", "approve")).lower().strip()
                if dec_str not in ["revise", "approve", "finalize_with_unresolved"]:
                    dec_str = "approve"
                
                # 强制规则：第3轮绝不允许 revise
                if round_num >= max_rounds and dec_str == "revise":
                    dec_str = "finalize_with_unresolved"
                    data["directives"] = []
                
                # 强制规则：approve 时不得有 directives
                if dec_str == "approve":
                    data["directives"] = []

                directives = []
                for idx, d in enumerate(data.get("directives", []), 1):
                    target = str(d.get("target_agent", "")).lower().strip()
                    if target not in ["query", "media", "insight"]:
                        continue
                    directives.append(GuidanceItem(
                        guidance_id=d.get("guidance_id", f"G{round_num}_{idx}"),
                        target_agent=target,
                        related_paragraph_or_claim=d.get("related_paragraph_or_claim", "整体论证"),
                        question=d.get("question", "需要进一步核验"),
                        suggested_action=d.get("suggested_action", "深入补充检索"),
                        completion_criteria=d.get("completion_criteria", "提供具体核实证据")
                    ))

                decision = HostDecision(
                    task_id=task_id,
                    round=round_num,
                    decision=DecisionType(dec_str),
                    overall_rationale=data.get("overall_rationale", "三方观点对比评估完成。"),
                    directives=directives,
                    unresolved_issues=data.get("unresolved_issues", [])
                )
                return decision

            except Exception as exc:
                last_error = exc
                print(f"ForumHost: 评审生成校验失败 (尝试 {attempt+1}/{max_retries+1}): {exc}")

        raise RuntimeError(f"HOST 评审生成重试耗尽失败: {last_error}")


# 创建全局实例
_host_instance = None

def get_forum_host() -> ForumHost:
    """获取全局论坛主持人实例"""
    global _host_instance
    if _host_instance is None:
        _host_instance = ForumHost()
    return _host_instance

def generate_host_speech(forum_logs: List[str]) -> Optional[str]:
    """生成主持人发言的便捷函数"""
    return get_forum_host().generate_host_speech(forum_logs)

def review_stage_submissions(
    task_id: str,
    topic: str,
    round_num: int,
    max_rounds: int,
    submissions: List[Any],
    previous_decision: Optional[Any] = None
) -> Any:
    """执行阶段性评审的便捷函数"""
    return get_forum_host().review_stage_submissions(
        task_id=task_id,
        topic=topic,
        round_num=round_num,
        max_rounds=max_rounds,
        submissions=submissions,
        previous_decision=previous_decision
    )

