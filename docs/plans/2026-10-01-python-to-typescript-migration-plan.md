# BettaFish Python 配套模块迁移到 TypeScript 实施计划

> **执行说明：** 按任务逐项实施；Pi 重构已由用户确认完成，本计划不重新实施 Pi 内核或 Agent 角色重构。

**Goal:** 复用现有 `agent-runtime/` 的 Pi 能力，将仍依赖 Python 的调度、存储、工具、API、报告适配和导出迁移到 TypeScript，使新流程仅需 Node.js。

**Architecture:** 在现有 `agent-runtime/` 内增加业务模块，逐步以本地 TS 接口替换 Python HTTP 桥接。Pi Agent 的调用方式、角色和提示词保持为迁移基础；调度状态、证据、预算与导出由同一 Node 应用持有。

**Tech Stack:** 现有 Node.js / TypeScript / Pi；TS 契约校验、SQLite、HTTP API 与事件流；TS 文档渲染和现有 Node 测试体系。

---

## 1. 范围与代码参考

日期：2026-10-01。用户已确认 Pi 重构完成；本次只规划后续 TS 迁移，不重复 Pi 安装、SDK 选型、Agent 循环、角色提示词及初始多 Agent 架构建设。

最近提交 `114541b` 中已包含：

- `agent-runtime/src/runtime/pi-adapter.ts`、`budget-gate.ts`。
- `agent-runtime/src/agents/host.ts`、`researcher.ts`、`verifier.ts`、`report.ts`。
- `agent-runtime/src/prompts/`、`contracts/research.ts` 及 Agent 相关测试。
- Python `ResearchEngine/` 的存储、预算、调度、工具、评审、API 和恢复实现。
- `ReportEngine/` 的研究输入适配、IR 和 DOCX 导出实现。

上述是已打开的提交快照，不是本次重新测试的结果。当前工作区多份源码为空，所以路径与行为以该提交作为计划参考；本次不恢复文件、不修改代码、不覆盖未提交内容。执行迁移前先确认真实可用的工作区或分支，不能把空文件当待迁移实现。

**复用而非重建：**

| 已有资产 | 本计划处理方式 |
|---|---|
| Pi 适配、HOST/研究/核验/Report 实例 | 直接复用，仅替换其依赖的预算、提交及工具回调 |
| Agent 角色、提示词和现有测试 | 保留，作为迁移回归基线 |
| `PythonToolClient` | 待本地工具覆盖后从标准调用链移除 |
| Python `ResearchEngine` | 按职责迁移为现有 TS 应用内模块 |
| Python `ReportEngine` | 迁移输入适配、IR 校验和渲染；不重写 Pi Report 的研究写作逻辑 |
| 已有数据库、模板、静态资产 | 读取和迁移样本，保留来源与版本 |

不另建 `ts-app/`，不复制一套 Pi 执行服务；所有新运行模块落在 `agent-runtime/src/`。不删除旧 Python 项目，不安排爬虫全面改写，不新增常驻 Agent。

## 2. 里程碑与依赖

| 里程碑 | 任务 | 验收成果 |
|---|---|---|
| M1 核心迁移 | 1—3 | TS 契约、数据库、证据与预算可供现有 Pi 调用 |
| M2 研究脱离 Python | 4—5 | TS 调度和工具接入原 Agent，三轮闭环可独立运行 |
| M3 报告脱离 Python | 6 | 现有 Report 输出通过 TS IR 校验和导出 |
| M4 入口切换 | 7—8 | TS API、页面、恢复取消及 Node-only 验收完成 |

依赖：`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8`。每任务按关键场景写测试、确认缺失行为、最小实现、通过检查，再形成独立提交。文档阶段不执行这些动作。

所有构建/测试命令在 `agent-runtime/` 执行。沿用并修正现有 `npm run build` 和 `npm test`，新增 `npm run typecheck`；测试脚本必须发现全部编译测试文件。普通测试使用现有脚本化模型，真实模型及收费工具测试单独启用。

