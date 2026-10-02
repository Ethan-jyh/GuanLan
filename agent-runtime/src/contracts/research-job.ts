import { z } from 'zod';
import { ResearchRole } from './task.js';

/**
 * HOST 派发独立研究作业的参数契约
 */
export const ResearchJobParamsSchema = z.object({
  question: z.string().min(1, 'question is required'),
  scope: z.record(z.string(), z.unknown()).default({}),
  completion_criteria: z.string().min(1, 'completion_criteria is required'),
  requested_budget_units: z.number().int().nonnegative().default(10),
  required_for_report: z.boolean().default(true),
  dependencies: z.array(z.string()).default([]),
});
export type ResearchJobParams = z.infer<typeof ResearchJobParamsSchema>;

export function parseResearchJobParams(data: unknown): ResearchJobParams {
  const result = ResearchJobParamsSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ResearchJobParams: ${issues}`);
  }
  return result.data;
}

/**
 * 任务即时回执契约 (接受或拒绝)
 */
export const AcceptedTaskReceiptSchema = z.object({
  status: z.literal('accepted'),
  task_id: z.string().min(1, 'task_id is required'),
  attempt_id: z.string().min(1, 'attempt_id is required'),
  role: z.nativeEnum(ResearchRole),
  result_pending: z.literal(true),
  message: z.string().optional(),
});
export type AcceptedTaskReceipt = z.infer<typeof AcceptedTaskReceiptSchema>;

export const RejectedTaskReceiptSchema = z.object({
  status: z.literal('rejected'),
  task_id: z.string().optional(),
  attempt_id: z.string().optional(),
  role: z.nativeEnum(ResearchRole).optional(),
  result_pending: z.literal(false).default(false),
  reason: z.string().min(1, 'reason is required'),
});
export type RejectedTaskReceipt = z.infer<typeof RejectedTaskReceiptSchema>;

export const TaskReceiptSchema = z.discriminatedUnion('status', [
  AcceptedTaskReceiptSchema,
  RejectedTaskReceiptSchema,
]);
export type TaskReceipt = z.infer<typeof TaskReceiptSchema>;

export function parseTaskReceipt(data: unknown): TaskReceipt {
  const result = TaskReceiptSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid TaskReceipt: ${issues}`);
  }
  return result.data;
}

/**
 * 独立任务成果终态枚举
 */
export const ResearchOutcomeStatusSchema = z.enum([
  'succeeded',
  'partial',
  'failed',
  'timed_out',
  'cancelled',
]);
export type ResearchOutcomeStatus = z.infer<typeof ResearchOutcomeStatusSchema>;

/**
 * 成果执行错误详情
 */
export const ResearchOutcomeErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean().default(false),
});
export type ResearchOutcomeError = z.infer<typeof ResearchOutcomeErrorSchema>;

/**
 * 资源使用用量契约
 */
export const ResearchOutcomeUsageSchema = z.object({
  tool_attempts: z.number().int().nonnegative().default(0),
  model_tokens: z.number().int().nonnegative().optional(),
});
export type ResearchOutcomeUsage = z.infer<typeof ResearchOutcomeUsageSchema>;

/**
 * 独立研究成果契约 (不可变)
 */
export const ResearchOutcomeSchema = z.object({
  run_id: z.string().min(1, 'run_id is required'),
  task_id: z.string().min(1, 'task_id is required'),
  attempt_id: z.string().min(1, 'attempt_id is required'),
  execution_version: z.number().int().min(1, 'execution_version must be >= 1'),
  role: z.nativeEnum(ResearchRole),
  status: ResearchOutcomeStatusSchema,
  result_ref: z.string().optional(),
  summary: z.string().optional(),
  error: ResearchOutcomeErrorSchema.optional(),
  usage: ResearchOutcomeUsageSchema,
  completed_at: z.string().min(1, 'completed_at is required'),
});
export type ResearchOutcome = z.infer<typeof ResearchOutcomeSchema>;

export function parseResearchOutcome(data: unknown): ResearchOutcome {
  const result = ResearchOutcomeSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ResearchOutcome: ${issues}`);
  }
  return result.data;
}

/**
 * HOST 收件箱事件类型枚举
 */
export const HostInboxEventTypeSchema = z.enum([
  'research_outcome',
  'task_timeout',
  'host_help_requested',
  'release_requested',
]);
export type HostInboxEventType = z.infer<typeof HostInboxEventTypeSchema>;

/**
 * HOST 收件箱事件契约
 */
export const HostInboxEventSchema = z.object({
  event_id: z.string().min(1, 'event_id is required'),
  run_id: z.string().min(1, 'run_id is required'),
  task_id: z.string().optional(),
  event_type: HostInboxEventTypeSchema,
  payload: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().optional(),
  timestamp: z.string().optional(),
});
export type HostInboxEvent = z.infer<typeof HostInboxEventSchema>;

export function parseHostInboxEvent(data: unknown): HostInboxEvent {
  const result = HostInboxEventSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid HostInboxEvent: ${issues}`);
  }
  return result.data;
}

/**
 * 专报放行申请契约
 */
export const ReleaseRequestSchema = z.object({
  run_id: z.string().optional(),
  snapshot_id: z.string().optional(),
  rationale: z.string().default(''),
  allowed_gaps: z.array(z.string()).default([]),
  unresolved_issues: z.array(z.string()).default([]),
  restricted: z.boolean().default(false),
  target_format: z.string().default('docx'),
});
export type ReleaseRequest = z.infer<typeof ReleaseRequestSchema>;

export function parseReleaseRequest(data: unknown): ReleaseRequest {
  const result = ReleaseRequestSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ReleaseRequest: ${issues}`);
  }
  return result.data;
}
