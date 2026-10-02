# BettaFish 子 Agent 工具化与独立执行 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 HOST 主 Agent 对研究角色的调度改造为异步工具调用模式，使子任务独立入队执行、逐项保存成果与失败、双层预算管控，并经 HOST 收件箱串行审查与放行门禁产出专报。

**Architecture:** HOST 通过 `research_authority` 等独立异步工具派发研究作业并立即获取回执；后台 worker 独立拉取任务、分配独立 Pi 实例/预算上下文执行；任务完成或失败原子写入数据库与事件外发箱；HOST 收件箱防抖汇聚事件后串行唤醒 HOST 决策；最终由程序放行门禁校验材料快照后交付 Report Agent。

**Tech Stack:** TypeScript 5.7+ / Node.js 22 (原生 test runner, SQLite `node:sqlite`), `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, Zod 4.6+, docx.

**Spec:** [docs/plans/2026-10-02-subagents-as-tools-design.md](file:///Users/air/Desktop/Project/BettaFish/docs/plans/2026-10-02-subagents-as-tools-design.md)

## Global Constraints

- 保持单进程 TypeScript / Node.js 体系，标准链路不依赖 Python，不改动 Pi 核心依赖版本 (`@earendil-works/pi-agent-core@0.99.2`)。
- 角色定义保持 `authority`、`evolution`、`feedback`，Report Agent 与 Verifier 核心校验逻辑不降低标准。
- 异步工具调用立即返回任务回执 (`status: 'accepted'`)，严禁伪造即时 `succeeded`。
- 单任务失败、超时或取消不得自动级联中断或取消同伴任务；已成功任务的结果不可覆写且予以保留。
- 任务执行预算与全局总预算双层校验，预算预留必须使用唯一 `call_id`，禁止用工具名作为预留键。
- 同一 Run 在任意时刻最多存在一个活跃的 HOST 模型决策轮次，通知事件经收件箱串行消费。
- 实质性补查严格受限于 generation <= 3；技术重试使用 attempt 计数；放行门禁基于不可变材料快照。

## Review Focus

1. **单任务失败或超时破坏同伴执行**：当一个子任务抛出异常或超时时，worker 必须局部捕获并持久化终态，同伴任务继续正常运行，HOST 收到局部失败通知。
2. **并发同名工具调用的预算串号与超扣**：当多个 worker 或主 Agent 同时并发调用同名工具时，BudgetGate 必须根据 Pi 传递的唯一 `call_id` 区分预留与结算，杜绝以工具名覆盖导致的预算错乱。
3. **HOST 决策并发重入与消息风暴**：多个子任务几乎同时提交结果时，收件箱必须通过 500ms 窗口防抖合并，并在 HOST 决策期间锁住重入，排队等待下一轮串行处理。
4. **迟到结果与超时响应覆写新尝试**：任务超时或取消后，旧调用若产生迟到返回，必须基于 `execution_version` 与 `attempt_id` 校验并予以丢弃，严禁污染或覆写后续尝试的成果。
5. **虚假放行与关键缺口绕过**：当必要角色失败且无替代证据时，Release Gate 必须拦截放行请求并强制进入 `paused` 或受限交付 (`restricted`)，严禁将任务终态当作材料充分。

---

### Task 1: 契约层重构与扩展 (任务工具参数、回执、结果与事件契约)

**Files:**
- Create: `agent-runtime/src/contracts/research-job.ts`
- Modify: `agent-runtime/src/contracts/task.ts`, `agent-runtime/src/contracts/research.ts`
- Test: `agent-runtime/tests/research-job-contracts.test.ts`

**Interfaces:**
- Consumes: `ResearchRole`, `TaskStatus` from `src/contracts/task.ts`, `ResearchResult` from `src/contracts/research.ts`
- Produces: `ResearchJobParamsSchema`, `TaskReceiptSchema`, `ResearchOutcomeSchema`, `HostInboxEventSchema`, `ReleaseRequestSchema`

- [ ] **Step 1: 编写契约校验失败测试**

在 `agent-runtime/tests/research-job-contracts.test.ts` 中编写测试：
- 验证 `ResearchJobParamsSchema` 对合法参数 (question, scope, completion_criteria, requested_budget_units, required_for_report) 校验通过，对缺少必填项校验失败。
- 验证 `TaskReceiptSchema` 的 `accepted` 状态包含 `task_id`, `attempt_id`, `role`, `result_pending: true`，且不包含 `succeeded`。
- 验证 `ResearchOutcomeSchema` 支持 `succeeded`, `partial`, `failed`, `timed_out`, `cancelled`，包含不可变的 `execution_version`、`attempt_id` 与 `usage`。
- 验证 `HostInboxEventSchema` 包含 `research_outcome`, `task_timeout`, `host_help_requested`, `release_requested` 等合法事件类型。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/research-job-contracts.test.js`
预期: FAIL (模块未定义或契约缺失)

