# BettaFish Pi 三方研究架构 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 用 Pi 执行层实现 HOST 调度、三位研究 Agent 并行、最多三轮核验补查及 Report Agent 综合研判，保留现有 Python 数据工具和文档渲染能力。

**Architecture:** Python 应用持有唯一调度状态、预算和证据记录；Node.js/TypeScript 服务承载 Pi Agent 实例，通过内部 HTTP 调用 Python 工具。HOST 决策由程序校验后执行，三位研究员提交结构化成果后等待；Report 根据已放行的版本生成判断及 Document IR。

**Tech Stack:** Python、Flask、Pydantic、SQLite；Node.js、TypeScript、Pi Agent Core / Pi AI；Node 内置测试运行器、Python unittest；现有 HTML/PDF/Markdown 渲染器及待新增 DOCX 渲染器。

---

## 执行边界与源码基线

- 本计划仅为实施文档，尚未执行任何代码迁移。源码基线 `6c32b6b`，日期 2026-10-01。
- 依据：[架构设计](/Users/air/Desktop/Project/BettaFish/docs/design/2026-10-01-main-subagent-research-design.md)。设计中的预算数值是可配置建议，执行时不改成无条件固定额度。
- 新系统使用 `ResearchEngine/` 保存 Python 调度与数据接口，`agent-runtime/` 保存 Pi 执行服务，避免直接改坏旧 ForumEngine 协议。
- 新角色为 `authority`、`evolution`、`feedback`，旧 `query/media/insight` 保留旧模式含义，不按名称直接映射。新模式不会要求三方再各写一份完整文章。
- 模式选择为 `legacy` / `pi_research`，迁移完成和评估通过前默认旧模式。同一 `run_id` 只属于一种模式，不同时调用旧论坛监控与新调度器。
- 现有模块路径已核查；以下标为“新增”的文件、接口、命令及测试都是待实现目标。Pi 的确切发布版本、运行时要求和 API 先由任务1验证，不预设版本号。
- 实施时每个任务完成并通过相应检查后形成独立提交；本次文档阶段不提交代码、不安装依赖、不启动服务。无需为文档编辑创建工作树。

## 里程碑与依赖

| 里程碑 | 任务 | 完成标志 |
|---|---|---|
| M1 单 Agent 可运行 | 1—5 | Pi 能读取真实工具结果后补查或提交，证据落库且预算有效 |
| M2 三方会商可运行 | 6—8 | 三方并发、HOST 核验、定向补查，最多三轮 |
| M3 研究到报告闭环 | 9—10 | 有依据的风险与建议进入有效 IR，终稿检查及格式导出通过 |
| M4 可交付与可评估 | 11—12 | 页面可使用，取消/恢复可靠，单/多 Agent 对照有记录 |

依赖顺序：`1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12`。任务3中的数据适配与任务4中的 Pi 工具适配可分别准备，但接口以任务2契约为准。不要在预算与提交机制完成前接入无界真实模型循环。

每个任务均遵循：写关键行为测试 → 确认测试因目标行为未实现而失败 → 最小实现 → 测试通过 → 更新接口说明并提交。下列测试文件内含多种场景，实施时逐个场景推进，不一次写完整系统。

## Task 1：验证并锁定 Pi 技术基线

**文件**

- 新增：`agent-runtime/package.json`、`agent-runtime/package-lock.json`、`agent-runtime/tsconfig.json`。
- 新增：`agent-runtime/src/runtime/pi-adapter.ts`、`agent-runtime/tests/pi-adapter.test.ts`。
- 新增：`docs/plans/pi-runtime-compatibility.md`。

**步骤**

1. 核对官方发布版本及 Node.js 要求，记录包名、版本、支持的模型服务和许可证，固定依赖与锁文件。
2. 先写脚本化模型测试：模型第一轮要求调用搜索工具，收到指定工具结果后才输出完成响应。
3. 用 Pi 核心接入该测试模型；验证工具结果回传、事件顺序、自定义工具、终止及错误信号。业务适配只依赖这一层，不在每个角色中重复包 API。
4. 增加可选真实模型冒烟测试，验证项目所用模型服务的工具调用及认证方式；密钥读取环境变量，不放入测试记录。
5. 记录会话保存/恢复和工具调用钩子的可用接口。若存在不兼容，先调整执行层适配设计，不继续下游集成。

