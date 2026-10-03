import { randomUUID } from 'node:crypto';
import {
  RunRepository,
  TaskRepository,
  TaskAttemptRepository,
  OutboxRepository,
  HostInboxRepository,
  TaskResultRepository,
  MaterialSnapshotRepository,
  HostDecisionRepository,
} from '../storage/repositories.js';
import { SubmissionManager } from './submissions.js';
import { EventStore } from '../storage/event-store.js';
import { EvidenceStore } from '../storage/evidence-store.js';
import { BudgetLedger } from '../storage/budget-ledger.js';
import { ResearchDatabase } from '../storage/database.js';
import {
  ResearchRun,
  ResearchTask,
  ResearchRole,
  RunStatus,
  TaskStatus,
} from '../contracts/research.js';
import type { ReleaseRequest } from '../contracts/research-job.js';
import { ResearchWorkerPool } from './research-worker.js';
import { HostInboxDispatcher } from './host-inbox.js';
import { ReleaseGate, type ReleaseVerificationResult } from './release-gate.js';
import { HostAgent } from '../agents/host.js';
import { ReportAgent } from '../agents/report.js';
import { SseManager } from '../api/sse.js';
import { buildReportInputFromSnapshot } from '../reporting/input.js';
import { runExecutionContext } from '../tools/research-tools.js';
import type { ReportJudgment } from '../contracts/artifact.js';

export interface CoordinatorComponents {
  workerPool?: ResearchWorkerPool;
  hostInboxDispatcher?: HostInboxDispatcher;
  releaseGate?: ReleaseGate;
  hostAgent?: HostAgent;
  reportAgent?: ReportAgent;
  db?: ResearchDatabase;
  attemptRepo?: TaskAttemptRepository;
  outboxRepo?: OutboxRepository;
  inboxRepo?: HostInboxRepository;
  resultRepo?: TaskResultRepository;
  snapshotRepo?: MaterialSnapshotRepository;
  decisionRepo?: HostDecisionRepository;
  evidenceStore?: EvidenceStore;
  budgetLedger?: BudgetLedger;
  sseManager?: SseManager;
}

export class ResearchCoordinator {
  private attemptRepo?: TaskAttemptRepository;
  private outboxRepo?: OutboxRepository;
  private inboxRepo?: HostInboxRepository;

  constructor(
    private runRepo: RunRepository,
    private taskRepo: TaskRepository,
    private submissionMgr?: SubmissionManager,
    private eventStore?: EventStore,
    public components: CoordinatorComponents = {}
  ) {
    const db = components.db || (runRepo as any).db;
    this.attemptRepo = components.attemptRepo || (db ? new TaskAttemptRepository(db) : undefined);
    this.outboxRepo = components.outboxRepo || (db ? new OutboxRepository(db) : undefined);
    this.inboxRepo = components.inboxRepo || (db ? new HostInboxRepository(db) : undefined);
  }

  public createRun(
    topic: string,
    scope: Record<string, unknown> = {},
    roles?: ResearchRole[],
    budget_total = 50,
    options?: {
      autoCreateTasks?: boolean;
      mode?: 'sync' | 'async';
      startHost?: boolean;
    }
  ): ResearchRun {
    const autoCreate =
      options?.autoCreateTasks !== undefined
        ? options.autoCreateTasks
        : options?.mode === 'async'
        ? false
        : true;

    const nowIso = new Date().toISOString();
    const runId = `run-${randomUUID().substring(0, 12)}`;
    const activeRoles = roles || [
      ResearchRole.Authority,
      ResearchRole.Evolution,
      ResearchRole.Feedback,
    ];

    const run: ResearchRun = {
      run_id: runId,
      topic,
      scope,
      status: RunStatus.Researching,
      current_round: 1,
      max_rounds: 3,
      budget_total,
      budget_used: 0,
      execution_version: 1,
      created_at: nowIso,
      updated_at: nowIso,
    };

    this.runRepo.createRun(run);

    if (this.eventStore) {
      this.eventStore.publishEvent(runId, 'run_created', { topic, roles: activeRoles });
    }

    // Initialize round 1 tasks for chosen roles ONLY IF autoCreate is enabled
    if (autoCreate) {
      for (const roleName of activeRoles) {
        const taskId = `task-${roleName}-${randomUUID().substring(0, 8)}`;
        const task: ResearchTask = {
          task_id: taskId,
          run_id: runId,
          role: roleName,
          round: 1,
          question: `针对主题【${topic}】开展【${roleName}】方向的第一轮基础事实与数据调研`,
          scope,
          status: TaskStatus.Pending,
          budget_allocated: 12,
          created_at: nowIso,
        };
        this.taskRepo.createTask(task);
      }
    }

    return run;
  }

