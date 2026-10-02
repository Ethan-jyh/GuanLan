import { z } from 'zod';

export enum ResearchRole {
  Authority = 'authority',
  Evolution = 'evolution',
  Feedback = 'feedback',
  Host = 'host',
  Report = 'report',
  Verifier = 'verifier',
}

export enum TaskStatus {
  Queued = 'queued',
  Running = 'running',
  Succeeded = 'succeeded',
  Partial = 'partial',
  Failed = 'failed',
  TimedOut = 'timed_out',
  Cancelled = 'cancelled',

  // Backward compatibility with v1
  Pending = 'pending',
  Submitted = 'submitted',
}

export const TaskSchema = z.object({
  task_id: z.string().min(1, 'task_id is required'),
  run_id: z.string().min(1, 'run_id is required'),
  role: z.nativeEnum(ResearchRole, {
    message: 'Invalid role',
  }),
  round: z.number().int().min(1).max(3).default(1),
  generation: z.number().int().min(1).default(1),
  question: z.string(),
  scope: z.record(z.string(), z.unknown()).default({}),
  completion_criteria: z.string().default(''),
  required_for_report: z.boolean().default(true),
  dependencies: z.array(z.string()).default([]),
  superseded_by: z.string().nullable().optional(),
  status: z.nativeEnum(TaskStatus),
  assigned_to: z.string().nullable().optional(),
  budget_allocated: z.number().nonnegative().default(0),
  created_at: z.string(),
  completed_at: z.string().nullable().optional(),
});

export type TaskOutput = z.infer<typeof TaskSchema>;

export type ResearchTask = Omit<
  TaskOutput,
  'generation' | 'completion_criteria' | 'required_for_report' | 'dependencies'
> & {
  generation?: number;
  completion_criteria?: string;
  required_for_report?: boolean;
  dependencies?: string[];
};

export function parseTask(data: unknown): TaskOutput {
  const result = TaskSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ResearchTask: ${issues}`);
  }
  return result.data;
}
