import { randomUUID } from 'node:crypto';
import { ResearchDatabase } from '../storage/database.js';
import {
  RunRepository,
  TaskRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
  type HostInboxRecord,
  type HostDecisionRecord,
} from '../storage/repositories.js';
import { BudgetLedger } from '../storage/budget-ledger.js';
import { HostAgent } from '../agents/host.js';
import {
  StageReviewManager,
  type StageReviewDecisionInput,
} from './review.js';
import { RunStatus, TaskStatus } from '../contracts/research.js';
import type { PiAgentResult } from '../runtime/pi-adapter.js';
import { runExecutionContext } from '../tools/research-tools.js';

export { StageReviewManager, type StageReviewDecisionInput };

export enum StageDecisionType {
  Accept = 'accept',
  FollowUp = 'follow_up',
  Wait = 'wait',
  RequestRelease = 'request_release',
  Finalize = 'finalize',
}

export interface HostPromptTaskItem {
  task_id: string;
  role: string;
  status: string;
  completion_criteria?: string;
  required_for_report?: boolean;
  generation?: number;
  budget_allocated?: number;
}

export interface HostPromptOutcomeItem {
  task_id: string;
  role: string;
  status: string;
  summary?: string;
  claims?: Array<{ claim_id: string; statement: string }>;
  evidence_refs?: string[];
  error?: { code: string; message: string };
  limitations?: string;
}

export interface HostPromptSnapshot {
  topic?: string;
  scope?: string | Record<string, unknown>;
  initialPrompt?: string;
  tasks: HostPromptTaskItem[];
  outcomes?: HostPromptOutcomeItem[];
  budget?: {
    global_remaining: number;
    global_total?: number;
    tasks_remaining?: Record<string, number>;
  };
  turn_number?: number;
  max_turns?: number;
}

/**
 * 格式化注入 HOST 的阶段审议 Prompt
 * 遵循五个结构化数据区块规范，不污染基础 system prompt
 */
