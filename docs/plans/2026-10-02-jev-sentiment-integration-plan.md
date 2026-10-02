# Jev 情感分类替换 Implementation Plan

> **执行说明：** 按任务逐项实施。本次仅编写计划，不修改运行代码、不安装依赖、不调用收费 API。

**Goal:** 使用 TypeSafe Jev 替换现有 TS 情感工具的关键词规则，保留逐条标签、概率与不确定性，给公众反馈 Agent 提供可追溯的样本统计。

**Architecture:** 保留 Pi 及 `analyze_sentiment` 工具名，TS 客户端调用 Jev 官方 HTTP API，工具层负责受限并发、结果校验、预算及聚合。研究 Agent 继续负责解释公众观点与诉求，Jev 不替代 HOST 或 Report。

**Tech Stack:** 现有 Node.js / TypeScript / Zod / Pi；Node fetch；TypeSafe Jev REST API；现有 CallLedger 与 BudgetLedger；Node 测试运行器。

---

## 1. 已核查现状与范围

日期：2026-10-02。

- `agent-runtime/src/tools/feedback.ts` 的 `analyzeSentiment` 当前使用正负面词表，混合或无命中直接归中性，仅返回三类比例。
- `agent-runtime/src/tools/registry.ts` 注册了同名工具，参数目前只有 `texts`；无分类后端注入。
- `agent-runtime/tests/local-tools.test.ts` 只检查比例非负，不验证分类语义、分母和失败行为。
- `agent-runtime/src/prompts/feedback.ts` 混用了极性、焦虑与理性等维度，本次仅纠正与极性工具相关的描述，不扩展为多维情绪系统。
- 可复用 `src/orchestration/call-ledger.ts`、`src/storage/budget-ledger.ts` 的调用预留/结算能力；具体装配需追踪实际入口，不新增第二套账本。

本次不重构 Pi，不改三方分工，不重新迁移 Python，不接入第三方仿冒或代理站点。优先使用 `https://api.typesafe.ai/v1/systemone` 官方接口。

## 2. 分类和统计契约

### 输入

保留 `texts: string[]`；增加必填 `target: string`，描述明确评价对象，例如“某高校9月30日回应”。可选 `context` 仅提供理解指代所需事件背景，不能用背景的正负面叙述替代文本自身态度。同步升级工具 Schema 和所有调用样本；旧调用缺少 target 返回明确参数错误，不暗中猜测。

### 标签

Jev Choice 选项为 `positive / neutral / negative / mixed / insufficient`。说明各选项都针对同一 target：

- positive：对目标明确赞同、认可或感谢。
- neutral：对目标有可识别但不偏正负的事实/信息表达。
- negative：对目标表达不满、批评或反对。
- mixed：对目标同时存在明确正负评价。
- insufficient：目标关联、指代或表达不足，无法判断。

最终单条状态为 classified / uncertain / error / skipped。低置信度输出保留原 predicted_label，但最终归 uncertain；insufficient 同样归 uncertain。mixed 是有效类别，不能等同中性或低置信度。空文本 skipped；API 失败 error，预算不足/取消未执行则 skipped 并记录原因。

### 输出

保留 `count` 为输入条数，以及 `distribution.positive/neutral/negative` 三个字段；增加 mixed、uncertain、error、skipped 比例、整数 counts、items、denominator、model_version、question_version 和阈值版本。每条结果保留输入 index、预测标签、最终状态、probabilities、confidence 与错误/跳过原因；响应不暴露密钥。

所有比例默认以输入总数为分母；三类旧字段可能合计小于1，所有类别合计约为1。先保留整数计数，展示层再舍入。若提供“有效分类样本内比例”，另设字段并显式使用 classified_count 分母，不能替换默认比例。

总数守恒：`positive + neutral + negative + mixed + uncertain + error + skipped = count`。空输入不发请求，分母为0并返回全零。批量状态支持 success/partial/error；存在失败、未执行或uncertain时给出具体说明。

## 3. 任务和依赖

