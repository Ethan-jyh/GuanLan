import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ResearchDatabase } from '../storage/database.js';
import {
  TaskRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
  saveOutcomeWithOutbox,
  type TaskResultRecord,
} from '../storage/repositories.js';
import {
  ResearchRole,
  TaskStatus,
  type ResearchSubagentRole,
  type ResearchJobParams,
  type TaskReceipt,
  type AcceptedTaskReceipt,
  type ResearchOutcome,
  type ResearchOutcomeStatus,
  parseResearchJobParams,
} from '../contracts/research.js';
import {
  createSubmitFindingsTool,
  type SubmitFindingsContext,
} from '../tools/submit-findings.js';
import {
  createResearcherAgent,
  ResearcherAgent,
} from '../agents/researcher.js';
import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';
import { BudgetGate } from '../runtime/budget-gate.js';
import { AUTHORITY_SYSTEM_PROMPT } from '../prompts/authority.js';
import { EVOLUTION_SYSTEM_PROMPT } from '../prompts/evolution.js';
import { FEEDBACK_SYSTEM_PROMPT } from '../prompts/feedback.js';

export interface WorkerTaskItem {
  run_id: string;
  task_id: string;
  attempt_id: string;
  role: ResearchSubagentRole;
  execution_version: number;
  question: string;
  scope?: Record<string, unknown>;
  completion_criteria?: string;
  budget_allocated?: number;
  timeoutMs?: number;
  dependencies?: string[];
  required_for_report?: boolean;
}

export interface WorkerTaskContext {
  run_id: string;
  task_id: string;
  attempt_id: string;
  role: ResearchSubagentRole;
  execution_version: number;
  question: string;
  scope?: Record<string, unknown>;
  completion_criteria?: string;
  signal: AbortSignal;
  abortController: AbortController;
  submitTool: ResearchToolDefinition;
}

export interface WorkerAgentLike {
  run: (prompt: string, signal?: AbortSignal) => Promise<any>;
  abort?: () => void;
  state?: any;
}

export interface ResearchWorkerPoolOptions {
  db: ResearchDatabase;
  maxConcurrency?: number;
  defaultTimeoutMs?: number;
  streamFn?: StreamFn;
  tools?: ResearchToolDefinition[] | ((role: ResearchSubagentRole) => ResearchToolDefinition[]);
  agentFactory?: (context: WorkerTaskContext) => Promise<WorkerAgentLike> | WorkerAgentLike;
}

interface ActiveExecution {
  item: WorkerTaskItem;
  abortController: AbortController;
  timeoutTimer: NodeJS.Timeout | null;
  promise: Promise<ResearchOutcome>;
  agent?: WorkerAgentLike;
}

export class ResearchWorkerPool {
  private maxConcurrency: number;
  private defaultTimeoutMs?: number;
  private queue: WorkerTaskItem[] = [];
  private activeExecutions = new Map<string, ActiveExecution>();
  private taskRepo: TaskRepository;
  private attemptRepo: TaskAttemptRepository;
  private resultRepo: TaskResultRepository;
  private outboxRepo: OutboxRepository;

  constructor(private options: ResearchWorkerPoolOptions) {
    this.maxConcurrency = options.maxConcurrency ?? 3;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.taskRepo = new TaskRepository(options.db);
    this.attemptRepo = new TaskAttemptRepository(options.db);
    this.resultRepo = new TaskResultRepository(options.db);
    this.outboxRepo = new OutboxRepository(options.db);
  }

  public get db(): ResearchDatabase {
    return this.options.db;
  }

