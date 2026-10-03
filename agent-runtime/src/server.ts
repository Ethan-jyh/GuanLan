import http from 'node:http';
import { URL } from 'node:url';

import { createDatabase, ResearchDatabase } from './storage/database.js';
import {
  RunRepository,
  TaskRepository,
  SubmissionRepository,
  ReviewRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
  MaterialSnapshotRepository,
} from './storage/repositories.js';
import { EvidenceStore } from './storage/evidence-store.js';
import { EventStore } from './storage/event-store.js';
import { BudgetLedger } from './storage/budget-ledger.js';
import { SubmissionManager } from './orchestration/submissions.js';
import { ResearchCoordinator } from './orchestration/coordinator.js';
import { RecoveryManager } from './orchestration/recovery.js';
import { ReviewManager } from './orchestration/review.js';
import { ResearchWorkerPool } from './orchestration/research-worker.js';
import { HostInboxDispatcher } from './orchestration/host-inbox.js';
import { ReleaseGate } from './orchestration/release-gate.js';
import { createHostAgent, HostAgent } from './agents/host.js';
import { createReportAgent, ReportAgent, createSubmitJudgmentTool } from './agents/report.js';
import {
  createResearchAuthorityTool,
  createResearchEvolutionTool,
  createResearchFeedbackTool,
  createGetResearchResultTool,
  createCancelResearchTaskTool,
} from './tools/research-tools.js';
import { createDelegateResearchTool } from './tools/delegate-research.js';
import { SseManager } from './api/sse.js';
import { ResearchApiRouter } from './api/routes.js';

import { ResearchRole } from './contracts/research.js';
import { createResearcherAgent } from './agents/researcher.js';
import { AUTHORITY_SYSTEM_PROMPT } from './prompts/authority.js';
import { createSubmitFindingsTool } from './tools/submit-findings.js';
import { PythonToolClient } from './tools/python-client.js';
import { createScriptedStreamFn } from './runtime/pi-adapter.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export interface RuntimeServerOptions {
  port?: number;
  dbPath?: string;
  pythonBaseUrl?: string;
  internalToken?: string;
  workerPool?: ResearchWorkerPool;
  hostAgent?: HostAgent;
  hostInboxDispatcher?: HostInboxDispatcher;
  releaseGate?: ReleaseGate;
  reportAgent?: ReportAgent;
  coordinator?: ResearchCoordinator;
  hostStreamFn?: StreamFn;
  workerStreamFn?: StreamFn;
  reportStreamFn?: StreamFn;
}