按 `1 → 2 → 3 → 4 → 5 → 6 → 7` 推进。每项先写行为测试并确认失败，再最小实现和回归。命令从 `agent-runtime/` 执行：`npm run typecheck`、`npm run build`、`npm test`。默认测试全部使用注入的模拟 transport，不读取真实密钥或外发评论。

## Task 1：定义 Jev 与工具业务契约

**新增**：`src/contracts/sentiment.ts`、`tests/sentiment-contracts.test.ts`。

**修改**：`src/tools/feedback.ts` 中输入/输出类型；相关契约引用。

1. 按第2节定义输入、五个模型选项、最终状态、逐条结果与聚合输出。
2. 定义 Jev response 校验：answers、choice、所有预期概率、confidence、model 与 usage；概率范围和归一化使用浮点容差。
3. 将阈值作为配置，先允许测试显式注入，不固定未经中文验证的生产阈值。
4. 定义不足信息、低置信度、混合情绪和接口错误的区别，写总数守恒测试。

**验收**：低置信度与故障不会进入中性；原三类字段仍可读取，统计口径变化可明确识别。

## Task 2：实现 TS Jev HTTP 客户端

**新增**：`src/tools/jev-client.ts`、`src/tools/jev-questions.ts`、`tests/jev-client.test.ts`。

1. 使用 Node fetch 调用官方 `POST /v1/systemone`，Bearer 密钥来自 `TYPESAFE_API_KEY`，禁止进入日志。
2. 请求含 state、model、questions.sentiment。state 为 target/text/context；instructions 明确只判断 text 对 target 的态度。
3. 开发默认模型可用 jev-latest，保存服务实际返回 model；正式评估选择可用的明确版本或记录别名解析版本，不假定永远不变。
4. 为 transport、时钟和超时提供注入点；区分401/403、429、5xx、超时、错误JSON与结构不合法。
5. 只对配置的可重试错误有限重试，遵守 Retry-After 与总期限；每次实际 HTTP 尝试都回传用量/账本信息。超时后不能认定供应商未消费。

**验收**：模拟请求符合官方结构；密钥缺失立即明确报错；错误不产生虚构标签。

## Task 3：替换关键词规则并完成批量聚合

**修改**：`src/tools/feedback.ts`。

**新增**：`tests/jev-sentiment.test.ts`。

1. 为 analyzeSentiment 注入分类 provider，使用 Jev 结果替换词表；生产路径不默默回退关键词规则。
2. 每条评论独立判断，按 index 保持原顺序；限制批量大小和并发，具体值配置而非默认无限并发。
3. 空文本跳过；重复文本可按模型/问题/目标/背景/文本缓存，缓存命中不发外部请求；保留输入记录数量，不把缓存去重当采样去重。
4. 根据阈值和 insufficient 标记 uncertain；保留逐条概率、原预测和实际模型版本。
5. 用整数 counts 计算各类比例，失败/未执行单列；没有可用结果也不返回“全部中性”。

**验收**：批量部分失败可追踪；总数守恒；改变评论顺序不影响文本与结果的配对。

## Task 4：接入预算、取消与调用记录

**修改**：`src/orchestration/call-ledger.ts`、`src/storage/budget-ledger.ts`（仅确有缺失时）；实际运行的依赖装配模块。

**新增**：`tests/jev-budget.test.ts`。

1. 每次实际 Jev HTTP 请求尝试先通过现有账本预留，记录父工具 call_id、子请求 id、run_id/task_id 与重试序号。
2. 一个 analyze_sentiment 批量调用不能只算一次请求而隐藏数百次消费；定义父调用为容器记录，子HTTP请求消费额度，避免重复记账。
3. 返回 usage 结算 token，费用按所用服务配置估算，价格未知显式标记；不复制官网价格作为永久常量。
4. 预算不足不再派发新条目，已派发结果按版本检查；取消后停止扩展请求，迟到结果不写有效成果但实际消费记账。
5. 超时/崩溃结果未知遵循既有恢复规则，不自动退回全部预留额度。

