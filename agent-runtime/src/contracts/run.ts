import { z } from 'zod';

export enum RunStatus {
  Planning = 'planning',
  Researching = 'researching',
  Reviewing = 'reviewing',
  Approved = 'approved',
  Writing = 'writing',
  FinalCheck = 'final_check',
  Completed = 'completed',
  Paused = 'paused',
  Cancelled = 'cancelled',
}

export const RunSchema = z.object({
  run_id: z.string().min(1, 'run_id is required'),
  topic: z.string().min(1, 'topic is required'),
  scope: z.record(z.string(), z.unknown()).default({}),
  status: z.nativeEnum(RunStatus),
  current_round: z
    .number()
    .int()
    .min(1, 'Round cannot be less than 1')
    .max(3, 'Round cannot exceed 3'),
  max_rounds: z.number().int().min(1).default(3),
  budget_total: z.number().nonnegative().default(50),
  budget_used: z.number().nonnegative().default(0),
  execution_version: z.number().int().default(1),
  created_at: z.string(),
  updated_at: z.string(),
});

export type ResearchRun = z.infer<typeof RunSchema>;

export function parseRun(data: unknown): ResearchRun {
  const result = RunSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ResearchRun: ${issues}`);
  }
  return result.data;
}
