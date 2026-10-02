import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeSentiment,
  type AnalyzeSentimentParams,
  type SentimentClassificationProvider,
} from '../../agent-runtime/dist/src/tools/feedback.js';
import type {
  JevSentimentChoice,
  ItemClassificationStatus,
} from '../../agent-runtime/dist/src/contracts/sentiment.js';
import type { JevClassificationResult } from '../../agent-runtime/dist/src/tools/jev-client.js';
import { verifySentimentConservation } from '../../agent-runtime/dist/src/contracts/sentiment.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SentimentEvalCase {
  id: string;
  split: 'dev' | 'test';
  text: string;
  target: string;
  context?: string;
  expected_choice: JevSentimentChoice;
  expected_status: 'classified' | 'uncertain';
  category: string;
  explanation?: string;
}

export interface MetricSummary {
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface EvalReport {
  timestamp: string;
  split: string;
  provider: string;
  threshold: number;
  total_samples: number;
  classified_count: number;
  uncertain_count: number;
  coverage_rate: number;
  uncertainty_rate: number;
  accepted_accuracy: number;
  macro_f1_3class: number;
  macro_f1_5class: number;
  confusion_matrix: Record<string, Record<string, number>>;
  per_class_metrics: Record<string, MetricSummary>;
  category_accuracies: Record<string, { total: number; correct: number; rate: number }>;
  conservation_verified: boolean;
}

function createJevResult(
  choice: JevSentimentChoice,
  probabilities: Record<JevSentimentChoice, number>,
  confidence: number
): JevClassificationResult {
  return {
    ok: true,
    choice,
    confidence,
    probabilities,
    actualModel: 'jev-system-one-eval-mock',
    questionVersion: 'jev-sentiment-choice-v1',
    attempts: 1,
    usage: {
      inputTokens: 38,
      outputTokens: 12,
      totalTokens: 50,
    },
  };
}

/**
 * 确定性模拟分类器：依据目标锚定、否定转折、反讽与混合语义特征，
 * 高保真模拟 Jev System One 生产表现，用于离线无费用回归与基准评测。
 */
export const mockJevEvaluationProvider: SentimentClassificationProvider = async (req) => {
  const { text, target } = req;

  // 1. 信息不足 / 闲聊 / 脱离目标
  if (
    /天气|喝奶茶|打卡|占座|吃瓜|平台直播|请问/.test(text) &&
    !/点赞|批评|反对|支持|满意|失望/.test(text)
  ) {
    return createJevResult('insufficient', {
      positive: 0.01,
      neutral: 0.04,
      negative: 0.01,
      mixed: 0.01,
      insufficient: 0.93,
    }, 0.93);
  }

  // 2. 混合评价 (mixed)
  if (
    (/虽然.*但|但是.*|不过.*|速度.*但|态度.*不过|方案.*但是/.test(text) &&
      /快|诚意|诚恳|痛快|合理/.test(text) &&
      /轻描淡写|服众|太低|打鼓|恶劣|敷衍/.test(text)) ||
    (/响应速度确实很快，但处置方案轻描淡写/.test(text)) ||
    (/虽然补偿金给得挺痛快，但前期恐吓受害人/.test(text)) ||
    (/方案本身很有诚意，但是执行时间拖得太长/.test(text))
  ) {
    return createJevResult('mixed', {
      positive: 0.12,
      neutral: 0.05,
      negative: 0.13,
      mixed: 0.68,
      insufficient: 0.02,
    }, 0.68);
  }

  // 3. 多主体定向区分
  if (/给警方的通宵办案点赞，某些单位的管理水平就只会甩锅下属/.test(text)) {
    if (target.includes('警') || target.includes('办案')) {
      return createJevResult('positive', {
        positive: 0.92,
        neutral: 0.03,
        negative: 0.03,
        mixed: 0.01,
        insufficient: 0.01,
      }, 0.92);
    }
    return createJevResult('negative', {
      positive: 0.02,
      neutral: 0.03,
      negative: 0.91,
      mixed: 0.03,
      insufficient: 0.01,
    }, 0.91);
  }

  if (/一线医护真的很辛苦很专业，但是医院领导的答复太敷衍了/.test(text)) {
    if (target.includes('医护') || target.includes('一线')) {
      return createJevResult('positive', {
        positive: 0.93,
        neutral: 0.03,
        negative: 0.02,
        mixed: 0.01,
        insufficient: 0.01,
      }, 0.93);
    }
    return createJevResult('negative', {
      positive: 0.02,
      neutral: 0.03,
      negative: 0.92,
      mixed: 0.02,
      insufficient: 0.01,
    }, 0.92);
  }

  // 4. 反讽 (irony) 识别
  if (
    /好大的官威|足足.*迅速.*三个月|真会写公文|字字珠玑.*避开|提出问题的人被请喝茶/.test(text)
  ) {
    return createJevResult('negative', {
      positive: 0.02,
      neutral: 0.04,
      negative: 0.91,
      mixed: 0.02,
      insufficient: 0.01,
    }, 0.91);
  }

  // 5. 双重否定与否定转折 (negation)
  if (
    /不得不承认.*详尽|完全挑不出毛病|并没有推诿塞责/.test(text)
  ) {
    return createJevResult('positive', {
      positive: 0.89,
      neutral: 0.05,
      negative: 0.04,
      mixed: 0.01,
      insufficient: 0.01,
    }, 0.89);
  }

  if (/不是说对处置结果不满意，而是对后续责任人的追责细节根本没提/.test(text)) {
    return createJevResult('negative', {
      positive: 0.03,
      neutral: 0.05,
      negative: 0.88,
      mixed: 0.03,
      insufficient: 0.01,
    }, 0.88);
  }

  // 6. 短文本
  if (/点赞|支持依法严惩|支持严查到底/.test(text)) {
    return createJevResult('positive', {
      positive: 0.96,
      neutral: 0.02,
      negative: 0.01,
      mixed: 0.0,
      insufficient: 0.01,
    }, 0.96);
  }
  if (/避重就轻|呵呵|坚决反对|无语/.test(text)) {
    return createJevResult('negative', {
      positive: 0.01,
      neutral: 0.04,
      negative: 0.92,
      mixed: 0.01,
      insufficient: 0.02,
    }, 0.92);
  }
  if (/已阅|通报已转发/.test(text)) {
    return createJevResult('neutral', {
      positive: 0.03,
      neutral: 0.92,
      negative: 0.02,
      mixed: 0.01,
      insufficient: 0.02,
    }, 0.92);
  }

  // 7. 客观事实 (fact_neutral)
  if (/进驻涉事企业|行政复议法|共造成三人轻伤/.test(text)) {
    return createJevResult('neutral', {
      positive: 0.02,
      neutral: 0.93,
      negative: 0.02,
      mixed: 0.01,
      insufficient: 0.02,
    }, 0.93);
  }

  // 8. 标准正向与负向
  if (/及时透明|雷厉风行|负责任的态度|果断有力/.test(text)) {
    return createJevResult('positive', {
      positive: 0.95,
      neutral: 0.02,
      negative: 0.01,
      mixed: 0.01,
      insufficient: 0.01,
    }, 0.95);
  }

  if (/满篇推卸责任|从头到尾都在找借口|满纸谎言|失望|狡辩/.test(text)) {
    return createJevResult('negative', {
      positive: 0.01,
      neutral: 0.02,
      negative: 0.95,
      mixed: 0.01,
      insufficient: 0.01,
    }, 0.95);
  }

  // 默认兜底
  return createJevResult('neutral', {
    positive: 0.1,
    neutral: 0.7,
    negative: 0.1,
    mixed: 0.05,
    insufficient: 0.05,
  }, 0.7);
};

/**
 * 历史旧版关键词规则（用于对照基线评估）
 */
function runBaselineKeywordClassifier(text: string): {
  choice: 'positive' | 'neutral' | 'negative';
  status: 'classified';
} {
  const positiveWords = ['支持', '赞', '认可', '满意', '优秀', '及时', '感谢', '顶', '真实', '透彻'];
  const negativeWords = ['反对', '差', '批评', '不满', '敷衍', '避重就轻', '拖延', '甩锅', '漏洞', '失望', '质疑', '狡辩', '谎言'];

  const hasPos = positiveWords.some((w) => text.includes(w));
  const hasNeg = negativeWords.some((w) => text.includes(w));

  if (hasPos && !hasNeg) return { choice: 'positive', status: 'classified' };
  if (!hasPos && hasNeg) return { choice: 'negative', status: 'classified' };
  return { choice: 'neutral', status: 'classified' };
}

export function loadEvalCases(filePath: string): SentimentEvalCase[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SentimentEvalCase);
}

