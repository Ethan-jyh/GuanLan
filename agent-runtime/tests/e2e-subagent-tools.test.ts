import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { createRuntimeServer } from '../src/server.js';
import { ResearchCoordinator } from '../src/orchestration/coordinator.js';
import {
  RunRepository,
  TaskRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
  MaterialSnapshotRepository,
} from '../src/storage/repositories.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { EventStore } from '../src/storage/event-store.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import { ResearchWorkerPool } from '../src/orchestration/research-worker.js';
import { HostInboxDispatcher, StageDecisionType, formatHostPrompt } from '../src/orchestration/host-inbox.js';
import { ReleaseGate } from '../src/orchestration/release-gate.js';
import { createHostAgent } from '../src/agents/host.js';
import { createReportAgent, createSubmitJudgmentTool } from '../src/agents/report.js';
import {
  createResearchAuthorityTool,
  createResearchEvolutionTool,
  createResearchFeedbackTool,
  createGetResearchResultTool,
  createCancelResearchTaskTool,
  runExecutionContext,
} from '../src/tools/research-tools.js';
import { createDelegateResearchTool } from '../src/tools/delegate-research.js';
import { createScriptedStreamFn } from '../src/runtime/pi-adapter.js';
import {
  ResearchRole,
  RunStatus,
  TaskStatus,
  type Claim,
  type Evidence,
  type ReportJudgment,
} from '../src/contracts/research.js';