- [ ] **Step 3: 实现研究作业、回执、成果与收件箱契约**

在 `agent-runtime/src/contracts/research-job.ts` 中实现：
- `ResearchJobParamsSchema` 及类型 `ResearchJobParams`
- `TaskReceiptSchema` 及类型 `TaskReceipt`
- `ResearchOutcomeSchema` 及类型 `ResearchOutcome`
- `HostInboxEventSchema` 及类型 `HostInboxEvent`
- `ReleaseRequestSchema` 及类型 `ReleaseRequest`
在 `src/contracts/task.ts` 中扩充 `TaskStatus` 枚举为 `queued | running | succeeded | partial | failed | timed_out | cancelled`，并在 `TaskSchema` 增加 `generation`, `completion_criteria`, `required_for_report`, `dependencies`, `superseded_by` 字段。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/research-job-contracts.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/contracts/research-job.ts agent-runtime/src/contracts/task.ts agent-runtime/src/contracts/research.ts agent-runtime/tests/research-job-contracts.test.ts
git commit -m "feat(contracts): add research job, receipt, outcome and host event contracts"
```

---

### Task 2: 存储层迁移与仓库 (尝试、成果版本、外发箱与收件箱)

**Files:**
- Create: `agent-runtime/src/storage/migrations/002-subagent-tools.sql`
- Modify: `agent-runtime/src/storage/database.ts`, `agent-runtime/src/storage/repositories.ts`, `agent-runtime/src/storage/event-store.ts`
- Test: `agent-runtime/tests/subagent-storage.test.ts`

**Interfaces:**
- Consumes: `TaskReceipt`, `ResearchOutcome`, `HostInboxEvent` from `src/contracts/research-job.ts`, `ResearchDatabase` from `src/storage/database.ts`
- Produces: `TaskAttemptRepository`, `TaskResultRepository`, `OutboxRepository`, `HostInboxRepository`, `DatabaseMigrations`

- [ ] **Step 1: 编写存储迁移与仓储操作失败测试**

在 `agent-runtime/tests/subagent-storage.test.ts` 中编写测试：
- 验证数据库升级至 002 迁移，成功创建 `task_attempts`, `task_results`, `event_outbox`, `host_inbox` 表及索引。
- 验证 `TaskAttemptRepository` 创建尝试、更新状态与租约 (`worker_lease`)。
- 验证 `TaskResultRepository` 原子保存成果与证据引用，禁止覆盖相同版本的成果。
- 验证 `OutboxRepository` 在同一事务中随成果写入外发事件，并支持根据游标与投递状态读取。
- 验证按 `run_id + execution_version + host_turn_id + tool_call_id` 进行幂等去重。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/subagent-storage.test.js`
预期: FAIL (表或仓储类未实现)

- [ ] **Step 3: 实现 002 迁移与新增仓储类**

