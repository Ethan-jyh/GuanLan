import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import {
  RunRepository,
  TaskRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
  MaterialSnapshotRepository,
  IdempotencyRepository,
  buildIdempotencyKey,
  saveOutcomeWithOutbox,
} from '../src/storage/repositories.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { EventStore } from '../src/storage/event-store.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import { TaskPlanner } from '../src/orchestration/planning.js';
import { ResearchWorkerPool } from '../src/orchestration/research-worker.js';
import { HostInboxDispatcher, StageDecisionType } from '../src/orchestration/host-inbox.js';
import { ReleaseGate } from '../src/orchestration/release-gate.js';
import { ResearchCoordinator } from '../src/orchestration/coordinator.js';
import { createHostAgent } from '../src/agents/host.js';
import {
  createResearchAuthorityTool,
  createResearchEvolutionTool,
  createResearchFeedbackTool,
  runExecutionContext,
} from '../src/tools/research-tools.js';
import { createDelegateResearchTool } from '../src/tools/delegate-research.js';
import { createScriptedStreamFn } from '../src/runtime/pi-adapter.js';
import {
  ResearchRole,
  RunStatus,
  TaskStatus,
  type AcceptedTaskReceipt,
  type ResearchJobParams,
  parseReleaseRequest,
} from '../src/contracts/research.js';

function jobParams(p: {
  run_id?: string;
  question: string;
  completion_criteria: string;
  scope?: Record<string, unknown>;
  requested_budget_units?: number;
  required_for_report?: boolean;
  dependencies?: string[];
}): ResearchJobParams {
  return {
    run_id: p.run_id,
    question: p.question,
    scope: p.scope ?? {},
    completion_criteria: p.completion_criteria,
    requested_budget_units: p.requested_budget_units ?? 10,
    required_for_report: p.required_for_report ?? true,
    dependencies: p.dependencies ?? [],
  };
}

