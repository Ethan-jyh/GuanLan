import { z } from 'zod';

export const ReportJudgmentSchema = z.object({
  overall_interpretation: z.string().min(1),
  risks: z.array(z.record(z.string(), z.unknown())).default([]),
  recommendations: z.array(z.record(z.string(), z.unknown())).default([]),
  linked_claim_ids: z.array(z.string()).default([]),
  linked_evidence_ids: z.array(z.string()).default([]),
  applicability_conditions: z.array(z.string()).default([]),
  alternative_explanations: z.array(z.string()).default([]),
  uncertainties: z.array(z.string()).default([]),
});

export type ReportJudgment = z.infer<typeof ReportJudgmentSchema>;

export const ArtifactSchema = z.object({
  artifact_id: z.string().min(1),
  run_id: z.string().min(1),
  version: z.number().int().default(1),
  research_versions: z.record(z.string(), z.number()).default({}),
  judgment_version: z.number().int().default(1),
  final_check_passed: z.boolean().default(false),
  ir_content: z.record(z.string(), z.unknown()).default({}),
  output_file_paths: z.record(z.string(), z.string()).default({}),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export function parseReportJudgment(data: unknown): ReportJudgment {
  const result = ReportJudgmentSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid ReportJudgment: ${issues}`);
  }
  return result.data;
}

export function parseArtifact(data: unknown): Artifact {
  const result = ArtifactSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new Error(`Invalid Artifact: ${issues}`);
  }
  return result.data;
}