  public async startRun(runId: string, initialPrompt?: string): Promise<void> {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run '${runId}' not found`);
    }

    if (this.components.workerPool) {
      this.components.workerPool.activeRunId = runId;
    }

    if (this.eventStore) {
      this.eventStore.publishEvent(runId, 'run_started', {
        topic: run.topic,
        scope: run.scope,
      });
    }

    if (this.components.hostInboxDispatcher) {
      this.components.hostInboxDispatcher.enqueueEvent({
        run_id: runId,
        event_type: 'run_started',
        payload: {
          topic: run.topic,
          scope: run.scope,
          prompt: initialPrompt,
        },
      });
      // Immediately trigger dispatch to prompt HOST without waiting for debounce timer
      await this.components.hostInboxDispatcher.triggerDispatch(runId);
    } else if (this.components.hostAgent) {
      const prompt =
        initialPrompt ||
        `请针对研判主题【${run.topic}】开展多维度情报调研规划，调用相应研究工具进行任务派发。`;
      await runExecutionContext.run({ run_id: runId }, async () => {
        await this.components.hostAgent!.run(prompt);
      });
    }
  }

  public resumeRun(runId: string): ResearchRun {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run '${runId}' not found`);
    }

    const nextVersion = (run.execution_version || 1) + 1;
    const nowIso = new Date().toISOString();

    const db = this.components.db || (this.runRepo as any).db;
    if (db) {
      db.raw
        .prepare(
          `UPDATE runs SET status = ?, execution_version = ?, updated_at = ? WHERE run_id = ?`
        )
        .run(RunStatus.Researching, nextVersion, nowIso, runId);
    } else {
      this.runRepo.updateRunStatus(runId, RunStatus.Researching);
    }

    if (this.components.hostInboxDispatcher) {
      this.components.hostInboxDispatcher.notifyOutbox(runId);
    }

    if (this.eventStore) {
      this.eventStore.publishEvent(runId, 'run_resumed', {
        execution_version: nextVersion,
      });
    }

    return this.getRun(runId)!;
  }

  public recoverOnStartup(): {
    interruptedAttempts: number;
    undeliveredEvents: number;
    pendingInboxRuns: string[];
  } {
    const db = this.components.db || (this.runRepo as any).db;
    let interruptedAttempts = 0;
    let undeliveredEvents = 0;
    const pendingInboxRunsSet = new Set<string>();

    // 1. Scan for interrupted 'running' attempts
    if (this.attemptRepo) {
      const activeAttempts = this.attemptRepo.listActiveAttempts();
      for (const att of activeAttempts) {
        interruptedAttempts++;
        const nowIso = new Date().toISOString();
        const errorPayload = {
          code: 'INTERRUPTED_ON_STARTUP',
          message: 'Process restarted while attempt was running',
          retryable: true,
        };

        this.attemptRepo.updateStatus(att.attempt_id, 'failed', {
          completed_at: nowIso,
          error: errorPayload,
        });

        const currentTask = this.taskRepo.getTask(att.task_id);
        if (
          currentTask &&
          currentTask.status !== TaskStatus.Succeeded &&
          currentTask.status !== TaskStatus.Partial
        ) {
          this.taskRepo.updateTaskStatus(att.task_id, TaskStatus.Failed, nowIso);
        }

        if (this.outboxRepo) {
          this.outboxRepo.appendEvent({
            run_id: att.run_id,
            task_id: att.task_id,
            event_type: 'task_interrupted',
            payload: {
              attempt_id: att.attempt_id,
              error: errorPayload,
            },
          });
        }
      }
    }

    // 2. Scan and re-queue undelivered outbox events to host inbox
    if (this.outboxRepo && this.inboxRepo && db) {
      const rows =
        (db.raw
          .prepare('SELECT DISTINCT run_id FROM event_outbox WHERE delivered = 0')
          .all() as Array<{ run_id: string }>) || [];

      for (const r of rows) {
        const undelivered = this.outboxRepo.getUndeliveredEvents(r.run_id);
        undeliveredEvents += undelivered.length;
        for (const ev of undelivered) {
          this.inboxRepo.recordEvent(r.run_id, ev.event_id);
        }
        pendingInboxRunsSet.add(r.run_id);
      }
    }

    // 3. Reset claimed inbox records that never finished back to pending (unclaim)
    if (db) {
      const claimedRows =
        (db.raw
          .prepare("SELECT inbox_id, run_id FROM host_inbox WHERE status = 'claimed'")
          .all() as Array<{ inbox_id: number; run_id: string }>) || [];

      for (const c of claimedRows) {
        db.raw
          .prepare("UPDATE host_inbox SET status = 'pending', claimed_at = NULL WHERE inbox_id = ?")
          .run(c.inbox_id);
        pendingInboxRunsSet.add(c.run_id);
      }
    }

    // 4. Resume host inbox dispatchers for affected runs
    if (this.components.hostInboxDispatcher) {
      for (const rId of pendingInboxRunsSet) {
        this.components.hostInboxDispatcher.scheduleDebouncedDispatch(rId);
      }
    }

    return {
      interruptedAttempts,
      undeliveredEvents,
      pendingInboxRuns: Array.from(pendingInboxRunsSet),
    };
  }

  public async cancelTask(taskId: string, reason?: string): Promise<boolean> {
    let cancelled = false;
    if (this.components.workerPool) {
      cancelled = this.components.workerPool.cancelTask(taskId, reason);
    }
    const task = this.taskRepo.getTask(taskId);
    if (task) {
      this.taskRepo.updateTaskStatus(taskId, TaskStatus.Cancelled);
      if (this.eventStore) {
        this.eventStore.publishEvent(task.run_id, 'task_cancelled', { taskId, reason });
      }
      return true;
    }
    return cancelled;
  }

  public async requestRelease(
    runId: string,
    releaseRequest?: ReleaseRequest
  ): Promise<ReleaseVerificationResult & { report?: any; judgment?: ReportJudgment | null }> {
    if (!this.components.releaseGate) {
      throw new Error('ReleaseGate is not configured in ResearchCoordinator');
    }

    const verification = this.components.releaseGate.verifyRelease(runId, releaseRequest);

    if (!verification.ok) {
      return verification;
    }

    // Released! Now invoke ReportAgent if present with formatted snapshot data
    let reportResult: any = null;
    let submittedJudgment: ReportJudgment | null = null;

    if (this.components.reportAgent && verification.snapshot) {
      const run = this.getRun(runId);
      const reportInput = buildReportInputFromSnapshot(verification.snapshot, {
        topic: run?.topic,
        scope: typeof run?.scope === 'object' ? (run.scope as any) : undefined,
      });

      const claimsStr = (reportInput.claims || [])
        .map((c) => `- [${c.claim_id}]: ${c.statement} (证据: ${(c.evidence_ids || []).join(', ')})`)
        .join('\n');

      const evidenceStr = (reportInput.evidence_pool || [])
        .map((e) => `- [${e.evidence_id}] 【${e.source_type}】${e.title || ''}: ${e.excerpt || ''}`)
        .join('\n');

      const findingsStr = Object.entries(reportInput.findings || {})
        .map(([role, f]: [string, any]) => `- 【${role}】: ${typeof f === 'string' ? f : f.summary || JSON.stringify(f)}`)
        .join('\n');

      const prompt = [
        `【不可变材料快照发布与综合研判指令】`,
        `快照编号: ${verification.snapshotId}`,
        `研判主题: ${run?.topic || '综合研判'}`,
        `受限交付状态: ${verification.restricted ? '是 (包含豁免缺口: ' + (verification.gaps || []).join(', ') + ')' : '否 (全量通过)'}`,
        `\n【各维度研究成果摘要】\n${findingsStr || '- 无独立成果摘要'}`,
        `\n【已核验主张清单 (Claims)】\n${claimsStr || '- 无主张'}`,
        `\n【证据库全集 (Evidence Pool)】\n${evidenceStr || '- 无证据'}`,
        `\n请基于上述冻结材料快照生成多维情报综合研判专报，并调用 submit_judgment 工具提交结构化研判结论 (overall_interpretation, risks, recommendations, linked_claim_ids, linked_evidence_ids)。`
      ].join('\n');

      reportResult = await runExecutionContext.run({ run_id: runId }, async () => {
        return await this.components.reportAgent!.run(prompt);
      });

      // Extract submitted judgment if present in tool calls
      if (reportResult?.messages) {
        for (const msg of reportResult.messages) {
          const contents = Array.isArray((msg as any).content)
            ? (msg as any).content
            : [(msg as any).content];
          for (const c of contents) {
            if (
              (c?.type === 'toolCall' || c?.type === 'tool_call') &&
              c?.name === 'submit_judgment' &&
              c?.arguments?.judgment
            ) {
              submittedJudgment = c.arguments.judgment;
              break;
            }
          }
          if (submittedJudgment) break;

          if ((msg as any).toolCalls) {
            for (const tc of (msg as any).toolCalls) {
              if (tc.name === 'submit_judgment' && tc.arguments?.judgment) {
                submittedJudgment = tc.arguments.judgment;
                break;
              }
            }
          }
          if (submittedJudgment) break;
        }
      }

      // Persist judgment to SQLite reviews/host_decisions if available
      if (submittedJudgment) {
        const db = this.components.db || (this.runRepo as any).db;
        if (db) {
          const nowIso = new Date().toISOString();
          try {
            const reviewId = `rev-report-${randomUUID().substring(0, 8)}`;
            const currentRound = run?.current_round || 1;
            db.raw.prepare(`
              INSERT OR REPLACE INTO reviews (
                review_id, run_id, task_id, round, decision, rationale,
                directives_json, unresolved_issues_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              reviewId,
              runId,
              'report',
              currentRound,
              'Finalize',
              submittedJudgment.overall_interpretation || 'Final report judgment',
              JSON.stringify(submittedJudgment.recommendations || []),
              JSON.stringify(submittedJudgment.risks || []),
              nowIso
            );
          } catch {}

          try {
            const decisionId = `dec-judgment-${randomUUID().substring(0, 8)}`;
            db.raw.prepare(`
              INSERT INTO host_decisions (
                decision_id, run_id, turn_number, decision_type, rationale,
                task_id, action_payload_json, inbox_event_ids_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              decisionId,
              runId,
              999,
              'finalize',
              submittedJudgment.overall_interpretation || 'Final report judgment',
              'report',
              JSON.stringify(submittedJudgment),
              JSON.stringify([]),
              nowIso
            );
          } catch {}
        }
      }
    }

    // Update run status to Completed
    this.runRepo.updateRunStatus(runId, RunStatus.Completed);

    if (this.eventStore) {
      this.eventStore.publishEvent(runId, 'run_completed', {
        snapshot_id: verification.snapshotId,
        restricted: verification.restricted,
        gaps: verification.gaps,
        judgment: submittedJudgment,
      });
    }

    return {
      ...verification,
      report: reportResult,
      judgment: submittedJudgment,
    };
  }

  public getRun(run_id: string): ResearchRun | null {
    return this.runRepo.getRun(run_id);
  }

  public getTasksForRound(run_id: string, round_num: number): ResearchTask[] {
    const tasks = this.taskRepo.listTasks(run_id);
    return tasks.filter((t) => t.round === round_num);
  }

  public checkRoundSyncBarrier(run_id: string, round_num: number): boolean {
    if (!this.submissionMgr) return false;
    const tasks = this.getTasksForRound(run_id, round_num);
    if (tasks.length === 0) return false;

    for (const t of tasks) {
      const sub = this.submissionMgr.getLatestSubmissionForRole(run_id, t.role, round_num);
      if (!sub) {
        return false;
      }
    }

    // All round tasks have completed submissions -> transition to Reviewing
    this.runRepo.updateRunStatus(run_id, RunStatus.Reviewing);

    if (this.eventStore) {
      this.eventStore.publishEvent(run_id, 'barrier_reached', { round: round_num });
    }

    return true;
  }

  public pauseRun(run_id: string, reason?: string): void {
    this.runRepo.updateRunStatus(run_id, RunStatus.Paused);
    if (this.eventStore) {
      this.eventStore.publishEvent(run_id, 'run_paused', { reason });
    }
  }

  public cancelRun(run_id: string, reason?: string): void {
    if (this.components.workerPool) {
      this.components.workerPool.cancelRun(run_id, reason);
    }
    this.runRepo.updateRunStatus(run_id, RunStatus.Cancelled);
    if (this.eventStore) {
      this.eventStore.publishEvent(run_id, 'run_cancelled', { reason });
    }
  }
}
