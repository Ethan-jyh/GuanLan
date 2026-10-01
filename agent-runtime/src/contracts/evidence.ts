import { z } from 'zod';

export const EvidenceSchema = z.object({
  evidence_id: z.string().min(1, 'evidence_id is required'),
  source_type: z.string().min(1),
  source_ref: z.string().min(1),
  title: z.string().default(''),
  excerpt: z.string().default(''),
  retrieval_time: z.string(),
  source_date: z.string().nullable().optional(),
  is_full_text: z.boolean().default(false),
  coverage_scope: z.record(z.string(), z.unknown()).optional(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const ClaimSchema = z.object({
  claim_id: z.string().min(1, 'claim_id is required'),
  statement: z.string().min(1),
  evidence_ids: z.array(z.string()).default([]),
  time_scope: z.string().nullable().optional(),
  applicability_scope: z.string().nullable().optional(),
  limitations: z.array(z.string()).default([]),
});

export type Claim = z.infer<typeof ClaimSchema>;

export function parseEvidence(data: unknown): Evidence {
  const result = EvidenceSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid Evidence: ${issues}`);
  }
  return result.data;
}

export function parseClaim(data: unknown): Claim {
  const result = ClaimSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid Claim: ${issues}`);
  }
  return result.data;
}

export function validateClaimEvidenceIsolation(
  claim: Claim,
  availableIds: Set<string>
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const id of claim.evidence_ids) {
    if (!availableIds.has(id)) {
      missing.push(id);
    }
  }
  return {
    valid: missing.length === 0,
    missing,
  };
}