export function formatHostPrompt(
  runId: string,
  pendingEvents: Array<{
    inbox_id?: number;
    run_id: string;
    event_seq?: number | null;
    task_id?: string;
    event_type?: string;
    payload?: Record<string, unknown>;
  }>,
  snapshot?: HostPromptSnapshot
): string {
  const sections: string[] = [];

  // 0. 【研判主题与背景】
  let topicStr = snapshot?.topic;
  let scopeStr =
    typeof snapshot?.scope === 'object'
      ? JSON.stringify(snapshot?.scope)
      : snapshot?.scope ? String(snapshot.scope) : undefined;
  let promptGuidance = snapshot?.initialPrompt;

  if (!topicStr || !scopeStr || !promptGuidance) {
    for (const ev of pendingEvents) {
      if (!topicStr && ev.payload?.topic) topicStr = String(ev.payload.topic);
      if (!scopeStr && ev.payload?.scope) {
        scopeStr =
          typeof ev.payload.scope === 'object'
            ? JSON.stringify(ev.payload.scope)
            : String(ev.payload.scope);
      }
      if (!promptGuidance && ev.payload?.prompt) promptGuidance = String(ev.payload.prompt);
    }
  }

  const topicLines: string[] = [];
  topicLines.push(`- 研判主题: ${topicStr || '未指定研判主题'}`);
  if (scopeStr) {
    topicLines.push(`- 研判范围/边界: ${scopeStr}`);
  }
  if (promptGuidance) {
    topicLines.push(`- 提示指引: ${promptGuidance}`);
  }

  const hasTasks = Boolean(snapshot?.tasks && snapshot.tasks.length > 0);
  if (!hasTasks) {
    topicLines.push(
      `- 任务状态: 初始阶段，尚未创建研究任务。请使用 research_authority、research_evolution、research_feedback 规划并派发第一轮研究任务。`
    );
  }
  sections.push('【研判主题与背景】\n' + topicLines.join('\n'));

  // 1. 【本次变化】
  const changeLines: string[] = [];
  const eventTaskIds = new Set<string>();

  for (const ev of pendingEvents) {
    const outcome = (ev.payload?.outcome as any) || (ev.payload as any) || {};
    const taskId = ev.task_id || outcome.task_id || 'unknown';
    eventTaskIds.add(taskId);
    const role = outcome.role || 'research';
    const status = outcome.status || ev.event_type || 'updated';
    const summary = outcome.summary || outcome.error?.message || '';

    let roleLabel = role;
    if (role === 'feedback') roleLabel = '公众反馈调研 (feedback)';
    else if (role === 'evolution') roleLabel = '舆情演化分析 (evolution)';
    else if (role === 'authority') roleLabel = '权威口径调查 (authority)';

    changeLines.push(
      `- ${roleLabel} 任务 (${taskId}) 状态变为【${status}】${summary ? `: ${summary}` : ''}`
    );
  }

  // Also include running tasks from snapshot if any
  if (snapshot?.tasks) {
    for (const t of snapshot.tasks) {
      if (!eventTaskIds.has(t.task_id) && (t.status === TaskStatus.Running || t.status === 'running')) {
        let roleLabel = t.role;
        if (t.role === 'authority') roleLabel = '权威口径调查 (authority)';
        else if (t.role === 'evolution') roleLabel = '舆情演化分析 (evolution)';
        else if (t.role === 'feedback') roleLabel = '公众反馈调研 (feedback)';
        changeLines.push(`- ${roleLabel} 任务 (${t.task_id}) 仍在执行中 (running)`);
      }
    }
  }

  sections.push('【本次变化】\n' + (changeLines.length > 0 ? changeLines.join('\n') : '- 无新状态变化'));

  // 2. 【当前计划】
  const planLines: string[] = [];
  planLines.push('| 任务ID | 角色 | 状态 | 完成标准 | 报告必需 |');
  planLines.push('|---|---|---|---|---|');

  if (snapshot?.tasks && snapshot.tasks.length > 0) {
    for (const t of snapshot.tasks) {
      const isReq = t.required_for_report !== false ? '是' : '否';
      const crit = t.completion_criteria || '-';
      planLines.push(`| ${t.task_id} | ${t.role} | ${t.status} | ${crit} | ${isReq} |`);
    }
    sections.push('【当前计划】\n' + planLines.join('\n'));
  } else {
    for (const ev of pendingEvents) {
      if (ev.task_id) {
        planLines.push(`| ${ev.task_id} | research | ${ev.event_type || 'pending'} | - | 是 |`);
      }
    }
    if (planLines.length > 2) {
      sections.push('【当前计划】\n' + planLines.join('\n'));
    } else {
      sections.push('【当前计划】\n（尚未创建任何研究任务，等待 HOST 规划派发）');
    }
  }

  // 3. 【新成果】
  const outcomeLines: string[] = [];
  const allOutcomes: HostPromptOutcomeItem[] = [];

  if (snapshot?.outcomes && snapshot.outcomes.length > 0) {
    allOutcomes.push(...snapshot.outcomes);
  } else {
    for (const ev of pendingEvents) {
      const o = (ev.payload?.outcome as any);
      if (o) allOutcomes.push(o);
    }
  }

  if (allOutcomes.length > 0) {
    for (const o of allOutcomes) {
      outcomeLines.push(`- ${o.role} (任务ID: ${o.task_id}):`);
      outcomeLines.push(`  * 状态: ${o.status}`);
      if (o.summary) {
        outcomeLines.push(`  * 摘要: ${o.summary}`);
      }
      if (o.claims && o.claims.length > 0) {
        const claimsStr = o.claims.map((c) => `[${c.claim_id}] ${c.statement}`).join('; ');
        outcomeLines.push(`  * 关键主张: ${claimsStr}`);
      }
      if (o.evidence_refs && o.evidence_refs.length > 0) {
        outcomeLines.push(`  * 证据引用: ${o.evidence_refs.join(', ')}`);
      }
      if (o.limitations) {
        outcomeLines.push(`  * 样本限制: ${o.limitations}`);
      }
      if (o.error) {
        outcomeLines.push(`  * 执行错误: [${o.error.code}] ${o.error.message}`);
      }
    }
  } else {
    outcomeLines.push('- 暂无最新已提交成果');
  }
  sections.push('【新成果】\n' + outcomeLines.join('\n'));

  // 4. 【可用额度】
  const budgetLines: string[] = [];
  if (snapshot?.budget) {
    const rem = snapshot.budget.global_remaining;
    const tot = snapshot.budget.global_total ?? 50;
    budgetLines.push(`- 全局可用工具额度: ${rem} / ${tot}`);

    if (snapshot.budget.tasks_remaining) {
      const taskBudgetParts = Object.entries(snapshot.budget.tasks_remaining).map(
        ([tId, bRem]) => `${tId}: ${bRem}`
      );
      if (taskBudgetParts.length > 0) {
        budgetLines.push(`- 任务剩余额度: ${taskBudgetParts.join(', ')}`);
      }
    }
  } else {
    budgetLines.push('- 全局可用工具额度: 50 / 50');
  }

  if (snapshot?.max_turns) {
    const curTurn = snapshot.turn_number ?? 1;
    budgetLines.push(`- 当前阶段审议轮次: 第 ${curTurn} 次 / 上限 ${snapshot.max_turns} 次`);
  }
  sections.push('【可用额度】\n' + budgetLines.join('\n'));

  // 5. 【请决定】
  let decisionText: string;
  if (!hasTasks) {
    decisionText = `【请决定】
当前运行刚启动且无现有任务，请执行以下行动之一：
1. 派发研究任务: 调用研究工具（如 research_authority, research_evolution, research_feedback）创建各维度的独立研究作业
2. 委托研究 (delegate_research): 批量下发初始研究任务清单`;
  } else {
    decisionText = `【请决定】
请根据上述最新进展与成果质量作出下一步决策：
1. 接受成果 (accept): 确认已完成任务成果质量合格，予以接收
2. 定向补查 (follow-up): 针对失败、存疑或关键依据缺失的任务发起定向补查
3. 继续等待 (wait): 保持等待其余正在运行的研究任务完成
4. 申请放行 (request release): 所有必要研究成果已具备，申请专报放行`;
  }
  sections.push(decisionText);

  return sections.join('\n\n');
}

