import { Claim, Evidence, VerificationItem } from '../contracts/research.js';
import type { MaterialSnapshot } from '../orchestration/release-gate.js';

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

export function isMaterialSnapshot(val: unknown): val is MaterialSnapshot {
  return (
    typeof val === 'object' &&
    val !== null &&
    'snapshot_id' in val &&
    typeof (val as any).snapshot_id === 'string'
  );
}

export function buildReportInputFromSnapshot(
  snapshot: MaterialSnapshot,
  meta?: {
    topic?: string;
    scope?: Record<string, unknown>;
    verifications?: VerificationItem[];
    unresolved_issues?: string[];
  }
): ReportInputResult {
  const research_versions: Record<string, number> = {};
  const findings_data: Record<string, any> = {};

  for (const res of snapshot.accepted_results || []) {
    research_versions[res.role] = res.version;
    findings_data[res.role] = res.findings || { summary: res.summary };
  }

  const combinedIssues = Array.from(
    new Set([...(meta?.unresolved_issues || []), ...(snapshot.gaps || [])])
  );

  return {
    run_id: snapshot.run_id,
    topic: meta?.topic || '',
    scope: meta?.scope || {},
    research_versions,
    findings: findings_data,
    claims: snapshot.claims || [],
    evidence_pool: snapshot.evidence_pool || [],
    verifications: meta?.verifications || [],
    unresolved_issues: combinedIssues,
  };
}

export function buildReportInput(
  runIdOrSnapshot: string | MaterialSnapshot,
  topicOrMeta?: string | {
    topic?: string;
    scope?: Record<string, unknown>;
    verifications?: VerificationItem[];
    unresolved_issues?: string[];
  },
  scope?: Record<string, unknown>,
  effectiveSubmissions?: Record<string, any> | Map<string, any> | MaterialSnapshot,
  verifications: VerificationItem[] = [],
  unresolved_issues: string[] = []
): ReportInputResult {
  // Overload 1: First argument is MaterialSnapshot
  if (isMaterialSnapshot(runIdOrSnapshot)) {
    const meta =
      typeof topicOrMeta === 'object' && topicOrMeta !== null
        ? topicOrMeta
        : {
            topic: typeof topicOrMeta === 'string' ? topicOrMeta : undefined,
            scope,
            verifications,
            unresolved_issues,
          };
    return buildReportInputFromSnapshot(runIdOrSnapshot, meta);
  }

  const run_id = runIdOrSnapshot;
  const topic = typeof topicOrMeta === 'string' ? topicOrMeta : '';
  const effectiveScope = scope || {};

  // Overload 2: effectiveSubmissions is MaterialSnapshot
  if (isMaterialSnapshot(effectiveSubmissions)) {
    const snapshot = effectiveSubmissions;
    if (snapshot.run_id && snapshot.run_id !== run_id) {
      throw new Error(
        `Cross-run isolation violation: foreign snapshot '${snapshot.run_id}' cannot be included in report for '${run_id}'`
      );
    }
    return buildReportInputFromSnapshot(snapshot, {
      topic,
      scope: effectiveScope,
      verifications,
      unresolved_issues,
    });
  }

  // Classic submission-based path
  const research_versions: Record<string, number> = {};
  const findings_data: Record<string, any> = {};
  const all_claims: Claim[] = [];
  const all_evidences: Evidence[] = [];

  const submissions = effectiveSubmissions || {};
  const entries =
    submissions instanceof Map
      ? Array.from(submissions.entries())
      : Object.entries(submissions);

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
    scope: effectiveScope,
    research_versions,
    findings: findings_data,
    claims: all_claims,
    evidence_pool: all_evidences,
    verifications,
    unresolved_issues,
  };
}