编写 `agent-runtime/src/storage/migrations/002-subagent-tools.sql`：
- 创建 `task_attempts (attempt_id, task_id, run_id, execution_version, status, worker_lease, started_at, completed_at, error_json, usage_json)`
- 创建 `task_results (result_id, run_id, task_id, attempt_id, version, role, status, findings_json, summary, evidence_refs_json, created_at)`
- 创建 `event_outbox (event_id, run_id, task_id, event_type, payload_json, delivered, created_at)`
- 创建 `host_inbox (inbox_id, run_id, event_seq, status, claimed_at, processed_at)`
- 为 tasks 表增加所需字段（若不存在通过 alter table）。
在 `agent-runtime/src/storage/database.ts` 中实现迁移执行机制。
在 `agent-runtime/src/storage/repositories.ts` 中实现对应的 Repository 类和原子事务包装。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/subagent-storage.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/storage/migrations/002-subagent-tools.sql agent-runtime/src/storage/database.ts agent-runtime/src/storage/repositories.ts agent-runtime/src/storage/event-store.ts agent-runtime/tests/subagent-storage.test.ts
git commit -m "feat(storage): add migrations and repositories for task attempts, results and outbox"
```

---

### Task 3: 独立研究工具与异步后台 Worker 引擎

**Files:**
- Create: `agent-runtime/src/tools/research-tools.ts`, `agent-runtime/src/orchestration/research-worker.ts`
- Modify: `agent-runtime/src/tools/delegate-research.ts`, `agent-runtime/src/tools/submit-findings.ts`, `agent-runtime/src/agents/researcher.ts`, `agent-runtime/src/orchestration/scheduler.ts`
- Test: `agent-runtime/tests/research-worker-tools.test.ts`

**Interfaces:**
- Consumes: `ResearchJobParams`, `TaskReceipt`, `ResearchOutcome` from contracts; `TaskRepository`, `TaskAttemptRepository`, `TaskResultRepository`, `OutboxRepository` from storage
- Produces: `createResearchAuthorityTool`, `createResearchEvolutionTool`, `createResearchFeedbackTool`, `createGetResearchResultTool`, `createCancelResearchTaskTool`, `ResearchWorkerPool`

- [ ] **Step 1: 编写独立研究工具与 Worker 执行失败测试**

在 `agent-runtime/tests/research-worker-tools.test.ts` 中编写测试：
- 调用 `research_authority` 工具，校验参数，在事务中写入任务与尝试，返回 `accepted` 回执（携带 `task_id`, `attempt_id`），不阻塞等待执行完成。
- `ResearchWorkerPool` 拉取入队任务，为每个尝试分配独立的 `ResearcherAgent`，具备独立的 AbortController、消息上下文与 BudgetGate。
- 单任务成功：通过受限 `submit_findings` 提交，绑定当前任务身份与 attempt_id，持久化成果并触发外发事件。
- 单任务抛出异常：worker 捕获错误，原子记录 `failed` 成果与外发事件，其他正在执行的任务不受任何影响。
- 兼容验证：旧 `delegate_research` 接收任务列表，内部拆解为独立任务入队，返回包含多个任务回执的数组。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/research-worker-tools.test.js`
预期: FAIL (工具与 WorkerPool 未定义)

- [ ] **Step 3: 实现独立研究工具与 WorkerPool**

在 `agent-runtime/src/tools/research-tools.ts` 中实现：
- `createResearchRoleTool(role, dispatcher)` 分别生成 `research_authority`, `research_evolution`, `research_feedback`。
- `createGetResearchResultTool(resultRepo)` 提供按 `task_id` 查询成果详情。
- `createCancelResearchTaskTool(workerPool)` 支持取消指定任务。
在 `agent-runtime/src/tools/submit-findings.ts` 中增加任务上下文校验，禁止跨角色或跨任务提交。
在 `agent-runtime/src/orchestration/research-worker.ts` 中实现 `ResearchWorkerPool`：管理并发执行槽位 (默认最多 3)，绑定独立超时控制器，捕获执行异常，并在事务中写入 `task_results` 与 `event_outbox`。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/research-worker-tools.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/tools/research-tools.ts agent-runtime/src/orchestration/research-worker.ts agent-runtime/src/tools/delegate-research.ts agent-runtime/src/tools/submit-findings.ts agent-runtime/src/agents/researcher.ts agent-runtime/src/orchestration/scheduler.ts agent-runtime/tests/research-worker-tools.test.ts
git commit -m "feat(orchestration): implement async research tools and isolated worker pool"
```

---

### Task 4: PiAdapter 原生调用 ID 传递、双层预算与任务取消

**Files:**
- Modify: `agent-runtime/src/runtime/pi-adapter.ts`, `agent-runtime/src/runtime/budget-gate.ts`, `agent-runtime/src/orchestration/call-ledger.ts`, `agent-runtime/src/storage/budget-ledger.ts`
- Test: `agent-runtime/tests/dual-budget-cancellation.test.ts`

**Interfaces:**
- Consumes: PiAgentCore `beforeToolCall`, `execute`, `afterToolCall`
- Produces: `PiAgentAdapter` (透传 callId), `BudgetGate` (双层配额: 任务与全局; callId 唯一预留键), `TaskCancellationController`

- [ ] **Step 1: 编写原生 callId、双层预算与取消机制失败测试**

在 `agent-runtime/tests/dual-budget-cancellation.test.ts` 中编写测试：
- 验证 Pi 工具调用执行时，原生 `callId` 完整传递至 `beforeToolCall`, `execute`, `afterToolCall`。
- 验证两个并发同名工具调用 (`search`) 使用各自的 `callId` 单独完成预留与结算，互不覆盖。
- 验证双层预算：当单任务额度达到上限时被拦截；当全局剩余额度不足（保留报告写作额度）时被拦截。
- 验证任务取消：触发单任务取消信号后，关联的 AbortSignal 变为 aborted，已超时的迟到调用被丢弃，不得写入结果。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/dual-budget-cancellation.test.js`
预期: FAIL (callId 未透传或 BudgetGate 未支持双层预算)

