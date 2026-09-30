# -*- coding: utf-8 -*-
"""
论坛阶段评审 Flask HTTP API 路由
为 Streamlit 子进程和前端提供任务创建、阶段提交、指令轮询、断点恢复与最终报告登记接口
"""

import uuid
from flask import Blueprint, request, jsonify
from loguru import logger

from .schema import AgentSubmission
from .coordinator import get_coordinator


forum_review_bp = Blueprint("forum_review", __name__)


@forum_review_bp.route("/tasks", methods=["POST"])
def create_task():
    """创建新的协作评审任务"""
    data = request.get_json() or {}
    topic = data.get("topic", "").strip()
    if not topic:
        return jsonify({"success": False, "error": "缺少主题 topic"}), 400

    task_id = data.get("task_id") or f"task_{uuid.uuid4().hex[:12]}"
    max_rounds = int(data.get("max_rounds", 3))

    try:
        coordinator = get_coordinator()
        task_state = coordinator.start_task(task_id=task_id, topic=topic, max_rounds=max_rounds)
        return jsonify({"success": True, "task": task_state.model_dump()})
    except ValueError as ve:
        return jsonify({"success": False, "error": str(ve)}), 409
    except Exception as e:
        logger.exception(f"创建协作任务失败: {e}")
        return jsonify({"success": False, "error": str(e)}), 500


@forum_review_bp.route("/tasks/active", methods=["GET"])
def get_active_task():
    """获取当前正在活跃的任务"""
    coordinator = get_coordinator()
    active = coordinator.storage.get_active_task()
    if active:
        # 检测超时
        state = coordinator.get_task_state(active.task_id)
        return jsonify({"success": True, "task": state.model_dump() if state else None})
    return jsonify({"success": True, "task": None})


@forum_review_bp.route("/tasks/<task_id>", methods=["GET"])
def get_task(task_id):
    """查询指定任务状态、当前轮次及等待成员"""
    coordinator = get_coordinator()
    task = coordinator.get_task_state(task_id)
    if not task:
        return jsonify({"success": False, "error": f"任务 {task_id} 不存在"}), 404
    return jsonify({"success": True, "task": task.model_dump()})


@forum_review_bp.route("/tasks/<task_id>/submissions", methods=["POST"])
def submit_stage_result(task_id):
    """Agent 提交当前轮次的阶段成果"""
    data = request.get_json() or {}
    data["task_id"] = task_id

    try:
        submission = AgentSubmission.model_validate(data)
        coordinator = get_coordinator()
        ok, msg = coordinator.submit_agent_result(submission)
        if ok:
            return jsonify({"success": True, "message": msg})
        else:
            return jsonify({"success": False, "error": msg}), 400
    except Exception as e:
        logger.exception(f"提交阶段成果解析失败: {e}")
        return jsonify({"success": False, "error": f"数据格式错误: {str(e)}"}), 400


@forum_review_bp.route("/tasks/<task_id>/agents/<agent_id>/decision", methods=["GET"])
def get_agent_decision(task_id, agent_id):
    """Agent 轮询查询自己当前所属的指导与任务状态"""
    coordinator = get_coordinator()
    task = coordinator.get_task_state(task_id)
    if not task:
        return jsonify({"success": False, "error": f"任务 {task_id} 不存在"}), 404

    status_val, directives = coordinator.get_agent_directives(task_id, agent_id)
    latest_decision = coordinator.storage.get_latest_host_decision(task_id)

    return jsonify({
        "success": True,
        "task_status": status_val,
        "current_round": task.current_round,
        "directives": [d.model_dump() for d in directives],
        "latest_decision": latest_decision.model_dump() if latest_decision else None,
        "paused_reason": task.paused_reason
    })


@forum_review_bp.route("/tasks/<task_id>/resume", methods=["POST"])
def resume_task(task_id):
    """恢复暂停的任务"""
    coordinator = get_coordinator()
    ok = coordinator.resume_task(task_id)
    return jsonify({"success": ok, "message": "任务已恢复" if ok else "无法恢复任务"})


@forum_review_bp.route("/tasks/<task_id>/cancel", methods=["POST"])
def cancel_task(task_id):
    """取消当前任务"""
    coordinator = get_coordinator()
    ok = coordinator.cancel_task(task_id)
    return jsonify({"success": ok, "message": "任务已取消" if ok else "无法取消任务"})


@forum_review_bp.route("/tasks/<task_id>/reports", methods=["POST"])
def register_final_report(task_id):
    """Agent 登记最终生成的 Markdown 研究报告"""
    data = request.get_json() or {}
    agent_id = data.get("agent_id")
    report_path = data.get("report_path")

    if not agent_id or not report_path:
        return jsonify({"success": False, "error": "缺少 agent_id 或 report_path"}), 400

    coordinator = get_coordinator()
    ok = coordinator.register_final_report(task_id, agent_id, report_path)
    return jsonify({"success": ok, "message": "报告登记成功" if ok else "报告登记失败"})
