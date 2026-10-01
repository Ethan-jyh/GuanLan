# Pi Agent Core 技术基线兼容性与验证记录

- **记录日期**：2026-10-01
- **环境基线**：Node.js v24.11.1 / npm 11.6.2 / macOS Darwin
- **关联计划**：`docs/plans/2026-10-01-pi-research-implementation-plan.md` (Task 1)

---

## 1. 锁定的核心包与版本

通过 npm registry 验证官方发布包（`earendil-works` / `pi` 生态），依赖已锁定在 `agent-runtime/package.json` 与 `package-lock.json`：

| 包名 | 锁定版本 | 许可证 | 职责 |
|---|---|---|---|
| `@earendil-works/pi-agent-core` | `0.99.2` | MIT | Agent 循环调度、事件分发（`agent_start`, `tool_execution_*`, `agent_end`）、状态与队列管理 |
| `@earendil-works/pi-ai` | `0.99.2` | MIT | 多模型/多供应商协议适配、流式事件流封装、结构化工具调用声明与测试 Mock 辅助 |

---

## 2. 运行时与执行层架构设计

在 `agent-runtime/src/runtime/pi-adapter.ts` 中封装 `PiAgentAdapter`，形成与具体业务逻辑解耦的轻量执行契约：

1. **工具定义契约 (`ResearchToolDefinition`)**：
   - 暴露 `name`, `description`, `parameters` (JSON Schema) 和 `execute(params, signal)`；
   - 自动映射为 Pi Core 的 `AgentTool`，统一捕获工具异常并格式化为 `isError: true` 的结构化结果，保障 Agent 循环不因工具崩溃而中断。
2. **预算钩子接口 (`beforeToolCall` / `afterToolCall`)**：
   - `beforeToolCall`: 支持检查当前剩余 Token/次数配额；可返回 `{ block: true, reason: string }` 阻断执行。
   - `afterToolCall`: 用于用量统计与审计日志落盘。
3. **确定性测试桩 (`createScriptedStreamFn`)**：
   - 基于 `@earendil-works/pi-ai` 的 `fauxAssistantMessage` 和 `fauxToolCall`，支持纯离线单测编排模型动作序列（如：第一轮调用搜索 $\rightarrow$ 收到工具返回 $\rightarrow$ 结合观察输出最终结论），执行测试零消耗外部模型额度。

---

## 3. 测试与验证结果

执行命令：
```bash
cd agent-runtime
npm ci
npm run build
npm test
```

### 验证证据记录
- **测试套件**：`dist/tests/pi-adapter.test.js`
- **运行器**：Node.js 内置测试套件 (`node --test`)
- **通过用例**：
  1. `should execute a scripted model loop: call search tool, receive observation, then complete`（验证完整搜索与工具结果回传观察闭环）
  2. `should handle tool error signal gracefully without crashing the loop`（验证网络或工具异常时安全记录错误并不退出进程）
  3. `should support beforeToolCall and afterToolCall hooks for budget control`（验证工具执行前拦截与后置核算钩子正常触发）
- **结果统计**：`pass 3 / fail 0 / duration ~130ms`

---

## 4. 结论与下游指引

Pi Agent Core 0.99.2 与 BettaFish 跨语言执行设计完全兼容，满足 Task 1 验收条件。可以安全进入 Task 2（定义跨语言契约和研究状态）。
