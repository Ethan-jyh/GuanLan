<div align="center">

# 观澜 · GuanLan
### 全媒体多智能体态势研判与决策专报平台
#### Multi-Agent Situation Awareness & Decision Reporting Platform

*“观水有术，必观其澜” —— 面向重大突发事件全网多源态势感知、多智能体会商博弈与受控专报装订的自主 Multi-Agent 系统*

[![Node.js](https://img.shields.io/badge/Node.js-22.x%20LTS-339933?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python)](https://python.org/)
[![Runtime Tests](https://img.shields.io/badge/TS%20Tests-91%20Passed-brightgreen?style=flat-square)](./agent-runtime/)
[![Python Tests](https://img.shields.io/badge/Python%20Tests-15%20Passed-brightgreen?style=flat-square)](./tests/)
[![License](https://img.shields.io/badge/License-GPL--2.0-blue.svg?style=flat-square)](LICENSE)

[English](./README-EN.md) | [中文文档](./README.md)

</div>

## ⚡ 项目概述

**「观澜」** 面向重大突发事件全网多源态势感知与研判决策场景，构建集**多源跨模态采集**、**多智能体会商博弈**与**受控专报装订**于一体的 Multi-Agent 舆情推演与内参生成平台。

系统打破了传统单一模型研判中的“信息茧房”与认知从众（Sycophancy）偏见，用户只需输入研判议题，系统即可驱动多智能体矩阵全自动完成权威叙事追踪、社媒跨模态感知、私有数据挖掘、异步会商博弈与受控编译级专报装订。

### 🚀 核心技术亮点

1. **现代 TypeScript 协同研判引擎 (`agent-runtime/`)**：
   - 核心研判中枢基于 TypeScript / Node.js 架构，承载任务 DAG 规划、会商编排、状态机、严格证据溯源、IR 编译与决策专报装订，提供低延迟、强类型与高可靠的研判调度服务。
   - **原生高效底座**：基于 Node.js 22 原生 `node:sqlite`（WAL 模式）、Zod 强类型契约校验与 SHA-256 去重证据池。
   - **严格证据闭环与预算管理**：每条核心论点必须双向绑定证据指纹，未验证事实无法入库；原子配额扣减确保终稿写作预算底线。
   - **3 角色会商屏障与强制收敛**：事实核查、态势演化、舆情反馈 3 智能体并行调研；第 3 轮会商强制收敛，彻底杜绝无限循环。
   - **全量自动化测试套件**：内建 91 项自动化核心测试，全面覆盖证据闭环、会商收敛、预算防护、崩溃恢复与专报导出。

2. **全媒体跨模态 Agent 矩阵架构**：
   - 权威叙事追踪、社媒跨模态感知与私有库情绪挖掘三层解耦的智能体矩阵。
   - 覆盖微博、小红书、抖音、快手等主流社媒图文、短视频及结构化卡片，实现全域态势的网格化感知。

3. **主控驱动的会商博弈与定向追查机制**：
   - 采用首席分析师 Host 模型统筹与同步屏障机制。
   - 评审发现证据不足时，仅对特定智能体下发定向追查任务，其余角色成果自动 Carry-Forward，大幅降低幻觉与无效开销。

4. **端云分级协同与轻量微调降本**：
   - 构建“本地轻量模型打标 + 云端大模型高层研判”架构；基于 LoRA 微调本地 BERT-Chinese 与小参数 Qwen 模型，完成多维度情绪极化分类，测试集 F1-score 达 91.8%，显著降低推理调用成本。

5. **受控编译级 Document IR 装订引擎**：
   - 解决大模型长篇研报生成的结构坍塌与图表语法损坏问题，严格遵循 JSON Schema 的 Document IR 规范；实现篇幅预算拆解、章节流水线生成、Echarts 图表语法自愈校验与最终装订导出（DOCX / Markdown / HTML / PDF），报告全流程自动化出稿合格率达 95.2%。

---

## 🏗️ 系统架构

<div align="center">

<img src="static/image/framework.svg" alt="「观澜」全媒体多智能体态势研判与决策专报平台系统架构图" width="100%">

</div>

### 一次完整研判决策流程

| 阶段 | 核心动作 | 参与组件 | 核心机制与输出约束 |
|---|---|---|---|
| **1. 议题接收与 DAG 规划** | 接收用户研判议题，拆解研判意图并生成任务 DAG | HostAgent + TaskPlanner | 有向无环图依赖校验，初始角色预算分配，建立 Run 隔离域 |
| **2. 三角色并行深入调研** | 3 智能体按职责并发调用工具链，提取核心事实 | Fact / Evolution / Feedback | 最大 3 并发调度；事实强绑定证据录入 EvidenceStore；原子预扣预算 |
| **3. 会商屏障与事实核验** | 等待三方成果齐备，触发同步屏障与事实核验 | Coordinator + VerifierComponent | 严格核验 Claim 关联证据；支持官方事实与大众情绪多维共存评估 |
| **4. Host 评审与定向追查** | Host 综合各方研判结果，决定通过或定向追加调研 | HostAgent + ReviewManager | **定向分派**：仅对信息缺口角色下发补充指令，其余角色 Carry-Forward；**第 3 轮强制收敛** |
| **5. 受控编译与专报装订** | 聚合终审证据集，撰写长篇专报并装订多格式交付 | ReportAgent + IRValidator + Renderers | **FinalChecker 门禁**：拦截泛化空话套话与悬空事实；Document IR 语法校验；原生导出 DOCX/HTML/MD/PDF |

---

### 项目代码结构树

```
GuanLan/
├── agent-runtime/                          # 🚀 TypeScript / Node.js 多智能体协同研判核心运行时
│   ├── src/contracts/                      # 统一领域契约 (Zod schema 运行时校验)
│   ├── src/storage/                        # 原生 SQLite 数据层、证据池、事件流与预算账本
│   ├── src/orchestration/                  # 任务规划、并发调度、成果提交、会商评审与恢复管理
│   ├── src/tools/                          # 核心研究工具集 (联网搜索、正文抓取、社媒参数化查询、时间序列)
│   ├── src/agents/                         # Pi Agent 核心 (HostAgent, ResearcherAgent, ReportAgent, Verifier)
│   ├── src/reporting/                      # 专报研判综合、终稿质量门禁、IR 校验与多格式导出 (DOCX/HTML/MD/PDF)
│   ├── src/api/                            # RESTful API、SSE 实时事件流与 Web 交互看板
│   └── tests/                              # 91 项自动化单元测试与端到端核心基准案例
├── MindSpider/                             # 社交媒体多源数据采集与爬虫集群
│   ├── main.py                             # 爬虫主程序入口
│   ├── config.py                           # 爬虫配置文件
│   ├── BroadTopicExtraction/               # 热点话题宏观提取模块
│   ├── DeepSentimentCrawling/              # 深度舆情与多平台爬取模块 (微博/小红书/抖音等)
│   └── schema/                             # 数据库结构定义与初始化脚本
├── SentimentAnalysisModel/                 # 情感分析与端侧微调模型
│   ├── WeiboSentiment_Finetuned/           # 微调 BERT-Chinese / GPT-2 模型
│   ├── WeiboMultilingualSentiment/         # 多语言情感分析模型
│   ├── WeiboSentiment_SmallQwen/           # 小参数 Qwen 模型微调与离线推断
│   └── WeiboSentiment_MachineLearning/     # 传统机器学习分类基线
├── contracts/                              # 跨语言协议契约规范与 JSON Fixtures
├── docs/                                   # 架构设计方案与性能基准文档
├── static/                                 # 静态资源 (系统架构矢量图 framework.svg 等)
├── tests/                                  # Python 基础与跨模块工具测试
├── utils/                                  # 通用辅助工具函数
├── .env.example                            # 环境变量配置模板
├── config.py                               # 系统全局配置模型 (pydantic-settings)
├── docker-compose.yml                      # Docker 多服务编排
├── Dockerfile                              # 容器构建镜像定义
├── requirements.txt                        # Python 工具链依赖清单
├── README.md                               # 中文说明文档
├── README-EN.md                            # 英文说明文档
├── CONTRIBUTING.md                         # 中文贡献指南
├── CONTRIBUTING-EN.md                      # 英文贡献指南
├── LICENSE                                 # GPL-2.0 开源许可证
└── THIRD_PARTY_NOTICES.md                  # 第三方开源声明
```

---

## ⚡ 极速开始：多智能体研判运行时（推荐）

「观澜」的核心研判调度运行时位于 `agent-runtime/` 目录。启动后提供交互式 Web 看板、全流程 RESTful API 与 SSE 实时会商事件流：

### 1. 运行环境要求
- **Node.js**: 20.x 或 22.x LTS
- **npm**: 10.x+

### 2. 安装与启动

```bash
# 1. 进入运行时目录
cd agent-runtime

# 2. 安装依赖并编译构建
npm install
npm run build

# 3. 运行全量 91 项自动化核心测试
npm test

# 4. 启动研判服务与 Web 交互看板
npm start
```

服务启动后，在浏览器中打开：**`http://localhost:3000`**

### 3. API 交互快速上手

- **创建研判任务**：
  ```bash
  curl -X POST http://localhost:3000/api/research/runs \
    -H "Content-Type: application/json" \
    -d '{"topic": "新能源汽车充电基础设施建设舆情研判"}'
  ```

- **监听会商实时事件流 (SSE)**：
  ```bash
  curl -N http://localhost:3000/api/research/runs/<RUN_ID>/events
  ```

- **下载决策专报**：
  - HTML 交互报告：`GET http://localhost:3000/api/research/runs/<RUN_ID>/report.html`
  - Markdown 专报：`GET http://localhost:3000/api/research/runs/<RUN_ID>/report.md`
  - Word 文档：`GET http://localhost:3000/api/research/runs/<RUN_ID>/report.docx`

详细架构与接口规范请参阅：[Node.js 运行时开发者指南](./docs/guides/node-runtime.md)

---

## 🚀 完整系统部署（Docker 全组件）

### 1. 配置环境变量
复制环境配置模板：
```bash
cp .env.example .env
```
编辑 `.env` 文件，填入您所使用的大模型 API 密钥（兼容所有遵循 OpenAI 标准的模型提供商）。

### 2. 启动服务
```bash
docker compose up -d
```
启动成功后，浏览器访问 `http://localhost:3000` 即可进入系统看板。

---

## 🐍 Python 辅助模块使用指南

系统由 **TypeScript 核心运行时**（负责多智能体任务调度、证据链条约束、会商收敛及决策专报装订）与 **Python 算法/采集组件**（负责全网社媒爬取及端侧情感分析）协同工作。

### 1. Python 环境配置

```bash
# 推荐使用 Conda
conda create -n guanlan python=3.11 -y
conda activate guanlan

# 安装 Python 工具链依赖
pip install -r requirements.txt

# 安装 Playwright 浏览器内核 (用于社媒爬虫)
playwright install chromium
```

### 2. MindSpider 社媒采集集群

MindSpider 支持对微博、小红书、抖音等主流社交平台进行宏观热点跟踪与深度评论采集：

```bash
cd MindSpider

# 1. 数据库初始化 (创建舆情与爬虫任务表)
python -m schema.init_database

# 2. 运行宏观热点话题发现
python main.py --broad-topic

# 3. 运行深度舆情采集 (支持指定平台: xhs/dy/wb)
python main.py --deep-sentiment --platforms xhs dy wb
```
详细配置请阅读：[MindSpider 使用说明](./MindSpider/README.md)

### 3. 情感分析与轻量模型推断

系统内置了多种情感分类与极化分析模型：

```bash
# 1. 小参数 Qwen 模型通用推断
cd SentimentAnalysisModel/WeiboSentiment_SmallQwen
python predict_universal.py --text "这次政策调整非常及时，解决了大家的顾虑"

# 2. 中文 BERT LoRA 模型推断
cd ../WeiboSentiment_Finetuned/BertChinese-Lora
python predict.py --text "服务质量令人满意"

# 3. 多语言舆情情感推断
cd ../../WeiboMultilingualSentiment
python predict.py --text "The overall response is remarkably positive." --lang "en"
```

---

## ⚙️ 核心配置说明

所有配置均由根目录 `.env` 统筹管理，核心配置项如下：

| 配置组 | 配置项 | 说明 | 推荐/默认值 |
|---|---|---|---|
| **服务配置** | `PORT` | 研判运行时端口 | `3000` |
| | `HOST` | 监听地址 | `0.0.0.0` |
| **数据库** | `DB_DIALECT` | 数据库类型 | `postgresql` / `mysql` |
| | `DB_HOST` / `DB_PORT` | 数据库主机与端口 | `localhost:5432` |
| | `DB_USER` / `DB_PASSWORD` | 数据库认证账号 | 自定义 |
| | `DB_NAME` | 数据库名 | `guanlan` |
| **通用大模型** | `OPENAI_API_KEY` | 大模型 API Key | 兼容 OpenAI 格式 |
| | `OPENAI_BASE_URL` | 大模型 API Base URL | 默认 `https://api.openai.com/v1` |
| | `OPENAI_MODEL_NAME` | 默认研判大模型 | `gpt-4o` / `deepseek-chat` |
| **定向智能体** | `HOST_AGENT_MODEL_NAME` | 主持研判 Host 模型 | 推荐 `qwen-plus` 或 `deepseek-reasoner` |
| | `FACT_AGENT_MODEL_NAME` | 事实核查 Agent 模型 | 推荐 `deepseek-chat` |
| | `EVOLUTION_AGENT_MODEL_NAME` | 态势演化 Agent 模型 | 推荐 `kimi-k2-0711-preview` |
| | `FEEDBACK_AGENT_MODEL_NAME` | 舆情反馈 Agent 模型 | 推荐 `gemini-2.5-pro` |
| **外部搜索** | `TAVILY_API_KEY` | 全网实时搜索 API 密钥 | [Tavily](https://tavily.com/) |
| | `SEARCH_TOOL_TYPE` | 智能体联网检索源 | `AnspireAPI` / `BochaAPI` |

---

## 🤝 贡献指南

我们欢迎所有形式的贡献！无论提出 Issue 还是提交 Pull Request，请遵循项目开发规范。

**请阅读详细指南：** [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 🗺️ 后续演进路线

- [x] **现代 TypeScript / Node.js 高并发调度引擎**（已完成：91 项自动化核心测试全绿通过）
- [x] **受控编译级 Document IR 装订与纯 JS 导出**（已完成：DOCX / Markdown / HTML / PDF）
- [ ] **多模态图生文/图生表深度融合研判**：支持短视频逐帧解构与多模态图表统一对齐
- [ ] **端侧轻量化模型蒸馏**：将研判推理策略蒸馏至小尺寸模型，实现全离线私密研判
- [ ] **高并发动态拓扑路由**：基于研判议题自适应伸缩子智能体数量与关注维度

---

## ⚠️ 免责声明

**重要提醒：本项目仅供学习、学术研究和教育目的使用**

1. **合规性声明**：
   - 本项目中的所有代码、工具和功能均仅供学习、学术研究和教育目的使用。
   - 严禁将本项目用于任何违法违规、侵犯公民个人隐私或扰乱网络公共秩序的行为。

2. **采集功能免责**：
   - 项目中的数据采集功能仅用于技术研究与学术数据样本分析。
   - 使用者必须遵守目标站点的 robots.txt 协议与使用条款，严禁高频攻击或违规采集。
   - 因使用数据采集工具造成的任何法律后果由使用者自行承担。

3. **研判内容免责**：
   - 智能体会商研判与专报输出内容由大模型基于检索证据综合生成，平台不对报告观点的绝对真确性提供明示或默示的担保。
   - 决策专报仅作为辅助分析参考，不构成法定决策结论。

---

## 📄 许可证

本项目基于 [GPL-2.0 License](LICENSE) 开源。

---

## 📬 交流与支持

- 📧 **联系邮箱**：`ethan.jyh1205@gmail.com`
- 💬 **问题反馈**：欢迎通过 [GitHub Issues](https://github.com/Ethan-jyh/GuanLan/issues) 提交 Bug 或建议。