**验证**

从 `agent-runtime/` 执行 `npm ci`、`npm run build`、`npm test`。计划中的 `npm test` 使用 Node 内置测试运行器执行已编译测试，默认使用测试模型，禁止自动消耗真实模型额度。

**验收**：有锁定版本和成功调用证据；同一次循环确实使用工具观察；不只是模型说“已经搜索”。

## Task 2：定义跨语言契约和研究状态

**文件**

- 新增：`ResearchEngine/__init__.py`、`ResearchEngine/schema.py`、`ResearchEngine/contracts.py`。
- 新增：`contracts/research-v1.schema.json`、`contracts/fixtures/research-v1.json`。
- 新增：`agent-runtime/src/contracts/research.ts`。
- 新增：`tests/test_research_contracts.py`、`agent-runtime/tests/contracts.test.ts`。

**步骤**

1. 将设计中的 Run、ResearchTask、Evidence、Claim、ResearchResult、角色专属成果、Verification、ReportJudgment 和 Artifact 写成 Pydantic 模型。
2. 约定外部包络字段：`schema_version/run_id/task_id/call_id/execution_version/idempotency_key`。证据与主张引用必须属于当前运行；时间使用含时区的标准格式。
3. 状态定义为 `planning/researching/reviewing/approved/writing/final_check/completed/paused/cancelled`；子任务状态独立定义，不用全局状态代替每个研究员状态。
4. Pydantic 导出 JSON Schema，TypeScript 按同一 Schema 校验。两端测试读取相同样本，拒绝未知角色、第四轮、缺少范围及无效引用。
5. 研究轮次初始为1，记录每轮评审状态。只有评审有效完成才形成该轮记录；重试同一轮不增加次数。

**验证**：`python -m unittest discover -s tests -p 'test_research_contracts.py' -v`；TypeScript 执行 `npm test`。

**验收**：Python 与 TypeScript 对相同输入得出一致校验结果；数据不足可表达为有效但带限制的成果。

## Task 3：封装 Python 工具及证据存储

**文件**

- 参考复用：`QueryEngine/tools/search.py`、`MediaEngine/tools/search.py`、`InsightEngine/tools/search.py`、`InsightEngine/tools/sentiment_analyzer.py`。
- 新增：`ResearchEngine/tools.py`、`ResearchEngine/tool_routes.py`、`ResearchEngine/evidence.py`。
- 新增：`tests/test_research_tools.py`、`tests/test_research_evidence.py`。

**步骤**

1. 封装 `search_web/read_source/query_posts/query_comments/analyze_sentiment/get_timeline`；仅公开明确参数，不接受模型任意 SQL。
2. `read_source` 实际读取正文；搜索摘要单独标记。数据不支持某工具时返回结构化 `data_unavailable`，不编造时间序列。
3. 保存来源、正文引用、检索日期、来源日期、平台、采样/去重与分母。统计工具标明查询范围和数据覆盖，不把抓到的记录总量称为全网量。
4. HTTP 工具接口为 `POST /api/research/internal/tools/{tool_name}`；部署时使用内部服务凭证及访问范围限制，浏览器不能获得内部凭证。
5. 按规范化来源和内容指纹复用材料，保留同源转引关系；不同运行可以复用缓存但不能混用证据编号。

**验证**：`python -m unittest discover -s tests -p 'test_research_tools.py' -v`；再执行 `test_research_evidence.py`。

**验收**：超时、缺少数据、工具错误与“未发现相关结果”可区分；每条正文可回到原始材料；测试不依赖在线采集。

## Task 4：建立预算账本与 Pi 工具桥接

**文件**

- 新增：`ResearchEngine/storage.py`、`ResearchEngine/budget.py`。
- 新增：`agent-runtime/src/tools/python-client.ts`、`agent-runtime/src/runtime/budget-gate.ts`。
- 新增：`tests/test_research_budget.py`、`agent-runtime/tests/python-client.test.ts`。

**步骤**

