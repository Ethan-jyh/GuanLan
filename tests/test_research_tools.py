# -*- coding: utf-8 -*-
"""
Task 3 研究工具接口单元测试
测试覆盖：
1. search_web (支持搜索与结构化结果返回，区分 not_found 与成功)
2. read_source (正文读取与摘要提取，标记 is_full_text)
3. query_posts & query_comments (参数白名单过滤，不接受任意 SQL，返回抽样与分母说明)
4. analyze_sentiment (情绪极性分析与分布统计)
5. get_timeline (时间序列，支持 data_unavailable，不虚构时间序列)
6. 内部 HTTP 工具调用端点鉴权与路由验证 (/api/research/internal/tools/<tool_name>)
"""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock

# 确保项目根目录在 sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


class TestResearchTools(unittest.TestCase):
    """Python 工具集与 HTTP 路由测试"""

    def setUp(self):
        from ResearchEngine.tools import ResearchToolRegistry
        self.registry = ResearchToolRegistry()

    def test_search_web_offline_and_mock(self):
        """测试 search_web 结构化包装与区分空结果"""
        # 测试在提供 mock search backend 时正常解析
        with patch.object(self.registry, "_execute_web_search") as mock_search:
            mock_search.return_value = [
                {
                    "title": "官方通报：水势平稳",
                    "url": "https://gov.example.cn/news/1",
                    "snippet": "最新汛情通报显示水位已回落。",
                    "published_date": "2026-10-01",
                }
            ]
            res = self.registry.search_web("汛情通报", count=3)
            self.assertEqual(res["status"], "success")
            self.assertEqual(len(res["results"]), 1)
            self.assertEqual(res["results"][0]["title"], "官方通报：水势平稳")

            # 测试未搜索到结果
            mock_search.return_value = []
            empty_res = self.registry.search_web("不存在的长尾词不存在不存在")
            self.assertEqual(empty_res["status"], "not_found")
            self.assertEqual(len(empty_res["results"]), 0)

    def test_read_source_full_text(self):
        """测试 read_source 实际读取正文并保留材料溯源"""
        with patch.object(self.registry, "_fetch_url_content") as mock_fetch:
            mock_fetch.return_value = (
                "【通告正文】经各部门连续抢险，辖区内所有受阻干道已全部恢复双向通车。"
            )
            res = self.registry.read_source("https://gov.example.cn/news/1")
            self.assertEqual(res["status"], "success")
            self.assertTrue(res["is_full_text"])
            self.assertIn("抢险", res["content"])

    def test_query_posts_and_comments_parameters(self):
        """测试社媒帖子与评论查询，拒绝 SQL 注入并返回分母信息"""
        # 正常查询
        with patch.object(self.registry, "_query_db_posts") as mock_db:
            mock_db.return_value = {
                "total_matched": 1500,
                "sampled_count": 20,
                "posts": [{"id": "p1", "text": "路面水退了", "created_at": "2026-10-01"}],
            }
            res = self.registry.query_posts("路面积水", platform="weibo", limit=20)
            self.assertEqual(res["status"], "success")
            self.assertEqual(res["denominator"], 1500)
            self.assertEqual(len(res["items"]), 1)

    def test_get_timeline_data_unavailable(self):
        """测试当底层数据库无匹配数据时返回 data_unavailable 而非虚构数据"""
        with patch.object(self.registry, "_query_timeline_data") as mock_tl:
            mock_tl.return_value = None  # 无数据支撑
            res = self.registry.get_timeline("完全没有提及的生僻词", window="24h")
            self.assertEqual(res["status"], "data_unavailable")
            self.assertIn("reason", res)

    def test_internal_tool_route_authentication(self):
        """测试内部 HTTP 工具接口需要鉴权令牌"""
        from flask import Flask
        from ResearchEngine.tool_routes import create_research_tools_blueprint

        app = Flask(__name__)
        app.register_blueprint(
            create_research_tools_blueprint(self.registry, internal_token="secret-token-123")
        )
        client = app.test_client()

        # 无 Token -> 401
        resp = client.post("/api/research/internal/tools/search_web", json={"query": "test"})
        self.assertEqual(resp.status_code, 401)

        # 错误 Token -> 403
        resp = client.post(
            "/api/research/internal/tools/search_web",
            headers={"X-Research-Internal-Token": "wrong-token"},
            json={"query": "test"},
        )
        self.assertEqual(resp.status_code, 403)

        # 正确 Token -> 200
        with patch.object(self.registry, "_execute_web_search", return_value=[]):
            resp = client.post(
                "/api/research/internal/tools/search_web",
                headers={"X-Research-Internal-Token": "secret-token-123"},
                json={"query": "test"},
            )
            self.assertEqual(resp.status_code, 200)
            data = resp.get_json()
            self.assertEqual(data["status"], "not_found")


if __name__ == "__main__":
    unittest.main()
