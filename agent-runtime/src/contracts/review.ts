import { z } from 'zod';
import { ResearchRole } from './task.js';

export enum DecisionType {
  Approve = 'approve',
  Revise = 'revise',
  FinalizeWithUnresolved = 'finalize_with_unresolved',
}

export const DirectiveItemSchema = z.object({
  directive_id: z.string().min(1),
  target_role: z.nativeEnum(ResearchRole),
  related_claim_or_issue: z.string(),
  question: z.string(),
  suggested_action: z.string(),
  completion_criteria: z.string(),
});

export type DirectiveItem = z.infer<typeof DirectiveItemSchema>;

export const HostReviewDecisionSchema = z
  .object({
    task_id: z.string().min(1),
    round: z.number().int().min(1).max(3),
    decision: z.nativeEnum(DecisionType),
    rationale: z.string().default(''),
    directives: z.array(DirectiveItemSchema).default([]),
    unresolved_issues: z.array(z.string()).default([]),
  })
  .superRefine((val, ctx) => {
    if (val.round >= 3 && val.decision === DecisionType.Revise) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Round 3 cannot issue revise: mandatory convergence required',
        path: ['decision'],
      });
    }
  });

export type HostReviewDecision = z.infer<typeof HostReviewDecisionSchema>;

export function parseHostReviewDecision(data: unknown): HostReviewDecision {
  const result = HostReviewDecisionSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid HostReviewDecision: ${issues}`);
  }
  return result.data;
}
