import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import {
  RunRepository,
  TaskRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
} from '../src/storage/repositories.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import {
  HostInboxDispatcher,
  formatHostPrompt,
  StageReviewManager,
  type HostPromptSnapshot,
} from '../src/orchestration/host-inbox.js';
import { createHostAgent } from '../src/agents/host.js';
import { createDelegateResearchTool } from '../src/tools/delegate-research.js';
import { createScriptedStreamFn, type PiAgentResult } from '../src/runtime/pi-adapter.js';
import {
  ResearchRole,
  RunStatus,
  TaskStatus,
} from '../src/contracts/research.js';
import { HOST_SYSTEM_PROMPT } from '../src/prompts/host.js';

describe('Task 5: HOST Serialized Inbox Dispatcher & Stage Review', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let runRepo: RunRepository;
  let taskRepo: TaskRepository;
  let outboxRepo: OutboxRepository;
  let hostInboxRepo: HostInboxRepository;
  let hostDecisionRepo: HostDecisionRepository;
  let budgetLedger: BudgetLedger;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    outboxRepo = new OutboxRepository(db);
    hostInboxRepo = new HostInboxRepository(db);
    hostDecisionRepo = new HostDecisionRepository(db);
    budgetLedger = new BudgetLedger(db, {
      totalToolLimit: 50,
      reservedForWriting: 10,
    });
  });

  const setupTestRun = (runId: string) => {
    runRepo.createRun({
      run_id: runId,
      topic: '测试某市暴雨应急响应舆情与处置成效',
      scope: {},
      status: RunStatus.Researching,
      current_round: 1,
      max_rounds: 3,
      budget_total: 50,
      budget_used: 0,
      execution_version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    taskRepo.createTask({
      task_id: `task-auth-${runId}`,
      run_id: runId,
      role: ResearchRole.Authority,
      round: 1,
      generation: 1,
      question: '调查官方通报与发布会通报演化',
      scope: {},
      completion_criteria: '获取完整通报原文并核对发文字号',
      required_for_report: true,
      status: TaskStatus.Running,
      budget_allocated: 12,
      created_at: new Date().toISOString(),
    });

    taskRepo.createTask({
      task_id: `task-evo-${runId}`,
      run_id: runId,
      role: ResearchRole.Evolution,
      round: 1,
      generation: 1,
      question: '提取发布前后社媒热度曲线与拐点',
      scope: {},
      completion_criteria: '输出含时间窗口的连续指标离散点',
      required_for_report: true,
      status: TaskStatus.Running,
      budget_allocated: 10,
      created_at: new Date().toISOString(),
    });

    taskRepo.createTask({
      task_id: `task-fb-${runId}`,
      run_id: runId,
      role: ResearchRole.Feedback,
      round: 1,
      generation: 1,
      question: '抽样网民评论并统计情绪诉求分布',
      scope: {},
      completion_criteria: '样本量不少于100且标明分母说明',
      required_for_report: true,
      status: TaskStatus.Running,
      budget_allocated: 12,
      created_at: new Date().toISOString(),
    });
  };

  describe('1. Debounce Window: Merge rapidly arriving outcomes into single HOST invocation', () => {
    it('should debounce outcomes arriving within 300ms and invoke hostAgent exactly once without concurrency', async () => {
      const runId = 'run-debounce-1';
      setupTestRun(runId);

      const receivedPrompts: string[] = [];
      let hostCallCount = 0;

      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([
          { text: '阶段审查完成：接受公众反馈与演化成果，继续等待权威通报结果。' },
        ]),
      });

      // Spy on hostAgent.run
      const origRun = hostAgent.run.bind(hostAgent);
      hostAgent.run = async (prompt: string) => {
        hostCallCount++;
        receivedPrompts.push(prompt);
        return origRun(prompt);
      };

      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        budgetLedger,
        debounceMs: 100, // 100ms debounce window for fast deterministic testing
      });

      // Rapidly emit 3 outcomes within 50ms (well under the debounce window)
      // Outcome 1
      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-fb-${runId}`,
        event_type: 'research_outcome',
        payload: {
          outcome: {
            task_id: `task-fb-${runId}`,
            role: 'feedback',
            status: 'succeeded',
            summary: '网民评论抽样完成，负面情绪占62%',
            claims: [{ claim_id: 'C-01', statement: '评论区存在对预警及时性的质疑' }],
            evidence_refs: ['E-FB-01', 'E-FB-02'],
          },
        },
      });

      await new Promise((r) => setTimeout(r, 20));

      // Outcome 2
      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-evo-${runId}`,
        event_type: 'research_outcome',
        payload: {
          outcome: {
            task_id: `task-evo-${runId}`,
            role: 'evolution',
            status: 'failed',
            summary: '数据源接口超时，重试已耗尽',
            error: { code: 'SOURCE_UNAVAILABLE', message: 'API rate limit exceeded' },
          },
        },
      });

      await new Promise((r) => setTimeout(r, 20));

      // Outcome 3
      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-auth-${runId}`,
        event_type: 'task_timeout',
        payload: {
          outcome: {
            task_id: `task-auth-${runId}`,
            role: 'authority',
            status: 'timed_out',
            summary: '任务超出截止时间',
          },
        },
      });

      // Before debounce window expires, hostCallCount must be 0
      assert.equal(hostCallCount, 0, 'Host should not be called before debounce window expires');

      // Wait for debounce window (100ms) + buffer
      await new Promise((r) => setTimeout(r, 160));

      // Host must have been called exactly ONCE
      assert.equal(hostCallCount, 1, 'Host must be invoked exactly once after debounce window');
      assert.equal(receivedPrompts.length, 1);

      // Prompt should combine all 3 events
      const prompt = receivedPrompts[0];
      assert.ok(prompt.includes('本次变化'), 'Prompt must contain 【本次变化】');
      assert.ok(prompt.includes('当前计划'), 'Prompt must contain 【当前计划】');
      assert.ok(prompt.includes('新成果'), 'Prompt must contain 【新成果】');
      assert.ok(prompt.includes('可用额度'), 'Prompt must contain 【可用额度】');
      assert.ok(prompt.includes('请决定'), 'Prompt must contain 【请决定】');

      assert.ok(prompt.includes('feedback') || prompt.includes('公众反馈'), 'Prompt must mention feedback');
      assert.ok(prompt.includes('evolution') || prompt.includes('演化'), 'Prompt must mention evolution');
      assert.ok(prompt.includes('authority') || prompt.includes('权威'), 'Prompt must mention authority');

      // Check SQLite host_inbox records: all pending records should be marked 'processed'
      const inboxRecords = hostInboxRepo.listByRun(runId);
      assert.equal(inboxRecords.length, 3);
      for (const rec of inboxRecords) {
        assert.equal(rec.status, 'processed', `Record ${rec.inbox_id} should be marked processed`);
      }

      dispatcher.destroy();
    });
  });

  describe('2. Serialized Execution Mutex: Queue new results while HOST is running', () => {
    it('should queue results arriving during active host run and execute next turn serially with max concurrency 1', async () => {
      const runId = 'run-mutex-1';
      setupTestRun(runId);

      let concurrentCount = 0;
      let maxConcurrent = 0;
      let totalInvocations = 0;
      const invocationPrompts: string[] = [];

      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([
          { text: '第一阶段决策：接受 feedback' },
          { text: '第二阶段决策：处理 evolution 补查' },
        ]),
      });

      // Wrap hostAgent.run with simulated 120ms latency to test concurrency mutex
      hostAgent.run = async (prompt: string): Promise<PiAgentResult> => {
        concurrentCount++;
        if (concurrentCount > maxConcurrent) {
          maxConcurrent = concurrentCount;
        }
        totalInvocations++;
        invocationPrompts.push(prompt);

        // Simulate 120ms thinking time
        await new Promise((r) => setTimeout(r, 120));

        concurrentCount--;
        return {
          finalText: `Host decision completed for turn ${totalInvocations}`,
          messages: [],
          events: [],
        };
      };

      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        budgetLedger,
        debounceMs: 30, // short debounce for quick transition
      });

      // Trigger event 1 -> starts Turn 1 after 30ms
      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-fb-${runId}`,
        event_type: 'research_outcome',
        payload: {
          outcome: {
            task_id: `task-fb-${runId}`,
            role: 'feedback',
            status: 'succeeded',
            summary: '网民抽样初步完成',
          },
        },
      });

      // Wait 50ms so Turn 1 has started executing
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(dispatcher.isActive(runId), true, 'Host invocation should be active');
      assert.equal(concurrentCount, 1);

      // Now enqueue Event 2 WHILE Turn 1 is active
      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-evo-${runId}`,
        event_type: 'research_outcome',
        payload: {
          outcome: {
            task_id: `task-evo-${runId}`,
            role: 'evolution',
            status: 'succeeded',
            summary: '热度拐点已计算完成',
          },
        },
      });

      // Wait for Turn 1 to complete (started at 30ms, runs for 120ms => ends around 150ms)
      // and Turn 2 to complete (runs for another 120ms => ends around 300ms)
      await new Promise((r) => setTimeout(r, 260));

      // Max concurrent active HOST calls must NEVER exceed 1
      assert.equal(maxConcurrent, 1, 'HOST invocation mutex violated: max concurrent was > 1');
      assert.equal(totalInvocations, 2, 'Both turns should have executed sequentially');

      // Invocations: turn 1 handled feedback, turn 2 handled evolution
      assert.ok(invocationPrompts[0].includes('feedback') || invocationPrompts[0].includes('公众反馈'));
      assert.ok(invocationPrompts[1].includes('evolution') || invocationPrompts[1].includes('演化'));

      dispatcher.destroy();
    });
  });

  describe('3. Prompt Structure & System Prompt Immutability', () => {
    it('should format host prompt with all required structured data blocks without mutating system prompt', async () => {
      const runId = 'run-prompt-1';
      setupTestRun(runId);

      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        systemPrompt: HOST_SYSTEM_PROMPT,
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([{ text: '决定：继续等待' }]),
      });

      const originalSystemPrompt = hostAgent.options.systemPrompt;
      assert.ok(originalSystemPrompt);

      const snapshot: HostPromptSnapshot = {
        tasks: [
          {
            task_id: `task-auth-${runId}`,
            role: 'authority',
            status: 'running',
            completion_criteria: '获取完整通报原文并核对发文字号',
            required_for_report: true,
          },
          {
            task_id: `task-evo-${runId}`,
            role: 'evolution',
            status: 'failed',
            completion_criteria: '输出含时间窗口的连续指标离散点',
            required_for_report: true,
          },
          {
            task_id: `task-fb-${runId}`,
            role: 'feedback',
            status: 'succeeded',
            completion_criteria: '样本量不少于100且标明分母说明',
            required_for_report: true,
          },
        ],
        outcomes: [
          {
            task_id: `task-fb-${runId}`,
            role: 'feedback',
            status: 'succeeded',
            summary: '公众情绪以担忧(58%)与关切(32%)为主',
            claims: [
              { claim_id: 'CLM-01', statement: '城区低洼路段积水消退时间引起较多网民关注' },
            ],
            evidence_refs: ['E-FB-01', 'E-FB-02'],
            limitations: '抽样样本覆盖微博与抖音平台，未包含长视频评论',
          },
          {
            task_id: `task-evo-${runId}`,
            role: 'evolution',
            status: 'failed',
            error: { code: 'SCRAPER_TIMEOUT', message: '热度数据源连接中断' },
          },
        ],
        budget: {
          global_remaining: 38,
          global_total: 50,
          tasks_remaining: {
            [`task-auth-${runId}`]: 12,
            [`task-evo-${runId}`]: 8,
            [`task-fb-${runId}`]: 5,
          },
        },
        turn_number: 1,
        max_turns: 12,
      };

      const pendingEvents = [
        {
          inbox_id: 1,
          run_id: runId,
          event_type: 'research_outcome',
          payload: { outcome: snapshot.outcomes![0] },
        },
      ];

      const formatted = formatHostPrompt(runId, pendingEvents, snapshot);

      // Verify all five structured sections
      assert.ok(formatted.includes('【本次变化】'), 'Missing 【本次变化】 section');
      assert.ok(formatted.includes('【当前计划】'), 'Missing 【当前计划】 section');
      assert.ok(formatted.includes('【新成果】'), 'Missing 【新成果】 section');
      assert.ok(formatted.includes('【可用额度】'), 'Missing 【可用额度】 section');
      assert.ok(formatted.includes('【请决定】'), 'Missing 【请决定】 section');

      // Verify specific details
      assert.ok(formatted.includes('task-auth-'), 'Must include auth task');
      assert.ok(formatted.includes('task-evo-'), 'Must include evo task');
      assert.ok(formatted.includes('task-fb-'), 'Must include fb task');
      assert.ok(formatted.includes('CLM-01'), 'Must include claim CLM-01');
      assert.ok(formatted.includes('E-FB-01'), 'Must include evidence E-FB-01');
      assert.ok(formatted.includes('抽样样本覆盖微博与抖音平台'), 'Must include sample limitations');
      assert.ok(formatted.includes('38'), 'Must include global remaining balance 38');
      assert.ok(formatted.includes('accept') || formatted.includes('接受'), 'Must offer accept option');
      assert.ok(formatted.includes('follow-up') || formatted.includes('补查'), 'Must offer follow-up option');
      assert.ok(formatted.includes('wait') || formatted.includes('等待'), 'Must offer wait option');
      assert.ok(formatted.includes('release') || formatted.includes('放行'), 'Must offer release option');

      // Dispatch through dispatcher and ensure systemPrompt is NOT mutated
      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        budgetLedger,
        debounceMs: 20,
      });

      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-fb-${runId}`,
        event_type: 'research_outcome',
        payload: { outcome: snapshot.outcomes![0] },
      });

      await new Promise((r) => setTimeout(r, 60));

      // Crucial verification: systemPrompt remains completely untouched
      assert.equal(
        hostAgent.options.systemPrompt,
        originalSystemPrompt,
        'Base system prompt MUST NOT be modified by dynamic prompt data'
      );

      dispatcher.destroy();
    });
  });

  describe('4. Decision Cap (Max 12 turns per Run): Prevent runaway loops', () => {
    it('should pause run and halt dispatcher when decision cap of 12 is reached', async () => {
      const runId = 'run-cap-12';
      setupTestRun(runId);

      let hostInvocations = 0;
      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([{ text: '审议通过' }]),
      });

      hostAgent.run = async (): Promise<PiAgentResult> => {
        hostInvocations++;
        return {
          finalText: `Turn ${hostInvocations} decision: wait`,
          messages: [],
          events: [],
        };
      };

      const stageReviewMgr = new StageReviewManager(db, runRepo, taskRepo, hostDecisionRepo);

      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        budgetLedger,
        stageReviewManager: stageReviewMgr,
        debounceMs: 10,
        maxDecisionsPerRun: 12, // default 12 cap
      });

      // Fire 12 turns sequentially
      for (let turn = 1; turn <= 12; turn++) {
        dispatcher.enqueueEvent({
          run_id: runId,
          task_id: `task-auth-${runId}`,
          event_type: 'research_outcome',
          payload: { outcome: { task_id: `task-auth-${runId}`, turn, status: 'succeeded' } },
        });

        await new Promise((r) => setTimeout(r, 25));
      }

      assert.equal(hostInvocations, 12, 'Host should have executed exactly 12 turns');
      assert.equal(stageReviewMgr.getDecisionCount(runId), 12);

      // Now enqueue the 13th event
      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-auth-${runId}`,
        event_type: 'research_outcome',
        payload: { outcome: { task_id: `task-auth-${runId}`, turn: 13, status: 'succeeded' } },
      });

      await new Promise((r) => setTimeout(r, 35));

      // Host must NOT be invoked again
      assert.equal(hostInvocations, 12, 'Host must NOT be invoked after reaching cap of 12');

      // Run status should automatically transition to Paused to prevent spinning
      const run = runRepo.getRun(runId);
      assert.ok(run);
      assert.equal(run.status, RunStatus.Paused, 'Run must transition to Paused when decision cap is reached');

      dispatcher.destroy();
    });

    it('should support configurable decision cap (e.g. 3 turns for constrained runs)', async () => {
      const runId = 'run-cap-3';
      setupTestRun(runId);

      let hostInvocations = 0;
      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([{ text: '决策' }]),
      });

      hostAgent.run = async (): Promise<PiAgentResult> => {
        hostInvocations++;
        return { finalText: '决策完成', messages: [], events: [] };
      };

      const stageReviewMgr = new StageReviewManager(db, runRepo, taskRepo, hostDecisionRepo);

      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        stageReviewManager: stageReviewMgr,
        debounceMs: 10,
        maxDecisionsPerRun: 3,
      });

      // Send 5 events
      for (let i = 1; i <= 5; i++) {
        dispatcher.enqueueEvent({
          run_id: runId,
          task_id: `task-evo-${runId}`,
          event_type: 'research_outcome',
          payload: { outcome: { task_id: `task-evo-${runId}`, i } },
        });
        await new Promise((r) => setTimeout(r, 25));
      }

      // Should stop at 3
      assert.equal(hostInvocations, 3);
      assert.equal(stageReviewMgr.getDecisionCount(runId), 3);

      const run = runRepo.getRun(runId);
      assert.equal(run?.status, RunStatus.Paused);

      dispatcher.destroy();
    });
  });

  describe('5. Persistence to host_decisions & StageReviewManager Decisions', () => {
    it('should record decision snapshots into host_decisions SQLite table and update event status', async () => {
      const runId = 'run-persist-1';
      setupTestRun(runId);

      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([{ text: '接受反馈成果' }]),
      });

      hostAgent.run = async (): Promise<PiAgentResult> => ({
        finalText: '决定：accept 接受成果并记录',
        messages: [],
        events: [],
      });

      const stageReviewMgr = new StageReviewManager(db, runRepo, taskRepo, hostDecisionRepo);
      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        stageReviewManager: stageReviewMgr,
        debounceMs: 15,
      });

      dispatcher.enqueueEvent({
        run_id: runId,
        task_id: `task-fb-${runId}`,
        event_type: 'research_outcome',
        payload: {
          outcome: {
            task_id: `task-fb-${runId}`,
            role: 'feedback',
            status: 'succeeded',
            summary: '公众情绪调研',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 45));

      // Verify host_decisions in SQLite
      const decisions = hostDecisionRepo.listDecisions(runId);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0].run_id, runId);
      assert.equal(decisions[0].turn_number, 1);
      assert.equal(decisions[0].decision_type, 'accept');
      assert.ok(decisions[0].decision_id.startsWith('hdec-'));

      // Check inbox event marked processed
      const inboxList = hostInboxRepo.listByRun(runId);
      assert.equal(inboxList.length, 1);
      assert.equal(inboxList[0].status, 'processed');
      assert.ok(inboxList[0].processed_at);

      dispatcher.destroy();
    });
  });

  describe('6. Multi-Run Isolation & Error Resiliency', () => {
    it('should isolate dispatchers across different runs and release mutex on error', async () => {
      const runA = 'run-iso-A';
      const runB = 'run-iso-B';
      setupTestRun(runA);
      setupTestRun(runB);

      const dummyDelegate = createDelegateResearchTool(async () => ({ ok: true, handles: [] }));
      const hostAgent = createHostAgent({
        delegateTool: dummyDelegate,
        streamFn: createScriptedStreamFn([{ text: 'OK' }]),
      });

      let failRunAOnce = true;
      let runACalls = 0;
      let runBCalls = 0;

      hostAgent.run = async (prompt: string): Promise<PiAgentResult> => {
        if (prompt.includes(runA)) {
          runACalls++;
          if (failRunAOnce) {
            failRunAOnce = false;
            throw new Error('Simulated transient LLM failure for Run A');
          }
        } else if (prompt.includes(runB)) {
          runBCalls++;
        }
        return { finalText: 'Success', messages: [], events: [] };
      };

      const dispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        debounceMs: 20,
      });

      // Dispatch event to Run A (will fail first time)
      dispatcher.enqueueEvent({
        run_id: runA,
        task_id: `task-auth-${runA}`,
        event_type: 'research_outcome',
        payload: { outcome: { task_id: `task-auth-${runA}` } },
      });

      // Dispatch event to Run B (should succeed independently)
      dispatcher.enqueueEvent({
        run_id: runB,
        task_id: `task-auth-${runB}`,
        event_type: 'research_outcome',
        payload: { outcome: { task_id: `task-auth-${runB}` } },
      });

      await new Promise((r) => setTimeout(r, 60));

      assert.equal(runBCalls, 1, 'Run B should succeed unaffected by Run A error');
      assert.equal(runACalls, 1, 'Run A was called once and threw error');
      assert.equal(dispatcher.isActive(runA), false, 'Run A mutex must be released despite error');

      // Now enqueue a second event for Run A - mutex was released, so it should run normally
      dispatcher.enqueueEvent({
        run_id: runA,
        task_id: `task-auth-${runA}`,
        event_type: 'research_outcome',
        payload: { outcome: { task_id: `task-auth-${runA}`, attempt: 2 } },
      });

      await new Promise((r) => setTimeout(r, 60));
      assert.equal(runACalls, 2, 'Run A can execute subsequent turn after error recovery');

      dispatcher.destroy();
    });
  });
});
