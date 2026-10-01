import { randomUUID } from 'node:crypto';
import { SubmissionRepository, TaskRepository } from '../storage/repositories.js';
import { EvidenceStore } from '../storage/evidence-store.js';
import { ResearchRole, TaskStatus, Claim, Evidence } from '../contracts/research.js';

export interface ValidateAndSaveSubmissionParams {
  run_id: string;
  task_id: string;
  findings: any;
}

export interface SubmissionResult {
  ok: boolean;
  submission_id?: string;
  error?: string;
}

export class SubmissionManager {
  constructor(
    private subRepo: SubmissionRepository,
    private taskRepo: TaskRepository,
    private evidenceStore?: EvidenceStore
  ) {}

  public validateAndSaveSubmission(params: ValidateAndSaveSubmissionParams): SubmissionResult {
    const { run_id, task_id, findings } = params;

    if (!run_id || !task_id) {
      return { ok: false, error: 'Missing run_id or task_id in submission payload' };
    }

    if (!findings || typeof findings !== 'object') {
      return { ok: false, error: 'Findings must be a non-null object' };
    }

    const role = findings.role as ResearchRole;
    const round = findings.round as number;

    if (!role || !Object.values(ResearchRole).includes(role)) {
      return { ok: false, error: `Invalid role '${role}' in findings` };
    }

    if (typeof round !== 'number' || round < 1 || round > 3) {
      return { ok: false, error: `Invalid round '${round}' in findings (must be 1-3)` };
    }

    // Evidence pool validation
    const pool = (findings.evidence_pool || []) as Evidence[];
    const knownEvidenceIds = new Set<string>(pool.map((e) => e.evidence_id));

    const claims = (findings.claims || []) as Claim[];
    for (const claim of claims) {
      for (const eid of claim.evidence_ids || []) {
        if (!knownEvidenceIds.has(eid)) {
          if (!this.evidenceStore || !this.evidenceStore.getEvidence(run_id, eid)) {
            return {
              ok: false,
              error: `Claim '${claim.claim_id}' references unknown evidence '${eid}'. Must be included in evidence_pool or stored.`,
            };
          }
        }
      }
    }

    // Role-specific finding validation
    if (role === ResearchRole.Authority && !findings.authority_finding) {
      return { ok: false, error: 'Authority finding is required for authority role submission' };
    }
    if (role === ResearchRole.Evolution && !findings.evolution_finding) {
      return { ok: false, error: 'Evolution finding is required for evolution role submission' };
    }
    if (role === ResearchRole.Feedback && !findings.feedback_finding) {
      return { ok: false, error: 'Feedback finding is required for feedback role submission' };
    }

    // Persist evidence into evidenceStore
    if (this.evidenceStore) {
      for (const ev of pool) {
        this.evidenceStore.addEvidence({
          run_id,
          source_type: ev.source_type,
          source_ref: ev.source_ref,
          title: ev.title || '',
          excerpt: ev.excerpt || '',
          retrieval_time: ev.retrieval_time,
          source_date: ev.source_date,
          is_full_text: ev.is_full_text,
          coverage_scope: ev.coverage_scope,
        });
      }
    }

    // Save submission and mark task submitted
    const nowIso = new Date().toISOString();
    const submissionId = `sub-${randomUUID().substring(0, 12)}`;

    try {
      this.subRepo.saveSubmission({
        submission_id: submissionId,
        run_id,
        task_id,
        role,
        round,
        data: findings,
        created_at: nowIso,
      });

      this.taskRepo.updateTaskStatus(task_id, TaskStatus.Submitted, nowIso);

      return { ok: true, submission_id: submissionId };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  public getSubmission(submission_id: string) {
    return this.subRepo.getSubmission(submission_id);
  }

  public getLatestSubmissionForRole(run_id: string, role: string, round_num?: number) {
    const subs = this.subRepo.listSubmissions(run_id, round_num);
    const roleSubs = subs.filter((s) => s.role === role);
    if (roleSubs.length === 0) return null;
    return roleSubs[roleSubs.length - 1];
  }
}