1. 新任务使用独立 `research.sqlite3`，初始化运行、子任务、证据、调用、预算和提交表，不修改旧论坛库。
2. 模型及工具调用前原子预留预算；调用后结算实际用量。费用未知时保留估算/未知标识，不能按0收费处理。
3. 并发调用抢同一剩余额度时只有合法预留者可执行；失败、重试都计入预算，重复幂等请求不重复执行。
4. TypeScript 客户端发送任务包络，读取 Python 结构化结果并交回 Pi；统一处理超时与错误类型。
5. 模型调用前和工具执行前均接入预算检查；预留写作与终稿检查额度，额度耗尽后提交限制或暂停按设计区分。

**验证**：`python -m unittest discover -s tests -p 'test_research_budget.py' -v`；TypeScript `npm test`。

**验收**：两个实例不能同时花掉最后一次额度；请求超时后的实际返回不会被记为第二次工具调用。

## Task 5：打通单研究 Agent 的有界循环

**文件**

- 新增：`agent-runtime/src/agents/researcher.ts`、`agent-runtime/src/prompts/authority.ts`。
- 新增：`agent-runtime/src/tools/submit-findings.ts`、`agent-runtime/src/server.ts`。
- 新增：`ResearchEngine/runtime_client.py`、`ResearchEngine/submissions.py`。
- 新增：`agent-runtime/tests/researcher.test.ts`、`tests/test_research_submissions.py`。

**步骤**

1. 用权威口径角色打通第一个完整任务；配置只读工具、独立上下文及成果 Schema。
2. 模型通过原生工具调用搜索/读取原文，通过 `submit_findings` 提交；不再解析自定义“思考—行动”文本。
3. 提交工具先请求 Python 校验和持久化；失败则返回具体错误允许修正，成功后结束本次研究调用。
4. 无工具调用的普通文本不自动视为有效成果；未提交的运行保留不完整状态，在预算内提示提交，超限按规则结束。
5. 脚本化测试覆盖补查、提前提交、无收益重复搜索、数据不足及错误后修正；短理由记录足够，不存储隐含思维链。

**验证**：TypeScript `npm test`；`python -m unittest discover -s tests -p 'test_research_submissions.py' -v`。

**验收（M1）**：同一任务从工具原文到成果中的证据引用完整闭环；持久化提交成功才算完成。

## Task 6：接入另外两位角色与三方并发

**文件**

- 新增：`agent-runtime/src/prompts/evolution.ts`、`agent-runtime/src/prompts/feedback.ts`。
- 新增：`ResearchEngine/scheduler.py`、`ResearchEngine/coordinator.py`。
- 新增：`tests/test_research_scheduler.py`、`agent-runtime/tests/role-boundaries.test.ts`。

**步骤**

1. 演化角色要求指标/窗口/阶段依据；反馈角色要求样本/分母/观点情绪诉求，完善各自工具范围。
2. 首轮创建三项研究任务并并发启动，各自拥有独立 Pi 实例及上下文；共享材料缓存，不共享首轮结论。
3. 汇合条件使用本轮 `required_tasks`，所需任务全部有效提交后才可评审。简单任务未启用角色显式记录 N/A。
4. 用可控阻塞的测试客户端证明第三个任务能在第一个完成前启动；不靠耗时猜测并行。
5. 任一必要任务执行失败则暂停运行；数据不足的有效提交可进入评审，二者不能混淆。

**验证**：`python -m unittest discover -s tests -p 'test_research_scheduler.py' -v`；TypeScript `npm test`。

**验收**：并发上限为3；不将三方分成境内/境外章节；公众样本比例与热度总量不会互相替代。

## Task 7：HOST 任务规划与核验组件

**文件**

- 新增：`agent-runtime/src/agents/host.ts`、`agent-runtime/src/agents/verifier.ts`。
- 新增：`agent-runtime/src/tools/delegate-research.ts`、`agent-runtime/src/prompts/host.ts`。
- 新增：`ResearchEngine/planning.py`、`ResearchEngine/verification.py`。
- 新增：`tests/test_research_planning.py`、`agent-runtime/tests/verification.test.ts`。

**步骤**

