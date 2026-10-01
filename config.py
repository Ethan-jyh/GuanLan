# -*- coding: utf-8 -*-
"""
「观澜」全局配置文件

此模块使用 pydantic-settings 管理全局配置，支持从环境变量和 .env 文件自动加载。
"""

from pathlib import Path
from pydantic_settings import BaseSettings
from pydantic import Field, ConfigDict
from typing import Optional, Literal


# 计算 .env 优先级：优先当前工作目录，其次项目根目录
PROJECT_ROOT: Path = Path(__file__).resolve().parent
CWD_ENV: Path = Path.cwd() / ".env"
ENV_FILE: str = str(CWD_ENV if CWD_ENV.exists() else (PROJECT_ROOT / ".env"))


class Settings(BaseSettings):
    """
    全局配置；支持 .env 和环境变量自动加载。
    """
    # ================== 服务配置 ====================
    HOST: str = Field("0.0.0.0", description="主机监听地址，例如 0.0.0.0 或 127.0.0.1")
    PORT: int = Field(3000, description="运行时服务端口号，默认 3000")

    # ====================== 数据库配置 ======================
    DB_DIALECT: str = Field("postgresql", description="数据库类型，可选 mysql 或 postgresql")
    DB_HOST: str = Field("localhost", description="数据库主机地址")
    DB_PORT: int = Field(5432, description="数据库端口号，postgresql默认为5432，mysql默认为3306")
    DB_USER: str = Field("your_db_user", description="数据库用户名")
    DB_PASSWORD: str = Field("your_db_password", description="数据库密码")
    DB_NAME: str = Field("guanlan", description="数据库名称")
    DB_CHARSET: str = Field("utf8mb4", description="数据库字符集，推荐utf8mb4，兼容emoji")
    DATABASE_URL: Optional[str] = Field(None, description="自定义数据库连接串（可选）")

    # ======================= 通用与各智能体 LLM 配置 =======================
    OPENAI_API_KEY: Optional[str] = Field(None, description="通用 LLM API 密钥")
    OPENAI_BASE_URL: Optional[str] = Field("https://api.openai.com/v1", description="通用 LLM BaseUrl")
    OPENAI_MODEL_NAME: str = Field("gpt-4o", description="通用 LLM 模型名称")

    HOST_AGENT_API_KEY: Optional[str] = Field(None, description="HostAgent 主持研判智能体 API 密钥")
    HOST_AGENT_BASE_URL: Optional[str] = Field(None, description="HostAgent BaseUrl")
    HOST_AGENT_MODEL_NAME: Optional[str] = Field(None, description="HostAgent 模型名称")

    FACT_AGENT_API_KEY: Optional[str] = Field(None, description="FactAgent 事实核查智能体 API 密钥")
    FACT_AGENT_BASE_URL: Optional[str] = Field(None, description="FactAgent BaseUrl")
    FACT_AGENT_MODEL_NAME: Optional[str] = Field(None, description="FactAgent 模型名称")

    EVOLUTION_AGENT_API_KEY: Optional[str] = Field(None, description="EvolutionAgent 演化研判智能体 API 密钥")
    EVOLUTION_AGENT_BASE_URL: Optional[str] = Field(None, description="EvolutionAgent BaseUrl")
    EVOLUTION_AGENT_MODEL_NAME: Optional[str] = Field(None, description="EvolutionAgent 模型名称")

    FEEDBACK_AGENT_API_KEY: Optional[str] = Field(None, description="FeedbackAgent 情绪反馈智能体 API 密钥")
    FEEDBACK_AGENT_BASE_URL: Optional[str] = Field(None, description="FeedbackAgent BaseUrl")
    FEEDBACK_AGENT_MODEL_NAME: Optional[str] = Field(None, description="FeedbackAgent 模型名称")

    # MindSpider 爬虫辅助大模型
    MINDSPIDER_API_KEY: Optional[str] = Field(None, description="MindSpider 爬虫辅助模型 API 密钥")
    MINDSPIDER_BASE_URL: Optional[str] = Field(None, description="MindSpider 模型 BaseUrl")
    MINDSPIDER_MODEL_NAME: Optional[str] = Field(None, description="MindSpider 模型名称")

    # ================== 外部搜索与多模态工具配置 ====================
    TAVILY_API_KEY: Optional[str] = Field(None, description="Tavily 全网搜索 API 密钥")

    SEARCH_TOOL_TYPE: Literal["AnspireAPI", "BochaAPI"] = Field("AnspireAPI", description="搜索工具类型，支持 AnspireAPI 或 BochaAPI")
    BOCHA_BASE_URL: Optional[str] = Field("https://api.bocha.cn/v1/ai-search", description="Bocha AI 搜索 BaseUrl")
    BOCHA_WEB_SEARCH_API_KEY: Optional[str] = Field(None, description="Bocha 搜索 API 密钥")

    ANSPIRE_BASE_URL: Optional[str] = Field("https://plugin.anspire.cn/api/ntsearch/search", description="Anspire AI 搜索 BaseUrl")
    ANSPIRE_API_KEY: Optional[str] = Field(None, description="Anspire 搜索 API 密钥")

    model_config = ConfigDict(
        env_file=ENV_FILE,
        env_prefix="",
        case_sensitive=False,
        extra="allow"
    )


# 创建全局配置实例
settings = Settings()


def reload_settings() -> Settings:
    """
    重新加载配置
    """
    global settings
    settings = Settings()
    return settings