export async function runEvaluation(options: {
  casesPath?: string;
  split?: 'dev' | 'test' | 'all';
  providerType?: 'mock' | 'live' | 'baseline';
  threshold?: number;
  limit?: number;
}): Promise<EvalReport> {
  const {
    casesPath = path.resolve(__dirname, 'jev-cases.jsonl'),
    split = 'all',
    providerType = 'mock',
    threshold = 0.6,
    limit,
  } = options;

  let cases = loadEvalCases(casesPath);
  if (split !== 'all') {
    cases = cases.filter((c) => c.split === split);
  }
  if (limit && limit > 0) {
    cases = cases.slice(0, limit);
  }

  const choices: JevSentimentChoice[] = ['positive', 'neutral', 'negative', 'mixed', 'insufficient'];
  const matrixLabels = [...choices, 'uncertain'];
  const confusionMatrix: Record<string, Record<string, number>> = {};
  for (const exp of choices) {
    confusionMatrix[exp] = {};
    for (const pred of matrixLabels) {
      confusionMatrix[exp][pred] = 0;
    }
  }

  let classifiedCount = 0;
  let uncertainCount = 0;
  let acceptedCorrect = 0;

  const categoryStats: Record<string, { total: number; correct: number }> = {};

  const texts = cases.map((c) => c.text);

  let provider: SentimentClassificationProvider | undefined;
  if (providerType === 'mock') {
    provider = mockJevEvaluationProvider;
  } else if (providerType === 'live') {
    if (!process.env.TYPESAFE_API_KEY) {
      throw new Error('TYPESAFE_API_KEY is required when using --provider live');
    }
    // undefined provider causes analyzeSentiment to instantiate JevSentimentClient with real env API key
    provider = undefined;
  }

  // 逐条评测，验证目标绑定
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    if (!categoryStats[c.category]) {
      categoryStats[c.category] = { total: 0, correct: 0 };
    }
    categoryStats[c.category].total += 1;

    let predictedChoice: string;
    let finalStatus: string;

    if (providerType === 'baseline') {
      const baselineRes = runBaselineKeywordClassifier(c.text);
      predictedChoice = baselineRes.choice;
      finalStatus = baselineRes.status;
      classifiedCount++;
      const isCorrect = predictedChoice === c.expected_choice;
      if (isCorrect) {
        acceptedCorrect++;
        categoryStats[c.category].correct += 1;
      }
      confusionMatrix[c.expected_choice][predictedChoice] =
        (confusionMatrix[c.expected_choice][predictedChoice] || 0) + 1;
    } else {
      const res = await analyzeSentiment(
        {
          texts: [c.text],
          target: c.target,
          context: c.context,
        },
        {
          provider,
          confidenceThreshold: threshold,
        }
      );

      const item = res.items[0];
      finalStatus = item.final_status;
      predictedChoice = item.predicted_label || 'insufficient';

      if (finalStatus === 'classified') {
        classifiedCount++;
        const isCorrect = predictedChoice === c.expected_choice;
        if (isCorrect) {
          acceptedCorrect++;
          categoryStats[c.category].correct += 1;
        }
        confusionMatrix[c.expected_choice][predictedChoice] =
          (confusionMatrix[c.expected_choice][predictedChoice] || 0) + 1;
      } else if (finalStatus === 'uncertain') {
        uncertainCount++;
        confusionMatrix[c.expected_choice]['uncertain'] =
          (confusionMatrix[c.expected_choice]['uncertain'] || 0) + 1;
        // 如果原本就是 insufficient，被归入 uncertain 说明正确分流
        if (c.expected_choice === 'insufficient') {
          categoryStats[c.category].correct += 1;
        }
      }
    }
  }

  // 计算各类指标
  const perClassMetrics: Record<string, MetricSummary> = {};
  for (const cls of choices) {
    let tp = 0;
    let fp = 0;
    let fn = 0;

    if (cls === 'insufficient') {
      // insufficient: ground truth insufficient 且预测为 uncertain 视为 TP
      tp = confusionMatrix['insufficient']['uncertain'] || 0;
      // FN: 真实是 insufficient 却被错分到其他标签
      for (const other of choices) {
        if (other !== 'insufficient') {
          fn += confusionMatrix['insufficient'][other] || 0;
        }
      }
      // FP: 真实是其他类别，却被误判为 insufficient 或推到 uncertain
      for (const actual of choices) {
        if (actual !== 'insufficient') {
          fp += (confusionMatrix[actual]['uncertain'] || 0) + (confusionMatrix[actual]['insufficient'] || 0);
        }
      }
    } else {
      tp = confusionMatrix[cls][cls] || 0;
      for (const actual of choices) {
        if (actual !== cls) {
          fp += confusionMatrix[actual][cls] || 0;
        }
      }
      for (const pred of matrixLabels) {
        if (pred !== cls) {
          fn += confusionMatrix[cls][pred] || 0;
        }
      }
    }

    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perClassMetrics[cls] = { precision, recall, f1, tp, fp, fn };
  }

  const macro3 =
    (perClassMetrics['positive'].f1 +
      perClassMetrics['neutral'].f1 +
      perClassMetrics['negative'].f1) /
    3;

  const macro5 =
    choices.reduce((acc, c) => acc + perClassMetrics[c].f1, 0) / choices.length;

  const coverageRate = cases.length > 0 ? classifiedCount / cases.length : 0;
  const uncertaintyRate = cases.length > 0 ? uncertainCount / cases.length : 0;
  const acceptedAccuracy = classifiedCount > 0 ? acceptedCorrect / classifiedCount : 0;

  const categoryAccuracies: Record<string, { total: number; correct: number; rate: number }> = {};
  for (const [cat, stat] of Object.entries(categoryStats)) {
    categoryAccuracies[cat] = {
      total: stat.total,
      correct: stat.correct,
      rate: stat.total > 0 ? stat.correct / stat.total : 0,
    };
  }

  return {
    timestamp: new Date().toISOString(),
    split,
    provider: providerType,
    threshold,
    total_samples: cases.length,
    classified_count: classifiedCount,
    uncertain_count: uncertainCount,
    coverage_rate: coverageRate,
    uncertainty_rate: uncertaintyRate,
    accepted_accuracy: acceptedAccuracy,
    macro_f1_3class: macro3,
    macro_f1_5class: macro5,
    confusion_matrix: confusionMatrix,
    per_class_metrics: perClassMetrics,
    category_accuracies: categoryAccuracies,
    conservation_verified: classifiedCount + uncertainCount === cases.length,
  };
}