export function createRuntimeServer(options: RuntimeServerOptions = {}) {
  const port = options.port ?? 4000;
  const dbPath = options.dbPath ?? ':memory:';
  const pythonBaseUrl = options.pythonBaseUrl ?? 'http://127.0.0.1:5000';
  const token = options.internalToken ?? 'guanlan-internal-secret';

  // Initialize SQLite persistence & domain layer
  const db = createDatabase(dbPath);
  const runRepo = new RunRepository(db);
  const taskRepo = new TaskRepository(db);
  const subRepo = new SubmissionRepository(db);
  const reviewRepo = new ReviewRepository(db);
  const attemptRepo = new TaskAttemptRepository(db);
  const resultRepo = new TaskResultRepository(db);
  const outboxRepo = new OutboxRepository(db);
  const inboxRepo = new HostInboxRepository(db);
  const decisionRepo = new HostDecisionRepository(db);
  const snapshotRepo = new MaterialSnapshotRepository(db);
  const evidenceStore = new EvidenceStore(db);
  const eventStore = new EventStore(db);
  const budgetLedger = new BudgetLedger(db, { totalToolLimit: 60, reservedForWriting: 10 });
  const sseManager = new SseManager(eventStore);

  // Initialize Worker Pool
  const workerPool =
    options.workerPool ||
    new ResearchWorkerPool({
      db,
      streamFn: options.workerStreamFn || createScriptedStreamFn([{ text: 'Worker ready' }]),
      evidenceStore,
    });

  // Wire worker pool transitions
  workerPool.onTaskTransition = (transition) => {
    sseManager.broadcastTaskTransition(transition.run_id, transition);
  };

  // Tools for HostAgent
  const authorityTool = createResearchAuthorityTool({ workerPool, db });
  const evolutionTool = createResearchEvolutionTool({ workerPool, db });
  const feedbackTool = createResearchFeedbackTool({ workerPool, db });
  const getResultTool = createGetResearchResultTool(db);
  const cancelTool = createCancelResearchTaskTool(workerPool);
  const delegateTool = createDelegateResearchTool({ workerPool, db });

  // Host Agent
  const hostAgent =
    options.hostAgent ||
    createHostAgent({
      streamFn: options.hostStreamFn || createScriptedStreamFn([{ text: 'Host ready' }]),
      delegateTool,
      additionalTools: [authorityTool, evolutionTool, feedbackTool, getResultTool, cancelTool],
    });

  // Host Inbox Dispatcher
  const hostInboxDispatcher =
    options.hostInboxDispatcher ||
    new HostInboxDispatcher({
      db,
      hostAgent,
      budgetLedger,
      debounceMs: 100,
      onHostDecision: (runId, decision) => {
        sseManager.broadcastHostDecision(runId, decision);
      },
    });

  // Connect worker pool outcome -> notify host inbox
  workerPool.onOutcome = (outcome) => {
    hostInboxDispatcher.notifyOutbox(outcome.run_id);
  };

  // Release Gate
  const releaseGate =
    options.releaseGate ||
    new ReleaseGate({
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

  // Report Agent
  const submitJudgmentTool = createSubmitJudgmentTool(async (_judgment) => {
    return { ok: true };
  });

  const reportAgent =
    options.reportAgent ||
    createReportAgent({
      streamFn: options.reportStreamFn || createScriptedStreamFn([{ text: 'Report ready' }]),
      submitJudgmentTool,
    });

  const submissionMgr = new SubmissionManager(subRepo, taskRepo, evidenceStore);
  const coordinator =
    options.coordinator ||
    new ResearchCoordinator(runRepo, taskRepo, submissionMgr, eventStore, {
      workerPool,
      hostInboxDispatcher,
      releaseGate,
      hostAgent,
      reportAgent,
      db,
      attemptRepo,
      outboxRepo,
      inboxRepo,
      resultRepo,
      snapshotRepo,
      decisionRepo,
      evidenceStore,
      budgetLedger,
      sseManager,
    });

  const recoveryMgr = new RecoveryManager(runRepo);
  const reviewMgr = new ReviewManager(runRepo, taskRepo, reviewRepo, submissionMgr);

  const apiRouter = new ResearchApiRouter({
    coordinator,
    recoveryMgr,
    reviewMgr,
    budgetLedger,
    eventStore,
    sseManager,
    workerPool,
    hostInboxDispatcher,
    releaseGate,
    outboxRepo,
    inboxRepo,
    taskRepo,
    resultRepo,
  });

  const server = http.createServer(async (req, res) => {
    // 1. Try Research API & Dashboard routes
    try {
      const handled = await apiRouter.handleRequest(req, res);
      if (handled) return;
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // 2. Backward compatibility: /api/runtime/execute-task
    if (req.method === 'POST' && url.pathname === '/api/runtime/execute-task') {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk;
      });

      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyStr || '{}');
          const { envelope, role, question, scriptedSteps } = payload;

          if (!envelope || !role || !question) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing envelope, role, or question' }));
            return;
          }

          const pythonClient = new PythonToolClient({
            baseUrl: pythonBaseUrl,
            internalToken: token,
          });

          const searchTool = {
            name: 'search_web',
            description: 'Search official web',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            execute: async (params: { query: string }) => {
              return pythonClient.callTool(envelope, 'search_web', params);
            },
          };

          const readSourceTool = {
            name: 'read_source',
            description: 'Read source full text',
            parameters: {
              type: 'object',
              properties: { url_or_ref: { type: 'string' } },
              required: ['url_or_ref'],
            },
            execute: async (params: { url_or_ref: string }) => {
              return pythonClient.callTool(envelope, 'read_source', params);
            },
          };

          let lastSubmissionResult: any = null;
          const submitTool = createSubmitFindingsTool(async (findings) => {
            const resp = await fetch(`${pythonBaseUrl}/api/research/internal/submissions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Research-Internal-Token': token,
              },
              body: JSON.stringify({
                run_id: envelope.run_id,
                task_id: envelope.task_id,
                ...findings,
              }),
            });
            const data: any = await resp.json();
            if (data.status === 'success' || data.submission_id) {
              lastSubmissionResult = data;
              return { ok: true, submissionId: data.submission_id };
            }
            return { ok: false, error: data.error || 'Submission failed' };
          });

          let systemPrompt = AUTHORITY_SYSTEM_PROMPT;
          const streamFn = createScriptedStreamFn(scriptedSteps || [{ text: 'No actions' }]);

          const agent = createResearcherAgent({
            role: role as ResearchRole,
            systemPrompt,
            tools: [searchTool, readSourceTool],
            submitTool,
            streamFn,
          });

          const result = await agent.run(question);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'completed',
              finalText: result.finalText,
              events: result.events,
              submission: lastSubmissionResult,
            })
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    server,
    listen: (customPort?: number) =>
      new Promise<void>((resolve) => {
        server.listen(customPort ?? port, () => resolve());
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        hostInboxDispatcher.destroy();
        sseManager.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const runtime = createRuntimeServer({ port: 4000 });
  runtime.listen(4000).then(() => {
    console.log('Pi Agent Runtime Server listening on http://localhost:4000');
  });
}
