import {
  AnalyzeSentimentParams,
  AnalyzeSentimentParamsSchema,
  AnalyzeSentimentResult,
  ClassifiedSentimentItem,
  JevSentimentChoice,
  SentimentCounts,
  SentimentDistribution,
  verifySentimentConservation,
} from '../contracts/sentiment.js';
import { JevClient, JevClassificationResult } from './jev-client.js';
import { JEV_SENTIMENT_QUESTION_VERSION } from './jev-questions.js';

export interface QueryCommentsParams {
  post_id_or_keyword: string;
  sample_size?: number;
  sentiment_filter?: string;
}

export interface QueryCommentsResult {
  status: 'success' | 'not_found' | 'error';
  target?: string;
  sample_size: number;
  denominator_info: string;
  comments: any[];
  error?: string;
}

export async function queryComments(
  params: QueryCommentsParams,
  commentsBackend?: (params: QueryCommentsParams) => Promise<any[]> | any[]
): Promise<QueryCommentsResult> {
  const target = params.post_id_or_keyword?.trim();
  if (!target) {
    return {
      status: 'error',
      sample_size: 0,
      denominator_info: '',
      comments: [],
      error: 'post_id_or_keyword cannot be empty',
    };
  }

  const sampleSize = params.sample_size ?? 100;
  let comments: any[] = [];
  if (commentsBackend) {
    comments = await commentsBackend(params);
  }

  return {
    status: 'success',
    target,
    sample_size: sampleSize,
    denominator_info: `抽样于关联的帖子评论池（最高限制 ${sampleSize} 条）`,
    comments,
  };
}

import { CallLedger } from '../orchestration/call-ledger.js';
import { BudgetLedger } from '../storage/budget-ledger.js';

export type SentimentClassificationProvider = (params: {
  text: string;
  target: string;
  context?: string;
}) => Promise<JevClassificationResult>;

export interface AnalyzeSentimentOptions {
  provider?: SentimentClassificationProvider;
  client?: JevClient;
  confidenceThreshold?: number;
  thresholdVersion?: string;
  maxConcurrency?: number;
  maxBatchSize?: number;
  enableCache?: boolean;
  callLedger?: CallLedger;
  parentCallId?: string;
  budgetLedger?: BudgetLedger;
  runId?: string;
  taskId?: string;
  signal?: AbortSignal;
  costPerToken?: number;
}

/**
 * TypeSafe Jev 驱动的情感分类聚合工具
 */