1. HOST 输出三方任务的范围、工具权限、预算与完成标准，程序验证角色、依赖和额度。
2. `delegate_research` 返回任务句柄。HOST 发起后等待持久化汇合信号，不反复调用模型询问“是否完成”。
3. 核验使用单独上下文，按需读取正文或补证，输出 supported/partially_supported/unsupported/contradicted/uncertain 和理由。
4. 测试“官方回应了、热度降低、评论仍质疑”同时成立的样本；不能判成必须选一方的矛盾。
5. 核验引用主张版本，来源不足就保留 uncertain；程序只校验结构，HOST 消费结果作出业务评审。

**验证**：`python -m unittest discover -s tests -p 'test_research_planning.py' -v`；TypeScript `npm test`。

**验收**：HOST 自身具备规划和评审能力；核验是可调用组件，不变成必须常驻的第六个业务 Agent。

## Task 8：实现三轮评审、定向补查与放行

**文件**

- 修改：`ResearchEngine/coordinator.py`、`ResearchEngine/storage.py`。
- 新增：`ResearchEngine/review.py`、`tests/test_research_review.py`。
- 参考行为：`ForumEngine/coordinator.py`、`tests/test_forum_stage_review.py`；不复制旧“三份最终文章登记”门槛。

**步骤**

1. HOST 评审产生 approve/revise/finalize_with_unresolved，含补查对象、问题、关联主张与完成标准。
2. 前两轮只对有补查指令的角色创建新任务；其他角色沿用不可变的有效版本。
3. 第三轮禁止追加研究批次；保留未解决事项，禁止将 unsupported 自动升级为 supported。
4. 放行检查覆盖情况、有效成果、核验记录和未解决事项；不存在仍在运行的必要任务。
5. 使用事务持久化评审与状态转移；重复评审请求只返回同一决定，失败重试不增加轮次。

**验证**：`python -m unittest discover -s tests -p 'test_research_review.py' -v`。

**验收（M2）**：可首轮提前放行；最多两次补查；不强制连续两轮无修改意见；不强求各方共识。

## Task 9：Report 综合研判与 Document IR

**文件**

- 新增：`agent-runtime/src/agents/report.ts`、`agent-runtime/src/prompts/report.ts`。
- 新增：`ResearchEngine/report_input.py`、`ResearchEngine/final_check.py`。
- 新增：`ReportEngine/core/research_input_adapter.py`。
- 修改：`ReportEngine/agent.py`、`ReportEngine/prompts/prompts.py`、`ReportEngine/ir/validator.py`。
- 新增：`tests/test_research_report.py`、`agent-runtime/tests/report.test.ts`。

**步骤**

1. 用显式成果版本构造 Report 输入，禁止扫描目录“最新文件”；不重新跑旧的 Report LLM 写作链造成双重写作。
2. Pi Report 形成 ReportJudgment：整体解释、风险、措施、证据引用及适用条件，再组织章节。
3. 接入现有 IR 契约，通过适配器复用布局/拼装的确定性部分；章节完成后生成摘要。
4. HOST 组织终稿检查，新事实有依据、推断有条件、建议针对具体风险；写作修订有单独上限及预算。
5. 需要新研究的问题标记未解决或暂停，不隐式启动第四轮；输出 Artifact 记录所有输入版本。

**验证**：`python -m unittest discover -s tests -p 'test_research_report.py' -v`；TypeScript `npm test`。

**验收**：输出有效 IR；风险与建议能追溯跨三方依据；只有三份摘要拼接或泛化建议不能通过。

## Task 10：实验室模板和文档导出

**文件**

- 新增：`ReportEngine/report_template/实验室舆情专报模板.md`。
- 新增：`ReportEngine/renderers/docx_renderer.py`、`tests/test_research_docx.py`。
- 修改：`ReportEngine/renderers/__init__.py`、`ReportEngine/flask_interface.py`、`requirements.txt`（仅补必要导出依赖）。
- 复用：`ReportEngine/renderers/html_renderer.py`、`pdf_renderer.py`、`markdown_renderer.py`。

**步骤**

1. 模板包含标题、摘要、事件与趋势、境外舆论、境内舆论、风险与建议；地区章节允许三方成果共同支撑。
2. 报告按 run_id / Artifact 版本导出；新增 DOCX renderer，不声称现有项目已支持 Word。
3. 按用户样稿核对标题层级、字体、段距和引用形式；风险/建议数量不固定，也不机械一一配对。
4. 自动检查 DOCX 结构、顺序、引用及数据完整性；渲染后检查中文字体、分页与脚注，记录本机缺字体等限制。
5. 对现有 HTML/PDF/Markdown 跑相应回归；未通过 DOCX 视觉验收不能宣告实验室交付完成。

