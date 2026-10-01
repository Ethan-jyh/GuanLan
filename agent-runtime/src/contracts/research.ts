/**
 * ResearchEngine TypeScript 跨语言契约定义与数据模型校验
 * 与 ResearchEngine/schema.py 完全对应
 */

export enum ResearchRole {
  Authority = 'authority',
  Evolution = 'evolution',
  Feedback = 'feedback',
  Host = 'host',
  Report = 'report',
  Verifier = 'verifier',
}

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

export enum TaskStatus {
  Pending = 'pending',
  Running = 'running',
  Submitted = 'submitted',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum VerificationStatus {
  Supported = 'supported',
  PartiallySupported = 'partially_supported',
  Unsupported = 'unsupported',
  Contradicted = 'contradicted',
  Uncertain = 'uncertain',
}

export enum DecisionType {
  Approve = 'approve',
  Revise = 'revise',
  FinalizeWithUnresolved = 'finalize_with_unresolved',
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

export interface Evidence {
  evidence_id: string;
  source_type: string;
  source_ref: string;
  title: string;
  excerpt: string;
  retrieval_time: string;
  source_date?: string | null;
  is_full_text: boolean;
  coverage_scope?: Record<string, unknown>;
}

export interface Claim {
  claim_id: string;
  statement: string;
  evidence_ids: string[];
  time_scope?: string | null;
  applicability_scope?: string | null;
  limitations: string[];
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

export interface DirectiveItem {
  directive_id: string;
  target_role: ResearchRole;
  related_claim_or_issue: string;
  question: string;
  suggested_action: string;
  completion_criteria: string;
}

export interface HostReviewDecision {
  task_id: string;
  round: number;
  decision: DecisionType;
  rationale: string;
  directives: DirectiveItem[];
  unresolved_issues: string[];
}

export interface ReportJudgment {
  overall_interpretation: string;
  risks: Array<Record<string, unknown>>;
  recommendations: Array<Record<string, unknown>>;
  linked_claim_ids: string[];
  linked_evidence_ids: string[];
  applicability_conditions: string[];
  alternative_explanations: string[];
  uncertainties: string[];
}

export interface Artifact {
  artifact_id: string;
  run_id: string;
  version: number;
  research_versions: Record<string, number>;
  judgment_version: number;
  final_check_passed: boolean;
  ir_content: Record<string, unknown>;
  output_file_paths: Record<string, string>;
}

export interface ResearchRun {
  run_id: string;
  topic: string;
  scope: Record<string, unknown>;
  status: RunStatus;
  current_round: number;
  max_rounds: number;
  budget_total: number;
  budget_used: number;
  created_at: string;
  updated_at: string;
}

export interface ResearchTask {
  task_id: string;
  run_id: string;
  role: ResearchRole;
  round: number;
  question: string;
  scope: Record<string, unknown>;
  status: TaskStatus;
  assigned_to?: string | null;
  budget_allocated: number;
  created_at: string;
  completed_at?: string | null;
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