  public async enqueueTask(
    role: ResearchSubagentRole | 'authority' | 'evolution' | 'feedback',
    params: ResearchJobParams,
    meta?: {
      run_id?: string;
      round?: number;
      generation?: number;
      task_id?: string;
      attempt_id?: string;
      execution_version?: number;
      timeoutMs?: number;
    }
  ): Promise<AcceptedTaskReceipt> {
    const validated = parseResearchJobParams(params);
    const subagentRole = String(role) as ResearchSubagentRole;

    const runId = meta?.run_id || 'default-run';
    const taskId = meta?.task_id || `task-${subagentRole}-${randomUUID().slice(0, 8)}`;
    const attemptId = meta?.attempt_id || `attempt-${randomUUID().slice(0, 8)}`;
    const executionVersion = meta?.execution_version || 1;
    const nowIso = new Date().toISOString();

    // Persist task and attempt in a transaction
    this.options.db.transaction(() => {
      const existingTask = this.taskRepo.getTask(taskId);
      if (!existingTask) {
        this.taskRepo.createTask({
          task_id: taskId,
          run_id: runId,
          role: subagentRole as ResearchRole,
          round: meta?.round ?? 1,
          generation: meta?.generation ?? 1,
          question: validated.question,
          scope: validated.scope,
          completion_criteria: validated.completion_criteria,
          required_for_report: validated.required_for_report,
          dependencies: validated.dependencies,
          status: TaskStatus.Queued,
          budget_allocated: validated.requested_budget_units,
          created_at: nowIso,
        });
      }

      this.attemptRepo.createAttempt({
        attempt_id: attemptId,
        task_id: taskId,
        run_id: runId,
        execution_version: executionVersion,
        status: 'running',
        started_at: nowIso,
      });
    });

    const item: WorkerTaskItem = {
      run_id: runId,
      task_id: taskId,
      attempt_id: attemptId,
      role: subagentRole,
      execution_version: executionVersion,
      question: validated.question,
      scope: validated.scope,
      completion_criteria: validated.completion_criteria,
      budget_allocated: validated.requested_budget_units,
      dependencies: validated.dependencies,
      required_for_report: validated.required_for_report,
      timeoutMs: meta?.timeoutMs ?? this.defaultTimeoutMs,
    };

    this.queue.push(item);
    // Non-blocking trigger of queue processing
    queueMicrotask(() => this.processQueue());

    return {
      status: 'accepted',
      task_id: taskId,
      attempt_id: attemptId,
      role: subagentRole,
      result_pending: true,
      message: 'Task accepted and enqueued for worker execution',
    };
  }

  public cancelTask(taskId: string, reason?: string): boolean {
    // 1. Check if it's currently active
    const active = this.activeExecutions.get(taskId);
    if (active) {
      active.abortController.abort(new Error(reason || 'Cancelled by user'));
      return true;
    }

    // 2. Check if it's waiting in the queue
    const queueIdx = this.queue.findIndex((item) => item.task_id === taskId);
    if (queueIdx !== -1) {
      const [item] = this.queue.splice(queueIdx, 1);
      const nowIso = new Date().toISOString();
      const resultId = `result-${item.task_id}-v${item.execution_version}`;

      const outcome: ResearchOutcome = {
        run_id: item.run_id,
        task_id: item.task_id,
        attempt_id: item.attempt_id,
        execution_version: item.execution_version,
        role: item.role,
        status: 'cancelled',
        result_ref: resultId,
        error: {
          code: 'CANCELLED',
          message: reason || 'Task cancelled before execution',
          retryable: false,
        },
        usage: { tool_attempts: 0 },
        completed_at: nowIso,
      };

      saveOutcomeWithOutbox(this.options.db, {
        result: {
          result_id: resultId,
          run_id: item.run_id,
          task_id: item.task_id,
          attempt_id: item.attempt_id,
          version: item.execution_version,
          role: item.role,
          status: 'cancelled',
          findings: null,
          summary: outcome.error?.message,
          created_at: nowIso,
        },
        attempt_status: 'cancelled',
        completed_at: nowIso,
        attempt_error: outcome.error,
        task_status: TaskStatus.Cancelled,
        outbox_event: {
          event_type: 'research_outcome',
          payload: { outcome },
        },
      });

      return true;
    }

    return false;
  }

  public cancelAttempt(attemptId: string, reason?: string): boolean {
    for (const [taskId, active] of this.activeExecutions.entries()) {
      if (active.item.attempt_id === attemptId) {
        return this.cancelTask(taskId, reason);
      }
    }
    const inQueue = this.queue.find((q) => q.attempt_id === attemptId);
    if (inQueue) {
      return this.cancelTask(inQueue.task_id, reason);
    }
    return false;
  }

  public getActiveCount(): number {
    return this.activeExecutions.size;
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public async waitForAll(): Promise<void> {
    while (this.activeExecutions.size > 0 || this.queue.length > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private processQueue(): void {
    while (this.activeExecutions.size < this.maxConcurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.runExecution(item);
    }
  }

  private runExecution(item: WorkerTaskItem): void {
    const abortController = new AbortController();
    let timeoutTimer: NodeJS.Timeout | null = null;

    if (item.timeoutMs && item.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        abortController.abort(new Error('TIMED_OUT'));
      }, item.timeoutMs);
    }

    const execPromise = this.executeTaskAttempt(item, abortController);

    const active: ActiveExecution = {
      item,
      abortController,
      timeoutTimer,
      promise: execPromise,
    };

    this.activeExecutions.set(item.task_id, active);

    execPromise.finally(() => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      this.activeExecutions.delete(item.task_id);
      this.processQueue();
    });
  }

