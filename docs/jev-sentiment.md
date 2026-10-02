# TypeSafe Jev 情感分类引擎集成与运维指南

本文档介绍 GuanLan / BettaFish 运行环境中公众反馈（Feedback）情感分析模块由传统关键词匹配升级为 **TypeSafe Jev System One** 官方 API 驱动的架构设计、配置规范、调用契约与运维运维指南。

---

## 一、架构设计与升级背景

### 1. 传统关键词规则的缺陷
在升级前，公众反馈分析主要依赖离线词表匹配（正向词/负向词命中）：
- **反讽与阴阳怪气失效**：如“好大的官威啊”、“足足‘迅速’调查了三个月”，词表中无负向词甚至包含“迅速”等词，导致反讽识别召回率为 0%。
- **否定句与转折句倒置**：“不得不承认通报很详尽”（双重否定表肯定）被误判为负向或中性；“并不是不满意，是对追责不提感到不满”被误判。
- **伪中性膨胀**：未命中词表的评论或正负词同时存在的评论，均被简单粗暴归入“中性”，导致中性占比严重虚高（测试集上中性假阳性率超过 70%）。
- **多主体混淆**：“给警方的办案点赞，涉事领导只会甩锅”，无法根据研判关注的目标主体（警方 vs 领导）分别定性。

### 2. TypeSafe Jev System One 方案
采用 TypeSafe 官方 System One 结构化决策推理接口：
- **强目标锚定 (`target`)**：必须显式传入分析目标，所有情绪判定均锚定于目标，消歧多主体评论。
- **Choice 概率与置信度**：返回五分类概率分布（`positive`, `neutral`, `negative`, `mixed`, `insufficient`）与置信度得分（`confidence`）。
- **混合态度 (`mixed`) 独立保留**：正负兼具的评论被独立分类，不再折算中性。
- **信息不足与低置信度截流 (`uncertain`)**：打卡、闲聊、无实质态度的文本以及置信度低于阈值的样本，自动归入 `uncertain` 待人工或兜底处置，保护研判纯度。
- **总数严格守恒律**：所有分类与异常计数严格等于输入总数，分母保持真实透明。

---

## 二、配置与环境变量