describe('Subagents-as-Tools: 14 Acceptance Scenarios (Section 11)', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let runRepo: RunRepository;
  let taskRepo: TaskRepository;
  let attemptRepo: TaskAttemptRepository;
  let resultRepo: TaskResultRepository;
  let outboxRepo: OutboxRepository;
  let inboxRepo: HostInboxRepository;
  let decisionRepo: HostDecisionRepository;
  let snapshotRepo: MaterialSnapshotRepository;
  let evidenceStore: EvidenceStore;
  let eventStore: EventStore;
  let budgetLedger: BudgetLedger;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    attemptRepo = new TaskAttemptRepository(db);
    resultRepo = new TaskResultRepository(db);
    outboxRepo = new OutboxRepository(db);
    inboxRepo = new HostInboxRepository(db);
    decisionRepo = new HostDecisionRepository(db);
    snapshotRepo = new MaterialSnapshotRepository(db);
    evidenceStore = new EvidenceStore(db);
    eventStore = new EventStore(db);
    budgetLedger = new BudgetLedger(db, { totalToolLimit: 60, reservedForWriting: 10 });
  });

  afterEach(() => {
    try {
      rawDb.close();
    } catch {}
  });

  const setupBaseRun = (runId: string, overrides: Record<string, any> = {}) => {
    const nowIso = new Date().toISOString();
    runRepo.createRun({
      run_id: runId,
      topic: '某突发水库泄洪险情应急处置与公众关切研判',
      scope: { region: '华东重点库区', time_window: '最近48小时' },
      status: RunStatus.Researching,
      current_round: 1,
      max_rounds: 3,
      budget_total: 60,
      budget_used: 0,
      execution_version: 1,
      created_at: nowIso,
      updated_at: nowIso,
      ...overrides,
    });
  };

  // --------------------------------------------------------------------------
  // Scenario 1: Three concurrent tasks with heterogeneous outcomes
  // --------------------------------------------------------------------------
  it('Scenario 1: Three concurrent tasks with heterogeneous outcomes (success, slow, fail) run in complete isolation', async () => {
    const runId = 'run-scen-01';
    setupBaseRun(runId);

    const outcomesReceived: any[] = [];

    const workerPool = new ResearchWorkerPool({
      db,
      maxConcurrency: 3,
      agentFactory: (ctx) => {
        return {
          run: async (_prompt: string, signal?: AbortSignal) => {
            if (ctx.role === 'authority') {
              // Task 1: Immediate success
              await ctx.submitTool.execute({
                findings: {
                  role: 'authority',
                  round: 1,
                  claims: [
                    {
                      claim_id: 'claim-auth-01',
                      statement: '防指于08:00启动防汛预警',
                      evidence_ids: ['ev-auth-01'],
                      confidence: 0.98,
                      dimension: 'official',
                    },
                  ],
                  evidence_pool: [
                    {
                      evidence_id: 'ev-auth-01',
                      source_ref: 'http://gov.cn/notice/01',
                      content: '防指关于启动防汛预警的正式通报',
                    },
                  ],
                  summary: '权威口径通报查证成功',
                },
              });
            } else if (ctx.role === 'evolution') {
              // Task 2: Slow task (takes 50ms)
              await new Promise((r) => setTimeout(r, 50));
              if (signal?.aborted) throw new Error('Aborted');
              await ctx.submitTool.execute({
                findings: {
                  role: 'evolution',
                  round: 1,
                  claims: [
                    {
                      claim_id: 'claim-evo-01',
                      statement: '舆情热度于10:00达到峰值后稳步回落',
                      evidence_ids: ['ev-evo-01'],
                      confidence: 0.92,
                      dimension: 'evolution',
                    },
                  ],
                  evidence_pool: [
                    {
                      evidence_id: 'ev-evo-01',
                      source_ref: 'http://weibo.cn/stats/01',
                      content: '泄洪险情社媒传播热度指数分析',
                    },
                  ],
                  summary: '舆情演化趋势计算成功',
                },
              });
            } else if (ctx.role === 'feedback') {
              // Task 3: Execution failure
              throw new Error('网络爬虫连接超时：公众反馈数据源不可用');
            }
          },
        };
      },
      onOutcome: (outcome) => {
        outcomesReceived.push(outcome);
      },
    });

    // Enqueue 3 tasks concurrently
    const receipt1 = await workerPool.enqueueTask(
      'authority',
      jobParams({
        run_id: runId,
        question: '调查防指预警通报发文时间',
        completion_criteria: '提取发文字号',
        requested_budget_units: 10,
      })
    );
    const receipt2 = await workerPool.enqueueTask(
      'evolution',
      jobParams({
        run_id: runId,
        question: '分析各时段传播热度曲线',
        completion_criteria: '提取热度拐点',
        requested_budget_units: 10,
      })
    );
    const receipt3 = await workerPool.enqueueTask(
      'feedback',
      jobParams({
        run_id: runId,
        question: '抓取社交平台公众诉求和疑虑',
        completion_criteria: '统计评论情绪分布',
        requested_budget_units: 10,
      })
    );

    // Verify all 3 receipts accepted immediately
    assert.equal(receipt1.status, 'accepted');
    assert.equal(receipt2.status, 'accepted');
    assert.equal(receipt3.status, 'accepted');

    // Wait for all 3 executions to finish
    await workerPool.waitForAll();

    // Check final task states in SQLite
    const taskAuth = taskRepo.getTask(receipt1.task_id);
    const taskEvo = taskRepo.getTask(receipt2.task_id);
    const taskFb = taskRepo.getTask(receipt3.task_id);

    assert.equal(taskAuth?.status, TaskStatus.Succeeded);
    assert.equal(taskEvo?.status, TaskStatus.Succeeded);
    assert.equal(taskFb?.status, TaskStatus.Failed);

    // Verify results in task_results table
    const results = resultRepo.listResultsByRun(runId);
    assert.equal(results.length, 3);

    const authRes = results.find((r) => r.task_id === receipt1.task_id);
    const evoRes = results.find((r) => r.task_id === receipt2.task_id);
    const fbRes = results.find((r) => r.task_id === receipt3.task_id);

    assert.equal(authRes?.status, 'succeeded');
    assert.equal(evoRes?.status, 'succeeded');
    assert.equal(fbRes?.status, 'failed');
    assert.ok(fbRes?.summary?.includes('网络爬虫连接超时'));

    // Verify Outbox events recorded for all three tasks
    const outboxEvents = outboxRepo.getEventsAfter(0, runId);
    assert.equal(outboxEvents.length, 3);
    const fbOutbox = outboxEvents.find((e) => e.task_id === receipt3.task_id);
    assert.equal(fbOutbox?.event_type, 'research_outcome');

    // Confirm that the failure of feedback did NOT abort or cancel peer tasks
    assert.equal(taskAuth?.status, TaskStatus.Succeeded);
    assert.equal(taskEvo?.status, TaskStatus.Succeeded);
    assert.equal(outcomesReceived.length, 3);
  });

  // --------------------------------------------------------------------------
  // Scenario 2: Single role invocation
  // --------------------------------------------------------------------------
  it('Scenario 2: Single role invocation only dispatches the requested role without waiting for uncalled roles', async () => {
    const runId = 'run-scen-02';
    setupBaseRun(runId);

    const workerPool = new ResearchWorkerPool({
      db,
      maxConcurrency: 3,
      agentFactory: (ctx) => {
        return {
          run: async () => {
            await ctx.submitTool.execute({
              findings: {
                role: 'feedback',
                round: 1,
                claims: [
                  {
                    claim_id: 'claim-fb-01',
                    statement: '公众集中关注下游受灾群众安置补贴政策',
                    evidence_ids: ['ev-fb-01'],
                    confidence: 0.94,
                    dimension: 'feedback',
                  },
                ],
                evidence_pool: [
                  {
                    evidence_id: 'ev-fb-01',
                    source_ref: 'http://weibo.cn/comment/01',
                    content: '超70%评论聚焦安置与补偿款发放进度',
                  },
                ],
                summary: '公众反馈调研顺利完成',
              },
            });
          },
        };
      },
    });

    const feedbackTool = createResearchFeedbackTool({ workerPool, db });

    // HOST only invokes research_feedback
    const receipt = (await runExecutionContext.run({ run_id: runId }, async () => {
      return (await feedbackTool.execute({
        question: '调研群众安置补贴主要关切与诉求',
        completion_criteria: '提取高频诉求类别与占比',
        requested_budget_units: 8,
        required_for_report: true,
      })) as AcceptedTaskReceipt;
    })) as AcceptedTaskReceipt;

    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.role, 'feedback');

    // Verify tasks table in database: exactly ONE task created for feedback
    const tasks = taskRepo.listTasks(runId);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].role, ResearchRole.Feedback);
    assert.equal(tasks[0].task_id, receipt.task_id);

    // Verify uncalled roles (authority, evolution) have NO tasks created
    const authorityTasks = tasks.filter((t) => t.role === ResearchRole.Authority);
    const evolutionTasks = tasks.filter((t) => t.role === ResearchRole.Evolution);
    assert.equal(authorityTasks.length, 0);
    assert.equal(evolutionTasks.length, 0);

    // Wait for the single task to finish; verify execution finishes cleanly without hanging
    await workerPool.waitForAll();

    const updatedTask = taskRepo.getTask(receipt.task_id);
    assert.equal(updatedTask?.status, TaskStatus.Succeeded);
  });

  // --------------------------------------------------------------------------
  // Scenario 3: Concurrent independent tasks of same role
  // --------------------------------------------------------------------------
  it('Scenario 3: Concurrent independent tasks of the same role have isolated contexts, IDs, cancellations, and outcomes', async () => {
    const runId = 'run-scen-03';
    setupBaseRun(runId);

    const workerPool = new ResearchWorkerPool({
      db,
      maxConcurrency: 3,
      agentFactory: (ctx) => {
        return {
          run: async (_prompt: string, signal?: AbortSignal) => {
            if (ctx.question.includes('新闻发布会')) {
              // Task 2 runs and succeeds
              await new Promise((r) => setTimeout(r, 20));
              if (signal?.aborted) throw new Error('Aborted');
              await ctx.submitTool.execute({
                findings: {
                  role: 'authority',
                  round: 1,
                  claims: [
                    {
                      claim_id: 'claim-auth-press',
                      statement: '新闻发布会明确无人员伤亡',
                      evidence_ids: ['ev-auth-press'],
                      confidence: 0.99,
                      dimension: 'official',
                    },
                  ],
                  evidence_pool: [
                    {
                      evidence_id: 'ev-auth-press',
                      source_ref: 'http://gov.cn/press/01',
                      content: '发布会发言人文字实录',
                    },
                  ],
                  summary: '发布会实录核查完毕',
                },
              });
            } else {
              // Task 1 will be cancelled from outside
              await new Promise((r) => setTimeout(r, 100));
            }
          },
        };
      },
    });

    const authorityTool = createResearchAuthorityTool({ workerPool, db });

    // Launch Task 1 (official bulletin) and Task 2 (press conference)
    const receipt1 = (await runExecutionContext.run({ run_id: runId }, async () => {
      return (await authorityTool.execute({
        question: '核对官方通报原文与字号',
        completion_criteria: '提取发文字号',
        requested_budget_units: 6,
      })) as AcceptedTaskReceipt;
    })) as AcceptedTaskReceipt;

    const receipt2 = (await runExecutionContext.run({ run_id: runId }, async () => {
      return (await authorityTool.execute({
        question: '核对新闻发布会发言记录',
        completion_criteria: '提取人员伤亡情况官方结论',
        requested_budget_units: 8,
      })) as AcceptedTaskReceipt;
    })) as AcceptedTaskReceipt;

    // Verify separate IDs and attempts
    assert.notEqual(receipt1.task_id, receipt2.task_id);
    assert.notEqual(receipt1.attempt_id, receipt2.attempt_id);

    // Cancel Task 1 while both are in progress
    const cancelled = workerPool.cancelTask(receipt1.task_id, 'HOST decided to cancel bulletin check');
    assert.equal(cancelled, true);

    await workerPool.waitForAll();

    // Check states: Task 1 cancelled, Task 2 succeeded
    const task1 = taskRepo.getTask(receipt1.task_id);
    const task2 = taskRepo.getTask(receipt2.task_id);

    assert.equal(task1?.status, TaskStatus.Cancelled);
    assert.equal(task2?.status, TaskStatus.Succeeded);
    assert.equal(task1?.budget_allocated, 6);
    assert.equal(task2?.budget_allocated, 8);

    // Verify task_results contains separate outcomes
    const results = resultRepo.listResultsByRun(runId);
    const res1 = results.find((r) => r.task_id === receipt1.task_id);
    const res2 = results.find((r) => r.task_id === receipt2.task_id);

    assert.equal(res1?.status, 'cancelled');
    assert.equal(res2?.status, 'succeeded');
    assert.ok(res2?.summary?.includes('发布会实录核查完毕'));
  });

  // --------------------------------------------------------------------------
  // Scenario 4: Single task timeout isolation & late response rejection
  // --------------------------------------------------------------------------
  it('Scenario 4: Single task timeout marks timed_out, leaves peer running, and rejects late submissions', async () => {
    const runId = 'run-scen-04';
    setupBaseRun(runId);

    let lateSubmitFn: any = null;

    const workerPool = new ResearchWorkerPool({
      db,
      maxConcurrency: 3,
      agentFactory: (ctx) => {
        return {
          run: async (_prompt: string, signal?: AbortSignal) => {
            if (ctx.role === 'evolution') {
              // Task A: times out (takes 100ms with 25ms timeout)
              lateSubmitFn = () =>
                ctx.submitTool.execute({
                  findings: {
                    role: 'evolution',
                    round: 1,
                    claims: [],
                    evidence_pool: [],
                    summary: 'Late evo result after timeout',
                  },
                });
              await new Promise((r) => setTimeout(r, 100));
            } else {
              // Task B: fast peer (authority)
              await new Promise((r) => setTimeout(r, 10));
              await ctx.submitTool.execute({
                findings: {
                  role: 'authority',
                  round: 1,
                  claims: [
                    {
                      claim_id: 'c-peer',
                      statement: 'Peer task completed',
                      evidence_ids: ['ev-peer'],
                      confidence: 1.0,
                      dimension: 'official',
                    },
                  ],
                  evidence_pool: [
                    {
                      evidence_id: 'ev-peer',
                      source_ref: 'http://gov.cn',
                      content: 'Peer content',
                    },
                  ],
                  summary: 'Peer authority succeeded',
                },
              });
            }
          },
        };
      },
    });

    const receiptA = await workerPool.enqueueTask(
      'evolution',
      jobParams({
        run_id: runId,
        question: '慢速演化分析',
        completion_criteria: '提取热度',
        requested_budget_units: 8,
      }),
      { timeoutMs: 25 }
    );

    const receiptB = await workerPool.enqueueTask(
      'authority',
      jobParams({
        run_id: runId,
        question: '同伴权威核查',
        completion_criteria: '核实通报',
        requested_budget_units: 8,
      })
    );

    await workerPool.waitForAll();

    // Check states: Task A timed_out, Task B succeeded
    const taskA = taskRepo.getTask(receiptA.task_id);
    const taskB = taskRepo.getTask(receiptB.task_id);

    assert.equal(taskA?.status, TaskStatus.TimedOut);
    assert.equal(taskB?.status, TaskStatus.Succeeded);

    // Verify late submission cannot overwrite terminal timed_out status
    assert.ok(lateSubmitFn, 'lateSubmitFn must be captured');
    await assert.rejects(
      async () => {
        await lateSubmitFn();
      },
      (err: any) => {
        // Must reject due to UNIQUE constraint (run_id, task_id, version) in task_results
        return (
          err.message.includes('UNIQUE constraint') ||
          err.message.includes('Submission rejected') ||
          err.message.includes('already exists')
        );
      }
    );

    // Task status remains TimedOut, never overwritten by late submission
    const finalTaskA = taskRepo.getTask(receiptA.task_id);
    assert.equal(finalTaskA?.status, TaskStatus.TimedOut);
  });

  // --------------------------------------------------------------------------
  // Scenario 5: Task-level cancellation vs Run-level cancellation
  // --------------------------------------------------------------------------
  it('Scenario 5: Cancelling a single task leaves peers running; cancelling the run aborts all and blocks release', async () => {
    // Part 1: Task-level cancellation
    const runId1 = 'run-scen-05-task';
    setupBaseRun(runId1);

    const workerPool1 = new ResearchWorkerPool({
      db,
      maxConcurrency: 3,
      agentFactory: (ctx) => {
        return {
          run: async (_prompt: string, signal?: AbortSignal) => {
            if (ctx.role === 'feedback') {
              // Task to be cancelled
              await new Promise((r) => setTimeout(r, 80));
            } else {
              // Peer task to complete
              await new Promise((r) => setTimeout(r, 20));
              await ctx.submitTool.execute({
                findings: {
                  role: 'authority',
                  round: 1,
                  claims: [
                    {
                      claim_id: 'claim-peer',
                      statement: 'Authority unaffected by peer cancel',
                      evidence_ids: ['ev-p'],
                      confidence: 1.0,
                      dimension: 'official',
                    },
                  ],
                  evidence_pool: [{ evidence_id: 'ev-p', source_ref: 'ref', content: 'c' }],
                  summary: 'Peer succeeded',
                },
              });
            }
          },
        };
      },
    });

    const coordinator1 = new ResearchCoordinator(runRepo, taskRepo, undefined, eventStore, {
      workerPool: workerPool1,
      db,
    });

    const receiptFb = await workerPool1.enqueueTask(
      'feedback',
      jobParams({
        run_id: runId1,
        question: '公众反馈调研',
        completion_criteria: '提取关切',
      })
    );
    const receiptAuth = await workerPool1.enqueueTask(
      'authority',
      jobParams({
        run_id: runId1,
        question: '权威口径调查',
        completion_criteria: '提取通告',
      })
    );

    // Cancel single task
    const cancelOk = await coordinator1.cancelTask(receiptFb.task_id, 'Cancelled specific task');
    assert.equal(cancelOk, true);

    await workerPool1.waitForAll();

    assert.equal(taskRepo.getTask(receiptFb.task_id)?.status, TaskStatus.Cancelled);
    assert.equal(taskRepo.getTask(receiptAuth.task_id)?.status, TaskStatus.Succeeded);

    // Part 2: Run-level cancellation
    const runId2 = 'run-scen-05-run';
    setupBaseRun(runId2);

    const workerPool2 = new ResearchWorkerPool({
      db,
      maxConcurrency: 3,
      agentFactory: () => {
        return {
          run: async () => {
            await new Promise((r) => setTimeout(r, 100));
          },
        };
      },
    });

    const releaseGate2 = new ReleaseGate({
      db,
      taskRepo,
      resultRepo,
      evidenceStore,
      runRepo,
      outboxRepo,
      inboxRepo,
      snapshotRepo,
    });

    const coordinator2 = new ResearchCoordinator(runRepo, taskRepo, undefined, eventStore, {
      workerPool: workerPool2,
      releaseGate: releaseGate2,
      db,
    });

    const r1 = await workerPool2.enqueueTask(
      'authority',
      jobParams({
        run_id: runId2,
        question: '核查任务1',
        completion_criteria: '准则1',
        required_for_report: true,
      })
    );
    const r2 = await workerPool2.enqueueTask(
      'evolution',
      jobParams({
        run_id: runId2,
        question: '核查任务2',
        completion_criteria: '准则2',
        required_for_report: true,
      })
    );

    // Cancel entire run via coordinator - workerPool cascade-cancels in-flight tasks
    coordinator2.cancelRun(runId2, 'Emergency user stop');

    await workerPool2.waitForAll();

    // Verify run status is cancelled
    assert.equal(coordinator2.getRun(runId2)?.status, RunStatus.Cancelled);
    assert.equal(taskRepo.getTask(r1.task_id)?.status, TaskStatus.Cancelled);
    assert.equal(taskRepo.getTask(r2.task_id)?.status, TaskStatus.Cancelled);

    // Verify release gate blocks cancelled run
    const releaseRes = releaseGate2.verifyRelease(runId2);
    assert.equal(releaseRes.ok, false);
    assert.ok(releaseRes.reason?.includes('has no accepted result'));
  });

  // --------------------------------------------------------------------------
  // Scenario 6: Idempotency deduplication
  // --------------------------------------------------------------------------
  it('Scenario 6: Idempotency keys prevent duplicate tool execution, duplicate outbox/inbox records, and double budget deductions', async () => {
    const runId = 'run-scen-06';
    setupBaseRun(runId);

    const idempotencyRepo = new IdempotencyRepository(db);

    // 1. Tool Call Idempotency
    const idemKey = buildIdempotencyKey({
      run_id: runId,
      execution_version: 1,
      host_turn_id: 'turn-1',
      tool_call_id: 'call-unique-101',
    });

    let executionCount = 0;
    const executeTool = () => {
      executionCount++;
      return {
        status: 'accepted',
        task_id: 'task-auth-idem-01',
        attempt_id: 'att-auth-idem-01',
      };
    };

    const firstCall = idempotencyRepo.checkOrExecute(idemKey, 'call-unique-101', executeTool);
    assert.equal(firstCall.cached, false);
    assert.equal(executionCount, 1);
    assert.equal(firstCall.response.task_id, 'task-auth-idem-01');

    // Duplicate call with same idempotency key: should return cached receipt without executing again
    const secondCall = idempotencyRepo.checkOrExecute(idemKey, 'call-unique-101', executeTool);
    assert.equal(secondCall.cached, true);
    assert.equal(executionCount, 1);
    assert.equal(secondCall.response.task_id, 'task-auth-idem-01');

    // 2. Budget Ledger Idempotency
    const budgetRes1 = budgetLedger.reserve({
      run_id: runId,
      units: 5,
      idempotency_key: 'budget-idem-key-99',
    });
    assert.equal(budgetRes1.ok, true);

    const budgetRes2 = budgetLedger.reserve({
      run_id: runId,
      units: 5,
      idempotency_key: 'budget-idem-key-99',
    });
    assert.equal(budgetRes2.ok, true);
    assert.equal(budgetRes1.reservation_id, budgetRes2.reservation_id);

    // Check remaining quota: only 5 units reserved, NOT 10
    const committed = budgetLedger.getUsage(runId).committed;
    assert.equal(committed, 5);

    // 3. Host Inbox Event Deduplication
    const outboxSeq = outboxRepo.appendEvent({
      run_id: runId,
      event_type: 'research_outcome',
      payload: { test: true },
    });

    const inboxId1 = inboxRepo.recordEvent(runId, outboxSeq);
    assert.ok(inboxId1 > 0);

    // Duplicate inbox recording for same run and event_seq
    const inboxId2 = inboxRepo.recordEvent(runId, outboxSeq);
    assert.equal(inboxId1, inboxId2, 'Duplicate event_seq must return existing inbox record');

    const pending = inboxRepo.listPending(runId);
    assert.equal(pending.length, 1, 'Duplicate inbox event must not create multiple pending rows');
  });

  // --------------------------------------------------------------------------
  // Scenario 7: Debounced arrival & serialized HOST turns
  // --------------------------------------------------------------------------
  it('Scenario 7: Rapidly arriving events are debounced and processed with strictly serialized HOST turns (mutex)', async () => {
    const runId = 'run-scen-07';
    setupBaseRun(runId);

    let activeHostInvocations = 0;
    let maxConcurrentHostInvocations = 0;
    let totalHostTurns = 0;

    const hostStreamFn = createScriptedStreamFn([
      { text: 'Turn 1 decision [WAIT]' },
      { text: 'Turn 2 decision [REQUEST_RELEASE] not_applicable: feedback' },
    ]);

    const hostAgent = createHostAgent({
      delegateTool: createDelegateResearchTool({ db }),
      streamFn: async (model, ctx, opt) => {
        activeHostInvocations++;
        maxConcurrentHostInvocations = Math.max(maxConcurrentHostInvocations, activeHostInvocations);
        totalHostTurns++;
        await new Promise((r) => setTimeout(r, 40));
        activeHostInvocations--;
        return hostStreamFn(model, ctx, opt);
      },
    });

    const dispatcher = new HostInboxDispatcher({
      db,
      hostAgent,
      budgetLedger,
      debounceMs: 50,
    });

    // Enqueue two events in rapid succession (within debounce window)
    dispatcher.enqueueEvent({
      run_id: runId,
      event_type: 'research_outcome',
      payload: {
        outcome: {
          task_id: 'task-1',
          role: 'authority',
          status: 'succeeded',
          summary: '权威报告完成',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 10));

    dispatcher.enqueueEvent({
      run_id: runId,
      event_type: 'research_outcome',
      payload: {
        outcome: {
          task_id: 'task-2',
          role: 'evolution',
          status: 'succeeded',
          summary: '演化报告完成',
        },
      },
    });

    // Wait for debounce and processing to complete
    await new Promise((r) => setTimeout(r, 200));

    // Verify Mutex: activeHostInvocations never exceeded 1
    assert.equal(maxConcurrentHostInvocations, 1, 'At no point should HOST run concurrently for same run');

    // Verify all pending inbox events were processed (none dropped)
    const pendingEvents = inboxRepo.listPending(runId);
    assert.equal(pendingEvents.length, 0, 'All inbox events must be claimed and processed');

    dispatcher.destroy();
  });

  // --------------------------------------------------------------------------
  // Scenario 8: HOST busy queueing without busy-loop
  // --------------------------------------------------------------------------
  it('Scenario 8: Events arriving while HOST is busy are queued and automatically trigger next turn without busy spinning', async () => {
    const runId = 'run-scen-08';
    setupBaseRun(runId);

    let hostTurn = 0;
    let turn1Resolve: () => void;
    const turn1Signal = new Promise<void>((r) => (turn1Resolve = r));

    const hostAgent = createHostAgent({
      delegateTool: createDelegateResearchTool({ db }),
      streamFn: async () => {
        hostTurn++;
        if (hostTurn === 1) {
          // Turn 1 intentionally held until we manually resolve it
          await turn1Signal;
          return {
            finalText: 'Turn 1 finished: [WAIT] for additional findings',
            messages: [{ role: 'assistant', content: 'Turn 1 finished: [WAIT]' }],
          } as any;
        } else {
          return {
            finalText: 'Turn 2 finished: [REQUEST_RELEASE]',
            messages: [{ role: 'assistant', content: 'Turn 2 finished: [REQUEST_RELEASE]' }],
          } as any;
        }
      },
    });

    const dispatcher = new HostInboxDispatcher({
      db,
      hostAgent,
      budgetLedger,
      debounceMs: 20,
    });

    // Start Turn 1
    dispatcher.enqueueEvent({
      run_id: runId,
      event_type: 'research_outcome',
      payload: { outcome: { task_id: 't-1', role: 'authority', status: 'succeeded' } },
    });

    // Wait for Turn 1 to start
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(dispatcher.isActive(runId), true, 'Dispatcher should be active running Turn 1');
    assert.equal(hostTurn, 1);

    // While HOST is busy in Turn 1, arrive a new event
    dispatcher.enqueueEvent({
      run_id: runId,
      event_type: 'research_outcome',
      payload: { outcome: { task_id: 't-2', role: 'evolution', status: 'succeeded' } },
    });

    // Verify new event is queued in SQLite host_inbox
    const allPending = inboxRepo.listPending(runId);
    assert.equal(allPending.length, 1, 'Second event must be queued with status=pending');

    // Turn 1 resolves now
    turn1Resolve!();

    // Wait for Turn 2 to automatically execute
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(hostTurn, 2, 'Dispatcher should automatically trigger Turn 2 for the queued event');
    const remainingPending = inboxRepo.listPending(runId);
    assert.equal(remainingPending.length, 0, 'All events should be fully processed');

    dispatcher.destroy();
  });

  // --------------------------------------------------------------------------
  // Scenario 9: Crash recovery of undelivered events & lease handling
  // --------------------------------------------------------------------------
  it('Scenario 9: Crash recovery on startup recovers interrupted attempts and replays undelivered outbox events to inbox', async () => {
    const runId = 'run-scen-09';
    setupBaseRun(runId);

    // 1. Simulate an interrupted attempt that was running when process crashed
    const interruptedAttemptId = 'att-crash-interrupted-01';
    const taskId1 = 'task-crash-01';
    taskRepo.createTask({
      task_id: taskId1,
      run_id: runId,
      role: ResearchRole.Authority,
      round: 1,
      generation: 1,
      question: '查证防汛预警通报',
      scope: {},
      completion_criteria: '提取发文字号',
      required_for_report: true,
      status: TaskStatus.Running,
      budget_allocated: 10,
      created_at: new Date().toISOString(),
    });

    attemptRepo.createAttempt({
      attempt_id: interruptedAttemptId,
      task_id: taskId1,
      run_id: runId,
      execution_version: 1,
      status: 'running',
      started_at: new Date().toISOString(),
    });

    // 2. Simulate worker saving task result & appending outbox event, but crashing before delivery
    const taskId2 = 'task-crash-02';
    taskRepo.createTask({
      task_id: taskId2,
      run_id: runId,
      role: ResearchRole.Evolution,
      round: 1,
      generation: 1,
      question: '查证演化趋势',
      scope: {},
      completion_criteria: '提取热度曲线',
      required_for_report: true,
      status: TaskStatus.Succeeded,
      budget_allocated: 10,
      created_at: new Date().toISOString(),
    });

    const undeliveredOutboxId = outboxRepo.appendEvent({
      run_id: runId,
      task_id: taskId2,
      event_type: 'research_outcome',
      payload: {
        outcome: {
          task_id: taskId2,
          role: 'evolution',
          status: 'succeeded',
          summary: '舆情演化结果已入库但通知未送达',
        },
      },
    });

    // 3. Simulate an already processed event
    const alreadyProcessedSeq = outboxRepo.appendEvent({
      run_id: runId,
      task_id: taskId2,
      event_type: 'research_outcome',
      payload: { previous: true },
    });
    outboxRepo.markDelivered(alreadyProcessedSeq);
    const prevInboxId = inboxRepo.recordEvent(runId, alreadyProcessedSeq);
    inboxRepo.claimPending(runId);
    inboxRepo.markProcessed(prevInboxId);

    // Instantiate coordinator and trigger startup recovery
    const coordinator = new ResearchCoordinator(runRepo, taskRepo, undefined, eventStore, { db });
    const recoveryResult = coordinator.recoverOnStartup();

    // Verify recovery findings
    assert.ok(recoveryResult.interruptedAttempts >= 1);
    assert.ok(recoveryResult.undeliveredEvents >= 1);
    assert.ok(recoveryResult.pendingInboxRuns.includes(runId));

    // Verify interrupted attempt marked failed with INTERRUPTED_ON_STARTUP
    const updatedAttempt = attemptRepo.getAttempt(interruptedAttemptId);
    assert.equal(updatedAttempt?.status, 'failed');
    assert.equal((updatedAttempt?.error as any)?.code, 'INTERRUPTED_ON_STARTUP');

    // Verify undelivered outbox event was recorded in host_inbox as pending
    const pendingInbox = inboxRepo.listPending(runId);
    const recoveredEvent = pendingInbox.find((e) => e.event_seq === undeliveredOutboxId);
    assert.ok(recoveredEvent, 'Undelivered outbox event must be enqueued into host inbox');

    // Verify already processed event is NOT re-queued into pending
    const duplicateProcessed = pendingInbox.find((e) => e.inbox_id === prevInboxId);
    assert.equal(duplicateProcessed, undefined, 'Previously processed event must not become pending again');
  });

  // --------------------------------------------------------------------------
  // Scenario 10: File-based SQLite recovery
  // --------------------------------------------------------------------------
  it('Scenario 10: Physical disk SQLite database cleanly recovers tasks, results, and outbox across process restarts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bettafish-scen10-'));
    const diskDbPath = path.join(tempDir, 'test-recovery.db');
    const runId = 'run-scen-10-disk';

    try {
      // 1. Initialize and write data to disk database
      const diskRaw1 = new DatabaseSync(diskDbPath);
      const diskDb1 = createDatabase(diskRaw1);

      const diskRunRepo1 = new RunRepository(diskDb1);
      const diskTaskRepo1 = new TaskRepository(diskDb1);
      const diskAttemptRepo1 = new TaskAttemptRepository(diskDb1);
      const diskResultRepo1 = new TaskResultRepository(diskDb1);
      const diskOutboxRepo1 = new OutboxRepository(diskDb1);

      const nowIso = new Date().toISOString();
      diskRunRepo1.createRun({
        run_id: runId,
        topic: '物理文件数据库断电恢复验收测试',
        scope: { test: true },
        status: RunStatus.Researching,
        current_round: 1,
        max_rounds: 3,
        budget_total: 50,
        budget_used: 0,
        execution_version: 1,
        created_at: nowIso,
        updated_at: nowIso,
      });

      diskTaskRepo1.createTask({
        task_id: 'task-disk-01',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: '文件持久化任务',
        scope: {},
        completion_criteria: '写入磁盘',
        required_for_report: true,
        status: TaskStatus.Succeeded,
        budget_allocated: 10,
        created_at: nowIso,
      });

      diskAttemptRepo1.createAttempt({
        attempt_id: 'att-disk-01',
        task_id: 'task-disk-01',
        run_id: runId,
        execution_version: 1,
        status: 'succeeded',
        started_at: nowIso,
        completed_at: nowIso,
      });

      diskResultRepo1.saveResult({
        result_id: 'res-disk-01',
        run_id: runId,
        task_id: 'task-disk-01',
        attempt_id: 'att-disk-01',
        version: 1,
        role: 'authority',
        status: 'succeeded',
        summary: '磁盘写入验证完成',
        created_at: nowIso,
      });

      diskOutboxRepo1.appendEvent({
        run_id: runId,
        task_id: 'task-disk-01',
        event_type: 'research_outcome',
        payload: { success: true },
      });

      // Close the connection completely (simulating process exit)
      diskRaw1.close();

      // 2. Open a completely new connection from disk file
      const diskRaw2 = new DatabaseSync(diskDbPath);
      const diskDb2 = createDatabase(diskRaw2);

      const diskRunRepo2 = new RunRepository(diskDb2);
      const diskTaskRepo2 = new TaskRepository(diskDb2);
      const diskAttemptRepo2 = new TaskAttemptRepository(diskDb2);
      const diskResultRepo2 = new TaskResultRepository(diskDb2);
      const diskOutboxRepo2 = new OutboxRepository(diskDb2);

      // Verify all data is intact from disk
      const loadedRun = diskRunRepo2.getRun(runId);
      assert.ok(loadedRun);
      assert.equal(loadedRun.topic, '物理文件数据库断电恢复验收测试');

      const loadedTasks = diskTaskRepo2.listTasks(runId);
      assert.equal(loadedTasks.length, 1);
      assert.equal(loadedTasks[0].task_id, 'task-disk-01');
      assert.equal(loadedTasks[0].status, TaskStatus.Succeeded);

      const loadedAttempts = diskAttemptRepo2.listAttemptsByRun(runId);
      assert.equal(loadedAttempts.length, 1);
      assert.equal(loadedAttempts[0].attempt_id, 'att-disk-01');

      const loadedResults = diskResultRepo2.listResultsByRun(runId);
      assert.equal(loadedResults.length, 1);
      assert.equal(loadedResults[0].result_id, 'res-disk-01');
      assert.equal(loadedResults[0].summary, '磁盘写入验证完成');

      const loadedOutbox = diskOutboxRepo2.getUndeliveredEvents(runId);
      assert.equal(loadedOutbox.length, 1);

      diskRaw2.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // Scenario 11: Dual-tier budget enforcement & report reservation
  // --------------------------------------------------------------------------
  it('Scenario 11: Dual-tier budget enforces task quota, protects writing reserve, and tracks concurrent calls separately', async () => {
    const runId = 'run-scen-11';
    setupBaseRun(runId);

    // Total limit = 25, reserve for writing = 5 => max research quota = 20
    const testLedger = new BudgetLedger(db, { totalToolLimit: 25, reservedForWriting: 5 });

    // Task 1 allocated budget = 3
    const t1Res1 = testLedger.reserve({ run_id: runId, task_id: 'task-1', units: 1, task_budget_allocated: 3 });
    const t1Res2 = testLedger.reserve({ run_id: runId, task_id: 'task-1', units: 1, task_budget_allocated: 3 });
    const t1Res3 = testLedger.reserve({ run_id: runId, task_id: 'task-1', units: 1, task_budget_allocated: 3 });
    assert.equal(t1Res1.ok, true);
    assert.equal(t1Res2.ok, true);
    assert.equal(t1Res3.ok, true);

    // 4th unit for Task 1: should be rejected by Task-level limit (3)
    const t1Res4 = testLedger.reserve({ run_id: runId, task_id: 'task-1', units: 1, task_budget_allocated: 3 });
    assert.equal(t1Res4.ok, false);
    assert.ok(t1Res4.error?.includes('Task budget quota exceeded'));

    // Task 2: allocated budget = 20
    // Try reserving 17 units: 3 (Task 1) + 17 = 20 (hits global research quota of 20)
    const t2Res1 = testLedger.reserve({ run_id: runId, task_id: 'task-2', units: 17, task_budget_allocated: 20 });
    assert.equal(t2Res1.ok, true);

    // Next research unit: should be rejected by Global Research Limit (20)
    const t2Res2 = testLedger.reserve({ run_id: runId, task_id: 'task-2', units: 1, task_budget_allocated: 20 });
    assert.equal(t2Res2.ok, false);
    assert.ok(t2Res2.error?.includes('Budget quota exceeded'));

    // Report writing reserve (5 units) is protected and available only for writing phase
    const writeRes = testLedger.reserve({
      run_id: runId,
      units: 5,
      is_writing_phase: true,
      call_type: 'report_writing',
    });
    assert.equal(writeRes.ok, true, 'Writing phase should be able to access the reserved writing budget');

    // Concurrent calls with distinct call_ids
    const callARes = testLedger.reserve({
      run_id: 'run-scen-11-concurrent',
      units: 1,
      idempotency_key: 'call-id-alpha',
    });
    const callBRes = testLedger.reserve({
      run_id: 'run-scen-11-concurrent',
      units: 1,
      idempotency_key: 'call-id-beta',
    });

    assert.equal(callARes.ok, true);
    assert.equal(callBRes.ok, true);
    assert.notEqual(callARes.reservation_id, callBRes.reservation_id);
  });

  // --------------------------------------------------------------------------
  // Scenario 12: Required vs optional role failure & restricted delivery
  // --------------------------------------------------------------------------
  it('Scenario 12: Required task failure halts release; optional failure allows restricted release; uncalled role allows normal delivery', async () => {
    const releaseGate = new ReleaseGate({
      db,
      taskRepo,
      resultRepo,
      evidenceStore,
      runRepo,
      outboxRepo,
      inboxRepo,
      snapshotRepo,
      decisionRepo,
    });

    // Case A: Required task failed with no gap justification
    const runA = 'run-scen-12-required-failed';
    setupBaseRun(runA);
    taskRepo.createTask({
      task_id: 'task-auth-req',
      run_id: runA,
      role: ResearchRole.Authority,
      round: 1,
      generation: 1,
      question: '关键权威核查',
      scope: {},
      completion_criteria: '通报',
      required_for_report: true,
      status: TaskStatus.Failed,
      budget_allocated: 10,
      created_at: new Date().toISOString(),
    });

    const verifyA = releaseGate.verifyRelease(runA);
    assert.equal(verifyA.ok, false);
    assert.ok(verifyA.reason?.includes('has no accepted result and no acceptable gap justification'));

    // Case B: Optional task failed, but has explicit gap justification in release request
    const runB = 'run-scen-12-optional-failed';
    setupBaseRun(runB, { scope: { not_applicable_roles: ['evolution'] } });

    // Required task succeeded
    taskRepo.createTask({
      task_id: 'task-auth-succ',
      run_id: runB,
      role: ResearchRole.Authority,
      round: 1,
      generation: 1,
      question: '权威核查',
      scope: {},
      completion_criteria: '通报',
      required_for_report: true,
      status: TaskStatus.Succeeded,
      budget_allocated: 10,
      created_at: new Date().toISOString(),
    });
    resultRepo.saveResult({
      result_id: 'res-b-1',
      run_id: runB,
      task_id: 'task-auth-succ',
      attempt_id: 'att-b-1',
      version: 1,
      role: 'authority',
      status: 'succeeded',
      findings: { claims: [], evidence_pool: [] },
      created_at: new Date().toISOString(),
    });

    // Optional feedback task failed
    taskRepo.createTask({
      task_id: 'task-fb-opt',
      run_id: runB,
      role: ResearchRole.Feedback,
      round: 1,
      generation: 1,
      question: '公众反馈调查（可选）',
      scope: {},
      completion_criteria: '抓取评论',
      required_for_report: false,
      status: TaskStatus.Failed,
      budget_allocated: 5,
      created_at: new Date().toISOString(),
    });

    const verifyB = releaseGate.verifyRelease(
      runB,
      parseReleaseRequest({
        restricted: true,
        allowed_gaps: ['feedback: 社交平台数据源风控导致部分评论样本缺失'],
        rationale: '受限发布：已通过权威通报核查，公众评论存在数据缺口',
      })
    );

    assert.equal(verifyB.ok, true, `Release should succeed with restricted delivery: ${verifyB.reason || ''}`);
    assert.equal(verifyB.restricted, true);
    assert.ok(verifyB.snapshotId);

    // Case C: Uncalled role evolution explicitly marked not_applicable
    assert.ok(verifyB.gaps.some((g) => g.includes('evolution')));
  });

  // --------------------------------------------------------------------------
  // Scenario 13: Generation cap <= 3 & review turns
  // --------------------------------------------------------------------------
  it('Scenario 13: Substantive follow-ups increment generation up to 3; 4th revision is blocked; review turns and retries do not increment generation', async () => {
    const runId = 'run-scen-13';
    setupBaseRun(runId);

    const planner = new TaskPlanner(taskRepo);
    const question = '调查泄洪前水库调蓄库容数据及前后对比';

    // Gen 1: Initial task
    const [t1] = planner.createPlannedTasks(runId, 1, [
      {
        role: ResearchRole.Authority,
        question,
        budget_allocated: 10,
        completion_criteria: '提取库容数字',
      },
    ]);
    assert.equal(t1.generation, 1);

    // Gen 2: Follow-up revision 1 for same question
    const [t2] = planner.createPlannedTasks(runId, 2, [
      {
        role: ResearchRole.Authority,
        question,
        budget_allocated: 10,
        completion_criteria: '补充核对上游水库调蓄记录',
      },
    ]);
    assert.equal(t2.generation, 2);

    // Gen 3: Follow-up revision 2 for same question
    const [t3] = planner.createPlannedTasks(runId, 3, [
      {
        role: ResearchRole.Authority,
        question,
        budget_allocated: 10,
        completion_criteria: '核实水文局入库流量传感器原始读数',
      },
    ]);
    assert.equal(t3.generation, 3);

    // Gen 4: 4th revision attempt MUST be blocked
    assert.throws(
      () => {
        planner.createPlannedTasks(runId, 4, [
          {
            role: ResearchRole.Authority,
            question,
            budget_allocated: 10,
            completion_criteria: '第4次无限补查',
          },
        ]);
      },
      (err: any) => {
        return err.message.includes('Generation limit exceeded') && err.message.includes('3');
      }
    );

    // Attempt retries do not consume generation
    attemptRepo.createAttempt({
      attempt_id: 'att-t1-retry-1',
      task_id: t1.task_id,
      run_id: runId,
      execution_version: 1,
      status: 'failed',
      started_at: new Date().toISOString(),
    });
    attemptRepo.createAttempt({
      attempt_id: 'att-t1-retry-2',
      task_id: t1.task_id,
      run_id: runId,
      execution_version: 1,
      status: 'succeeded',
      started_at: new Date().toISOString(),
    });
    const currentTask = taskRepo.getTask(t1.task_id);
    assert.equal(currentTask?.generation, 1, 'Task generation must remain 1 regardless of retries');

    // Review turns do not consume substantive revision generations
    decisionRepo.saveDecision({
      decision_id: 'dec-scen13-01',
      run_id: runId,
      turn_number: 1,
      decision_type: StageDecisionType.Wait,
      rationale: 'Reviewing evidence',
      task_id: t1.task_id,
      inbox_event_ids: [1],
      created_at: new Date().toISOString(),
    });
    decisionRepo.saveDecision({
      decision_id: 'dec-scen13-02',
      run_id: runId,
      turn_number: 2,
      decision_type: StageDecisionType.Wait,
      rationale: 'Still reviewing',
      task_id: t1.task_id,
      inbox_event_ids: [2],
      created_at: new Date().toISOString(),
    });

    assert.equal(taskRepo.getTask(t1.task_id)?.generation, 1);
  });

  // --------------------------------------------------------------------------
  // Scenario 14: Immutable material snapshot freezing
  // --------------------------------------------------------------------------
  it('Scenario 14: Material snapshot frozen by ReleaseGate is strictly immutable and subsequent results cannot overwrite it', async () => {
    const runId = 'run-scen-14';
    setupBaseRun(runId, { scope: { not_applicable_roles: ['evolution', 'feedback'] } });

    // Seed valid evidence in EvidenceStore
    evidenceStore.addEvidence({
      evidence_id: 'ev-snap-01',
      run_id: runId,
      source_type: 'official_document',
      source_ref: 'http://gov.cn/bulletin/88',
      title: '泄洪调度命令',
      excerpt: '防汛抗旱指挥部关于水库开闸泄洪调度命令全文',
    });

    // Create succeeded authority task
    taskRepo.createTask({
      task_id: 'task-snap-auth',
      run_id: runId,
      role: ResearchRole.Authority,
      round: 1,
      generation: 1,
      question: '核实泄洪调度命令全文',
      scope: {},
      completion_criteria: '调度命令字号',
      required_for_report: true,
      status: TaskStatus.Succeeded,
      budget_allocated: 10,
      created_at: '2026-10-02T10:00:00.000Z',
    });

    resultRepo.saveResult({
      result_id: 'res-snap-01',
      run_id: runId,
      task_id: 'task-snap-auth',
      attempt_id: 'att-snap-01',
      version: 1,
      role: 'authority',
      status: 'succeeded',
      findings: {
        claims: [
          {
            claim_id: 'c-snap-01',
            statement: '防指于07:30签发水库开闸泄洪调度令第1号',
            evidence_ids: ['ev-snap-01'],
            confidence: 0.99,
            dimension: 'official',
          },
        ],
      },
      summary: '初始成果已锁定',
      created_at: '2026-10-02T10:05:00.000Z',
    });

    const releaseGate = new ReleaseGate({
      db,
      taskRepo,
      resultRepo,
      evidenceStore,
      runRepo,
      outboxRepo,
      inboxRepo,
      snapshotRepo,
      decisionRepo,
    });

    // Freeze snapshot
    const freezeRes = releaseGate.verifyRelease(runId);
    assert.equal(freezeRes.ok, true);
    assert.ok(freezeRes.snapshotId);
    const originalSnapshot = freezeRes.snapshot!;

    assert.equal(originalSnapshot.claims.length, 1);
    assert.equal(originalSnapshot.claims[0].claim_id, 'c-snap-01');
    assert.equal(originalSnapshot.evidence_pool.length, 1);
    assert.equal(originalSnapshot.evidence_pool[0].evidence_id, 'ev-snap-01');

    // Attempt to tamper: Add new evidence and a late arriving result after freeze
    evidenceStore.addEvidence({
      evidence_id: 'ev-snap-tamper-02',
      run_id: runId,
      source_type: 'social_media',
      source_ref: 'http://weibo.cn/tamper',
      title: '迟到的社媒爆料',
      excerpt: '未经核实的小道消息',
    });

    resultRepo.saveResult({
      result_id: 'res-snap-late-02',
      run_id: runId,
      task_id: 'task-snap-auth',
      attempt_id: 'att-snap-02',
      version: 2,
      role: 'authority',
      status: 'succeeded',
      findings: {
        claims: [
          {
            claim_id: 'c-snap-tamper-02',
            statement: '篡改或新增的主张',
            evidence_ids: ['ev-snap-tamper-02'],
          },
        ],
      },
      summary: '迟到结果',
      created_at: new Date(Date.now() + 60000).toISOString(),
    });

    // Re-fetch snapshot from snapshotRepo: MUST be identical to original freeze time
    const fetchedSnapshot = snapshotRepo.getSnapshot(freezeRes.snapshotId);
    assert.equal(fetchedSnapshot.claims.length, 1, 'Claims count in frozen snapshot must remain 1');
    assert.equal(fetchedSnapshot.claims[0].claim_id, 'c-snap-01');
    assert.equal(fetchedSnapshot.evidence_pool.length, 1, 'Evidence count in frozen snapshot must remain 1');
    assert.equal(fetchedSnapshot.evidence_pool[0].evidence_id, 'ev-snap-01');

    // Attempting to overwrite existing snapshot ID throws error
    assert.throws(
      () => {
        snapshotRepo.saveSnapshot({
          snapshot_id: freezeRes.snapshotId!,
          run_id: runId,
          claims: [],
        } as any);
      },
      (err: any) => {
        return err.message.includes('Material snapshot already exists and cannot overwrite');
      }
    );

    // Verify that attempting to release with the now-invalidated snapshot fails because newer results arrived
    const lateVerify = releaseGate.verifyRelease(
      runId,
      parseReleaseRequest({ snapshot_id: freezeRes.snapshotId })
    );
    assert.equal(lateVerify.ok, false);
    assert.ok(lateVerify.reason?.includes('is invalidated by 1 newer task result(s)'));
  });
});
