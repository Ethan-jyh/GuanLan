import { randomUUID } from 'node:crypto';
import { ResearchDatabase } from '../storage/database.js';
import {
  RunRepository,
  TaskRepository,
  ReviewRepository,
  HostDecisionRepository,
  type HostDecisionRecord,
} from '../storage/repositories.js';
import { SubmissionManager } from './submissions.js';
import {
  ResearchRole,
  RunStatus,
  TaskStatus,
  DecisionType,
  HostReviewDecision,
  DirectiveItem,
} from '../contracts/research.js';

export class ReviewManager {
  public static readonly REQUIRED_ROLES: ResearchRole[] = [
    ResearchRole.Authority,
    ResearchRole.Evolution,
    ResearchRole.Feedback,
  ];

  constructor(
    private runRepo: RunRepository,
    private taskRepo: TaskRepository,
    private reviewRepo: ReviewRepository,
    private submissionMgr: SubmissionManager
  ) {}

  public submitReviewDecision(
    run_id: string,
    decision: HostReviewDecision
  ): HostReviewDecision {
    const run = this.runRepo.getRun(run_id);
    if (!run) {
      throw new Error(`Run ${run_id} not found`);
    }

    // 1. Idempotency check
    const existing = this.reviewRepo.getReview(run_id, decision.round);
    if (existing) {
      return {
        task_id: existing.task_id,
        round: existing.round,
        decision: existing.decision,
        rationale: existing.rationale,
        directives: existing.directives,
        unresolved_issues: existing.unresolved_issues,
      };
    }

    // 2. Round 3 mandatory convergence
    if (decision.round >= 3 && decision.decision === DecisionType.Revise) {
      throw new Error(
        'Round 3 cannot issue revise: mandatory convergence required. Must approve or finalize_with_unresolved.'
      );
    }

    const nowIso = new Date().toISOString();
    const reviewId = `rev-${run_id}-r${decision.round}`;

    // 3. Persist review
    this.reviewRepo.saveReview({
      review_id: reviewId,
      run_id,
      task_id: decision.task_id,
      round: decision.round,
      decision: decision.decision,
      rationale: decision.rationale,
      directives: decision.directives || [],
      unresolved_issues: decision.unresolved_issues || [],
      created_at: nowIso,
    });

    // 4. Transitions
    if (
      decision.decision === DecisionType.Approve ||
      decision.decision === DecisionType.FinalizeWithUnresolved
    ) {
      this.runRepo.updateRunStatus(run_id, RunStatus.Approved);
    } else if (decision.decision === DecisionType.Revise) {
      const nextRound = decision.round + 1;
      this.runRepo.updateRunStatus(run_id, RunStatus.Researching, nextRound);

      // Create new follow-up tasks ONLY for targeted roles in directives
      for (const dir of decision.directives || []) {
        const taskId = `task-${dir.target_role}-r${nextRound}-${randomUUID().substring(0, 6)}`;
        this.taskRepo.createTask({
          task_id: taskId,
          run_id,
          role: dir.target_role,
          round: nextRound,
          question: dir.question,
          scope: {
            directive_id: dir.directive_id,
            related_claim_or_issue: dir.related_claim_or_issue,
            suggested_action: dir.suggested_action,
            completion_criteria: dir.completion_criteria,
          },
          status: TaskStatus.Pending,
          budget_allocated: 10,
          created_at: nowIso,
        });
      }
    }

    return decision;
  }

  public getEffectiveSubmissions(
    run_id: string,
    round_num: number
  ): Map<ResearchRole, any> {
    const currentTasks = this.taskRepo
      .listTasks(run_id)
      .filter((t) => t.round === round_num);

    const pendingOrRunningRoles = new Set(
      currentTasks
        .filter((t) => t.status === TaskStatus.Pending || t.status === TaskStatus.Running)
        .map((t) => t.role)
    );

    const effective = new Map<ResearchRole, any>();

    for (const role of ReviewManager.REQUIRED_ROLES) {
      if (pendingOrRunningRoles.has(role)) {
        // Directed task still executing in this round -> deliverable not yet available for this round
        continue;
      }

      // Carry-forward: find newest submission from round_num down to 1
      for (let r = round_num; r >= 1; r--) {
        const sub = this.submissionMgr.getLatestSubmissionForRole(run_id, role, r);
        if (sub) {
          effective.set(role, sub.data);
          break;
        }
      }
    }

    return effective;
  }

