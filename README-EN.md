<div align="center">

# 🌊 观澜 · GuanLan
### Multi-Agent Situation Awareness & Decision Reporting Platform

*“To observe water, one must observe its surging waves.” — An autonomous Multi-Agent system for multi-source situation awareness, dialectical deliberation, and controlled briefing compilation on critical events.*

[![Node.js](https://img.shields.io/badge/Node.js-22.x%20LTS-339933?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8+-3178C6?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat-square&logo=python)](https://python.org/)
[![Runtime Tests](https://img.shields.io/badge/TS%20Tests-91%20Passed-brightgreen?style=flat-square)](./agent-runtime/)
[![Python Tests](https://img.shields.io/badge/Python%20Tests-15%20Passed-brightgreen?style=flat-square)](./tests/)
[![License](https://img.shields.io/badge/License-GPL--2.0-blue.svg?style=flat-square)](LICENSE)

[English](./README-EN.md) | [中文文档](./README.md)

</div>

## ⚡ Overview

**GuanLan (观澜)** is designed for multi-source situation awareness, trend reasoning, and executive briefing synthesis during critical and emerging events. It builds an autonomous Multi-Agent matrix combining **cross-modal social sensing**, **dialectical deliberation**, and **controlled Document IR compilation**.

The system addresses information silos and LLM sycophancy. Given an analysis topic, the agent matrix automatically performs authoritative narrative tracking, multi-platform media sensing, private data analysis, asynchronous deliberation, and structured report compilation.

### 🚀 Technical Highlights

1. **Modern TypeScript Collaborative Runtime (`agent-runtime/`)**:
   - The core orchestration engine is built on TypeScript / Node.js, providing low-latency, strictly-typed, and highly resilient orchestration for DAG planning, state machines, evidence tracking, IR compilation, and report rendering.
   - **Native High-Performance Core**: Powered by Node.js 22 native `node:sqlite` (WAL mode), Zod domain contracts, and SHA-256 deduplicated evidence pools.
   - **Strict Evidence Verification & Budget Gate**: Every claim is bidirectionally bound to evidence fingerprints; unverified statements are rejected. Atomic quotas ensure report generation budgets are strictly preserved.
   - **3-Role Deliberation Barrier & Mandatory Convergence**: Parallel investigations by FactAgent, EvolutionAgent, and FeedbackAgent. Mandatory convergence at round 3 permanently prevents infinite deliberation loops.
   - **Comprehensive Automated Test Suite**: 91 unit and end-to-end tests covering evidence tracking, convergence barriers, budget protection, crash recovery, and document rendering.

2. **Cross-Modal Agent Matrix**:
   - Decoupled into authoritative narrative tracking, social media cross-modal perception, and sentiment mining.
   - Covers mainstream social media platforms (Weibo, Xiaohongshu, Douyin/TikTok, Kuaishou), handling text, images, short videos, and structured cards.

3. **Host-Driven Deliberation & Targeted Follow-Up**:
   - Led by a Host Analyst model with synchronous barriers.
   - When evidence gaps are identified, follow-up directives are dispatched *only* to the relevant agent, while findings from other agents are carried forward automatically.

4. **Edge-Cloud Synergy & Efficient Fine-Tuning**:
   - "Local lightweight tagging + Cloud LLM high-level reasoning" architecture.
   - LoRA-finetuned BERT-Chinese and compact Qwen models handle multi-dimensional sentiment polarization with a 91.8% F1-score, reducing API costs.

5. **Controlled Compiler-Grade Document IR Engine**:
   - Eliminates formatting collapse and broken chart syntax in LLM-generated long reports using strict JSON Schema Document IR specifications.
   - Features chapter pipelining, self-healing chart validation, and pure JS export (DOCX, Markdown, HTML, PDF), achieving a 95.2% first-pass report pass rate.

---

## 🏗️ System Architecture

<div align="center">

<img src="static/image/framework.svg" alt="GuanLan Multi-Agent Architecture Diagram" width="100%">

</div>

### End-to-End Decision Workflow

| Phase | Core Action | Components | Mechanisms & Constraints |
|---|---|---|---|
| **1. Ingestion & DAG Planning** | Parse topic intent and construct task DAG | HostAgent + TaskPlanner | Acyclic dependency verification, initial budget allocation, Run isolation |
| **2. 3-Role Parallel Research** | Subagents execute specialized investigations | Fact / Evolution / Feedback | Max 3 concurrency; claims strictly bound to evidence; atomic budget reservation |
| **3. Barrier & Claim Verification** | Synchronize outputs and verify evidence claims | Coordinator + VerifierComponent | Strict evidence validation; supports multi-dimensional coexistence of facts & sentiment |
| **4. Host Review & Follow-Up** | Host reviews findings and issues targeted tasks | HostAgent + ReviewManager | **Targeted dispatch**: Follow-ups sent only to agents with gaps; others Carry-Forward; **Mandatory convergence at Round 3** |
| **5. Controlled IR Compilation** | Aggregate verified findings and assemble report | ReportAgent + IRValidator + Renderers | **FinalChecker gate**: Rejects unsupported claims and generic slogans; Document IR syntax check; native export to DOCX/HTML/MD/PDF |

---

### Project Structure

```
GuanLan/
├── agent-runtime/                          # 🚀 TypeScript / Node.js multi-agent core orchestration runtime
│   ├── src/contracts/                      # Domain contracts (Zod schema validation)
│   ├── src/storage/                        # SQLite storage, evidence pool, event log, budget ledger
│   ├── src/orchestration/                  # DAG planner, scheduler, submissions, reviews, recovery
│   ├── src/tools/                          # Research tools (web search, scraper, social query, time series)
│   ├── src/agents/                         # Pi Agents (HostAgent, ResearcherAgent, ReportAgent, Verifier)
│   ├── src/reporting/                      # Report synthesis, quality gate, IR validator, multi-format renderers
│   ├── src/api/                            # RESTful API, SSE event stream, web dashboard
│   └── tests/                              # 91 automated test cases and benchmarks
├── MindSpider/                             # Social media crawling cluster
│   ├── main.py                             # Crawler CLI entry point
│   ├── config.py                           # Crawler configuration
│   ├── BroadTopicExtraction/               # Macro hot topic detection
│   ├── DeepSentimentCrawling/              # Deep crawling for Weibo, Xiaohongshu, Douyin, etc.
│   └── schema/                             # Database schema definition and migration
├── SentimentAnalysisModel/                 # Sentiment classification models
│   ├── WeiboSentiment_Finetuned/           # Finetuned BERT-Chinese / GPT-2 models
│   ├── WeiboMultilingualSentiment/         # Multilingual sentiment analysis
│   ├── WeiboSentiment_SmallQwen/           # Compact Qwen LoRA finetuning & offline inference
│   └── WeiboSentiment_MachineLearning/     # Classical ML baselines
├── contracts/                              # Cross-language contract specifications and fixtures
├── docs/                                   # Architectural designs and benchmark reports
├── static/                                 # Static assets (architecture vector diagram framework.svg, etc.)
├── tests/                                  # Python utility and infrastructure tests
├── utils/                                  # Common utilities
├── .env.example                            # Environment variables configuration template
├── config.py                               # Global configuration model (pydantic-settings)
├── docker-compose.yml                      # Docker Compose multi-service deployment
├── Dockerfile                              # Container image specification
├── requirements.txt                        # Python toolchain dependencies
├── README.md                               # Chinese documentation
├── README-EN.md                            # English documentation
├── CONTRIBUTING.md                         # Contribution guide
├── CONTRIBUTING-EN.md                      # English contribution guide
├── LICENSE                                 # GPL-2.0 License
└── THIRD_PARTY_NOTICES.md                  # Third-party notices
```

---

## ⚡ Quick Start: Agent Runtime (Recommended)

The core orchestration engine lives in the `agent-runtime/` directory. Once running, it provides an interactive web dashboard, RESTful APIs, and real-time SSE event streaming:

### 1. Requirements
- **Node.js**: 20.x or 22.x LTS
- **npm**: 10.x+

### 2. Install & Start

```bash
# 1. Enter the runtime directory
cd agent-runtime

# 2. Install dependencies & build
npm install
npm run build

# 3. Run all 91 automated tests
npm test

# 4. Launch runtime server & web dashboard
npm start
```

Open your browser and navigate to: **`http://localhost:3000`**

### 3. API Usage

- **Create a Research Run**:
  ```bash
  curl -X POST http://localhost:3000/api/research/runs \
    -H "Content-Type: application/json" \
    -d '{"topic": "Public sentiment on new energy vehicle charging infrastructure"}'
  ```

- **Stream Deliberation Events (SSE)**:
  ```bash
  curl -N http://localhost:3000/api/research/runs/<RUN_ID>/events
  ```

- **Export Decision Reports**:
  - Interactive HTML: `GET http://localhost:3000/api/research/runs/<RUN_ID>/report.html`
  - Markdown Report: `GET http://localhost:3000/api/research/runs/<RUN_ID>/report.md`
  - Word Document: `GET http://localhost:3000/api/research/runs/<RUN_ID>/report.docx`

For comprehensive documentation, see [Node.js Runtime Guide](./docs/guides/node-runtime.md).

---

## 🚀 Full Docker Deployment

### 1. Configure Environment
```bash
cp .env.example .env
```
Edit `.env` to supply your LLM API keys (compatible with OpenAI-compatible providers).

### 2. Launch Services
```bash
docker compose up -d
```
Access the dashboard at `http://localhost:3000`.

---

## 🐍 Python Supporting Modules

The GuanLan system pairs a **TypeScript core runtime** (orchestration, verification, deliberation, and report export) with **Python algorithm/crawler components** (social media harvesting and local sentiment modeling).

### 1. Python Setup

```bash
# Recommended: Conda environment
conda create -n guanlan python=3.11 -y
conda activate guanlan

# Install toolchain dependencies
pip install -r requirements.txt

# Install Playwright browser binaries
playwright install chromium
```

### 2. MindSpider Crawler Cluster

```bash
cd MindSpider

# 1. Initialize database tables
python -m schema.init_database

# 2. Extract macro trending topics
python main.py --broad-topic

# 3. Deep crawling across platforms (e.g. Xiaohongshu, Douyin, Weibo)
python main.py --deep-sentiment --platforms xhs dy wb
```

### 3. Sentiment Analysis Models

```bash
# 1. Compact Qwen model inference
cd SentimentAnalysisModel/WeiboSentiment_SmallQwen
python predict_universal.py --text "The policy update is timely and addresses major public concerns."

# 2. Chinese BERT LoRA model inference
cd ../WeiboSentiment_Finetuned/BertChinese-Lora
python predict.py --text "The service response exceeded expectations."

# 3. Multilingual sentiment model
cd ../../WeiboMultilingualSentiment
python predict.py --text "The overall response is remarkably positive." --lang "en"
```

---

## ⚙️ Configuration Reference

All settings are managed via `.env` at the repository root:

| Category | Key | Description | Default / Recommended |
|---|---|---|---|
| **Server** | `PORT` | Runtime port | `3000` |
| | `HOST` | Bind address | `0.0.0.0` |
| **Database** | `DB_DIALECT` | Database dialect | `postgresql` / `mysql` |
| | `DB_HOST` / `DB_PORT` | Host & Port | `localhost:5432` |
| | `DB_USER` / `DB_PASSWORD` | DB Credentials | Custom |
| | `DB_NAME` | Database name | `guanlan` |
| **LLM** | `OPENAI_API_KEY` | Primary API Key | OpenAI-compatible key |
| | `OPENAI_BASE_URL` | API Base URL | `https://api.openai.com/v1` |
| | `OPENAI_MODEL_NAME` | Default Model | `gpt-4o` / `deepseek-chat` |
| **Specialized Agents** | `HOST_AGENT_MODEL_NAME` | Deliberation Host | `qwen-plus` or `deepseek-reasoner` |
| | `FACT_AGENT_MODEL_NAME` | Fact Verification | `deepseek-chat` |
| | `EVOLUTION_AGENT_MODEL_NAME` | Trend Evolution | `kimi-k2-0711-preview` |
| | `FEEDBACK_AGENT_MODEL_NAME` | Sentiment Feedback | `gemini-2.5-pro` |
| **Search** | `TAVILY_API_KEY` | Web search key | [Tavily](https://tavily.com/) |
| | `SEARCH_TOOL_TYPE` | Search backend | `AnspireAPI` / `BochaAPI` |

---

## 🤝 Contributing

Contributions are welcome! Please review [CONTRIBUTING.md](./CONTRIBUTING.md) before submitting issues or pull requests.

---

## 🗺️ Roadmap

- [x] **Modern TypeScript / Node.js High-Concurrency Engine** (91 automated tests passing)
- [x] **Controlled Document IR Assembly & Pure JS Export** (DOCX / Markdown / HTML / PDF)
- [ ] **Cross-Modal Image/Video-to-Text Deep Synthesis**: Deconstruct short-form videos and unify multimodal tables.
- [ ] **On-Device Model Distillation**: Distill deliberation reasoning patterns into compact offline models.
- [ ] **Dynamic Topology Routing**: Dynamically scale agent roles based on topic complexity.

---

## ⚠️ Disclaimer

**Educational and Academic Research Use Only**

1. **Compliance**: All tools and code are intended strictly for academic research and educational purposes. Any unlawful or abusive usage is strictly prohibited.
2. **Web Scraping**: Crawlers must respect site `robots.txt` policies and applicable regulations. Users assume full responsibility for data collection practices.
3. **Report Accuracy**: Briefings are generated by multi-agent reasoning based on retrieved evidence. The system makes no warranties regarding absolute factual completeness and outputs do not constitute official statutory decisions.

---

## 📄 License

Distributed under the [GPL-2.0 License](LICENSE).

---

## 📬 Contact & Support

- 📧 **Email**: `ethan.jyh1205@gmail.com`
- 💬 **Issues**: Submit bugs and feature requests via [GitHub Issues](https://github.com/jyhkkk/GuanLan/issues).