**验证**：`python -m unittest discover -s tests -p 'test_research_docx.py' -v`；另做有记录的文档视觉检查。

**验收（M3）**：同一有效 IR 可以导出各目标格式；正文、限制和引用一致，摘要位于规定位置。

## Task 11：运行 API、恢复取消及页面接入

**文件**

- 新增：`ResearchEngine/flask_routes.py`、`ResearchEngine/recovery.py`、`ResearchEngine/events.py`。
- 修改：`app.py`、`templates/index.html`。
- 新增：`static/research.js`、`tests/test_research_routes.py`、`tests/test_research_recovery.py`。

**步骤**

1. 在新 Blueprint 注册创建/读取运行、事件、pause/resume/cancel 和结果接口；创建采用 `POST /api/research/runs`。
2. 增加模式配置，新模式仅启动 Pi 服务和新调度器，不启动旧论坛流程；旧 API 行为保持可回归。
3. 重启时将未结束运行暂停；恢复从已提交成果、消息及预算继续，不刷新额度。重复运行实例只允许一个领取任务。
4. 取消和恢复提升执行版本；工具不能真正中断时保留实际用量，迟到结果丢弃且不写成果。
5. 页面展示三方状态、核验、补查、预算和报告，不模拟轮流发言；事件有持久化序号，刷新后可重新读取。

**验证**：`python -m unittest discover -s tests -p 'test_research_routes.py' -v`；再执行 `test_research_recovery.py`，并对页面做创建、刷新、取消、恢复检查。

**验收**：模型请求和 HTTP 请求超时不会导致重复提交；浏览器断连不取消研究；取消后的迟到响应不能继续写报告。

## Task 12：端到端评估、回归与交付

**文件**

- 新增：`tests/test_research_e2e.py`、`evaluation/research/cases.json`。
- 新增：`evaluation/research/run.py`、`evaluation/research/rubric.md`、`docs/research-runtime.md`。
- 新增：`evaluation/research/results/README.md`（记录后续结果字段，实际结果运行时生成）。

**步骤**

1. 脚本化端到端样本覆盖提前结束、三轮未解决、源数据缺失、工具失败、重启恢复、终稿修订及混用 run_id 拒绝。
2. 准备简单/复杂事件集合，对照单研究 Agent、三方无核验、完整方案；全部模式使用相同工具访问范围和报告能力。
3. 比较相近预算并记录实际 token、调用、费用与耗时；统计费用/用量未知的案例，不能排除后美化结果。
4. 人工核对事实、引用、覆盖、不确定性和建议，模型评分仅作辅助；样本结果注明规模，不写成普遍性能承诺。
5. 运行原论坛及报告相关回归，补齐启动命令、环境变量、Pi 版本、接口、暂停恢复和回退说明。评估通过后再决定默认模式。

**验证**

```bash
python -m unittest discover -s tests -p 'test_research_*.py' -v
python -m unittest discover -s tests -p 'test_forum_*.py' -v
python -m unittest discover -s tests -p 'test_report_*.py' -v
python -m unittest discover -s tests -p 'test_export_pdf_paths.py' -v
```

在 `agent-runtime/` 执行 `npm run build` 和 `npm test`。真实模型评估是独立显式命令，计划为 `python evaluation/research/run.py --cases evaluation/research/cases.json --modes single,multi_no_verify,multi_verify`；运行前展示预计预算，不混入普通单元测试。

**验收（M4）**：有可以重放的行为证据、可解释的质量与成本对照、旧模式回归记录和部署说明。测试成功只证明对应场景，不能代替真实研究质量评估。

## 第一次实施的建议范围

先完成任务1—5，交付一个“权威口径 Agent → Python 工具 → 证据 → 有效提交”的闭环。M1 未验证前，不启动完整五 Agent 系统；M1 通过后按依赖继续，不将这一阶段称为整个项目重构完成。

本计划的各任务提交建议分别使用 `feat` / `refactor` / `test` 类型，提交内容限制在已完成任务范围。执行方式待用户决定，本次不自动进入实施。
