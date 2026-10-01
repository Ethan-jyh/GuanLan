import { ResearchRole, Claim, Evidence, VerificationItem } from '../contracts/research.js';

export interface ReportInputResult {
  run_id: string;
  topic: string;
  scope: Record<string, unknown>;
  research_versions: Record<string, number>;
  findings: Record<string, any>;
  claims: Claim[];
  evidence_pool: Evidence[];
  verifications: VerificationItem[];
  unresolved_issues: string[];
}

export function buildReportInput(
  run_id: string,
  topic: string,
  scope: Record<string, unknown>,
  effectiveSubmissions: Record<string, any> | Map<string, any>,
  verifications: VerificationItem[] = [],
  unresolved_issues: string[] = []
): ReportInputResult {
  const research_versions: Record<string, number> = {};
  const findings_data: Record<string, any> = {};
  const all_claims: Claim[] = [];
  const all_evidences: Evidence[] = [];

  const entries =
    effectiveSubmissions instanceof Map
      ? Array.from(effectiveSubmissions.entries())
      : Object.entries(effectiveSubmissions);

  for (const [roleName, sub] of entries) {
    if (!sub) continue;

    // Cross-run isolation check
    if (sub.run_id && sub.run_id !== run_id) {
      throw new Error(
        `Cross-run isolation violation: foreign run submission '${sub.run_id}' cannot be included in report for '${run_id}'`
      );
    }

    const roundNum = typeof sub.round === 'number' ? sub.round : 1;
    research_versions[roleName] = roundNum;
    findings_data[roleName] = sub;

    for (const c of sub.claims || []) {
      all_claims.push(c);
    }
    for (const e of sub.evidence_pool || []) {
      all_evidences.push(e);
    }
  }

  return {
    run_id,
    topic,
    scope,
    research_versions,
    findings: findings_data,
    claims: all_claims,
    evidence_pool: all_evidences,
    verifications,
    unresolved_issues,
  };
}
