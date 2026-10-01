# -*- coding: utf-8 -*-
"""
ResearchEngine 内部工具 HTTP 路由接口
供 Node.js/TypeScript Pi Runtime 内部服务远程调用 Python 搜索与分析服务
"""

import os
from typing import Optional
from flask import Blueprint, request, jsonify
from .tools import ResearchToolRegistry


def create_research_tools_blueprint(
    registry: ResearchToolRegistry,
    internal_token: Optional[str] = None,
) -> Blueprint:
    """创建内部研究工具蓝图"""
    bp = Blueprint("research_internal_tools", __name__)
    token = internal_token or os.getenv("RESEARCH_INTERNAL_TOKEN", "bettafish-internal-secret")

    @bp.before_request
    def check_internal_auth():
        auth_header = request.headers.get("X-Research-Internal-Token")
        if not auth_header:
            return jsonify({"error": "Missing internal authentication token"}), 401
        if auth_header != token:
            return jsonify({"error": "Invalid internal authentication token"}), 403

    @bp.route("/api/research/internal/tools/<tool_name>", methods=["POST"])
    def execute_tool(tool_name: str):
        payload = request.get_json(silent=True) or {}
        run_id = payload.get("run_id")

        if tool_name == "search_web":
            res = registry.search_web(
                query=payload.get("query", ""),
                count=payload.get("count", 5),
                freshness=payload.get("freshness"),
                run_id=run_id,
            )
            return jsonify(res)

        elif tool_name == "read_source":
            res = registry.read_source(
                url_or_ref=payload.get("url_or_ref", ""),
                extract_summary=payload.get("extract_summary", False),
                run_id=run_id,
            )
            return jsonify(res)

        elif tool_name == "query_posts":
            res = registry.query_posts(
                keyword=payload.get("keyword", ""),
                platform=payload.get("platform"),
                start_time=payload.get("start_time"),
                end_time=payload.get("end_time"),
                limit=payload.get("limit", 20),
            )
            return jsonify(res)

        elif tool_name == "query_comments":
            res = registry.query_comments(
                post_id_or_keyword=payload.get("post_id_or_keyword", ""),
                sample_size=payload.get("sample_size", 100),
                sentiment_filter=payload.get("sentiment_filter"),
            )
            return jsonify(res)

        elif tool_name == "analyze_sentiment":
            res = registry.analyze_sentiment(
                texts=payload.get("texts", []),
            )
            return jsonify(res)

        elif tool_name == "get_timeline":
            res = registry.get_timeline(
                topic_keyword=payload.get("topic_keyword", ""),
                interval=payload.get("interval", "1h"),
                window=payload.get("window", "48h"),
            )
            return jsonify(res)

        else:
            return jsonify({"error": f"Unknown tool: {tool_name}"}), 404

    return bp
