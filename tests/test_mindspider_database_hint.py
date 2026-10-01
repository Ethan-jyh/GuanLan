from types import SimpleNamespace
from unittest.mock import Mock
import pytest

pytest.importorskip("pymysql")
from MindSpider import main as mindspider_main



class FakeConnection:
    def __init__(self, tables):
        self.tables = tables

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False

    async def run_sync(self, callback):
        return self.tables


class FakeEngine:
    def __init__(self, tables):
        self.tables = tables

    def connect(self):
        return FakeConnection(self.tables)

    async def dispose(self):
        return None


def test_missing_tables_hint_supports_documented_working_directories(monkeypatch):
    logger = Mock()
    settings = SimpleNamespace(
        DB_DIALECT="postgresql",
        DB_USER="user",
        DB_PASSWORD="password",
        DB_HOST="localhost",
        DB_PORT=5432,
        DB_NAME="bettafish",
        DB_CHARSET="utf8mb4",
    )
    monkeypatch.setattr(mindspider_main, "logger", logger)
    monkeypatch.setattr(mindspider_main, "settings", settings)
    monkeypatch.setattr(
        mindspider_main,
        "create_async_engine",
        lambda *args, **kwargs: FakeEngine(["daily_news"]),
    )

    assert mindspider_main.MindSpider().check_database_tables() is False

    info_messages = [call.args[0] for call in logger.info.call_args_list]
    hint = next(message for message in info_messages if message.startswith("提示:"))
    assert "python main.py --init-db" in hint
    assert "python MindSpider/main.py --init-db" in hint
