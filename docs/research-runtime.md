# BettaFish 多智能体协同研究系统运行与部署指南 (Research Runtime Guide)

本文档面向国家重点实验室科研人员与工程运维人员，详细阐述基于 **Pi 智能体内核 (@earendil-works/pi-agent-core@0.99.2)** 构建的主从子智能体研究架构的配置、启动、API 接口、容灾恢复与回退机制。

---

## 一、系统架构概览

```
[前端 Web UI / REST Client]
          │
          ▼
   [Flask REST API (/api/research/runs)]
          │
   ┌──────┴───────────────────────────────────────────────────────┐
   │                     ResearchCoordinator                       │
   │  ┌───────────────┐   ┌────────────────┐   ┌───────────────┐  │
   │  │ TaskPlanner   │   │ BudgetManager  │   │ ReviewManager │  │
   │  └───────────────┘   └────────────────┘   └───────────────┘  │
   └──────────────┬───────────────────────────────┬───────────────┘
                  │                               │
       ┌──────────┴──────────┐        ┌───────────┴───────────┐
       ▼                     ▼        ▼                       ▼
[Authority Agent]    [Evolution Agent] [Feedback Agent]   [ClaimVerifier]
 (权威通报/发文字号)    (传播曲线/转折点)  (评论抽样/诉求)     (独立事实溯源)
       │                     │        │
       └──────────┬──────────┴────────┘
                  │ 汇合屏障 (Sync Barrier)
                  ▼
          [Report Chief Editor Agent]
           (跨维度研判 ReportJudgment)
                  │
                  ▼
          [Document IR 1.0 适配器]
                  │
          ┌───────┴───────┬───────────────┐
          ▼               ▼               ▼
      [DOCX 导出]     [HTML 预览]     [Markdown]
```

---

## 二、运行环境与依赖要求

- **操作系统**：macOS / Linux / Windows WSL2
- **Python 环境**：Python 3.10 ~ 3.12 (推荐 Conda 环境)
  - 核心依赖：`flask`, `pydantic>=2.5.2`, `python-docx>=1.1.0`
- **Node.js 环境**：Node.js >= 20.0.0 (推荐 v24.x LTS)
  - 运行时包：`@earendil-works/pi-agent-core@0.99.2`, `@earendil-works/pi-ai@0.99.2`

---

## 三、服务启动与构建命令

### 1. 构建与启动 TypeScript Agent Runtime
```bash
cd agent-runtime
# 安装依赖
npm ci
# 编译构建
npm run build
# 执行单元测试
npm test
# 启动 HTTP/IPC 代理适配服务 (默认端口 3000)
npm start
```

### 2. 启动 Flask 后端主服务
```bash
# 根目录下运行
python app.py
```
服务启动时会自动检查数据库并执行 `auto_pause_unended_runs_on_startup()`，将上次未正常终止的活跃任务置为安全暂停状态。

---

## 四、核心 REST API 接口清单

| 方法 | 路径 | 功能说明 | 请求/响应格式 |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/research/runs` | 创建新的协同研判任务 | `{"topic": "...", "scope": {}, "budget_total": 50}` |
| `GET` | `/api/research/runs/<run_id>` | 查询任务状态、子任务与预算 | 返回包含 run, tasks, budget 详情 |
| `POST` | `/api/research/runs/<run_id>/pause` | 暂停正在进行的研究任务 | 原子跃迁为 paused |
| `POST` | `/api/research/runs/<run_id>/resume` | 恢复暂停的研究任务 | 递增 execution_version 并继续 |
| `POST` | `/api/research/runs/<run_id>/cancel` | 取消研究任务 | 提升版本并使迟到响应失效 |
| `GET` | `/api/research/runs/<run_id>/events` | 增量拉取有序事件流 | 支持 `?after_seq=N` 断点续拉 |
| `GET` | `/api/report/export/docx/<task_id>` | 导出专报为 DOCX 格式 | 返回 Word 附件下载流 |

---

## 五、预算与并发防护机制

1. **三方并发控制**：调度器使用 `max_workers=3` 线程池并发派发三方子任务，保证权威口径、舆情演化与公众反馈三方真正并发执行。
2. **预算保底配额**：
   - 默认总调用配额：50 次。
   - 保底预留：10 次专门保留给后期 Report 撰写与终稿质量审查，研究阶段最多消耗 40 次。
   - 原子预留与结算：使用 SQLite `BEGIN IMMEDIATE` 事务与行级锁，阻断并发超额。

---

## 六、容灾与回退策略

1. **断网重连与刷新防护**：
   - 前端 Web UI 在 `localStorage` 维护活跃 `run_id`，浏览器刷新后直接通过 `GET /events?after_seq=...` 补齐事件，不会丢失后端研判进度。
2. **脑裂与迟到响应拦截**：
   - 每次 `resume` 或 `cancel` 均原子自增 `execution_version`。
   - 客户端迟到提交携带旧版本时被自动拒绝，杜绝旧任务覆盖新状态。
3. **旧架构平滑回退**：
   - 新架构与旧论坛架构完全解耦，分别挂载在 `/api/research` 与 `/api/forum` 独立蓝图；
   - 如需回退，仅需在前端切换调用入口，旧模式代码保持 100% 单元测试全绿。