describe('Task 7: E2E Subagent Tools, Host Inbox & Release Gate Assembly', () => {
  let serverHandle: {
    server: any;
    listen: (p?: number) => Promise<void>;
    close: () => Promise<void>;
  };
  let baseUrl: string;

  beforeEach(async () => {
    // Basic test server
    serverHandle = createRuntimeServer({ port: 0, dbPath: ':memory:' });
    await serverHandle.listen(0);
    const addr = serverHandle.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 4055;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.close();
    }
  });

  describe('1. API Run Creation in Async Mode', () => {
    it('creates run without auto-creating 3 fixed tasks when mode is async', async () => {
      const resp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: '某省突发山洪灾害救援态势分析',
          mode: 'async',
          budget_total: 60,
          scope: { region: '涉事山区', not_applicable_roles: ['evolution', 'feedback'] },
        }),
      });

      assert.equal(resp.status, 201);
      const data = (await resp.json()) as any;
      assert.equal(data.ok, true);
      assert.ok(data.run.run_id);
      assert.equal(data.run.status, RunStatus.Researching);

      // Verify NO 3 fixed tasks were pre-created
      const getResp = await fetch(`${baseUrl}/api/research/runs/${data.run.run_id}`);
      assert.equal(getResp.status, 200);
      const detail = (await getResp.json()) as any;
      assert.equal(detail.ok, true);
      assert.equal(detail.tasks.length, 0, 'New async mode must not pre-populate tasks');
    });
  });

  describe('2. End-to-End Orchestration Loop with Simulated Host, Worker & Release Gate', () => {
    it('executes full cycle: HOST plans -> Worker runs in background -> Outbox/Inbox triggers HOST -> ReleaseGate passes -> ReportAgent generates report', async () => {
      const rawDb = new DatabaseSync(':memory:');
      const db = createDatabase(rawDb);

      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const attemptRepo = new TaskAttemptRepository(db);
      const resultRepo = new TaskResultRepository(db);
      const outboxRepo = new OutboxRepository(db);
      const inboxRepo = new HostInboxRepository(db);
      const decisionRepo = new HostDecisionRepository(db);
      const snapshotRepo = new MaterialSnapshotRepository(db);
      const evidenceStore = new EvidenceStore(db);
      const eventStore = new EventStore(db);
      const budgetLedger = new BudgetLedger(db, { totalToolLimit: 60, reservedForWriting: 10 });

      let hostTurn = 0;
      let lastReportJudgment: ReportJudgment | null = null;

      // 1. Worker StreamFn: calls submit_findings with verifiable claims and evidence
      const workerStreamFn = createScriptedStreamFn([
        {
          toolCalls: [
            {
              name: 'submit_findings',
              arguments: {
                findings: {
                  role: 'authority',
                  round: 1,
                  summary: '官方通报查证完成：防汛抗旱指挥部于08:30发布一级响应通报',
                  authority_finding: {
                    raw_text: '防汛抗旱指挥部通告发文字号[2026]12号',
                    issuing_authority: '省防汛抗旱指挥部',
                  },
                  claims: [
                    {
                      claim_id: 'claim-auth-01',
                      statement: '省防指于08:30启动一级防汛应急响应',
                      evidence_ids: ['ev-doc-01'],
                      confidence: 0.95,
                      dimension: 'official',
                    },
                  ],
                  evidence_pool: [
                    {
                      evidence_id: 'ev-doc-01',
                      source_ref: 'http://gov.example.com/bulletin/12',
                      content: '省防汛抗旱指挥部关于启动防汛一级应急响应的通报',
                      reliability: 0.98,
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          text: '权威核查完成，成果已提交。',
        },
      ]);

      const workerPool = new ResearchWorkerPool({
        db,
        streamFn: workerStreamFn,
        evidenceStore,
      });

      // 2. Host StreamFn:
      // Turn 1: Calls research_authority
      // Turn 2: Upon receiving worker outcome from inbox, decides request_release
      const hostStreamStep1 = createScriptedStreamFn([
        {
          toolCalls: [
            {
              name: 'research_authority',
              arguments: {
                question: '查证防汛应急响应通报的发文时间与字号',
                completion_criteria: '获取完整通报原文并核对发文字号',
                requested_budget_units: 12,
                required_for_report: true,
              },
            },
          ],
        },
        {
          text: '已派发权威口径核查作业，等待结果。',
        },
      ]);

      const hostStreamStep2 = createScriptedStreamFn([
        {
          text: '经审查，权威口径证据确凿，evolution与feedback已豁免不适用，申请专报放行 [REQUEST_RELEASE] not_applicable: evolution, feedback',
        },
      ]);

      const hostStreamFn = (model: any, ctx: any, opt: any) => {
        hostTurn++;
        if (hostTurn === 1) {
          return hostStreamStep1(model, ctx, opt);
        } else {
          return hostStreamStep2(model, ctx, opt);
        }
      };

      const authorityTool = createResearchAuthorityTool({ workerPool, db });
      const evolutionTool = createResearchEvolutionTool({ workerPool, db });
      const feedbackTool = createResearchFeedbackTool({ workerPool, db });
      const getResultTool = createGetResearchResultTool(db);
      const cancelTool = createCancelResearchTaskTool(workerPool);
      const delegateTool = createDelegateResearchTool({ workerPool, db });

      const hostAgent = createHostAgent({
        streamFn: hostStreamFn as any,
        delegateTool,
        additionalTools: [authorityTool, evolutionTool, feedbackTool, getResultTool, cancelTool],
      });

      const hostInboxDispatcher = new HostInboxDispatcher({
        db,
        hostAgent,
        budgetLedger,
        debounceMs: 50,
      });

      // Connect worker pool outcome -> notify host inbox dispatcher
      workerPool.onOutcome = async (outcome) => {
        hostInboxDispatcher.notifyOutbox(outcome.run_id);
      };

      const releaseGate = new ReleaseGate({
        db,
        taskRepo,
        resultRepo,
        evidenceStore,
        runRepo,
        outboxRepo,
        inboxRepo,
        snapshotRepo,
      });

      const submitJudgmentTool = createSubmitJudgmentTool(async (judgment) => {
        lastReportJudgment = judgment;
        return { ok: true };
      });

      const reportStreamFn = createScriptedStreamFn([
        {
          toolCalls: [
            {
              name: 'submit_judgment',
              arguments: {
                judgment: {
                  overall_interpretation: '本次暴雨灾害应急响应及时，官方权威发布明确可靠。',
                  risks: ['次生滑坡地质灾害隐患'],
                  recommendations: ['加强低洼地区人员疏散巡查'],
                  linked_claim_ids: ['claim-auth-01'],
                  linked_evidence_ids: ['ev-doc-01'],
                  applicability_conditions: ['仅限首轮通报公布后24小时内适用'],
                },
              },
            },
          ],
        },
        {
          text: '研判专报发布完毕。',
        },
      ]);

      const reportAgent = createReportAgent({
        streamFn: reportStreamFn,
        submitJudgmentTool,
      });

      const coordinator = new ResearchCoordinator(
        runRepo,
        taskRepo,
        undefined as any,
        eventStore,
        {
          workerPool,
          hostInboxDispatcher,
          releaseGate,
          hostAgent,
          reportAgent,
          db,
        }
      );

      // 1. Create Run in async mode
      const run = coordinator.createRun(
        '突发汛情态势研判',
        { not_applicable_roles: ['evolution', 'feedback'] },
        undefined,
        60,
        { autoCreateTasks: false }
      );

      assert.equal(run.status, RunStatus.Researching);
      assert.equal(coordinator.getTasksForRound(run.run_id, 1).length, 0);

      // 2. Start Run: prompts HOST to plan
      await coordinator.startRun(run.run_id);

      // HOST Turn 1 executed research_authority tool
      const tasks = taskRepo.listTasks(run.run_id);
      assert.equal(tasks.length, 1, 'HOST should have dispatched 1 authority task');
      assert.equal(tasks[0].role, 'authority');

      // 3. Wait for background worker pool to finish the task
      await workerPool.waitForAll();

      // Check task succeeded
      const updatedTask = taskRepo.getTask(tasks[0].task_id);
      assert.ok(updatedTask);
      assert.equal(updatedTask.status, TaskStatus.Succeeded);

      // Check outbox has research_outcome event
      const undelivered = outboxRepo.getEventsAfter(0, run.run_id);
      const outcomeEvent = undelivered.find((e) => e.event_type === 'research_outcome');
      assert.ok(outcomeEvent, 'Outbox must contain research_outcome event');

      // 4. Trigger / wait for HostInboxDispatcher to process outcome and call HOST Turn 2
      await hostInboxDispatcher.triggerDispatch(run.run_id);

      // HOST Turn 2 should have made decision: request_release
      const decisions = decisionRepo.listDecisions(run.run_id);
      assert.ok(decisions.length >= 1);
      const lastDecision = decisions[decisions.length - 1];
      assert.equal(lastDecision.decision_type, StageDecisionType.RequestRelease);

      // 5. Trigger release gate and generate final report
      const releaseResult = await coordinator.requestRelease(run.run_id);
      assert.equal(releaseResult.ok, true, `Release gate should pass: ${releaseResult.reason || ''}`);
      assert.ok(releaseResult.snapshotId);
      assert.ok(lastReportJudgment, 'ReportAgent should have submitted final judgment');
      assert.equal((lastReportJudgment as ReportJudgment).linked_claim_ids[0], 'claim-auth-01');

      // Verify run status transitioned to Completed
      const finalizedRun = coordinator.getRun(run.run_id);
      assert.equal(finalizedRun?.status, RunStatus.Completed);
    });
  });

  describe('3. SSE Event Streaming & Task Transition Broadcasts', () => {
    it('broadcasts queued -> running -> succeeded transitions and host decisions', async () => {
      const rawDb = new DatabaseSync(':memory:');
      const db = createDatabase(rawDb);
      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const eventStore = new EventStore(db);

      const eventsReceived: Array<{ event: string; data: any }> = [];

      // Wire SseManager with event store
      const { SseManager } = await import('../src/api/sse.js');
      const sseManager = new SseManager(eventStore);

      // Mock SSE client
      const fakeRes: any = {
        writeHead: () => {},
        write: (chunk: string) => {
          const matchEvent = chunk.match(/event: (.*)\n/);
          const matchData = chunk.match(/data: (.*)\n\n/);
          if (matchEvent && matchData) {
            eventsReceived.push({
              event: matchEvent[1],
              data: JSON.parse(matchData[1]),
            });
          }
        },
        on: () => {},
      };

      const testRunId = 'run-sse-test-1';
      sseManager.handleSseConnection(testRunId, fakeRes, 0);

      // Broadcast task transitions
      sseManager.broadcastTaskTransition(testRunId, {
        task_id: 'task-auth-01',
        role: 'authority',
        from: 'pending',
        to: 'queued',
      });

      sseManager.broadcastTaskTransition(testRunId, {
        task_id: 'task-auth-01',
        role: 'authority',
        from: 'queued',
        to: 'running',
      });

      sseManager.broadcastTaskTransition(testRunId, {
        task_id: 'task-auth-01',
        role: 'authority',
        from: 'running',
        to: 'succeeded',
        payload: { summary: 'Done' },
      });

      sseManager.broadcastHostDecision(testRunId, {
        decision_id: 1,
        run_id: testRunId,
        turn_number: 1,
        decision_type: 'request_release',
        rationale: 'All checks passed',
        created_at: new Date().toISOString(),
      });

      assert.equal(eventsReceived.length, 4);
      assert.equal(eventsReceived[0].event, 'task_transition');
      assert.equal(eventsReceived[0].data.to, 'queued');
      assert.equal(eventsReceived[1].event, 'task_transition');
      assert.equal(eventsReceived[1].data.to, 'running');
      assert.equal(eventsReceived[2].event, 'task_transition');
      assert.equal(eventsReceived[2].data.to, 'succeeded');
      assert.equal(eventsReceived[3].event, 'host_decision');
      assert.equal(eventsReceived[3].data.decision_type, 'request_release');

      sseManager.close();
    });
  });

  describe('4. Extended REST API Endpoints', () => {
    it('supports querying tasks, outbox, inbox, cancelling a task, and triggering release', async () => {
      // 1. Create run
      const createResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: 'API扩展端点测试',
          mode: 'async',
        }),
      });
      assert.equal(createResp.status, 201);
      const runId = ((await createResp.json()) as any).run.run_id;

      // 2. Query tasks: GET /api/research/runs/:id/tasks
      const tasksResp = await fetch(`${baseUrl}/api/research/runs/${runId}/tasks`);
      assert.equal(tasksResp.status, 200);
      const tasksData = (await tasksResp.json()) as any;
      assert.equal(tasksData.ok, true);
      assert.ok(Array.isArray(tasksData.tasks));

      // 3. Query outbox: GET /api/research/runs/:id/outbox
      const outboxResp = await fetch(`${baseUrl}/api/research/runs/${runId}/outbox`);
      assert.equal(outboxResp.status, 200);
      const outboxData = (await outboxResp.json()) as any;
      assert.equal(outboxData.ok, true);
      assert.ok(Array.isArray(outboxData.events));

      // 4. Query inbox: GET /api/research/runs/:id/inbox
      const inboxResp = await fetch(`${baseUrl}/api/research/runs/${runId}/inbox`);
      assert.equal(inboxResp.status, 200);
      const inboxData = (await inboxResp.json()) as any;
      assert.equal(inboxData.ok, true);
      assert.ok(Array.isArray(inboxData.records));

      // 5. Trigger release: POST /api/research/runs/:id/release
      const releaseResp = await fetch(`${baseUrl}/api/research/runs/${runId}/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rationale: 'Manual release request' }),
      });
      // Might be 200 or 400 depending on gate checks, but endpoint must respond with structured JSON
      assert.ok(releaseResp.status === 200 || releaseResp.status === 400);
      const releaseData = (await releaseResp.json()) as any;
      assert.ok('ok' in releaseData);
    });
  });

  describe('5. Coordinator Recovery & Startup Recovery', () => {
    it('recovers interrupted running attempts, unpauses outbox and host inbox', async () => {
      const rawDb = new DatabaseSync(':memory:');
      const db = createDatabase(rawDb);
      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const attemptRepo = new TaskAttemptRepository(db);
      const outboxRepo = new OutboxRepository(db);
      const inboxRepo = new HostInboxRepository(db);

      const runId = 'run-recovery-test';
      runRepo.createRun({
        run_id: runId,
        topic: '崩溃恢复测试',
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
        task_id: 'task-crash-1',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: '崩溃前未结任务',
        scope: {},
        completion_criteria: '查证崩溃前未结状态',
        required_for_report: true,
        budget_allocated: 10,
        status: TaskStatus.Running,
        created_at: new Date().toISOString(),
      });

      attemptRepo.createAttempt({
        attempt_id: 'attempt-crash-1',
        task_id: 'task-crash-1',
        run_id: runId,
        execution_version: 1,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // Append undelivered outbox event
      outboxRepo.appendEvent({
        run_id: runId,
        task_id: 'task-crash-1',
        event_type: 'research_outcome',
        payload: { summary: 'Simulated pending outcome' },
      });

      const coordinator = new ResearchCoordinator(
        runRepo,
        taskRepo,
        undefined as any,
        undefined,
        { db }
      );

      const recoveryReport = coordinator.recoverOnStartup();
      assert.ok(recoveryReport.interruptedAttempts >= 1, 'Should find and fail interrupted running attempts');

      // Interrupted attempt should now be failed or timed_out
      const attempt = attemptRepo.getAttempt('attempt-crash-1');
      assert.ok(attempt?.status === 'failed' || attempt?.status === 'timed_out');

      // Resume run
      const resumed = coordinator.resumeRun(runId);
      assert.equal(resumed.execution_version, 2);
    });

    it('should display topic, scope, and tool dispatch guidance in formatHostPrompt when no tasks exist', () => {
      const runId = 'run-prompt-test';
      const prompt = formatHostPrompt(
        runId,
        [
          {
            run_id: runId,
            event_type: 'run_started',
            payload: {
              topic: '大模型生成内容知识产权归属争议',
              scope: { jurisdiction: 'CN', year: 2026 },
              prompt: '聚焦司法判例与行政监管定调',
            },
          },
        ],
        {
          tasks: [],
          budget: { global_remaining: 50, global_total: 50 },
        }
      );

      assert.ok(prompt.includes('【研判主题与背景】'), 'Must contain topic section');
      assert.ok(prompt.includes('大模型生成内容知识产权归属争议'), 'Must contain topic title');
      assert.ok(prompt.includes('CN'), 'Must contain scope content');
      assert.ok(prompt.includes('聚焦司法判例与行政监管定调'), 'Must contain guidance prompt');
      assert.ok(prompt.includes('尚未创建任何研究任务'), 'Must indicate no tasks yet');
      assert.ok(prompt.includes('research_authority'), 'Must instruct using research tools');
      assert.ok(prompt.includes('【当前计划】\n（尚未创建任何研究任务'), 'Plan section must show empty guidance');
      assert.ok(prompt.includes('派发研究任务') || prompt.includes('delegate_research'), 'Decision section must guide dispatching');
    });

    it('should pass snapshot claims, evidence, and findings to ReportAgent and persist ReportJudgment on release', async () => {
      const db = createDatabase(':memory:');
      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const resultRepo = new TaskResultRepository(db);
      const evidenceStore = new EvidenceStore(db);
      const outboxRepo = new OutboxRepository(db);
      const inboxRepo = new HostInboxRepository(db);
      const snapshotRepo = new MaterialSnapshotRepository(db);
      const decisionRepo = new HostDecisionRepository(db);

      const runId = 'run-report-judgment-test';
      const nowIso = new Date().toISOString();

      runRepo.createRun({
        run_id: runId,
        topic: '新能源汽车固态电池量产突破研判',
        scope: { region: 'CN' },
        status: RunStatus.Researching,
        current_round: 1,
        max_rounds: 3,
        budget_total: 50,
        budget_used: 15,
        execution_version: 1,
        created_at: nowIso,
        updated_at: nowIso,
      });

      const taskId = 'task-auth-bat';
      taskRepo.createTask({
        task_id: taskId,
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: '固态电池量产时间表与工信部公告核实',
        scope: {},
        completion_criteria: '查证官方公告',
        required_for_report: true,
        budget_allocated: 12,
        status: TaskStatus.Succeeded,
        created_at: nowIso,
      });

      evidenceStore.addEvidence({
        evidence_id: 'E-BAT-01',
        run_id: runId,
        source_type: 'official_announcement',
        source_ref: 'MIIT-2026-BAT',
        title: '工信部固态电池规范',
        excerpt: '第一批示范产线进入装车验证阶段',
      });

      const claim: Claim = {
        claim_id: 'CLM-BAT-1',
        statement: '首批装车验证产线已投产',
        evidence_ids: ['E-BAT-01'],
        limitations: [],
      };

      resultRepo.saveResult({
        result_id: 'res-bat-1',
        task_id: taskId,
        attempt_id: 'attempt-bat-1',
        run_id: runId,
        version: 1,
        role: 'authority',
        status: 'succeeded',
        summary: '官方通报显示装车验证启动',
        findings: { summary: '官方通报显示装车验证启动', claims: [claim] },
        created_at: nowIso,
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

      let receivedReportPrompt = '';
      const mockJudgment: ReportJudgment = {
        overall_interpretation: '固态电池商业化处于量产突破临界期，供应链格局将重构。',
        risks: [{ risk: '低温充放电效率与良率控制' }],
        recommendations: [{ action: '跟踪第二批工信部试点示范名单' }],
        linked_claim_ids: ['CLM-BAT-1'],
        linked_evidence_ids: ['E-BAT-01'],
        applicability_conditions: ['乘用车示范产线'],
        alternative_explanations: [],
        uncertainties: ['上游关键前驱体产能瓶颈'],
      };

      const submitJudgmentTool = createSubmitJudgmentTool(async () => {
        return { ok: true };
      });

      const reportAgent = createReportAgent({
        submitJudgmentTool,
        streamFn: createScriptedStreamFn([
          {
            toolCalls: [
              {
                name: 'submit_judgment',
                arguments: { judgment: mockJudgment },
              },
            ],
          },
          { text: 'Final report submitted successfully' },
        ]),
      });

      const coordinator = new ResearchCoordinator(
        runRepo,
        taskRepo,
        undefined as any,
        undefined,
        {
          db,
          releaseGate,
          reportAgent,
        }
      );

      // Request release with allowed_gaps for uncalled roles
      const releaseRes = await coordinator.requestRelease(runId, {
        allowed_gaps: ['evolution: not_applicable', 'feedback: not_applicable'],
        rationale: '专项技术合规先行发布，evolution and feedback are not applicable',
        unresolved_issues: [],
        restricted: true,
        target_format: 'brief',
      });

      assert.equal(releaseRes.ok, true, 'Release should pass');
      assert.ok(releaseRes.snapshot, 'Snapshot should be returned');
      assert.ok(releaseRes.judgment, 'Judgment should be returned in release result');
      assert.equal(releaseRes.judgment?.overall_interpretation, mockJudgment.overall_interpretation);

      // Verify persisted in host_decisions
      const decisions = decisionRepo.listDecisions(runId);
      assert.ok(decisions.some((d) => d.decision_type === 'finalize' && d.task_id === 'report'));

      // Verify run status transitioned to Completed
      const completedRun = runRepo.getRun(runId);
      assert.equal(completedRun?.status, RunStatus.Completed);
    });

    it('should execute startup recovery during createRuntimeServer', () => {
      const db = createDatabase(':memory:');
      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const attemptRepo = new TaskAttemptRepository(db);

      const runId = 'run-cold-boot';
      runRepo.createRun({
        run_id: runId,
        topic: '冷启动测试',
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
        task_id: 'task-active-1',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: '活跃任务',
        scope: {},
        completion_criteria: '完成',
        required_for_report: true,
        budget_allocated: 10,
        status: TaskStatus.Running,
        created_at: new Date().toISOString(),
      });

      attemptRepo.createAttempt({
        attempt_id: 'attempt-dangling-1',
        task_id: 'task-active-1',
        run_id: runId,
        execution_version: 1,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // createRuntimeServer with custom db
      const srv = createRuntimeServer({ db, port: 0 });
      assert.ok(srv.coordinator, 'Server should expose coordinator');

      // The attempt should have been failed by recoverOnStartup() on boot
      const attempt = attemptRepo.getAttempt('attempt-dangling-1');
      assert.equal(attempt?.status, 'failed');
    });

    it('should filter outbox events by after_seq via GET /api/research/runs/:id/outbox?after_seq=N', async () => {
      // Create run
      const createRes = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'Outbox seq filter test', mode: 'async' }),
      });
      const createData = (await createRes.json()) as any;
      const runId = createData.run_id;

      // Query outbox
      const outboxRes = await fetch(`${baseUrl}/api/research/runs/${runId}/outbox?after_seq=9999`);
      assert.equal(outboxRes.status, 200);
      const outboxData = (await outboxRes.json()) as any;
      assert.equal(outboxData.ok, true);
      assert.deepEqual(outboxData.events, []);
    });

    it('should guard recoverOnStartup from overwriting Succeeded and Partial tasks', () => {
      const db = createDatabase(':memory:');
      const runRepo = new RunRepository(db);
      const taskRepo = new TaskRepository(db);
      const attemptRepo = new TaskAttemptRepository(db);

      const runId = 'run-guard-test';
      runRepo.createRun({
        run_id: runId,
        topic: '防护状态测试',
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

      // Succeeded task
      taskRepo.createTask({
        task_id: 'task-succ',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: '已成功任务',
        scope: {},
        completion_criteria: '完成',
        required_for_report: true,
        budget_allocated: 10,
        status: TaskStatus.Succeeded,
        created_at: new Date().toISOString(),
      });
      attemptRepo.createAttempt({
        attempt_id: 'attempt-succ-dangling',
        task_id: 'task-succ',
        run_id: runId,
        execution_version: 1,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // Partial task
      taskRepo.createTask({
        task_id: 'task-part',
        run_id: runId,
        role: ResearchRole.Evolution,
        round: 1,
        generation: 1,
        question: '部分完成任务',
        scope: {},
        completion_criteria: '完成',
        required_for_report: true,
        budget_allocated: 10,
        status: TaskStatus.Partial,
        created_at: new Date().toISOString(),
      });
      attemptRepo.createAttempt({
        attempt_id: 'attempt-part-dangling',
        task_id: 'task-part',
        run_id: runId,
        execution_version: 1,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      // Running task
      taskRepo.createTask({
        task_id: 'task-run',
        run_id: runId,
        role: ResearchRole.Feedback,
        round: 1,
        generation: 1,
        question: '执行中任务',
        scope: {},
        completion_criteria: '完成',
        required_for_report: true,
        budget_allocated: 10,
        status: TaskStatus.Running,
        created_at: new Date().toISOString(),
      });
      attemptRepo.createAttempt({
        attempt_id: 'attempt-run-dangling',
        task_id: 'task-run',
        run_id: runId,
        execution_version: 1,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      const coordinator = new ResearchCoordinator(
        runRepo,
        taskRepo,
        undefined as any,
        undefined,
        { db, attemptRepo }
      );

      coordinator.recoverOnStartup();

      // Verify task statuses
      const succTask = taskRepo.getTask('task-succ');
      assert.equal(succTask?.status, TaskStatus.Succeeded, 'Succeeded task status must be preserved');

      const partTask = taskRepo.getTask('task-part');
      assert.equal(partTask?.status, TaskStatus.Partial, 'Partial task status must be preserved');

      const runTask = taskRepo.getTask('task-run');
      assert.equal(runTask?.status, TaskStatus.Failed, 'Running task should be marked Failed');
    });

    it('should provide run_id via runExecutionContext to research tools during host turns', async () => {
      const db = createDatabase(':memory:');
      const tool = createResearchAuthorityTool({ db });

      let capturedRunId: string | undefined;
      await runExecutionContext.run({ run_id: 'context-isolated-run-888' }, async () => {
        const receipt = (await tool.execute({
          question: 'Context isolation test',
          completion_criteria: 'Validate context run_id',
        })) as any;

        const taskRepo = new TaskRepository(db);
        const task = taskRepo.getTask(receipt.task_id);
        capturedRunId = task?.run_id;
      });

      assert.equal(capturedRunId, 'context-isolated-run-888', 'Tool should inherit run_id from runExecutionContext');
    });
  });
});