## Task 1：沿用现有契约，补齐 TS 业务结构

**新增**：`src/contracts/run.ts`、`task.ts`、`evidence.ts`、`review.ts`、`artifact.ts`、`tests/migration-contracts.test.ts`。

**修改**：`src/contracts/research.ts`（复用原角色与成果定义，不破坏现有 Agent 接口）、`package.json`（检查脚本）。

**参考**：Python `ResearchEngine/schema.py`、`contracts.py`；已有 `contracts/fixtures/research-v1.json`。

1. 列出 Python 与 TS 的字段、状态、枚举和实际调用差异；冻结迁移输入/输出样本。
2. 将尚在 Python 定义的 Run、Task、Evidence、Review、Artifact 契约迁入 TS；已有 TS 契约直接复用。
3. 增加运行时校验，统一 Schema 版本与引用归属；必要新增依赖只为缺失校验能力，不改变 Pi 工具协议。
4. 原测试继续使用原导出名称；新状态与历史状态不兼容时提供显式读取适配，不强行改写历史记录。

**测试**：有效样本、错误角色、第四轮、异运行引用、历史字段适配及明确的数据不足成果。

**命令**：`npm run build`、`npm run typecheck`、`npm test`。

**完成条件**：一个业务契约来源；无需 Python 生成或校验标准运行的消息。

## Task 2：迁移 SQLite、证据和持久化事件

**新增**：`src/storage/database.ts`、`migrations/001-research.sql`、`repositories.ts`、`evidence-store.ts`、`event-store.ts`、`tests/storage-migration.test.ts`。

**参考**：`ResearchEngine/storage.py`、`evidence.py`、`events.py`。

1. 按实际 Python 表结构建立 TS 数据层；验证驱动、事务和运行时兼容。
2. 新运行使用独立版本化 TS 数据库；默认不原地改旧库。历史记录需继续使用时，先从副本导入并核对计数、版本及引用。
3. 迁移证据、材料路径、提交幂等与事件序号，确保所有读写按 run_id 隔离。
4. 成果、阶段和事件在同一短事务持久化；成果版本不可覆盖。
5. 保留原始材料文件和内容指纹，不把材料全文全部放入模型上下文。

**测试**：重复提交、跨运行读取拒绝、事务回滚、材料恢复、事件顺序；历史副本导入前后引用一致。

**命令**：`npm test`。

**完成条件**：现有 Pi 的提交回调可直接持久化到 TS repository，无 Python HTTP 提交接口。

## Task 3：迁移预算并绑定现有 BudgetGate

**新增**：`src/storage/budget-ledger.ts`、`src/orchestration/call-ledger.ts`、`tests/budget-migration.test.ts`。

**修改**：`src/runtime/budget-gate.ts`（迁移所需的账本绑定及调用标识）。

**参考**：`ResearchEngine/budget.py`、`storage.py`。

1. 将额度检查、预留、结算、费用记录及写作预留迁到 TS 数据层。
2. 为现有 BudgetGate 注入本地 reserve/settle 回调；按 call_id 跟踪预留，不能按工具名称存唯一预留导致同名并发互相覆盖。
3. 模型请求和工具请求都受预算约束；失败和重试计入消费，未知费用显式保留。
4. 调用先记录意图再执行；崩溃后结果未知的预留不得无条件释放，恢复不重置预算。

**测试**：两调用争抢最后额度、同名工具并发、重复结算、失败消费、写作预留和未知结果恢复。

**命令**：`npm test`。

**完成条件（M1）**：原 Agent 能使用 TS 账本控制执行，不依赖 Python budget API。

## Task 4：迁移规划、调度、评审和恢复

**新增**：`src/orchestration/planning.ts`、`scheduler.ts`、`coordinator.ts`、`submissions.ts`、`review.ts`、`recovery.ts`；`tests/orchestration-migration.test.ts`。

