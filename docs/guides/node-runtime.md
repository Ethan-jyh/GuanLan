# BettaFish Node.js 纯运行时开发与操作指南

## 1. 架构总览

BettaFish 现采用纯 TypeScript / Node.js 单进程架构。系统将大模型 Agent、三方调度协调器、SQLite 数据层、预算账本、本地工具集及多格式报表渲染引擎完整内聚在 `agent-runtime/` 中，无需启动任何 Python 服务。

```
agent-runtime/
├── src/
│   ├── contracts/        # 统一业务契约 (Zod schema 校验: run, task, evidence, review, artifact)
│   ├── storage/          # SQLite 持久化 (node:sqlite, 证据池, 事件表, 预算账本)
│   ├── orchestration/    # 协调器 (TaskPlanner, Scheduler, Submissions, Review, Recovery)
│   ├── tools/            # 本地工具注册表 (search, read-source, database, feedback, timeline)
│   ├── agents/           # Pi Agent (HostAgent, ResearcherAgent, ReportAgent, VerifierComponent)
│   ├── reporting/        # 专报引擎 (input, ir-validator, artifacts, markdown/html/docx/pdf renderers)
│   ├── api/              # RESTful HTTP 路由、SSE 实时流与仪表盘
│   └── server.ts         # 统一主入口
└── tests/                # 91 项全面单元与端到端测试
```

---

## 2. 快速启动

### 2.1 安装依赖与构建

```bash
cd agent-runtime
npm install
npm run build
```

### 2.2 运行完整测试套件

```bash
npm test
```
*所有 91 项自动化测试应在 0.5 秒内全部通过，覆盖契约、存储、预算并发、调度屏障、终稿合规、多格式导出及 5 项核心基准用例。*

### 2.3 启动服务与 Web 仪表盘

```bash
npm start
```
默认监听端口 `http://localhost:4000`。
- **Web 仪表盘**: 访问 `http://localhost:4000/` 或 `http://localhost:4000/dashboard`。
- **健康检查**: `GET http://localhost:4000/health`。

---

## 3. 核心 API 接口指南

### 3.1 创建研判任务
- **方法与路径**: `POST /api/research/runs`
- **请求体**:
```json
{
  "topic": "某突发暴雨抢险与次生民生舆情研判",
  "scope": { "region": "涉事区域", "time_window": "48h" },
  "budget_total": 50
}
```
- **返回**: `201 Created`，返回生成的 `run` 对象及初始化的首轮三方子任务。

### 3.2 查看运行详情与预算
- **方法与路径**: `GET /api/research/runs/:run_id`
- **返回**: 包含当前状态、各角色子任务进度、预算已用/冻结情况。

### 3.3 订阅实时有序事件流 (SSE)
- **方法与路径**: `GET /api/research/runs/:run_id/events`
- **请求头**: `Accept: text/event-stream`
- **说明**: 支持 `?after_seq=N` 断点续传，页面刷新或断网重连自动增量同步，包含心跳保活。

### 3.4 提交会商评审决策
- **方法与路径**: `POST /api/research/runs/:run_id/review`
- **请求体**:
```json
{
  "task_id": "task-host-r1",
  "round": 1,
  "decision": "revise",
  "rationale": "反馈样本不足，需继续扩充",
  "directives": [
    {
      "directive_id": "dir-1",
      "target_role": "feedback",
      "related_claim_or_issue": "sample_size",
      "question": "将评论抽样规模扩大至 5000 条",
      "suggested_action": "query_comments",
      "completion_criteria": "sample >= 5000"
    }
  ],
  "unresolved_issues": []
}
```

### 3.5 暂停、恢复与取消
- `POST /api/research/runs/:run_id/pause`: 原子置为暂停状态。
- `POST /api/research/runs/:run_id/resume`: 递增 `execution_version`，唤醒继续执行，自动作废迟到响应。
- `POST /api/research/runs/:run_id/cancel`: 取消运行。

---

## 4. 关键设计与安全机制

1. **防幻觉与数据不可得原则**：
   - 检索或时间序列底层无数据时，工具如实返回 `status: 'data_unavailable'`，严禁大模型捏造事实或虚构时间戳。
2. **三方并发与受控预算**：
   - 调度器默认最大并发数为 3。
   - 所有工具调用通过唯一 `call_id` 在 SQLite 预算账本中执行原子预留与核销；失败重试亦计入实际消耗，杜绝无限空耗。
3. **强制收敛机制**：
   - 最多执行 3 轮研究。达到第 3 轮时，评审禁止下发 `revise`，系统强制收敛放行并将未解决问题列入未决事项附录。
4. **专报质量门禁 (FinalChecker)**：
   - 严格审查事实闭环：专报引用的每个主张与证据编号必须在入库证据池中真实存在。
   - 自动拦截“高度重视”、“加强舆论引导”等缺乏具体责任主体与量化动作的空泛口号。