- [ ] **Step 3: 改造 PiAdapter 与 BudgetGate**

在 `agent-runtime/src/runtime/pi-adapter.ts` 中：
- 修改工具包装函数，将 Pi 原生 `callId` 传递给 `ResearchToolDefinition.execute(params, signal, callId)` 以及 `beforeToolCall({ name, arguments, call_id })` / `afterToolCall({ name, arguments, call_id }, result)`.
在 `agent-runtime/src/runtime/budget-gate.ts` 中：
- 强制要求预留键使用 `toolCall.call_id`，未提供时生成唯一 UUID，杜绝以 `toolCall.name` 作为键。
- 引入任务级配额校验：`checkTaskQuota(taskId)` 与 `checkGlobalQuota(runId)` 结合。
在 `agent-runtime/src/storage/budget-ledger.ts` 中：
- 支持 task_id 级消耗聚合与剩余预算统计。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/dual-budget-cancellation.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/runtime/pi-adapter.ts agent-runtime/src/runtime/budget-gate.ts agent-runtime/src/orchestration/call-ledger.ts agent-runtime/src/storage/budget-ledger.ts agent-runtime/tests/dual-budget-cancellation.test.ts
git commit -m "feat(runtime): wire native tool callId and enforce dual-tier budget gate"
```

---

### Task 5: HOST 串行收件箱、防抖调度与阶段审查

**Files:**
- Create: `agent-runtime/src/orchestration/host-inbox.ts`
- Modify: `agent-runtime/src/agents/host.ts`, `agent-runtime/src/orchestration/review.ts`, `agent-runtime/src/prompts/host.ts`
- Test: `agent-runtime/tests/host-inbox.test.ts`

**Interfaces:**
- Consumes: `OutboxRepository`, `HostInboxRepository`, `HostAgent`
- Produces: `HostInboxDispatcher`, `formatHostPrompt`, `StageReviewManager`

- [ ] **Step 1: 编写收件箱串行消费与阶段审查失败测试**

在 `agent-runtime/tests/host-inbox.test.ts` 中编写测试：
- 多个研究成果在 300ms 内相继到达，收件箱防抖合并为单次 HOST 唤醒输入，不产生多次模型并发调用。
- HOST 正在执行模型决策期间到达的新结果被保存在队列中，待当前决策完成后由下一次串行轮次处理。
- 校验注入 HOST 的 Prompt 结构：明确包含当前任务状态表、新到达成果摘要/证据、可用余额，不修改底层 system prompt。
- 验证单个 Run 的 HOST 阶段决策调用次数达到上限（默认 12 次）时自动转为暂停或提示终审，防止无限决策。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/host-inbox.test.js`
预期: FAIL (HostInboxDispatcher 未实现)

- [ ] **Step 3: 实现 HostInboxDispatcher 与 HOST 阶段调度**