**验收**：预算只剩2次时最多派发2个新请求；429重试消耗额度；并发同类请求各自独立结算。

## Task 5：接入工具注册与反馈 Agent

**修改**：`src/tools/registry.ts`、`src/server.ts`（按实际装配位置接入）、`src/prompts/feedback.ts`、`src/contracts/research.ts`（仅需要扩展统计元数据时）。

**修改测试**：`tests/local-tools.test.ts`；新增 `tests/jev-tool-integration.test.ts`。

1. Registry 新增 Jev provider 注入，保持 analyze_sentiment 名称；工具 Schema 增加 target/context 并更新输出说明。
2. 生产配置读取 API key/model/阈值/超时/并发；测试注入 mock。服务可启动，未配置 Jev 时工具返回明确不可用，不静默生成分布。
3. 反馈提示词要求说明评价对象、样本范围及分母；不把极性标签称为焦虑/理性维度，不把比例解释成全体公众态度。
4. 将 mixed/uncertain/error/skipped 及模型/问题版本传到研究成果；Report 不重新将这些比例归中性。
5. 更新只检查非负比例的旧测试，使用固定模拟分类结果验证完整计数和传递。

**验收**：原 Agent 能通过同一工具获得新输出；缺 target 或缺配置明确失败；无隐含生产收费测试。

## Task 6：中文标注评估与阈值选择

**新增**：`evaluation/sentiment/jev-cases.jsonl`、`rubric.md`、`run.ts`、`results/README.md`。

1. 准备有权限的人工标注中文样本，覆盖否定、反讽、短文本、混合、无关、指代、多目标及典型事件场景。
2. 划分调参与独立测试集；用调参集选择问题措辞/阈值，冻结后测试。重复/同源样本不能跨集合泄漏。
3. 对明确三类样本报告Macro-F1、各类召回和混淆矩阵；mixed/insufficient单独评估，不能删掉难例只报漂亮三类分数。
4. 记录不确定/错误/跳过比例、有效分类覆盖率、接受结果错误率、实际请求/费用/延迟；低置信度拒判不算自动正确。
5. 与原词表规则对照，并记录目标、问题版本、模型实际版本；置信度不等于中文样本实测准确率。

**验收**：有可复现报告和明确阈值理由；测试集不用于反复挑选最佳配置。实际样本规模与指标范围如实说明，不宣称通用提升。

## Task 7：上线配置、回归与切换

**新增**：`docs/jev-sentiment.md`；实际环境变量示例文件按项目已有位置补充。

**修改**：必要的启动说明及 `package.json`（独立评估命令）。

1. 文档列出官方密钥取得方式、服务地址、配置、分类目标、统计口径、费用和错误行为。
2. 普通CI跑mock测试；真实集成评估单独命令执行，明确样本外发范围与调用预算。未获允许外发的材料不送出。
3. 通过样本评估及少量真实调用后正式启用Jev；该阶段需要已配置可用密钥，不能用mock宣称实接成功。
4. 全量运行构建及原Agent/研究/报告回归，检查分布不再被强制归一为三类合计1。
5. 回退保留显式功能开关或旧入口，结果标记 provider；不能静默将Jev故障替换成词表结果。

**命令**：`npm run typecheck`、`npm run build`、`npm test`；另实现独立 `npm run evaluate:sentiment`，默认明确区分mock与live。

**完成条件**：生产调用有真实证据，中文评估和费用记录完整；不确定性及失败可见，报告分母一致。

## 4. 参考与事实边界

核查日期：2026-10-02。

- 官方API：https://docs.typesafe.ai/api
- 官方快速开始与密钥：https://docs.typesafe.ai/introduction/quickstart
- Choice/Score/Noul：https://docs.typesafe.ai/primitives
- 置信度含义：https://docs.typesafe.ai/confidence

本方案使用Choice处理名义极性分类，不使用Score假定中性与褒贬混合是一条有序轴。同一评论若后续确有强度/诉求需求，可增加独立问题；本次不扩展范围。供应商宣称的速度、成本及校准效果不是本项目测得结果。