export interface HostInboxDispatcherOptions {
  db: ResearchDatabase;
  hostAgent?: HostAgent;
  budgetLedger?: BudgetLedger;
  stageReviewManager?: StageReviewManager;
  debounceMs?: number; // default 500ms
  maxDecisionsPerRun?: number; // default 12
  onHostDecision?: (runId: string, decision: HostDecisionRecord) => Promise<void> | void;
  onRunPaused?: (runId: string, reason: string) => Promise<void> | void;
  decisionExtractor?: (result: PiAgentResult) => {
    decision_type: string;
    rationale?: string;
    task_id?: string | null;
    action_payload?: Record<string, unknown> | null;
  };
}

export class HostInboxDispatcher {
  private db: ResearchDatabase;
  private hostAgent?: HostAgent;
  private budgetLedger?: BudgetLedger;
  private stageReviewMgr: StageReviewManager;
  private runRepo: RunRepository;
  private taskRepo: TaskRepository;
  private outboxRepo: OutboxRepository;
  private hostInboxRepo: HostInboxRepository;
  private hostDecisionRepo: HostDecisionRepository;

  public readonly debounceMs: number;
  public readonly maxDecisionsPerRun: number;

  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private activeInvocations = new Map<string, Promise<void>>();
  private rerunQueued = new Set<string>();
  private eventPayloadCache = new Map<number, Record<string, unknown>>();
  private destroyed = false;

  constructor(public options: HostInboxDispatcherOptions) {
    this.db = options.db;
    this.hostAgent = options.hostAgent;
    this.budgetLedger = options.budgetLedger;
    this.debounceMs = options.debounceMs ?? 500;
    this.maxDecisionsPerRun = options.maxDecisionsPerRun ?? 12;

    this.runRepo = new RunRepository(this.db);
    this.taskRepo = new TaskRepository(this.db);
    this.outboxRepo = new OutboxRepository(this.db);
    this.hostInboxRepo = new HostInboxRepository(this.db);
    this.hostDecisionRepo = new HostDecisionRepository(this.db);

    this.stageReviewMgr =
      options.stageReviewManager ||
      new StageReviewManager(this.db, this.runRepo, this.taskRepo, this.hostDecisionRepo);
  }