创建 `agent-runtime/src/orchestration/host-inbox.ts`：
- `HostInboxDispatcher` 类：管理事件防抖计时器 (500ms) 与串行互斥锁 (`activeHostInvocation`)。
- 实现 `formatHostPrompt(runId, pendingEvents, snapshot)`：结构化生成“本次变化”、“当前计划”、“新成果”、“可用额度”与“请决定”数据块。
- 在 HOST 空闲时执行 `hostAgent.run(prompt)`，记录决策快照至 `host_decisions`，标记相关收件箱事件已处理。
- 限制单个 Run 决策上限为 12 次。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/host-inbox.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/orchestration/host-inbox.ts agent-runtime/src/agents/host.ts agent-runtime/src/orchestration/review.ts agent-runtime/src/prompts/host.ts agent-runtime/tests/host-inbox.test.ts
git commit -m "feat(orchestration): implement host inbox with debounced serialized dispatch"
```

---

### Task 6: 研究修订上限 (generation <= 3)、材料快照与报告放行门禁

**Files:**
- Create: `agent-runtime/src/orchestration/release-gate.ts`
- Modify: `agent-runtime/src/orchestration/planning.ts`, `agent-runtime/src/orchestration/review.ts`, `agent-runtime/src/reporting/input.ts`
- Test: `agent-runtime/tests/release-gate.test.ts`

**Interfaces:**
- Consumes: `TaskRepository`, `TaskResultRepository`, `EvidenceStore`, `ReleaseRequest`
- Produces: `ReleaseGate`, `ReleaseVerificationResult`, `freezeMaterialSnapshot`

- [ ] **Step 1: 编写修订上限与放行门禁失败测试**

在 `agent-runtime/tests/release-gate.test.ts` 中编写测试：
- 针对同一核心问题的补查任务，generation 递增；达到 generation=3 后禁止再次派发同质补查任务。
- `ReleaseGate.verifyRelease` 严格检查：
  1. 所有标记 `required_for_report=true` 的任务具有已接受成果或明确的缺口记录；
  2. 未调用角色具有明确 `not_applicable` 记录，无虚构数据；
  3. 没有处于 `running` 或 `queued` 的必要任务；
  4. 成果中所有主张引用均可在证据库中解析。
- 放行通过后生成不可变 `MaterialSnapshot`，后续到来的迟到结果不可注入已放行的快照。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/release-gate.test.js`
预期: FAIL (ReleaseGate 未定义)

- [ ] **Step 3: 实现 ReleaseGate 与材料快照冻结**

在 `agent-runtime/src/orchestration/release-gate.ts` 中实现：
- `ReleaseGate` 类：提供 `verifyRelease(runId, releaseRequest)` 方法，执行 6 项标准门禁检查，返回 `{ ok: boolean, snapshotId?: string, gaps: string[], restricted: boolean }`。
- 实现 `freezeMaterialSnapshot(runId)`：将当前已接受成果、主张及证据打包为冻结版本并写入持久层。
在 `agent-runtime/src/orchestration/planning.ts` 与 `review.ts` 中增加 generation 校验，超过上限抛出或拒绝修订。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/release-gate.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/orchestration/release-gate.ts agent-runtime/src/orchestration/planning.ts agent-runtime/src/orchestration/review.ts agent-runtime/src/reporting/input.ts agent-runtime/tests/release-gate.test.ts
git commit -m "feat(orchestration): implement release gate and material snapshot freezing"
```

---

### Task 7: Coordinator 闭环装配、服务入口与 API/SSE 适配

**Files:**
- Modify: `agent-runtime/src/orchestration/coordinator.ts`, `agent-runtime/src/server.ts`, `agent-runtime/src/api/routes.ts`, `agent-runtime/src/api/sse.ts`, `agent-runtime/src/api/dashboard.ts`
- Test: `agent-runtime/tests/e2e-subagent-tools.test.ts`

**Interfaces:**
- Consumes: `ResearchWorkerPool`, `HostInboxDispatcher`, `ReleaseGate`, `ReportAgent`
- Produces: `ResearchCoordinator.startRun`, `ResearchCoordinator.resumeRun`, Express API 路由及实时 SSE 事件推送

- [ ] **Step 1: 编写端到端装配与 API/SSE 失败测试**

在 `agent-runtime/tests/e2e-subagent-tools.test.ts` 中编写测试：
- API 创建 Run 后，仅保存主题并启动 HOST，不再自动预设三方任务。
- HOST 调用 `research_authority` 工具，触发 Worker 后台执行并返回回执。
- Worker 完成后出具成果并送入 Outbox，HostInbox 消费并重新唤起 HOST 审查。
- HOST 申请报告放行，ReleaseGate 校验通过后调用 Report Agent 生成最终专报。
- 验证 SSE 端点推送独立任务的状态转移事件 (`queued` -> `running` -> `succeeded`)。

- [ ] **Step 2: 运行测试并验证失败**

运行: `cd agent-runtime && npm test -- tests/e2e-subagent-tools.test.js`
预期: FAIL (Coordinator 尚未装配 Worker 与 Inbox)

- [ ] **Step 3: 装配 Coordinator 与 Server 服务**

在 `agent-runtime/src/orchestration/coordinator.ts` 中：
- 整合 `ResearchWorkerPool`, `HostInboxDispatcher`, `ReleaseGate`。
- 修改 `createRun`：移除强制初始化 3 个固定任务，改为保存 Run 并派发初始 HOST 任务。
- 增加服务重启恢复逻辑：扫描未完成的 attempts 和未投递的 outbox 事件。
在 `agent-runtime/src/server.ts` 与 `routes.ts` 中注入新组件，更新 SSE 推送事件结构与 Dashboard 页面支持独立任务状态。

- [ ] **Step 4: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/e2e-subagent-tools.test.js`
预期: PASS