  public checkReleaseGate(run_id: string): { ok: boolean; reason: string } {
    const run = this.runRepo.getRun(run_id);
    if (!run) {
      return { ok: false, reason: `Run ${run_id} not found` };
    }

    const currentTasks = this.taskRepo
      .listTasks(run_id)
      .filter((t) => t.round === run.current_round);

    const activeTasks = currentTasks.filter(
      (t) => t.status === TaskStatus.Pending || t.status === TaskStatus.Running
    );
    if (activeTasks.length > 0) {
      return {
        ok: false,
        reason: `Tasks ${activeTasks.map((t) => t.task_id).join(', ')} are still active`,
      };
    }

    const effective = this.getEffectiveSubmissions(run_id, run.current_round);
    const missing = ReviewManager.REQUIRED_ROLES.filter((r) => !effective.has(r));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `Missing required deliverables for roles: ${missing.join(', ')}`,
      };
    }

    return { ok: true, reason: 'Release gate check passed' };
  }
}

export interface StageReviewDecisionInput {
  decision_id?: string;
  run_id: string;
  turn_number?: number;
  decision_type: string;
  rationale?: string;
  task_id?: string | null;
  action_payload?: Record<string, unknown> | null;
  inbox_event_ids?: number[] | null;
  created_at?: string;
}

export class StageReviewManager {
  private runRepo: RunRepository;
  private taskRepo: TaskRepository;
  private hostDecisionRepo: HostDecisionRepository;

  constructor(
    private db: ResearchDatabase,
    runRepo?: RunRepository,
    taskRepo?: TaskRepository,
    hostDecisionRepo?: HostDecisionRepository
  ) {
    this.runRepo = runRepo || new RunRepository(this.db);
    this.taskRepo = taskRepo || new TaskRepository(this.db);
    this.hostDecisionRepo = hostDecisionRepo || new HostDecisionRepository(this.db);
  }

  public recordDecision(input: StageReviewDecisionInput): HostDecisionRecord {
    const turnNumber = input.turn_number ?? (this.getDecisionCount(input.run_id) + 1);
    const decisionId =
      input.decision_id || `hdec-${input.run_id}-t${turnNumber}-${randomUUID().substring(0, 6)}`;
    const nowIso = input.created_at || new Date().toISOString();

    const record: HostDecisionRecord = {
      decision_id: decisionId,
      run_id: input.run_id,
      turn_number: turnNumber,
      decision_type: input.decision_type,
      rationale: input.rationale,
      task_id: input.task_id || null,
      action_payload: input.action_payload || null,
      inbox_event_ids: input.inbox_event_ids || null,
      created_at: nowIso,
    };

    this.hostDecisionRepo.saveDecision(record);
    return record;
  }

  public getDecisionCount(run_id: string): number {
    return this.hostDecisionRepo.getDecisionCount(run_id);
  }

  public listDecisions(run_id: string): HostDecisionRecord[] {
    return this.hostDecisionRepo.listDecisions(run_id);
  }

  public getLatestDecision(run_id: string): HostDecisionRecord | null {
    return this.hostDecisionRepo.getLatestDecision(run_id);
  }

  public isDecisionCapReached(run_id: string, maxDecisions = 12): boolean {
    return this.getDecisionCount(run_id) >= maxDecisions;
  }

  public pauseRunOnCapReached(run_id: string, reason = 'HOST stage decision cap reached'): void {
    this.runRepo.updateRunStatus(run_id, RunStatus.Paused);
  }
}