export async function analyzeSentiment(
  rawParams: any,
  options: AnalyzeSentimentOptions = {}
): Promise<AnalyzeSentimentResult> {
  // 1. 参数校验
  const parsedParams = AnalyzeSentimentParamsSchema.safeParse(rawParams);
  if (!parsedParams.success) {
    const errorMsg = parsedParams.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    const count = Array.isArray(rawParams?.texts) ? rawParams.texts.length : 0;
    return {
      status: 'error',
      count,
      denominator: count,
      classified_count: 0,
      counts: { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0, error: count, skipped: 0 },
      distribution: { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0, error: count > 0 ? 1 : 0, skipped: 0 },
      items: [],
      model_version: 'unknown',
      question_version: JEV_SENTIMENT_QUESTION_VERSION,
      threshold_version: options.thresholdVersion ?? 'th-default-v1',
      confidence_threshold: options.confidenceThreshold ?? 0.65,
      error: `Invalid parameters: ${errorMsg}`,
    };
  }

  const { texts, target, context } = parsedParams.data;
  const confidenceThreshold = options.confidenceThreshold ?? 0.65;
  const thresholdVersion = options.thresholdVersion ?? 'th-default-v1';
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 5);

  // 2. 空输入处理
  if (texts.length === 0) {
    return {
      status: 'success',
      count: 0,
      denominator: 0,
      classified_count: 0,
      counts: { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0, error: 0, skipped: 0 },
      distribution: { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0, error: 0, skipped: 0 },
      items: [],
      model_version: 'none',
      question_version: JEV_SENTIMENT_QUESTION_VERSION,
      threshold_version: thresholdVersion,
      confidence_threshold: confidenceThreshold,
    };
  }

  // 3. Provider 解析：支持显式注入或自动创建 JevClient
  let provider = options.provider;
  if (!provider) {
    const client = options.client ?? (process.env.TYPESAFE_API_KEY ? new JevClient() : undefined);
    if (client) {
      provider = async (p) => client.classifySentiment(p);
    }
  }

  if (!provider) {
    const total = texts.length;
    return {
      status: 'error',
      count: total,
      denominator: total,
      classified_count: 0,
      counts: { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0, error: total, skipped: 0 },
      distribution: { positive: 0, neutral: 0, negative: 0, mixed: 0, uncertain: 0, error: 1, skipped: 0 },
      items: texts.map((t, idx) => ({
        index: idx,
        text: t,
        final_status: 'error',
        reason: 'Jev classification provider is not configured (missing TYPESAFE_API_KEY)',
      })),
      model_version: 'none',
      question_version: JEV_SENTIMENT_QUESTION_VERSION,
      threshold_version: thresholdVersion,
      confidence_threshold: confidenceThreshold,
      error: 'TYPESAFE_API_KEY is not configured and no provider was injected.',
    };
  }

  // 4. 并发与缓存处理
  const cache = new Map<string, JevClassificationResult>();
  const items: ClassifiedSentimentItem[] = new Array(texts.length);
  let resolvedModel = 'jev-latest';

  const workerTasks: Array<() => Promise<void>> = [];

  for (let i = 0; i < texts.length; i++) {
    const index = i;
    const text = texts[index];

    if (!text || !text.trim()) {
      items[index] = {
        index,
        text,
        final_status: 'skipped',
        reason: 'Empty or whitespace-only text',
      };
      continue;
    }

    workerTasks.push(async () => {
      // 检查取消信号
      if (options.signal?.aborted) {
        items[index] = {
          index,
          text,
          final_status: 'skipped',
          reason: 'Operation cancelled',
        };
        return;
      }

      // 预留预算
      let reservationId: string | undefined;
      const subCallId = options.parentCallId ? `${options.parentCallId}:item:${index}` : undefined;

      if (options.callLedger && options.parentCallId) {
        const reserveRes = options.callLedger.beginSubCall({
          parent_call_id: options.parentCallId,
          sub_call_id: subCallId!,
          units: 1,
        });
        if (!reserveRes.ok) {
          items[index] = {
            index,
            text,
            final_status: 'skipped',
            reason: `Budget exhausted: ${reserveRes.error || 'cannot reserve quota'}`,
          };
          return;
        }
        reservationId = reserveRes.reservation_id;
      } else if (options.budgetLedger && options.runId) {
        const reserveRes = options.budgetLedger.reserve({
          run_id: options.runId,
          task_id: options.taskId,
          units: 1,
          call_type: 'tool:analyze_sentiment:http',
        });
        if (!reserveRes.ok) {
          items[index] = {
            index,
            text,
            final_status: 'skipped',
            reason: `Budget exhausted: ${reserveRes.error || 'cannot reserve quota'}`,
          };
          return;
        }
        reservationId = reserveRes.reservation_id;
      }

      const cacheKey = `${target}:::${context || ''}:::${text}`;
      let res: JevClassificationResult;

      try {
        if (options.enableCache !== false && cache.has(cacheKey)) {
          res = cache.get(cacheKey)!;
        } else {
          res = await provider!({ text, target, context });
          if (options.enableCache !== false) {
            cache.set(cacheKey, res);
          }
        }

        if (res.actualModel) {
          resolvedModel = res.actualModel;
        }

        const choice = res.choice;
        const confidence = res.confidence ?? 0;

        if (choice === 'insufficient') {
          items[index] = {
            index,
            text,
            predicted_label: choice,
            final_status: 'uncertain',
            probabilities: res.probabilities,
            confidence,
            reason: 'Insufficient information regarding target',
          };
        } else if (confidence < confidenceThreshold) {
          items[index] = {
            index,
            text,
            predicted_label: choice,
            final_status: 'uncertain',
            probabilities: res.probabilities,
            confidence,
            reason: `Confidence ${confidence.toFixed(2)} below threshold ${confidenceThreshold}`,
          };
        } else {
          items[index] = {
            index,
            text,
            predicted_label: choice,
            final_status: 'classified',
            probabilities: res.probabilities,
            confidence,
          };
        }

        // 结算账本
        const totalTokens = res.usage?.totalTokens;
        const costEstimate = totalTokens ? totalTokens * (options.costPerToken ?? 0.00001) : undefined;
        if (options.callLedger && subCallId) {
          options.callLedger.endCall({
            call_id: subCallId,
            success: true,
            actual_units: 1,
            cost_estimate: costEstimate,
          });
        } else if (options.budgetLedger && reservationId) {
          options.budgetLedger.settle({
            reservation_id: reservationId,
            actual_units: 1,
            cost_estimate: costEstimate,
          });
        }
      } catch (err: any) {
        items[index] = {
          index,
          text,
          final_status: 'error',
          reason: err?.message || 'Classification request failed',
        };

        // 失败也结算 1 单元，防止免费无限重试
        if (options.callLedger && subCallId) {
          options.callLedger.endCall({
            call_id: subCallId,
            success: false,
            error: err?.message,
            actual_units: 1,
          });
        } else if (options.budgetLedger && reservationId) {
          options.budgetLedger.settle({
            reservation_id: reservationId,
            actual_units: 1,
          });
        }
      }
    });
  }

  // 5. 受限并发调度池
  let currentTaskIdx = 0;
  async function runWorker() {
    while (currentTaskIdx < workerTasks.length) {
      const task = workerTasks[currentTaskIdx++];
      if (task) {
        await task();
      }
    }
  }

  const pool = Array.from({ length: Math.min(maxConcurrency, workerTasks.length) }, () => runWorker());
  await Promise.all(pool);

  // 6. 统计汇总与总数守恒
  const counts: SentimentCounts = {
    positive: 0,
    neutral: 0,
    negative: 0,
    mixed: 0,
    uncertain: 0,
    error: 0,
    skipped: 0,
  };

  for (const item of items) {
    if (item.final_status === 'classified' && item.predicted_label) {
      if (item.predicted_label === 'positive') counts.positive++;
      else if (item.predicted_label === 'neutral') counts.neutral++;
      else if (item.predicted_label === 'negative') counts.negative++;
      else if (item.predicted_label === 'mixed') counts.mixed++;
      else counts.uncertain++;
    } else if (item.final_status === 'uncertain') {
      counts.uncertain++;
    } else if (item.final_status === 'error') {
      counts.error++;
    } else if (item.final_status === 'skipped') {
      counts.skipped++;
    }
  }

  const total = texts.length;
  const classifiedCount = counts.positive + counts.neutral + counts.negative + counts.mixed;

  const distribution: SentimentDistribution = {
    positive: Number((counts.positive / total).toFixed(4)),
    neutral: Number((counts.neutral / total).toFixed(4)),
    negative: Number((counts.negative / total).toFixed(4)),
    mixed: Number((counts.mixed / total).toFixed(4)),
    uncertain: Number((counts.uncertain / total).toFixed(4)),
    error: Number((counts.error / total).toFixed(4)),
    skipped: Number((counts.skipped / total).toFixed(4)),
  };

  let effectiveDistribution: Record<string, number> | undefined;
  if (classifiedCount > 0) {
    effectiveDistribution = {
      positive: Number((counts.positive / classifiedCount).toFixed(4)),
      neutral: Number((counts.neutral / classifiedCount).toFixed(4)),
      negative: Number((counts.negative / classifiedCount).toFixed(4)),
      mixed: Number((counts.mixed / classifiedCount).toFixed(4)),
    };
  }

  let status: 'success' | 'partial' | 'error' = 'success';
  if (counts.error === total) {
    status = 'error';
  } else if (counts.error > 0 || counts.uncertain > 0 || counts.skipped > 0) {
    status = 'partial';
  }

  const result: AnalyzeSentimentResult = {
    status,
    count: total,
    denominator: total,
    classified_count: classifiedCount,
    counts,
    distribution,
    effective_distribution: effectiveDistribution,
    items,
    model_version: resolvedModel,
    question_version: JEV_SENTIMENT_QUESTION_VERSION,
    threshold_version: thresholdVersion,
    confidence_threshold: confidenceThreshold,
  };

  // 严格验证总数守恒
  if (!verifySentimentConservation(result)) {
    throw new Error('Internal state violation: sentiment counts do not conserve total input count.');
  }

  return result;
}