- [ ] **Step 5: 提交代码**

```bash
git add agent-runtime/src/orchestration/coordinator.ts agent-runtime/src/server.ts agent-runtime/src/api/routes.ts agent-runtime/src/api/sse.ts agent-runtime/src/api/dashboard.ts agent-runtime/tests/e2e-subagent-tools.test.ts
git commit -m "feat(server): assemble coordinator with worker pool, host inbox and sse updates"
```

---

### Task 8: 14 大验收场景验证与回归测试

**Files:**
- Create: `agent-runtime/tests/acceptance-scenarios.test.ts`
- Modify: `agent-runtime/tests/orchestration-migration.test.ts`, `agent-runtime/tests/e2e-node-migration.test.ts` (保持回归兼容)
- Test: 全量测试集 `npm test`

**Interfaces:**
- Consumes: 全量系统模块
- Produces: 覆盖设计文档第 11 节中 14 个完整验收场景的测试套件

- [ ] **Step 1: 编写 14 大验收场景测试**

在 `agent-runtime/tests/acceptance-scenarios.test.ts` 中实现：
1. 同时启动三任务：一成功、一慢、一失败；成功先通知 HOST，慢任务继续，失败不取消同伴。
2. 仅调用单个角色（如 feedback）：不创建其他角色，不等待未调用角色。
3. 同一角色并发独立任务：上下文、取消与预算互不覆盖。
4. 单任务超时：超时后不可写，其他任务正常，迟到结果丢弃。
5. 取消单任务 vs 取消整个 Run。
6. 重复工具调用回执与完成事件幂等去重。
7. 双完成事件同时到达：防抖或串行处理，无并发 HOST。
8. HOST 忙碌时事件排队入队，空闲后处理，无忙轮询。
9. 崩溃重启恢复未投递事件与租约。
10. 文件数据库恢复，不依赖内存状态。
11. 单任务配额、全局总额度与报告预留有效性。
12. 必需角色失败（暂停）vs 可选角色失败（受限交付）。
13. 同一问题 generation > 3 禁止无限补查。
14. 放行后材料快照不可变性。

- [ ] **Step 2: 运行测试并验证通过**

运行: `cd agent-runtime && npm run build && npm test -- dist/tests/acceptance-scenarios.test.js`
预期: PASS

- [ ] **Step 3: 运行全量测试套件回归验证**

运行: `cd agent-runtime && npm test`
预期: 所有测试（包括现有 114 个测试与新增场景）全部通过，0 失败。

- [ ] **Step 4: 提交代码**

```bash
git add agent-runtime/tests/acceptance-scenarios.test.ts agent-runtime/tests/orchestration-migration.test.ts agent-runtime/tests/e2e-node-migration.test.ts
git commit -m "test: add comprehensive acceptance test suite covering 14 isolation scenarios"
```