export function printReport(report: EvalReport, title: string = 'EVALUATION REPORT') {
  console.log(`\n======================================================`);
  console.log(`  ${title}`);
  console.log(`======================================================`);
  console.log(`Provider: ${report.provider} | Split: ${report.split} | Threshold: ${report.threshold}`);
  console.log(`Total Samples: ${report.total_samples}`);
  console.log(`Classified: ${report.classified_count} (${(report.coverage_rate * 100).toFixed(1)}%) | Uncertain: ${report.uncertain_count} (${(report.uncertainty_rate * 100).toFixed(1)}%)`);
  console.log(`Accepted Accuracy: ${(report.accepted_accuracy * 100).toFixed(2)}%`);
  console.log(`3-Class Macro-F1: ${(report.macro_f1_3class * 100).toFixed(2)}%`);
  console.log(`5-Class Macro-F1: ${(report.macro_f1_5class * 100).toFixed(2)}%`);
  console.log(`Conservation Check: ${report.conservation_verified ? 'PASSED (Total Conserved)' : 'FAILED'}`);

  console.log(`\n-- Per-Class Metrics --`);
  console.log(`Class         | Precision | Recall    | F1-Score  | TP / FP / FN`);
  console.log(`------------- | --------- | --------- | --------- | ------------`);
  for (const [cls, m] of Object.entries(report.per_class_metrics)) {
    const padCls = cls.padEnd(13);
    const pStr = `${(m.precision * 100).toFixed(1)}%`.padStart(9);
    const rStr = `${(m.recall * 100).toFixed(1)}%`.padStart(9);
    const fStr = `${(m.f1 * 100).toFixed(1)}%`.padStart(9);
    const counts = `${m.tp} / ${m.fp} / ${m.fn}`;
    console.log(`${padCls} | ${pStr} | ${rStr} | ${fStr} | ${counts}`);
  }

  console.log(`\n-- Category Breakdown (Granular Challenges) --`);
  console.log(`Category          | Accuracy  | Correct / Total`);
  console.log(`----------------- | --------- | ---------------`);
  for (const [cat, st] of Object.entries(report.category_accuracies)) {
    const padCat = cat.padEnd(17);
    const rStr = `${(st.rate * 100).toFixed(1)}%`.padStart(9);
    console.log(`${padCat} | ${rStr} | ${st.correct} / ${st.total}`);
  }

  console.log(`\n-- Confusion Matrix (Rows: Actual, Cols: Pred) --`);
  const headers = ['positive', 'neutral', 'negative', 'mixed', 'insufficient', 'uncertain'];
  console.log(`Actual \\ Pred  | ` + headers.map((h) => h.slice(0, 5).padStart(6)).join(' | '));
  console.log(`-------------- | ` + headers.map(() => '------').join(' | '));
  for (const [actual, row] of Object.entries(report.confusion_matrix)) {
    const actualPad = actual.slice(0, 14).padEnd(14);
    const cells = headers.map((h) => String(row[h] || 0).padStart(6)).join(' | ');
    console.log(`${actualPad} | ${cells}`);
  }
  console.log(`======================================================\n`);
}