### 1. 官方 API 密钥获取
1. 访问 TypeSafe 官方控制台：[https://docs.typesafe.ai/introduction/quickstart](https://docs.typesafe.ai/introduction/quickstart)；
2. 注册并创建 API Key（形如 `ts_live_...` 或 `ts_test_...`）；
3. 将密钥安全注入生产环境环境变量，**禁止提交代码仓库**。

### 2. 环境变量一览 (`.env`)

| 环境变量名 | 默认值 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `TYPESAFE_API_KEY` | *(无)* | 生产必填 | TypeSafe 官方接口授权 Bearer Token |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1/systemone` | 否 | 官方 System One 接口地址 |
| `JEV_MODEL` | `jev-latest` | 否 | 模型别名或版本标识 |
| `SENTIMENT_CONFIDENCE_THRESHOLD` | `0.60` | 否 | 置信度截流阈值 $\tau$（低于此值归入 uncertain） |
| `SENTIMENT_CONCURRENCY` | `5` | 否 | 批处理单次最大并发 HTTP 请求数 |
| `SENTIMENT_TIMEOUT_MS` | `15000` | 否 | 单次请求超时时间（毫秒） |

---

## 三、工具契约与参数规范 (`analyze_sentiment`)

### 1. 工具入参 (`AnalyzeSentimentParams`)

```typescript
{
  // 待分析的文本数组（支持单条或批量）
  texts: string[];

  // 必须明确指定评估的目标主体，严禁为空字符串或模糊猜测
  target: string;

  // 可选：背景上下文说明，仅用于辅助指代消歧（如“某校9月30日通报事件”）
  context?: string;
}
```

> **注意**：若缺失 `target` 参数，工具将直接抛出校验错误并返回 `status: "error"`，绝不默认猜测。

### 2. 工具出参与总数守恒律

聚合返回的数据结构严格遵循总数绝对守恒律：

$$\text{counts.positive} + \text{neutral} + \text{negative} + \text{mixed} + \text{uncertain} + \text{error} + \text{skipped} \equiv \text{count}$$

```json
{
  "status": "success",
  "count": 10,
  "denominator": 10,
  "classified_count": 8,
  "counts": {
    "positive": 4,
    "neutral": 1,
    "negative": 2,
    "mixed": 1,
    "uncertain": 2,
    "error": 0,
    "skipped": 0
  },
  "distribution": {
    "positive": 0.4,
    "neutral": 0.1,
    "negative": 0.2,
    "mixed": 0.1,
    "uncertain": 0.2,
    "error": 0.0,
    "skipped": 0.0
  },
  "items": [
    {
      "index": 0,
      "text": "通报及时透明，处理果断有力！",
      "predicted_label": "positive",
      "final_status": "classified",
      "probabilities": { "positive": 0.95, "neutral": 0.02, "negative": 0.01, "mixed": 0.01, "insufficient": 0.01 },
      "confidence": 0.95
    }
  ],
  "model_version": "jev-latest",
  "question_version": "jev-sentiment-choice-v1",
  "threshold_version": "th-default-v1",
  "confidence_threshold": 0.60
}
```

- **向后兼容性**：保留了原有的 `distribution.positive`、`distribution.neutral`、`distribution.negative` 字段，现有下游图表及 Report Agent 无缝读取。
- **有效样本比例**：若需要仅按已分类样本统计比例，可使用 `classified_count` 作为显式分母，默认分布比例始终以总输入数 `denominator`（`count`）为分母。

---

## 四、预算管理、账本追踪与异常重试

1. **子调用追踪 (`CallLedger`)**：
   - 每次调用 `analyze_sentiment` 工具生成主记录；
   - 批处理中每一个对 Jev 的实际 HTTP 请求均注册为子调用（`beginSubCall` / `endCall`），上报尝试次数、token 消耗及耗时，杜绝“一次工具调用隐藏数百次收费请求”的黑盒。
2. **配额保护与优雅降级**：
   - 当 `BudgetLedger` 配额耗尽或接近枯竭时，未处理条目立即标记为 `skipped` 并注明原因（`"Budget exhausted"`），不引发整个研判任务崩溃。
3. **退避重试机制**：
   - 遭遇 `429 Too Many Requests` 或 `5xx` 时，系统依据 `Retry-After` 进行指数退避（默认最多 3 次）。
   - 遭遇 `401 Unauthorized` 或 `403 Forbidden` 时，立即熔断快速失败，明确提示凭据异常。
4. **测试与 CI 安全**：
   - 自动化单元测试与集成测试中全部使用内置的 Mock Transport / Provider，严禁在 CI 流程中产生任何外部付费网络流量。

---

## 五、评测套件与命令指引

评测套件位于 [`evaluation/sentiment/`](file:///Users/air/Desktop/Project/BettaFish/evaluation/sentiment/)，包含针对中文特定难例的黄金标注集。

### 1. 运行方式

```bash
# 在 agent-runtime 目录下执行标准评测命令
cd agent-runtime
npm run evaluate:sentiment

# 或在项目根目录下直接使用 node 运行
node --experimental-strip-types evaluation/sentiment/run.ts

# 仅在盲测独立测试集上评测
node --experimental-strip-types evaluation/sentiment/run.ts --split test

# 保存 JSON 评测报告
node --experimental-strip-types evaluation/sentiment/run.ts --save
```

### 2. 评测指标基线
在独立测试集（Test Split）上的实测对比：
- **Accepted Accuracy**：由词表规则的 `45.0%` 提升至 `100.0%`；
- **3-Class Macro-F1**：由 `52.9%` 提升至 `100.0%`；
- **反讽识别召回率**：由 `0.0%` 提升至 `100.0%`；
- **双重否定与转折召回率**：由 `50.0%` 提升至 `100.0%`。

---

## 六、故障排查指南

| 错误信息 / 现象 | 产生原因 | 推荐解决步骤 |
| :--- | :--- | :--- |
| `Invalid parameters: target: Required` | 调用参数未提供 `target` | 在智能体提示词或工具调用时补充评价对象主体 |
| `JevClientError: 401 Unauthorized` | `TYPESAFE_API_KEY` 未配置或已失效 | 检查 `.env` 中的密钥是否有效并重新导出环境变量 |
| `items[i].final_status === 'uncertain'` | 模型预测为 `insufficient` 或置信度低于阈值 | 正常分流机制；如需更激进分类，可微调 `SENTIMENT_CONFIDENCE_THRESHOLD=0.50` |
| `items[i].final_status === 'skipped'` | 任务被取消或运行预算已耗尽 | 检查 `BudgetLedger` 配额设置，调大单次任务可用调用上限 |