  private async executeTaskAttempt(
    item: WorkerTaskItem,
    abortController: AbortController
  ): Promise<ResearchOutcome> {
    let submittedOutcome: ResearchOutcome | null = null;
    let toolAttempts = 0;

    // Update status to running
    try {
      this.attemptRepo.updateStatus(item.attempt_id, 'running');
      this.taskRepo.updateTaskStatus(item.task_id, TaskStatus.Running);
    } catch {
      // Ignore if update fails
    }

    // 1. Create bound submit_findings tool for this specific attempt
    const submitContext: SubmitFindingsContext = {
      run_id: item.run_id,
      task_id: item.task_id,
      attempt_id: item.attempt_id,
      role: item.role,
      execution_version: item.execution_version,
    };

    const submitTool = createSubmitFindingsTool(async (findings: any) => {
      toolAttempts++;
      const nowIso = new Date().toISOString();
      const resultId = `result-${item.task_id}-v${item.execution_version}`;

      const status: ResearchOutcomeStatus =
        findings.status === 'partial' ? 'partial' : 'succeeded';
      const taskStatus =
        status === 'partial' ? TaskStatus.Partial : TaskStatus.Succeeded;

      let summary =
        findings.summary ||
        findings.authority_finding?.raw_text ||
        findings.evolution_finding?.phase_transition_analysis ||
        (Array.isArray(findings.feedback_finding?.demands_summary)
          ? findings.feedback_finding.demands_summary.join('; ')
          : findings.feedback_finding?.denominator_info) ||
        'Research task findings submitted successfully';

      const evidenceRefs: string[] = Array.isArray(findings.evidence_pool)
        ? findings.evidence_pool
            .map((e: any) => e.evidence_id || e.source_ref)
            .filter(Boolean)
        : [];

      const resultRecord: TaskResultRecord = {
        result_id: resultId,
        run_id: item.run_id,
        task_id: item.task_id,
        attempt_id: item.attempt_id,
        version: item.execution_version,
        role: item.role,
        status,
        findings,
        summary,
        evidence_refs: evidenceRefs,
        created_at: nowIso,
      };

      const outcome: ResearchOutcome = {
        run_id: item.run_id,
        task_id: item.task_id,
        attempt_id: item.attempt_id,
        execution_version: item.execution_version,
        role: item.role,
        status,
        result_ref: resultId,
        summary,
        usage: { tool_attempts: toolAttempts },
        completed_at: nowIso,
      };

      // Atomic commit to SQLite and outbox
      saveOutcomeWithOutbox(this.options.db, {
        result: resultRecord,
        attempt_status: status,
        completed_at: nowIso,
        attempt_usage: outcome.usage,
        task_status: taskStatus,
        outbox_event: {
          event_type: 'research_outcome',
          payload: { outcome },
        },
      });

      submittedOutcome = outcome;
      return { ok: true, submissionId: resultId };
    }, submitContext);

    // 2. Build or obtain isolated agent for this attempt
    const taskContext: WorkerTaskContext = {
      run_id: item.run_id,
      task_id: item.task_id,
      attempt_id: item.attempt_id,
      role: item.role,
      execution_version: item.execution_version,
      question: item.question,
      scope: item.scope,
      completion_criteria: item.completion_criteria,
      signal: abortController.signal,
      abortController,
      submitTool,
    };

    let agent: WorkerAgentLike;
    if (this.options.agentFactory) {
      agent = await this.options.agentFactory(taskContext);
    } else {
      let systemPrompt: string;
      switch (item.role) {
        case 'evolution':
          systemPrompt = EVOLUTION_SYSTEM_PROMPT;
          break;
        case 'feedback':
          systemPrompt = FEEDBACK_SYSTEM_PROMPT;
          break;
        case 'authority':
        default:
          systemPrompt = AUTHORITY_SYSTEM_PROMPT;
          break;
      }

      const roleTools =
        typeof this.options.tools === 'function'
          ? this.options.tools(item.role)
          : this.options.tools || [];

      const budgetGate = new BudgetGate();

      agent = createResearcherAgent({
        role: item.role as ResearchRole,
        systemPrompt,
        tools: roleTools,
        submitTool,
        streamFn: this.options.streamFn || (() => ({}) as any),
        budgetGate,
      });
    }

    // Record agent reference for active cancellation
    const active = this.activeExecutions.get(item.task_id);
    if (active) {
      active.agent = agent;
    }

    if (agent.abort) {
      abortController.signal.addEventListener('abort', () => agent.abort?.(), {
        once: true,
      });
    }

    // 3. Run the worker agent in try/catch isolated sandbox
    try {
      if (abortController.signal.aborted) {
        throw abortController.signal.reason || new Error('Aborted before start');
      }

      await agent.run(item.question, abortController.signal);

      if (submittedOutcome) {
        return submittedOutcome;
      }

      // Completed without explicit submission: save partial
      const nowIso = new Date().toISOString();
      const resultId = `result-${item.task_id}-v${item.execution_version}`;
      const outcome: ResearchOutcome = {
        run_id: item.run_id,
        task_id: item.task_id,
        attempt_id: item.attempt_id,
        execution_version: item.execution_version,
        role: item.role,
        status: 'partial',
        result_ref: resultId,
        summary: 'Agent run completed without explicit submit_findings invocation',
        usage: { tool_attempts: toolAttempts },
        completed_at: nowIso,
      };

      saveOutcomeWithOutbox(this.options.db, {
        result: {
          result_id: resultId,
          run_id: item.run_id,
          task_id: item.task_id,
          attempt_id: item.attempt_id,
          version: item.execution_version,
          role: item.role,
          status: 'partial',
          findings: null,
          summary: outcome.summary,
          created_at: nowIso,
        },
        attempt_status: 'partial',
        completed_at: nowIso,
        attempt_usage: outcome.usage,
        task_status: TaskStatus.Partial,
        outbox_event: {
          event_type: 'research_outcome',
          payload: { outcome },
        },
      });

      return outcome;
    } catch (err: any) {
      const nowIso = new Date().toISOString();
      const resultId = `result-${item.task_id}-v${item.execution_version}`;

      let status: ResearchOutcomeStatus = 'failed';
      let code = 'EXECUTION_FAILED';
      let message = err?.message || String(err);
      let retryable = false;
      let eventType = 'research_outcome';

      const reasonStr = String(
        abortController.signal.reason?.message ||
          abortController.signal.reason ||
          err?.message ||
          ''
      );

      if (
        abortController.signal.aborted ||
        reasonStr.includes('TIMED_OUT') ||
        message.includes('TIMED_OUT') ||
        reasonStr.includes('CANCEL') ||
        message.includes('CANCEL')
      ) {
        if (reasonStr.includes('TIMED_OUT') || message.includes('TIMED_OUT')) {
          status = 'timed_out';
          code = 'TIMED_OUT';
          message = 'Task execution timed out';
          retryable = true;
          eventType = 'task_timeout';
        } else {
          status = 'cancelled';
          code = 'CANCELLED';
          message = reasonStr || 'Task execution cancelled';
          retryable = false;
        }
      }

      const taskStatusMap: Record<ResearchOutcomeStatus, TaskStatus> = {
        succeeded: TaskStatus.Succeeded,
        partial: TaskStatus.Partial,
        failed: TaskStatus.Failed,
        timed_out: TaskStatus.TimedOut,
        cancelled: TaskStatus.Cancelled,
      };

      const outcome: ResearchOutcome = {
        run_id: item.run_id,
        task_id: item.task_id,
        attempt_id: item.attempt_id,
        execution_version: item.execution_version,
        role: item.role,
        status,
        result_ref: resultId,
        error: { code, message, retryable },
        usage: { tool_attempts: toolAttempts },
        completed_at: nowIso,
      };

      // Save outcome atomically to DB and outbox
      saveOutcomeWithOutbox(this.options.db, {
        result: {
          result_id: resultId,
          run_id: item.run_id,
          task_id: item.task_id,
          attempt_id: item.attempt_id,
          version: item.execution_version,
          role: item.role,
          status,
          findings: null,
          summary: message,
          created_at: nowIso,
        },
        attempt_status: status,
        completed_at: nowIso,
        attempt_error: outcome.error,
        attempt_usage: outcome.usage,
        task_status: taskStatusMap[status],
        outbox_event: {
          event_type: eventType,
          payload: { outcome },
        },
      });

      return outcome;
    }
  }
}