  public isActive(runId: string): boolean {
    return this.activeInvocations.has(runId);
  }

  public enqueueEvent(event: {
    run_id: string;
    task_id?: string;
    event_type?: string;
    payload?: Record<string, unknown>;
    event_seq?: number;
  }): number {
    if (this.destroyed) return -1;

    // Persist to outbox if event_seq not provided
    let outboxSeq = event.event_seq;
    if (outboxSeq === undefined) {
      outboxSeq = this.outboxRepo.appendEvent({
        run_id: event.run_id,
        task_id: event.task_id || null,
        event_type: event.event_type || 'research_outcome',
        payload: event.payload || {},
      });
    }

    // Record into host_inbox
    const inboxId = this.hostInboxRepo.recordEvent(event.run_id, outboxSeq);

    // Cache payload for rapid prompt generation
    if (event.payload) {
      this.eventPayloadCache.set(inboxId, event.payload);
    }

    // Schedule debounced dispatch
    this.scheduleDebouncedDispatch(event.run_id);
    return inboxId;
  }

  public notifyOutbox(runId: string): void {
    if (this.destroyed) return;
    const undelivered = this.outboxRepo.getUndeliveredEvents(runId);
    for (const ev of undelivered) {
      const inboxId = this.hostInboxRepo.recordEvent(runId, ev.event_id);
      this.eventPayloadCache.set(inboxId, ev.payload);
    }
    this.scheduleDebouncedDispatch(runId);
  }

  public scheduleDebouncedDispatch(runId: string): void {
    if (this.destroyed) return;

    const existingTimer = this.debounceTimers.get(runId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(runId);
      this.triggerDispatch(runId).catch((err) => {
        // Log unhandled dispatch error
        console.error(`[HostInboxDispatcher] error in dispatch for ${runId}:`, err);
      });
    }, this.debounceMs);

    if (timer.unref) {
      timer.unref();
    }