**修改**：`src/tools/delegate-research.ts`、`submit-findings.ts`（绑定本地服务，不重写 Agent 本身）。

**参考**：`ResearchEngine/planning.py`、`scheduler.py`、`coordinator.py`、`submissions.py`、`review.py`、`recovery.py`、`verification.py`。

1. 将 Python 状态机、所需任务屏障和三方并发迁为 TS 异步调度；复用已有 HOST/研究/核验实例及提示词。
2. 委托工具绑定本地创建任务函数；提交工具绑定本地校验和存储。持久化成功才算提交，普通文本响应不算完成。
3. HOST 在成果汇合后被唤醒；核验记录和主张版本入库，定向补查仅启动相关角色。
4. 最多三轮、允许提前放行；沿用角色成果版本，失败重试不增加轮次。
5. 暂停/恢复/取消采用执行版本和安全检查点；迟到返回丢弃但消费记录保留。

**测试**：受控三方并发、只补查一方、第三轮禁止追加、执行失败暂停、数据不足有效提交、重启恢复、取消后的迟到响应。

**命令**：`npm test`；原 Agent 与角色测试继续通过。

**完成条件**：状态和恢复仅由 TS 控制，Python Coordinator 不参与新运行。

## Task 5：迁移工具并移除 PythonToolClient 依赖

**新增**：`src/tools/registry.ts`、`search.ts`、`read-source.ts`、`database.ts`、`timeline.ts`、`feedback.ts`、`tests/local-tools.test.ts`。

**修改**：`src/server.ts`（装配本地依赖）、原 Agent 工具注入位置；保留 `python-client.ts` 至入口切换验收完成。

**参考**：`ResearchEngine/tools.py`、`tool_routes.py`；旧 Query/Media/Insight 搜索与数据库连接器。

1. 搜索与正文读取改为 TS 直接调用服务；数据库查询为只读参数化连接器，模型不传任意 SQL。
2. 迁移时间序列和评论样本处理，保留范围、指标、分母、数据时效和错误类型。
3. 情绪分类用现有模型访问能力封装 TS 工具；如需要迁移原 Python 分类器，单独评估，不使其成为标准流程依赖。
4. 用相同响应样本比较 Python 与 TS 的归一化结果；只凭摘要不能标为已读正文。
5. 把既有 Pi Agent 的工具回调从 PythonToolClient 替换为本地工具注册表；原文地址与材料内容遵循权限边界。

**测试**：超时、零结果、数据不可得、摘要/正文分类、转引去重和无真实网络的工具回归。

**命令**：`npm test`；另做一轮明确预算的真实供应商集成验证。

**完成条件（M2）**：已有 Pi 能在无 Python 服务的环境完成研究、核验及补查；不安排重新实现 Pi 循环。

## Task 6：迁移报告输入、IR 校验和导出

**新增**：`src/reporting/input.ts`、`ir-validator.ts`、`artifacts.ts`、`renderers/html.ts`、`markdown.ts`、`pdf.ts`、`docx.ts`、`export-queue.ts`、`tests/report-migration.test.ts`、`tests/export-migration.test.ts`。

**修改**：现有 `src/agents/report.ts` 的外部依赖装配（仅需适配时），保留其写作能力。

**参考**：`ResearchEngine/report_input.py`、`final_check.py`；`ReportEngine/core/research_input_adapter.py`、`ir/schema.py`、`ir/validator.py`、`renderers/` 和实验室模板。

1. TS 按显式成果版本构造输入，调用现有 Pi Report，不再调用 Python ReportAgent。
2. 迁移终稿检查和 IR 校验，保留依据/限制、风险建议和摘要生成顺序；写作修改不增加研究轮次。
3. TS 实现 HTML/Markdown、Chromium PDF、DOCX 导出；模板及资产直接复用，候选依赖先核对能力。
4. 导出状态独立，失败只重试导出；未支持 IR 块显式报错。
5. 在样稿上核对中文字体、层级、分页和原生引用；历史报告用固定 IR 做输出对照。

