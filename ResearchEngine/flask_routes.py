# -*- coding: utf-8 -*-
"""
ResearchEngine REST API 路由 (flask_routes)
提供多智能体协同研究任务生命周期全流程接口：
- 创建运行 (POST /api/research/runs)
- 查询运行与子任务状态 (GET /api/research/runs/<run_id>)
- 暂停、恢复与取消 (POST /api/research/runs/<run_id>/[pause|resume|cancel])
- 有序事件拉取 (GET /api/research/runs/<run_id>/events)
"""

from typing import Optional
from flask import Blueprint, request, jsonify

from .storage import ResearchStorage
from .coordinator import ResearchCoordinator
from .events import EventManager
from .recovery import RecoveryManager
from .budget import BudgetManager


def create_research_blueprint(
    storage: Optional[ResearchStorage] = None,
    coordinator: Optional[ResearchCoordinator] = None,
    event_mgr: Optional[EventManager] = None,
    recovery_mgr: Optional[RecoveryManager] = None,
    budget_mgr: Optional[BudgetManager] = None,
) -> Blueprint:
    """创建并配置 ResearchEngine 的 Flask 蓝图"""
    bp = Blueprint("research_engine", __name__)

    # 默认单例配置
    _storage = storage or ResearchStorage()
    _budget_mgr = budget_mgr or BudgetManager(_storage)
    _coordinator = coordinator
    _event_mgr = event_mgr or EventManager(_storage)
    _recovery_mgr = recovery_mgr

    @bp.route("/runs", methods=["POST"])
    def create_run():
        nonlocal _coordinator
        data = request.get_json(silent=True) or {}
        topic = data.get("topic", "").strip()
        if not topic:
            return jsonify({"ok": False, "error": "Missing required field 'topic'"}), 400

        scope = data.get("scope", {})
        budget_total = int(data.get("budget_total", 50))

        if not _coordinator:
            from .submissions import SubmissionManager
            from .evidence import EvidenceStore
            ev_store = EvidenceStore(_storage.db_path)
            sub_mgr = SubmissionManager(_storage, ev_store)
            _coordinator = ResearchCoordinator(_storage, sub_mgr, _budget_mgr)

        run = _coordinator.create_run(
            topic=topic,
            scope=scope,
            budget_total=budget_total,
        )

        _event_mgr.publish_event(
            run.run_id,
            "RUN_CREATED",
            {"run_id": run.run_id, "topic": run.topic, "budget_total": run.budget_total},
        )

        return jsonify({"ok": True, "run": run.model_dump()}), 201

    @bp.route("/runs/<run_id>", methods=["GET"])
    def get_run(run_id: str):
        if not _coordinator:
            return jsonify({"ok": False, "error": "Coordinator not initialized"}), 500

        run = _coordinator.get_run(run_id)
        if not run:
            return jsonify({"ok": False, "error": f"Run '{run_id}' not found"}), 404

        tasks = _coordinator.get_tasks_for_round(run_id, run.current_round)
        usage = _budget_mgr.get_usage(run_id)

        return jsonify({
            "ok": True,
            "run": run.model_dump(),
            "tasks": [t.model_dump() for t in tasks],
            "budget": usage,
        }), 200

    @bp.route("/runs/<run_id>/pause", methods=["POST"])
    def pause_run(run_id: str):
        if not _coordinator:
            return jsonify({"ok": False, "error": "Coordinator not initialized"}), 500

        _coordinator.pause_run(run_id, reason="User requested pause")
        run = _coordinator.get_run(run_id)
        if not run:
            return jsonify({"ok": False, "error": "Run not found"}), 404

        _event_mgr.publish_event(run_id, "RUN_PAUSED", {"run_id": run_id})
        return jsonify({"ok": True, "run": run.model_dump()}), 200

    @bp.route("/runs/<run_id>/resume", methods=["POST"])
    def resume_run(run_id: str):
        nonlocal _recovery_mgr
        if not _recovery_mgr:
            _recovery_mgr = RecoveryManager(_storage, _coordinator)

        try:
            run = _recovery_mgr.resume_run(run_id)
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400

        _event_mgr.publish_event(
            run_id,
            "RUN_RESUMED",
            {"run_id": run_id, "execution_version": run.execution_version},
        )
        return jsonify({"ok": True, "run": run.model_dump()}), 200

    @bp.route("/runs/<run_id>/cancel", methods=["POST"])
    def cancel_run(run_id: str):
        nonlocal _recovery_mgr
        if not _recovery_mgr:
            _recovery_mgr = RecoveryManager(_storage, _coordinator)

        try:
            run = _recovery_mgr.cancel_run(run_id)
        except ValueError as e:
            return jsonify({"ok": False, "error": str(e)}), 400

        _event_mgr.publish_event(
            run_id,
            "RUN_CANCELLED",
            {"run_id": run_id, "execution_version": run.execution_version},
        )
        return jsonify({"ok": True, "run": run.model_dump()}), 200

    @bp.route("/runs/<run_id>/events", methods=["GET"])
    def get_events(run_id: str):
        after_seq = int(request.args.get("after_seq", 0))
        events = _event_mgr.get_events(run_id, after_seq=after_seq)
        return jsonify({"ok": True, "events": events}), 200

    return bp


# 导出默认全局蓝图
research_bp = create_research_blueprint()
