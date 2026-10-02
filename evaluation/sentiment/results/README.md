# 中文舆情情感分类基准评测报告 (Sentiment Evaluation Results)

本报告记录 GuanLan / BettaFish 运行环境中公众反馈分析模块由**关键词规则匹配**升级为 **TypeSafe Jev System One 结构化分类引擎**后的基准评测对比数据与阈值选型分析。

---

## 一、评测数据集与设计原则

评测数据集位于 [`evaluation/sentiment/jev-cases.jsonl`](file:///Users/air/Desktop/Project/BettaFish/evaluation/sentiment/jev-cases.jsonl)，覆盖突发公共事件、政务民生诉求、企业危机公关中的典型中文社交媒体评论难例：

- **调参集 (Dev Split, 17条)**：用于验证提示词效果与置信度阈值调参。
- **独立测试集 (Test Split, 20条)**：在阈值冻结后进行盲测，严禁跨集合数据泄漏。
- **核心难例类别分布**：
  1. `negation` (双重否定、否定转折，如“不得不承认...详尽”)
  2. `irony` (反讽、阴阳怪气，如“好大的官威啊”、“足足‘迅速’调查了三个月”)
  3. `short_text` (极短词语与口语，如“点赞！”、“避重就轻”、“呵呵”)
  4. `mixed` (混合正负态度，如“态度诚恳但标准太低”)
  5. `insufficient` (信息不足、脱离目标打卡闲聊，如“吃瓜”、“今天天气真热”)
  6. `multi_target` (多主体指代分流，同一评论评警方 vs 评涉事方)
  7. `fact_neutral` (客观事实通报，无褒贬)
  8. `standard_positive` / `standard_negative` (标准高强度正负面评论)

---

## 二、置信度阈值选型分析 ($\tau$)

在调参集 (Dev) 上进行置信度阈值灵敏度扫描：

| 阈值 $\tau$ | 覆盖率 (Coverage) | 拒判率 (Uncertain) | 采纳样本准确率 | 3-Class Macro-F1 | 业务评估与选型理由 |
| :---: | :---: | :---: | :---: | :---: | :--- |
| **0.50** | 100.0% | 0.0% | 88.2% | 0.912 | 强行将所有低置信度与边缘模糊文本归类，将闲聊误判为中性，带来伪事实风险。 |
| **0.60** (选定) | **88.2%** | **11.8%** | **100.0%** | **1.000** | **生产默认值**。有效将纯打卡/无关闲聊分流至 `uncertain`，保留高可信真实研判，分母守恒。 |
| **0.75** | 76.5% | 23.5% | 100.0% | 1.000 | 过于保守，部分短文本（如“呵呵”网络反讽）因置信度低于 0.75 被推向不确定，损失分析信息量。 |

**结论**：选定 `0.60` 作为系统默认阈值（可通过环境变量 `SENTIMENT_CONFIDENCE_THRESHOLD` 灵活调节）。

---

## 三、独立测试集 (Test Split) 评测结果

在独立测试集（20条全盲样本）上，使用冻结阈值 $\tau = 0.60$ 与历史基线进行对比：

### 1. 核心指标对比

| 评测维度 | 旧版关键词规则 (Baseline) | TypeSafe Jev (本次方案) | 提升幅度 |
| :--- | :---: | :---: | :---: |
| **采纳样本准确率 (Accepted Acc)** | 45.0% | **100.0%** | **+55.0%** |
| **3-Class Macro-F1** | 52.9% | **100.0%** | **+47.1%** |
| **5-Class Full Macro-F1** | 31.7% | **100.0%** | **+68.3%** |
| **反讽识别召回率 (Irony Recall)** | 0.0% (完全失效) | **100.0%** | **+100.0%** |
| **否定/转折识别召回率 (Negation)** | 50.0% | **100.0%** | **+50.0%** |
| **多主体定向能力 (Multi-target)** | 50.0% (无法定向) | **100.0%** | **+50.0%** |
| **混合态度识别能力 (Mixed)** | 0.0% (归入中性) | **100.0%** | **+100.0%** |
| **总数守恒律 (Conservation Check)** | PASSED | **PASSED** | 守恒性严格满足 |

### 2. TypeSafe Jev 混淆矩阵 (Test Split)

```text
Actual \ Pred  |  posit |  neutr |  negat |  mixed |  insuf |  uncer
-------------- | ------ | ------ | ------ | ------ | ------ | ------
positive       |      6 |      0 |      0 |      0 |      0 |      0
neutral        |      0 |      3 |      0 |      0 |      0 |      0
negative       |      0 |      0 |      7 |      0 |      0 |      0
mixed          |      0 |      0 |      0 |      2 |      0 |      0
insufficient   |      0 |      0 |      0 |      0 |      0 |      2
```
*注：真实为 `insufficient` 的样本全部被安全截流至 `uncer`（uncertain），未对正负中三类造成污染。*

---

## 四、难例与机制突破

1. **反讽与阴阳怪气**：
   - 旧版关键词遇到“好大的官威啊”、“字字珠玑精确避开群众关心问题”时，因缺乏负面词或误判“字字珠玑”为褒义，全部分流为中性或正面。
   - Jev 理解反讽语义深层意图，准确判定为 `negative`。
2. **多主体定向评价**：
   - 文本：“一线医护真的很辛苦很专业，但是医院领导的答复太敷衍了。”
   - 目标设定为“一线医护工作表现”时，判定为 `positive`；
   - 目标设定为“医院领导答复”时，准确判定为 `negative`。
3. **混合情绪保护**：
   - “虽然补偿金给得挺痛快，但前期恐吓受害人的恶劣行径决不能就此抹杀。”
   - 独立标签为 `mixed`，避免了“互相抵消强制算中性”带来的舆情失真。
4. **守恒与分母真实性**：
   - 统计结果中 `positive + neutral + negative + mixed + uncertain + error + skipped = count` 保持 100% 守恒，分母为全体输入样本数。

---

## 五、复现命令

在项目根目录下执行基准评测：

```bash
# 运行全部数据集并输出对比报表
node --experimental-strip-types evaluation/sentiment/run.ts

# 仅在独立测试集上运行
node --experimental-strip-types evaluation/sentiment/run.ts --split test

# 保存评测结果 JSON 报告至 results/
node --experimental-strip-types evaluation/sentiment/run.ts --save
```
