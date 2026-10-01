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
  Pending = 'pending',
  Running = 'running',
  Submitted = 'submitted',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export const TaskSchema = z.object({
  task_id: z.string().min(1, 'task_id is required'),
  run_id: z.string().min(1, 'run_id is required'),
  role: z.nativeEnum(ResearchRole, {
    message: 'Invalid role',
  }),
  round: z.number().int().min(1).max(3),
  question: z.string(),
  scope: z.record(z.string(), z.unknown()).default({}),
  status: z.nativeEnum(TaskStatus),
  assigned_to: z.string().nullable().optional(),
  budget_allocated: z.number().nonnegative().default(0),
  created_at: z.string(),
  completed_at: z.string().nullable().optional(),
});

export type ResearchTask = z.infer<typeof TaskSchema>;

export function parseTask(data: unknown): ResearchTask {
  const result = TaskSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ResearchTask: ${issues}`);
  }
  return result.data;
}
