/**
 * ResearchEngine TypeScript 跨语言契约定义与数据模型校验
 * 与 ResearchEngine/schema.py 完全对应
 */

export * from './run.js';
export * from './task.js';
export * from './evidence.js';
export * from './review.js';
export * from './artifact.js';
export * from './research-job.js';

import { ResearchRole } from './task.js';
import { ResearchRun, parseRun } from './run.js';
import { ResearchTask, parseTask } from './task.js';
import { Evidence, Claim } from './evidence.js';
import { HostReviewDecision } from './review.js';
import { ReportJudgment, Artifact } from './artifact.js';

export enum VerificationStatus {
  Supported = 'supported',
  PartiallySupported = 'partially_supported',
  Unsupported = 'unsupported',
  Contradicted = 'contradicted',
  Uncertain = 'uncertain',
}

export interface Envelope {
  schema_version: string;
  run_id: string;
  task_id: string;
  call_id: string;
  execution_version: number;
  idempotency_key: string;
  timestamp: string;
}

export interface AuthorityFinding {
  entity_name: string;
  source_type: string;
  published_at: string;
  raw_text: string;
  stance_evolution: string;
  covered_issues: string[];
  unaddressed_issues: string[];
}

export interface EvolutionFinding {
  metric_definition: string;
  platform: string;
  time_window: string;
  data_points: Array<Record<string, unknown>>;
  missing_periods: string[];
  phase_transition_analysis: string;
  concurrent_events: string[];
  limitations: string[];
}

export interface FeedbackFinding {
  sampling_method: string;
  sample_size: number;
  viewpoint_breakdown: Record<string, number>;
  sentiment_distribution: Record<string, number>;
  demands_summary: string[];
  denominator_info: string;
  representative_quotes: string[];
  limitations: string[];
}

export interface ResearchResult {
  role: ResearchRole;
  round: number;
  claims: Claim[];
  evidence_pool: Evidence[];
  scope: Record<string, unknown>;
  changes_from_previous_round?: string | null;
  coverage_list?: string[];
  unresolved_issues?: string[];
  tool_call_summary?: Record<string, number>;
  authority_finding?: AuthorityFinding | null;
  evolution_finding?: EvolutionFinding | null;
  feedback_finding?: FeedbackFinding | null;
}

export interface VerificationItem {
  claim_id: string;
  claim_statement: string;
  status: VerificationStatus;
  rationale: string;
  supplementary_evidence_ids?: string[];
  suggested_checks?: string | null;
}

export interface ResearchBundle {
  run: ResearchRun;
  tasks: ResearchTask[];
  results: ResearchResult[];
  verifications: VerificationItem[];
  host_decisions?: HostReviewDecision[];
  report_judgment?: ReportJudgment | null;
  artifact?: Artifact | null;
}

const VALID_ROLES = new Set<string>(Object.values(ResearchRole));

/**
 * 校验给定的研究数据包是否符合 v1 契约规范
 */
export function validateResearchFixture(data: any): ResearchBundle {
  if (!data || typeof data !== 'object') {
    throw new Error('ResearchBundle must be a non-null object');
  }

  if (!data.run || typeof data.run.run_id !== 'string') {
    throw new Error('ResearchBundle must contain valid run with run_id');
  }

  // Parse and validate run if full fields provided
  if (data.run.topic) {
    parseRun(data.run);
  }

  if (Array.isArray(data.tasks)) {
    for (const task of data.tasks) {
      if (task.role && !VALID_ROLES.has(task.role)) {
        throw new Error(`Invalid role: ${task.role}`);
      }
    }
  }

  if (Array.isArray(data.results)) {
    for (const res of data.results) {
      if (!VALID_ROLES.has(res.role)) {
        throw new Error(`Invalid role: ${res.role}`);
      }
      if (typeof res.round !== 'number' || res.round > 3 || res.round < 1) {
        throw new Error(`Round cannot exceed 3, received: ${res.round}`);
      }
    }
  }

  return data as ResearchBundle;
}
