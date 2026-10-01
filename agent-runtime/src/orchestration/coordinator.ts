import { randomUUID } from 'node:crypto';
import { RunRepository, TaskRepository } from '../storage/repositories.js';
import { SubmissionManager } from './submissions.js';
import { EventStore } from '../storage/event-store.js';
import {
  ResearchRun,
  ResearchTask,
  ResearchRole,
  RunStatus,
  TaskStatus,
} from '../contracts/research.js';

export class ResearchCoordinator {
  constructor(
    private runRepo: RunRepository,
    private taskRepo: TaskRepository,
    private submissionMgr: SubmissionManager,
    private eventStore?: EventStore
  ) {}

  public createRun(
    topic: string,
    scope: Record<string, unknown> = {},
    roles?: ResearchRole[],
    budget_total = 50
  ): ResearchRun {
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

    // Initialize round 1 tasks for chosen roles
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

    return run;
  }

  public getRun(run_id: string): ResearchRun | null {
    return this.runRepo.getRun(run_id);
  }

  public getTasksForRound(run_id: string, round_num: number): ResearchTask[] {
    const tasks = this.taskRepo.listTasks(run_id);
    return tasks.filter((t) => t.round === round_num);
  }

  public checkRoundSyncBarrier(run_id: string, round_num: number): boolean {
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
    this.runRepo.updateRunStatus(run_id, RunStatus.Cancelled);
    if (this.eventStore) {
      this.eventStore.publishEvent(run_id, 'run_cancelled', { reason });
    }
  }
}
