# 公众反馈情感分类评估量规 (Sentiment Evaluation Rubric)

本量规定义 GuanLan / BettaFish 运行环境中公众反馈分析模块（基于 TypeSafe Jev System One 分类引擎）的评测指标体系、分流机制、阈值选择依据与质检红线。

---

## 一、核心原则与总数守恒律

1. **目标锚定原则 (Target Anchored)**
   评论情感判定必须严格锚定给定的评估目标 (`target`)。同一段评论若包含多个主体（如“赞赏警方办案，批评校方管理”），当评估目标为警方时判定为 positive，当评估目标为校方时判定为 negative。严禁脱离目标进行笼统的情绪揣测。
2. **总数绝对守恒律 (Strict Conservation Law)**
   批处理返回的分布计数必须满足：
   $$\text{positive} + \text{neutral} + \text{negative} + \text{mixed} + \text{uncertain} + \text{error} + \text{skipped} = \text{total\_count}$$
   分母必须保持为总输入样本数。严禁通过静默丢弃难例或缩减分母来人为虚高正负向比例。
3. **混合与不确定性显式区分 (Mixed vs Uncertain)**
   - `mixed`：文本对目标同时存在清晰的正面与负面评价，属于**高置信度的有效分类结果**，不可等同于中性，亦不可归入不确定。
   - `uncertain`：包含模型输出 `insufficient`（信息不足/脱离目标/纯闲聊打卡）以及最高预测概率低于置信度阈值（$\text{confidence} < \tau$）的低置信样本。
4. **低置信度拒判非自动正确**
   模型将样本判定为 `uncertain`（拒判）代表放弃强行分类以保护下游研判质量，其错误率降低是以覆盖率（Coverage Rate）为代价，不能在常规三类 F1 统计中偷换概念为“准确分类”。

---

## 二、评测指标体系

| 指标项 | 计算公式 / 定义 | 目标基线 / 期望值 | 业务含义说明 |
| :--- | :--- | :--- | :--- |
| **覆盖率 (Coverage)** | $\frac{\text{classified\_count}}{\text{total\_count}}$ | $\ge 85\%$ | 系统能够给出确定性分类的样本比例，避免因过度谨慎导致信息流失 |
| **拒判率 (Uncertainty Rate)** | $\frac{\text{uncertain\_count}}{\text{total\_count}}$ | $\le 15\%$ | 因信息不足或模型低置信度而分流到人工/兜底池的比例 |
| **接受样本准确率 (Accepted Accuracy)** | $\frac{\text{TP}_{\text{accepted}}}{\text{classified\_count}}$ | $\ge 90\%$ | 在模型采纳并确定分类的样本中，标签与黄金标注完全一致的比例 |
| **3-Class Macro-F1** | $\frac{1}{3} \sum_{c \in \{pos, neu, neg\}} F1_c$ | $\ge 0.88$ | 核心三类极性的未加权平均 F1，检验主流态度识别水准 |
| **5-Class Macro-F1** | $\frac{1}{5} \sum_{c \in \{pos, neu, neg, mix, ins\}} F1_c$ | $\ge 0.82$ | 全维度宏 F1（包含混合评价与信息不足判定），衡量综合研判能力 |
| **反讽识别召回率 (Irony Recall)** | $\frac{\text{TP}_{irony}}{\text{Total}_{irony}}$ | $\ge 75\%$ | 针对反语、讽刺类隐蔽负向评论的识别能力（词表基线通常为 0%） |
| **双重/否定句召回率 (Negation Recall)** | $\frac{\text{TP}_{negation}}{\text{Total}_{negation}}$ | $\ge 85\%$ | 准确解析“不得不承认”、“并不是不满意”等否定转折语法逻辑的能力 |

---

## 三、混淆矩阵统计定义

对于五分类标注体系（`positive`, `neutral`, `negative`, `mixed`, `insufficient`）：

1. **混淆矩阵格式**：行表示标注黄金真值（Ground Truth），列表示系统预测结果（Prediction）。
2. **状态映射**：
   - 若系统输出为 `uncertain`（源于 `insufficient` 或低置信度），且标注真值为 `insufficient`，计入 `insufficient` 的 True Positive。
   - 若系统输出为 `uncertain`，而标注真值为明确的 `positive`/`negative`/`neutral`/`mixed`，则计入该真实类别的 False Negative（未召回），并在混淆矩阵中映射至 `uncertain` 列。
3. **指标计算**：
   - 类别精度：$\text{Precision}_c = \frac{\text{TP}_c}{\text{TP}_c + \text{FP}_c}$
   - 类别召回：$\text{Recall}_c = \frac{\text{TP}_c}{\text{TP}_c + \text{FN}_c}$
   - 类别 $F1$: $F1_c = \frac{2 \cdot \text{Precision}_c \cdot \text{Recall}_c}{\text{Precision}_c + \text{Recall}_c}$

---

## 四、置信度阈值选择策略 ($\tau$)

系统提供动态置信度阈值配置（环境变量 `SENTIMENT_CONFIDENCE_THRESHOLD`，默认 `0.60`）：

| 阈值区间 | 调参表现倾向 | 推荐适用场景 |
| :--- | :--- | :--- |
| **$\tau < 0.50$ (激进)** | 覆盖率接近 $100\%$，但将模糊文本、多主体纠缠文本强行分类，导致接受样本错误率上升。 | 宏观大盘粗粒度扫描，可容忍少量噪声。 |
| **$\tau = 0.60$ (基准平衡)** | 覆盖率维持在 $88\% \sim 95\%$，有效过滤边缘模糊样本与打卡闲聊，Accepted Accuracy 达到最佳平衡点。 | **默认生产推荐配置**，兼顾召回与高可信。 |
| **$\tau \ge 0.75$ (保守防御)** | 拒判率显著上升（$> 25\%$），大量轻微歧义样本被推向 `uncertain`，接受样本精度极高（$> 95\%$）。 | 重大突发涉稳研判、法律合规审核、审计级报告。 |

---

## 五、合规与外部调用红线

1. **敏感数据不出境/不外发**：仅已公开网民社交媒体评论可传入分类器；涉及内部研讨、未解密调查记录严禁作为文本传入。
2. **限流重试与调用成本透明**：严禁无上限并发，单批次默认限并发 5。每次调用必须接入 `CallLedger`，如实上报 token 消耗与费用。
3. **退避熔断机制**：收到 HTTP 429 或 5xx 时遵守指数退避，严禁暴力重试；若遭遇 401/403 鉴权失败立刻中断全流程并标记不可用，禁止生成虚构标签。
