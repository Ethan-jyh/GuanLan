import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createResearchAuthorityTool,
  createResearchEvolutionTool,
  createResearchFeedbackTool,
  createResearchRoleTool,
  createGetResearchResultTool,
  createCancelResearchTaskTool,
} from '../src/tools/research-tools.js';
import { createSubmitFindingsTool } from '../src/tools/submit-findings.js';
import { createDelegateResearchTool } from '../src/tools/delegate-research.js';
import { ResearchWorkerPool } from '../src/orchestration/research-worker.js';
import { createDatabase, type ResearchDatabase } from '../src/storage/database.js';
import {
  RunRepository,
  TaskRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
} from '../src/storage/repositories.js';
import {
  ResearchRole,
  TaskStatus,
  type AcceptedTaskReceipt,
} from '../src/contracts/research.js';
import { createScriptedStreamFn } from '../src/runtime/pi-adapter.js';
import { createResearcherAgent } from '../src/agents/researcher.js';
import { AUTHORITY_SYSTEM_PROMPT } from '../src/prompts/authority.js';

describe('Task 3: Independent Research Tools & Async Background Worker Engine', () => {
  let db: ResearchDatabase;
  let runRepo: RunRepository;
  let taskRepo: TaskRepository;
  let attemptRepo: TaskAttemptRepository;
  let resultRepo: TaskResultRepository;
  let outboxRepo: OutboxRepository;

  const testRunId = 'run-test-task3';

  beforeEach(() => {
    db = createDatabase(':memory:');
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    attemptRepo = new TaskAttemptRepository(db);
    resultRepo = new TaskResultRepository(db);
    outboxRepo = new OutboxRepository(db);

    runRepo.createRun({
      run_id: testRunId,
      topic: '某市强对流暴雨应急通报研判',
      scope: { region: '华东', time_window: '最近48小时' },
      status: 'active' as any,
      current_round: 1,
      max_rounds: 3,
      budget_total: 50,
      budget_used: 0,
      execution_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  describe('1. Research Role Tools & Immediate Receipts', () => {
    it('should validate parameters and return accepted TaskReceipt without blocking', async () => {
      let enqueuedParams: any = null;
      let enqueuedRole: any = null;

      const authorityTool = createResearchAuthorityTool(async (role: string, params: any) => {
        enqueuedRole = role;
        enqueuedParams = params;
        return {
          status: 'accepted',
          task_id: 'task-auth-001',
          attempt_id: 'attempt-001',
          role: 'authority',
          result_pending: true,
          message: 'Task accepted',
        };
      });

      assert.equal(authorityTool.name, 'research_authority');
      assert.ok(authorityTool.description.includes('权威口径'));

      // Call tool with valid parameters
      const validParams = {
        question: '核对官方通报原文与定调演化',
        scope: { region: '市区', time_window: '24h' },
        completion_criteria: '提取发文字号并比对前后通报定调',
        requested_budget_units: 12,
        required_for_report: true,
      };

      const result = (await authorityTool.execute(validParams)) as AcceptedTaskReceipt;

      assert.equal(result.status, 'accepted');
      assert.equal(result.task_id, 'task-auth-001');
      assert.equal(result.attempt_id, 'attempt-001');
      assert.equal(result.role, 'authority');
      assert.equal(result.result_pending, true);
      assert.equal(enqueuedRole, 'authority');
      assert.equal(enqueuedParams.question, validParams.question);
    });

    it('should reject invalid parameters with rejected receipt', async () => {
      const evolutionTool = createResearchEvolutionTool(async () => {
        throw new Error('Should not be called for invalid params');
      });

      // Missing required question and completion_criteria
      const invalidParams = {
        requested_budget_units: 5,
      };

      const receipt = (await evolutionTool.execute(invalidParams as any)) as any;
      assert.equal(receipt.status, 'rejected');
      assert.equal(receipt.result_pending, false);
      assert.ok(receipt.reason.includes('question'));
    });

    it('should write task and attempt into database transaction when connected with worker pool', async () => {
      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        streamFn: createScriptedStreamFn([{ text: 'Worker idle' }]),
      });

      const feedbackTool = createResearchFeedbackTool({
        db,
        run_id: testRunId,
        workerPool: pool,
      });

      assert.equal(feedbackTool.name, 'research_feedback');

      const receipt = (await feedbackTool.execute({
        question: '抽样网民评论并统计情绪诉求分布',
        completion_criteria: '样本量不少于100且标明分母说明',
        requested_budget_units: 10,
        required_for_report: true,
      })) as AcceptedTaskReceipt;

      assert.equal(receipt.status, 'accepted');
      assert.equal(receipt.role, 'feedback');
      assert.ok(receipt.task_id);
      assert.ok(receipt.attempt_id);

      // Verify task and attempt in DB
      const dbTask = taskRepo.getTask(receipt.task_id);
      assert.ok(dbTask);
      assert.equal(dbTask.run_id, testRunId);
      assert.equal(dbTask.role, 'feedback');
      assert.equal(dbTask.question, '抽样网民评论并统计情绪诉求分布');

      const dbAttempt = attemptRepo.getAttempt(receipt.attempt_id);
      assert.ok(dbAttempt);
      assert.equal(dbAttempt.task_id, receipt.task_id);
      assert.equal(dbAttempt.run_id, testRunId);

      await pool.waitForAll();
    });
  });

  describe('2. submit_findings Context Binding & Role Enforcement', () => {
    it('should accept submission when role and task_id match bound context', async () => {
      let savedFindings: any = null;

      const submitTool = createSubmitFindingsTool(
        async (findings: any, context?: any) => {
          savedFindings = { findings, context };
          return { ok: true, submissionId: 'sub-bound-01' };
        },
        {
          run_id: testRunId,
          task_id: 'task-auth-100',
          attempt_id: 'att-100',
          role: 'authority',
          execution_version: 1,
        }
      );

      const res: any = await submitTool.execute({
        findings: {
          role: 'authority',
          task_id: 'task-auth-100',
          round: 1,
          claims: [{ claim_id: 'C1', statement: '已启动应急响应', evidence_ids: ['E1'] }],
          evidence_pool: [{ evidence_id: 'E1', source_type: 'official', excerpt: '通报内容' }],
        },
      });

      assert.equal(res.status, 'success');
      assert.equal(res.submission_id, 'sub-bound-01');
      assert.equal(savedFindings.context.role, 'authority');
      assert.equal(savedFindings.context.task_id, 'task-auth-100');
    });

    it('should reject submission if role does not match bound role', async () => {
      const submitTool = createSubmitFindingsTool(
        async () => ({ ok: true, submissionId: 'sub-bound-02' }),
        {
          run_id: testRunId,
          task_id: 'task-auth-100',
          attempt_id: 'att-100',
          role: 'authority',
          execution_version: 1,
        }
      );

      await assert.rejects(
        async () => {
          await submitTool.execute({
            findings: {
              role: 'feedback', // mismatched role!
              round: 1,
              claims: [],
              evidence_pool: [],
            },
          });
        },
        /role mismatch/i
      );
    });

    it('should reject submission if task_id does not match bound task_id', async () => {
      const submitTool = createSubmitFindingsTool(
        async () => ({ ok: true, submissionId: 'sub-bound-03' }),
        {
          run_id: testRunId,
          task_id: 'task-auth-100',
          attempt_id: 'att-100',
          role: 'authority',
          execution_version: 1,
        }
      );

      await assert.rejects(
        async () => {
          await submitTool.execute({
            findings: {
              role: 'authority',
              task_id: 'different-task-id', // mismatched task_id!
              round: 1,
              claims: [],
              evidence_pool: [],
            },
          });
        },
        /task_id mismatch/i
      );
    });
  });

  describe('3. ResearchWorkerPool Execution & Isolated Error Handling', () => {
    it('should run task successfully: invoke agent, submit findings, persist result and outbox event', async () => {
      // Scripted agent steps: call submit_findings then finish
      const streamFn = createScriptedStreamFn([
        {
          toolCalls: [
            {
              name: 'submit_findings',
              arguments: {
                findings: {
                  role: 'authority',
                  round: 1,
                  claims: [
                    {
                      claim_id: 'C1',
                      statement: '通报已下发，无伤亡',
                      evidence_ids: ['E1'],
                    },
                  ],
                  evidence_pool: [
                    {
                      evidence_id: 'E1',
                      source_type: 'official_doc',
                      title: '暴雨通报',
                      excerpt: '全市无人员伤亡',
                    },
                  ],
                  authority_finding: {
                    entity_name: '市应急局',
                    source_type: '官方通报',
                    published_at: '2026-10-02T12:00:00Z',
                    raw_text: '全市无人员伤亡',
                    stance_evolution: '平稳',
                    covered_issues: ['伤亡'],
                    unaddressed_issues: [],
                  },
                },
              },
            },
          ],
        },
        {
          text: '权威口径调查完毕，成果已提交。',
        },
      ]);

      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        streamFn,
      });

      const receipt = await pool.enqueueTask(
        'authority',
        {
          question: '查证暴雨通报与伤亡情况',
          completion_criteria: '查验官方通报全文并提取定调',
          requested_budget_units: 8,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      assert.equal(receipt.status, 'accepted');
      assert.ok(receipt.task_id);

      // Wait for pool to process
      await pool.waitForAll();

      // Verify task result persisted
      const result = resultRepo.getLatestResult(testRunId, receipt.task_id);
      assert.ok(result);
      assert.equal(result.status, 'succeeded');
      assert.equal(result.role, 'authority');
      assert.ok(result.summary);

      // Verify attempt marked succeeded
      const attempt = attemptRepo.getAttempt(receipt.attempt_id);
      assert.ok(attempt);
      assert.equal(attempt.status, 'succeeded');
      assert.ok(attempt.completed_at);

      // Verify event outbox recorded research_outcome event
      const undelivered = outboxRepo.getUndeliveredEvents(testRunId);
      assert.ok(undelivered.length >= 1);
      const outcomeEvent = undelivered.find((e) => e.task_id === receipt.task_id);
      assert.ok(outcomeEvent);
      assert.equal(outcomeEvent.event_type, 'research_outcome');
      assert.equal((outcomeEvent.payload as any).outcome.status, 'succeeded');

      // Verify get_research_result tool
      const getResultTool = createGetResearchResultTool(resultRepo);
      const fetched: any = await getResultTool.execute({ task_id: receipt.task_id });
      assert.equal(fetched.found, true);
      assert.equal(fetched.result.task_id, receipt.task_id);
      assert.equal(fetched.result.status, 'succeeded');
    });

    it('should catch single worker exception and persist failed outcome without affecting peer workers', async () => {
      // Step functions:
      // Worker 1 (evolution): throws an error / fails
      // Worker 2 (feedback): succeeds normally
      let evolutionAttemptId = '';
      let feedbackAttemptId = '';

      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        agentFactory: (context: any) => {
          if (context.role === 'evolution') {
            evolutionAttemptId = context.attempt_id;
            return {
              run: async () => {
                throw new Error('Platform API connection failure');
              },
              abort: () => {},
              state: {} as any,
            };
          } else {
            feedbackAttemptId = context.attempt_id;
            return {
              run: async () => {
                // calls context.submitTool
                await context.submitTool.execute({
                  findings: {
                    role: 'feedback',
                    round: 1,
                    claims: [{ claim_id: 'C-FB', statement: '网民关注退票政策', evidence_ids: ['E-FB'] }],
                    evidence_pool: [{ evidence_id: 'E-FB', source_type: 'social', excerpt: '何时退票' }],
                  },
                });
                return { finalText: 'done', messages: [], events: [] };
              },
              abort: () => {},
              state: {} as any,
            };
          }
        },
      });

      const receiptEvo = await pool.enqueueTask(
        'evolution',
        {
          question: '分析热度演化趋势',
          completion_criteria: '提取热度曲线',
          requested_budget_units: 10,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      const receiptFeedback = await pool.enqueueTask(
        'feedback',
        {
          question: '分析公众情绪反馈',
          completion_criteria: '统计情绪诉求',
          requested_budget_units: 10,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      await pool.waitForAll();

      // Check failed task (evolution): caught by worker, saved as failed with error details
      const evoAttempt = attemptRepo.getAttempt(receiptEvo.attempt_id);
      assert.ok(evoAttempt);
      assert.equal(evoAttempt.status, 'failed');
      assert.ok(evoAttempt.error);
      assert.ok((evoAttempt.error as any).message.includes('Platform API connection failure'));

      const evoTask = taskRepo.getTask(receiptEvo.task_id);
      assert.equal(evoTask?.status, TaskStatus.Failed);

      // Check peer task (feedback): completed successfully despite evolution error!
      const fbAttempt = attemptRepo.getAttempt(receiptFeedback.attempt_id);
      assert.ok(fbAttempt);
      assert.equal(fbAttempt.status, 'succeeded');

      const fbResult = resultRepo.getLatestResult(testRunId, receiptFeedback.task_id);
      assert.ok(fbResult);
      assert.equal(fbResult.status, 'succeeded');

      // Both should have events in outbox: one failed, one succeeded
      const undelivered = outboxRepo.getUndeliveredEvents(testRunId);
      const evoEvent = undelivered.find((e) => e.task_id === receiptEvo.task_id);
      const fbEvent = undelivered.find((e) => e.task_id === receiptFeedback.task_id);
      assert.ok(evoEvent);
      assert.equal((evoEvent.payload as any).outcome.status, 'failed');
      assert.ok(fbEvent);
      assert.equal((fbEvent.payload as any).outcome.status, 'succeeded');
    });

    it('should support task cancellation via cancel_research_task without affecting peer tasks', async () => {
      let taskToCancelAborted = false;
      let siblingFinished = false;

      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        agentFactory: (context: any) => {
          if (context.role === 'evolution') {
            return {
              run: async () => {
                // Hanging task awaiting cancellation
                return new Promise((resolve, reject) => {
                  context.signal.addEventListener('abort', () => {
                    taskToCancelAborted = true;
                    reject(new Error('Task execution cancelled'));
                  });
                });
              },
              abort: () => {
                taskToCancelAborted = true;
              },
              state: {} as any,
            };
          } else {
            return {
              run: async () => {
                await new Promise((r) => setTimeout(r, 50));
                await context.submitTool.execute({
                  findings: {
                    role: 'authority',
                    round: 1,
                    claims: [],
                    evidence_pool: [],
                  },
                });
                siblingFinished = true;
                return { finalText: 'done', messages: [], events: [] };
              },
              abort: () => {},
              state: {} as any,
            };
          }
        },
      });

      const receiptEvo = await pool.enqueueTask(
        'evolution',
        {
          question: '长时间任务',
          completion_criteria: '测试取消',
          requested_budget_units: 10,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      const receiptAuth = await pool.enqueueTask(
        'authority',
        {
          question: '正常伴随任务',
          completion_criteria: '测试不受取消影响',
          requested_budget_units: 10,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      // Cancel evolution task using tool
      const cancelTool = createCancelResearchTaskTool(pool);
      const cancelRes: any = await cancelTool.execute({
        task_id: receiptEvo.task_id,
        reason: 'User requested cancellation',
      });

      assert.equal(cancelRes.status, 'cancelled');
      assert.equal(cancelRes.cancelled, true);

      await pool.waitForAll();

      assert.ok(taskToCancelAborted);
      assert.ok(siblingFinished);

      const evoAttempt = attemptRepo.getAttempt(receiptEvo.attempt_id);
      assert.equal(evoAttempt?.status, 'cancelled');

      const authAttempt = attemptRepo.getAttempt(receiptAuth.attempt_id);
      assert.equal(authAttempt?.status, 'succeeded');
    });
  });

  describe('4. Backward Compatibility with delegate_research', () => {
    it('should unpack task list into independent task receipts using pool or dispatcher', async () => {
      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        streamFn: createScriptedStreamFn([{ text: 'Done' }]),
      });

      const delegateTool = createDelegateResearchTool({
        db,
        run_id: testRunId,
        workerPool: pool,
      });

      const res: any = await delegateTool.execute({
        tasks: [
          {
            role: 'authority',
            question: '查证官方通报发文字号',
            budget_allocated: 12,
            completion_criteria: '获取完整通报原文',
          },
          {
            role: 'evolution',
            question: '提取社媒热度曲线',
            budget_allocated: 10,
            completion_criteria: '输出连续指标离散点',
          },
          {
            role: 'feedback',
            question: '抽样网民评论',
            budget_allocated: 12,
            completion_criteria: '样本量不少于100',
          },
        ],
      });

      assert.equal(res.status, 'dispatched');
      assert.equal(res.count, 3);
      assert.ok(Array.isArray(res.receipts));
      assert.equal(res.receipts.length, 3);
      assert.equal(res.receipts[0].role, 'authority');
      assert.equal(res.receipts[1].role, 'evolution');
      assert.equal(res.receipts[2].role, 'feedback');
      assert.equal(res.receipts[0].status, 'accepted');

      // Also retains task_handles for legacy compatibility
      assert.ok(Array.isArray(res.task_handles));
      assert.equal(res.task_handles.length, 3);

      await pool.waitForAll();
    });

    it('should maintain compatibility with legacy onDelegate callback signature', async () => {
      let capturedTasks: any[] = [];
      const delegateTool = createDelegateResearchTool(async (tasks) => {
        capturedTasks = tasks;
        return {
          ok: true,
          handles: tasks.map((t, idx) => ({
            taskId: `legacy-task-${idx}`,
            role: t.role,
            status: 'dispatched',
          })),
        };
      });

      const res: any = await delegateTool.execute({
        tasks: [
          {
            role: 'authority',
            question: '旧接口测试问题',
            budget_allocated: 8,
            completion_criteria: '测试完成条件',
          },
        ],
      });

      assert.equal(res.status, 'dispatched');
      assert.equal(capturedTasks.length, 1);
      assert.equal(res.task_handles[0].taskId, 'legacy-task-0');
      assert.ok(Array.isArray(res.receipts));
    });
  });

  describe('5. Robustness & Review Findings', () => {
    it('should mark cancelled (not partial) when agent run resolves normally upon abort', async () => {
      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        agentFactory: (context: any) => {
          return {
            run: async () => {
              // Wait until abort signal fires, then resolve normally (like Pi's waitForIdle)
              return new Promise<any>((resolve) => {
                context.signal.addEventListener('abort', () => {
                  resolve({ finalText: 'stopped', messages: [], events: [] });
                });
              });
            },
            abort: () => {},
            state: {} as any,
          };
        },
      });

      const receipt = await pool.enqueueTask(
        'authority',
        {
          question: '查证取消行为',
          completion_criteria: '测试取消不落入partial',
          requested_budget_units: 10,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      // Cancel the task while it is running
      pool.cancelTask(receipt.task_id, 'Manual cancellation');

      await pool.waitForAll();

      const attempt = attemptRepo.getAttempt(receipt.attempt_id);
      assert.ok(attempt);
      assert.equal(attempt.status, 'cancelled');

      const result = resultRepo.getLatestResult(testRunId, receipt.task_id);
      assert.ok(result);
      assert.equal(result.status, 'cancelled');
    });

    it('should prevent overwriting already submitted results when error occurs after submission', async () => {
      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
        agentFactory: (context: any) => {
          return {
            run: async () => {
              // 1. Successfully submit findings
              await context.submitTool.execute({
                findings: {
                  role: 'authority',
                  round: 1,
                  claims: [{ claim_id: 'C1', statement: '通报已核验', evidence_ids: ['E1'] }],
                  evidence_pool: [{ evidence_id: 'E1', source_type: 'official', excerpt: '通报内容' }],
                },
              });

              // 2. Throws an error after successful submission during teardown
              throw new Error('Teardown socket reset error after submit');
            },
            abort: () => {},
            state: {} as any,
          };
        },
      });

      const receipt = await pool.enqueueTask(
        'authority',
        {
          question: '测试提交后异常保护',
          completion_criteria: '成果不被篡改',
          requested_budget_units: 10,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      await pool.waitForAll();

      // Attempt and Result must remain 'succeeded' and NOT overwritten by 'failed'
      const attempt = attemptRepo.getAttempt(receipt.attempt_id);
      assert.ok(attempt);
      assert.equal(attempt.status, 'succeeded');

      const result = resultRepo.getLatestResult(testRunId, receipt.task_id);
      assert.ok(result);
      assert.equal(result.status, 'succeeded');
    });

    it('should track initial attempt status as queued and transition to running on start', async () => {
      let resolveStart: () => void = () => {};
      const startPromise = new Promise<void>((r) => {
        resolveStart = r;
      });

      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 1,
        agentFactory: (context: any) => {
          return {
            run: async () => {
              await startPromise;
              await context.submitTool.execute({
                findings: {
                  role: context.role,
                  round: 1,
                  claims: [],
                  evidence_pool: [],
                },
              });
              return { finalText: 'done', messages: [], events: [] };
            },
            abort: () => {},
            state: {} as any,
          };
        },
      });

      // Task 1: will run and hold the single slot
      const r1 = await pool.enqueueTask(
        'authority',
        {
          question: '槽位占有任务',
          completion_criteria: '占位',
          requested_budget_units: 5,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      // Task 2: will be queued because maxConcurrency is 1
      const r2 = await pool.enqueueTask(
        'evolution',
        {
          question: '排队等待任务',
          completion_criteria: '验证queued状态',
          requested_budget_units: 5,
          required_for_report: true,
          scope: {},
          dependencies: [],
        },
        { run_id: testRunId }
      );

      // Verify Task 2 attempt is initially 'queued' in DB
      const attempt2 = attemptRepo.getAttempt(r2.attempt_id);
      assert.ok(attempt2);
      assert.equal(attempt2.status, 'queued');

      // Release Task 1
      resolveStart();
      await pool.waitForAll();

      // After pool finishes, Task 2 attempt should have transitioned and succeeded
      const attempt2Done = attemptRepo.getAttempt(r2.attempt_id);
      assert.ok(attempt2Done);
      assert.equal(attempt2Done.status, 'succeeded');
    });

    it('should reject invalid role in enqueueTask', async () => {
      const pool = new ResearchWorkerPool({
        db,
        maxConcurrency: 3,
      });

      await assert.rejects(
        async () => {
          await pool.enqueueTask(
            'invalid_role' as any,
            {
              question: '非法角色测试',
              completion_criteria: '测试',
              requested_budget_units: 5,
              required_for_report: true,
              scope: {},
              dependencies: [],
            },
            { run_id: testRunId }
          );
        },
        /Invalid research role/i
      );
    });

    it('should throw immediately when ResearcherAgent.run is called with already aborted signal', async () => {
      const agent = createResearcherAgent({
        role: ResearchRole.Authority,
        systemPrompt: AUTHORITY_SYSTEM_PROMPT,
        tools: [],
        submitTool: {
          name: 'submit_findings',
          description: 'submit',
          parameters: {},
          execute: async () => ({ status: 'success' }),
        },
        streamFn: createScriptedStreamFn([{ text: 'hi' }]),
      });

      const controller = new AbortController();
      controller.abort(new Error('Pre-aborted signal'));

      await assert.rejects(
        async () => {
          await agent.run('test prompt', controller.signal);
        },
        /Pre-aborted signal|aborted/i
      );
    });
  });
});