**测试**：异运行输入拒绝、主张引用、缺失块报错、导出重试不重跑 Agent；另有格式视觉验收记录。

**命令**：`npm test`；PDF/DOCX 视觉检查分别执行并记录。

**完成条件（M3）**：现有 Report 能完成标准交付，全程无 Python 写作和渲染器。

## Task 7：将 Flask 研究入口迁到 TS API 与页面

**新增**：`src/api/runs.ts`、`events.ts`、`exports.ts`、`src/web/index.html`、`research.ts`、`tests/api-migration.test.ts`。

**修改**：`src/server.ts`、`package.json`（统一启动命令）。

**参考**：`ResearchEngine/flask_routes.py`、`app.py` 的研究入口、`static/research.js`。

1. 同一 Node 服务提供创建/查询研究、pause/resume/cancel、事件与导出接口，保持必要的前端字段兼容。
2. 现有服务器启动方式按需扩展为业务入口；不再额外启动一个与其重复的 Pi 服务。
3. 事件从 TS 存储重放，浏览器断开/刷新不重启任务；页面显示三方、核验、预算和报告状态。
4. 注册生产模型配置到现有 Pi 适配层；脚本化模型仍只用于测试，公共创建任务接口不接受测试脚本参数。
5. API 请求校验、身份/运行访问范围及模型密钥处理在 TS 完成；不继续依赖 Flask 认证或隐藏代理。

**测试**：API 契约、幂等创建、事件续读、刷新、取消、暂停恢复、结果下载；兼容字段变化有明确说明。

**命令**：`npm run build`、`npm test`；页面交互检查。

**完成条件**：前端连接 Node 新入口即可使用，Flask 不参与新请求链。

## Task 8：完成 Node-only 切换与迁移回归

**新增**：`tests/node-only-e2e.test.ts`、`evaluation/migration-cases.json`、`docs/typescript-runtime.md`。

**修改**：`package.json`、启动与部署说明；确认无需兼容后从标准装配移除 `python-client.ts` 和旧内部 HTTP 路径。

1. 停止 Python 进程后创建研究，覆盖三方、HOST 补查、Report、四种导出、暂停恢复和取消。
2. 审查生产调用链，不出现 PythonToolClient、Python subprocess 或 Flask 必需地址；区分数据库/模型外部服务与 Python 内核依赖。
3. 固定迁移样本比较主张、证据、轮次、限制和模板，避免迁移改变业务语义；不重做 Pi 架构选型评估。
4. 提供统一 Node 启动、模型/数据库配置、浏览器依赖、材料持久化及回退说明；回退旧入口只针对旧运行，禁止两系统同时写同一库。
5. 新旧数据库和材料保持隔离。未提交改动、历史库及 Python 项目不自动清除；退役另行安排。

**命令**：`npm run typecheck`、`npm run build`、`npm test`；真实模型 Node-only 验收单独运行并记录费用。

**完成条件（M4）**：可独立启动的 TS 产品入口、迁移行为回归和导出验收齐备；没有仅靠模拟测试宣称生产闭环完成。

## 3. 本次明确不再安排的任务

- 重新安装/选型 Pi，重写 SDK 适配层或 Agent 循环。
- 重新设计三个研究角色、HOST/Report 提示词和整体会商架构。
- 新建一套 Python 调度内核或 Python/TS 内部桥接服务。
- 再创建 `ts-app/` 并复制现有 `agent-runtime/`。
- 自动恢复空源码、覆盖用户当前修改，或删除旧项目。

先完成任务1—3，交付能接入既有 Pi 的 TS 数据与预算核心；之后逐项替换剩余 Python 依赖。本计划只规划迁移，尚未执行代码变更。
