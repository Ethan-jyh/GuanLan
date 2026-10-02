import { z } from 'zod';

/**
 * Jev Choice 原始分类选项
 */
export const JevSentimentChoiceSchema = z.enum([
  'positive',
  'neutral',
  'negative',
  'mixed',
  'insufficient',
]);
export type JevSentimentChoice = z.infer<typeof JevSentimentChoiceSchema>;

/**
 * 单条文本最终判定状态
 */
export const ItemClassificationStatusSchema = z.enum([
  'classified',
  'uncertain',
  'error',
  'skipped',
]);
export type ItemClassificationStatus = z.infer<typeof ItemClassificationStatusSchema>;

/**
 * 单条文本分析结果
 */
export const ClassifiedSentimentItemSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string(),
  predicted_label: JevSentimentChoiceSchema.optional(),
  final_status: ItemClassificationStatusSchema,
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});
export type ClassifiedSentimentItem = z.infer<typeof ClassifiedSentimentItemSchema>;

/**
 * 整数计数分布
 */
export const SentimentCountsSchema = z.object({
  positive: z.number().int().nonnegative().default(0),
  neutral: z.number().int().nonnegative().default(0),
  negative: z.number().int().nonnegative().default(0),
  mixed: z.number().int().nonnegative().default(0),
  uncertain: z.number().int().nonnegative().default(0),
  error: z.number().int().nonnegative().default(0),
  skipped: z.number().int().nonnegative().default(0),
});
export type SentimentCounts = z.infer<typeof SentimentCountsSchema>;

/**
 * 比例分布（以输入总数 count 为分母）
 */
export const SentimentDistributionSchema = z.object({
  positive: z.number().min(0).max(1).default(0),
  neutral: z.number().min(0).max(1).default(0),
  negative: z.number().min(0).max(1).default(0),
  mixed: z.number().min(0).max(1).default(0),
  uncertain: z.number().min(0).max(1).default(0),
  error: z.number().min(0).max(1).default(0),
  skipped: z.number().min(0).max(1).default(0),
});
export type SentimentDistribution = z.infer<typeof SentimentDistributionSchema>;

/**
 * 工具输入契约
 */
export const AnalyzeSentimentParamsSchema = z.object({
  texts: z.array(z.string()),
  target: z.string().min(1, 'target is required and cannot be empty'),
  context: z.string().optional(),
});
export type AnalyzeSentimentParams = z.infer<typeof AnalyzeSentimentParamsSchema>;

/**
 * 工具输出契约
 */
export const AnalyzeSentimentResultSchema = z.object({
  status: z.enum(['success', 'partial', 'error']),
  count: z.number().int().nonnegative(),
  denominator: z.number().int().nonnegative(),
  classified_count: z.number().int().nonnegative().default(0),
  counts: SentimentCountsSchema,
  distribution: SentimentDistributionSchema,
  effective_distribution: z.record(z.string(), z.number()).optional(),
  items: z.array(ClassifiedSentimentItemSchema),
  model_version: z.string(),
  question_version: z.string(),
  threshold_version: z.string(),
  confidence_threshold: z.number().min(0).max(1),
  message: z.string().optional(),
  error: z.string().optional(),
});
export type AnalyzeSentimentResult = z.infer<typeof AnalyzeSentimentResultSchema>;

/**
 * Jev SystemOne 官方响应契约
 */
export const JevAnswerSchema = z.object({
  choice: JevSentimentChoiceSchema.optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().optional(),
});
export type JevAnswer = z.infer<typeof JevAnswerSchema>;

export const JevSystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), JevAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});
export type JevSystemOneResponse = z.infer<typeof JevSystemOneResponseSchema>;

/**
 * 总数守恒校验工具函数
 * positive + neutral + negative + mixed + uncertain + error + skipped === count
 */
export function verifySentimentConservation(result: {
  count: number;
  counts: SentimentCounts;
}): boolean {
  const sum =
    result.counts.positive +
    result.counts.neutral +
    result.counts.negative +
    result.counts.mixed +
    result.counts.uncertain +
    result.counts.error +
    result.counts.skipped;
  return sum === result.count;
}