    this.debounceTimers.set(runId, timer);
  }

  public async triggerDispatch(runId: string): Promise<void> {
    if (this.destroyed) return;

    // Mutex check: strictly one active hostAgent.run per runId
    if (this.activeInvocations.has(runId)) {
      this.rerunQueued.add(runId);
      return;
    }

    let turnSucceeded = false;
    const invocationPromise = (async () => {
      try {
        await this.executeTurn(runId);
        turnSucceeded = true;
      } finally {
        this.activeInvocations.delete(runId);

        // If cap is reached, do not spin re-triggering
        if (this.stageReviewMgr.isDecisionCapReached(runId, this.maxDecisionsPerRun)) {
          this.rerunQueued.delete(runId);
        } else if (turnSucceeded && (this.rerunQueued.has(runId) || this.hostInboxRepo.listPending(runId).length > 0)) {
          // Process queued events that arrived while HOST was running
          this.rerunQueued.delete(runId);
          const timer = this.debounceTimers.get(runId);
          if (timer) {
            clearTimeout(timer);
            this.debounceTimers.delete(runId);
          }
          // Trigger next turn
          this.triggerDispatch(runId).catch((err) => {
            console.error(`[HostInboxDispatcher] error in follow-up turn for ${runId}:`, err);
          });
        }
      }
    })();

    this.activeInvocations.set(runId, invocationPromise);
    await invocationPromise;
  }

  private async executeTurn(runId: string): Promise<void> {
    // 1. Decision cap check (default 12) BEFORE claiming events to avoid stranding
    const currentDecisions = this.stageReviewMgr.getDecisionCount(runId);
    if (currentDecisions >= this.maxDecisionsPerRun) {
      this.runRepo.updateRunStatus(runId, RunStatus.Paused);
      if (this.options.onRunPaused) {
        await this.options.onRunPaused(
          runId,
          `Decision cap reached: ${currentDecisions} / ${this.maxDecisionsPerRun}`
        );
      }
      return;
    }

    // 2. Claim pending inbox events
    const claimed = this.hostInboxRepo.claimPending(runId);
    if (claimed.length === 0) {
      return;
    }

    // 3. Assemble claimed events payload
    const pendingEventsWithData = claimed.map((c) => {
      let payload = this.eventPayloadCache.get(c.inbox_id);
      let taskId: string | undefined;
      let eventType: string | undefined;

      if (!payload && c.event_seq) {
        const outboxEv = this.outboxRepo.getEvent(c.event_seq);
        if (outboxEv) {
          payload = outboxEv.payload;
          taskId = outboxEv.task_id || undefined;
          eventType = outboxEv.event_type;
        }
      }

      if (!taskId && payload && (payload as any).outcome?.task_id) {
        taskId = (payload as any).outcome.task_id;
      }

      return {
        inbox_id: c.inbox_id,
        run_id: c.run_id,
        event_seq: c.event_seq,
        task_id: taskId,
        event_type: eventType || 'research_outcome',
        payload: payload || {},
      };
    });

    // 4. Build prompt snapshot
    const snapshot = this.buildSnapshot(runId, pendingEventsWithData, currentDecisions + 1);

    // 5. Format prompt (distinct data block, preserves system prompt untouched)
    const prompt = formatHostPrompt(runId, pendingEventsWithData, snapshot);

    if (!this.hostAgent) {
      // If hostAgent not configured, mark events processed, clean cache, and exit
      this.hostInboxRepo.markBatchProcessed(claimed.map((c) => c.inbox_id));
      for (const c of claimed) {
        this.eventPayloadCache.delete(c.inbox_id);
      }
      return;
    }

    // 6. Invoke host agent (wrapped in try/catch to unclaim on failure)
    let result: PiAgentResult;
    try {
      result = await runExecutionContext.run({ run_id: runId }, async () => {
        return await this.hostAgent!.run(prompt);
      });
    } catch (err) {
      // Unclaim claimed events so they are not stranded in 'claimed'
      this.hostInboxRepo.unclaimBatch(claimed.map((c) => c.inbox_id));
      throw err;
    }

    // 7. Parse decision
    const parsedDecision = this.extractDecision(result);

    // 8. Record decision snapshot to host_decisions
    const decisionRecord = this.stageReviewMgr.recordDecision({
      run_id: runId,
      turn_number: currentDecisions + 1,
      decision_type: parsedDecision.decision_type,
      rationale: parsedDecision.rationale || result.finalText,
      task_id: parsedDecision.task_id,
      action_payload: parsedDecision.action_payload,
      inbox_event_ids: claimed.map((c) => c.inbox_id),
    });

    // 9. Mark claimed inbox records as processed in SQLite & clean payload cache
    this.hostInboxRepo.markBatchProcessed(claimed.map((c) => c.inbox_id));
    for (const c of claimed) {
      this.eventPayloadCache.delete(c.inbox_id);
    }

    // Also mark outbox events delivered if present
    const outboxIds = claimed
      .map((c) => c.event_seq)
      .filter((seq): seq is number => typeof seq === 'number');
    if (outboxIds.length > 0) {
      this.outboxRepo.markDeliveredBatch(outboxIds);
    }

    // 10. Fire callback if provided
    if (this.options.onHostDecision) {
      await this.options.onHostDecision(runId, decisionRecord);
    }
  }

  private buildSnapshot(
    runId: string,
    pendingEvents: Array<{ task_id?: string; payload: Record<string, unknown> }>,
    turnNumber: number
  ): HostPromptSnapshot {
    const run = this.runRepo.getRun(runId);
    let topic = run?.topic;
    let scope = run?.scope;
    let initialPrompt: string | undefined;

    for (const ev of pendingEvents) {
      if (ev.payload?.topic && !topic) topic = String(ev.payload.topic);
      if (ev.payload?.scope && !scope) scope = ev.payload.scope as any;
      if (ev.payload?.prompt && !initialPrompt) initialPrompt = String(ev.payload.prompt);
    }

    const rawTasks = this.taskRepo.listTasks(runId);
    const tasks: HostPromptTaskItem[] = rawTasks.map((t) => ({
      task_id: t.task_id,
      role: t.role,
      status: t.status,
      completion_criteria: t.completion_criteria,
      required_for_report: t.required_for_report,
      generation: t.generation,
      budget_allocated: t.budget_allocated,
    }));

    const outcomes: HostPromptOutcomeItem[] = [];
    for (const ev of pendingEvents) {
      const outcome = (ev.payload.outcome as any) || ev.payload;
      if (outcome && outcome.task_id) {
        outcomes.push(outcome);
      }
    }

    let globalRemaining = 40;
    let globalTotal = 50;
    const tasksRemaining: Record<string, number> = {};

    if (this.budgetLedger) {
      globalRemaining = this.budgetLedger.getRemaining(runId);
      globalTotal = this.budgetLedger.totalToolLimit;
      for (const t of tasks) {
        tasksRemaining[t.task_id] = this.budgetLedger.getTaskRemaining(
          t.task_id,
          t.budget_allocated
        );
      }
    }

    return {
      topic,
      scope,
      initialPrompt,
      tasks,
      outcomes,
      budget: {
        global_remaining: globalRemaining,
        global_total: globalTotal,
        tasks_remaining: tasksRemaining,
      },
      turn_number: turnNumber,
      max_turns: this.maxDecisionsPerRun,
    };
  }

  private extractDecision(result: PiAgentResult): {
    decision_type: string;
    rationale?: string;
    task_id?: string | null;
    action_payload?: Record<string, unknown> | null;
  } {
    if (this.options.decisionExtractor) {
      return this.options.decisionExtractor(result);
    }

    // Inspect messages / tool calls
    for (const msg of result.messages || []) {
      if (msg.role === 'assistant' && (msg as any).toolCalls) {
        for (const tc of (msg as any).toolCalls) {
          if (tc.name === 'stage_review_decision' && tc.arguments) {
            return {
              decision_type: tc.arguments.decision_type || 'accept',
              rationale: tc.arguments.rationale,
              task_id: tc.arguments.task_id,
              action_payload: tc.arguments,
            };
          }
          if (tc.name === 'delegate_research') {
            return {
              decision_type: 'follow_up',
              rationale: 'Dispatched follow-up tasks',
              action_payload: tc.arguments,
            };
          }
          if (tc.name === 'request_release') {
            return {
              decision_type: 'request_release',
              rationale: tc.arguments?.rationale,
              action_payload: tc.arguments,
            };
          }
        }
      }
    }

    // Inspect text content
    const text = (result.finalText || '').toLowerCase();

    // 1. Follow-up / Revise takes priority
    if (
      text.includes('follow-up') ||
      text.includes('follow_up') ||
      text.includes('补查') ||
      text.includes('revise') ||
      text.includes('定向补查')
    ) {
      return { decision_type: 'follow_up', rationale: result.finalText };
    }

    // 2. Request release / Approve takes priority over simple accept
    if (
      text.includes('request_release') ||
      text.includes('request release') ||
      text.includes('申请放行') ||
      text.includes('申请专报放行') ||
      text.includes('放行') ||
      text.includes('approve')
    ) {
      return { decision_type: 'request_release', rationale: result.finalText };
    }

    // 3. Accept with negative qualifier guards
    const hasNegativeAccept =
      text.includes('不接受') ||
      text.includes('暂不接受') ||
      text.includes('拒绝') ||
      text.includes('未通过') ||
      text.includes('不予接收') ||
      text.includes('not accept') ||
      text.includes("don't accept") ||
      text.includes('cannot accept');

    if (!hasNegativeAccept && (text.includes('accept') || text.includes('接受') || text.includes('接收'))) {
      return { decision_type: 'accept', rationale: result.finalText };
    }

    // 4. Wait
    if (text.includes('wait') || text.includes('等待')) {
      return { decision_type: 'wait', rationale: result.finalText };
    }

    return { decision_type: 'wait', rationale: result.finalText };
  }

  public destroy(): void {
    this.destroyed = true;
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.activeInvocations.clear();
    this.rerunQueued.clear();
    this.eventPayloadCache.clear();
  }
}