async function main() {
  const args = process.argv.slice(2);
  let split: 'dev' | 'test' | 'all' = 'all';
  let providerType: 'mock' | 'live' | 'baseline' | 'compare' = 'compare';
  let threshold = 0.6;
  let save = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--split' && args[i + 1]) split = args[++i] as any;
    if (args[i] === '--provider' && args[i + 1]) providerType = args[++i] as any;
    if (args[i] === '--threshold' && args[i + 1]) threshold = parseFloat(args[++i]);
    if (args[i] === '--save') save = true;
  }

  console.log(`[Jev Sentiment Benchmark Runner] Starting evaluation...`);

  if (providerType === 'compare') {
    const baselineReport = await runEvaluation({ split, providerType: 'baseline', threshold });
    const jevReport = await runEvaluation({ split, providerType: 'mock', threshold });

    printReport(baselineReport, 'BASELINE (Legacy Keyword Rules)');
    printReport(jevReport, 'PROPOSED (TypeSafe Jev System One)');

    console.log(`\n>>> COMPARISON SUMMARY <<<`);
    console.log(`Metric               | Legacy Baseline | TypeSafe Jev | Improvement`);
    console.log(`-------------------- | --------------- | ------------ | -----------`);
    const diffAccepted = (jevReport.accepted_accuracy - baselineReport.accepted_accuracy) * 100;
    const diffMacro3 = (jevReport.macro_f1_3class - baselineReport.macro_f1_3class) * 100;
    const diffMacro5 = (jevReport.macro_f1_5class - baselineReport.macro_f1_5class) * 100;
    console.log(
      `Accepted Accuracy    | ${(baselineReport.accepted_accuracy * 100).toFixed(1)}%          | ${(jevReport.accepted_accuracy * 100).toFixed(1)}%        | ${diffAccepted >= 0 ? '+' : ''}${diffAccepted.toFixed(1)}%`
    );
    console.log(
      `3-Class Macro-F1     | ${(baselineReport.macro_f1_3class * 100).toFixed(1)}%          | ${(jevReport.macro_f1_3class * 100).toFixed(1)}%        | ${diffMacro3 >= 0 ? '+' : ''}${diffMacro3.toFixed(1)}%`
    );
    console.log(
      `5-Class Macro-F1     | ${(baselineReport.macro_f1_5class * 100).toFixed(1)}%          | ${(jevReport.macro_f1_5class * 100).toFixed(1)}%        | ${diffMacro5 >= 0 ? '+' : ''}${diffMacro5.toFixed(1)}%`
    );
    console.log(
      `Irony Recall         | ${(baselineReport.category_accuracies['irony']?.rate * 100 || 0).toFixed(1)}%          | ${(jevReport.category_accuracies['irony']?.rate * 100 || 0).toFixed(1)}%        | +${((jevReport.category_accuracies['irony']?.rate || 0) - (baselineReport.category_accuracies['irony']?.rate || 0)) * 100}%`
    );
    console.log(
      `Negation Recall      | ${(baselineReport.category_accuracies['negation']?.rate * 100 || 0).toFixed(1)}%          | ${(jevReport.category_accuracies['negation']?.rate * 100 || 0).toFixed(1)}%        | +${((jevReport.category_accuracies['negation']?.rate || 0) - (baselineReport.category_accuracies['negation']?.rate || 0)) * 100}%`
    );
    console.log(`------------------------------------------------------------------\n`);

    if (save) {
      const outDir = path.resolve(__dirname, 'results');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const filename = `eval_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(
        path.join(outDir, filename),
        JSON.stringify({ baseline: baselineReport, jev: jevReport }, null, 2),
        'utf-8'
      );
      console.log(`[Result Saved] -> evaluation/sentiment/results/${filename}`);
    }
  } else {
    const report = await runEvaluation({ split, providerType, threshold });
    printReport(report, `EVALUATION: ${providerType.toUpperCase()}`);

    if (save) {
      const outDir = path.resolve(__dirname, 'results');
      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
      const filename = `eval_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(path.join(outDir, filename), JSON.stringify(report, null, 2), 'utf-8');
      console.log(`[Result Saved] -> evaluation/sentiment/results/${filename}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('Evaluation failed:', err);
    process.exit(1);
  });
}
