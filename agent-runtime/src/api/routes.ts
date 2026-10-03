import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { ResearchCoordinator } from '../orchestration/coordinator.js';
import { RecoveryManager } from '../orchestration/recovery.js';
import { ReviewManager } from '../orchestration/review.js';
import { BudgetLedger } from '../storage/budget-ledger.js';
import { EventStore } from '../storage/event-store.js';
import {
  TaskRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
} from '../storage/repositories.js';
import { ResearchWorkerPool } from '../orchestration/research-worker.js';
import { HostInboxDispatcher } from '../orchestration/host-inbox.js';
import { ReleaseGate } from '../orchestration/release-gate.js';
import { SseManager } from './sse.js';
import { renderDashboardHtml } from './dashboard.js';
import { HostReviewDecision } from '../contracts/review.js';

export interface ApiHandlerDependencies {
  coordinator: ResearchCoordinator;
  recoveryMgr: RecoveryManager;
  reviewMgr: ReviewManager;
  budgetLedger: BudgetLedger;
  eventStore: EventStore;
  sseManager: SseManager;
  workerPool?: ResearchWorkerPool;
  hostInboxDispatcher?: HostInboxDispatcher;
  releaseGate?: ReleaseGate;
  outboxRepo?: OutboxRepository;
  inboxRepo?: HostInboxRepository;
  taskRepo?: TaskRepository;
  resultRepo?: TaskResultRepository;
}

export class ResearchApiRouter {
  constructor(private deps: ApiHandlerDependencies) {}

  public async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const host = req.headers.host || 'localhost';
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    // 1. Dashboard routes
    if (method === 'GET' && (pathname === '/' || pathname === '/dashboard')) {
      const html = renderDashboardHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    }

    // 2. Health check
    if (method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, { status: 'ok', service: 'guanlan-agent-runtime' });
      return true;
    }

    // 3. API Routes under /api/research
    if (!pathname.startsWith('/api/research/')) {
      return false;
    }

    const subPath = pathname.replace(/^\/api\/research\//, '');

    // POST /api/research/runs
    if (method === 'POST' && subPath === 'runs') {
      const body = await this.readJsonBody(req);
      const topic = body.topic?.trim();
      if (!topic) {
        this.sendJson(res, 400, { ok: false, error: "Missing required field 'topic'" });
        return true;
      }

      const budgetTotal = typeof body.budget_total === 'number' ? body.budget_total : 50;
      const isAsync =
        body.mode === 'async' ||
        body.auto_create_tasks === false ||
        parsedUrl.searchParams.get('mode') === 'async';

      const autoCreateTasks =
        body.auto_create_tasks !== undefined ? Boolean(body.auto_create_tasks) : !isAsync;

      const run = this.deps.coordinator.createRun(
        topic,
        body.scope || {},
        body.roles,
        budgetTotal,
        { autoCreateTasks, mode: isAsync ? 'async' : 'sync' }
      );

      if (isAsync) {
        this.deps.coordinator.startRun(run.run_id).catch((err) => {
          console.error(`[ApiRouter] Error starting run ${run.run_id}:`, err);
        });
      }

      this.sendJson(res, 201, { ok: true, run });
      return true;
    }

    // Direct task routes: /api/research/tasks/:taskId(/cancel)?
    const taskDirectMatch = subPath.match(/^tasks\/([^/]+)(\/(.*))?$/);
    if (taskDirectMatch) {
      const taskId = taskDirectMatch[1];
      const action = taskDirectMatch[3] || '';

      if (method === 'GET' && !action) {
        const task = this.deps.taskRepo?.getTask(taskId);
        if (!task) {
          this.sendJson(res, 404, { ok: false, error: `Task '${taskId}' not found` });
          return true;
        }
        const result = this.deps.resultRepo?.getLatestResult(task.run_id, taskId);
        this.sendJson(res, 200, { ok: true, task, result });
        return true;
      }

      if (method === 'POST' && action === 'cancel') {
        const body = await this.readJsonBody(req);
        const cancelled = await this.deps.coordinator.cancelTask(taskId, body.reason);
        this.sendJson(res, 200, { ok: true, cancelled, task_id: taskId });
        return true;
      }
    }

    // Match /api/research/runs/:id/...
    const runMatch = subPath.match(/^runs\/([^/]+)(\/(.*))?$/);
    if (runMatch) {
      const runId = runMatch[1];
      const action = runMatch[3] || '';

      // GET /api/research/runs/:id
      if (method === 'GET' && !action) {
        const run = this.deps.coordinator.getRun(runId);
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `Run '${runId}' not found` });
          return true;
        }

        const tasks =
          this.deps.taskRepo?.listTasks(runId) ??
          this.deps.coordinator.getTasksForRound(runId, run.current_round);
        const budget = this.deps.budgetLedger.getUsage(runId);

        this.sendJson(res, 200, { ok: true, run, tasks, budget });
        return true;
      }

      // GET /api/research/runs/:id/tasks
      if (method === 'GET' && action === 'tasks') {
        const tasks =
          this.deps.taskRepo?.listTasks(runId) ??
          this.deps.coordinator.getTasksForRound(runId, 1);
        this.sendJson(res, 200, { ok: true, tasks });
        return true;
      }

      // Tasks item routes: /api/research/runs/:id/tasks/:taskId(/cancel)?
      const runTaskMatch = action.match(/^tasks\/([^/]+)(\/(.*))?$/);
      if (runTaskMatch) {
        const taskId = runTaskMatch[1];
        const taskAction = runTaskMatch[3] || '';

        if (method === 'GET' && !taskAction) {
          const task = this.deps.taskRepo?.getTask(taskId);
          if (!task) {
            this.sendJson(res, 404, { ok: false, error: `Task '${taskId}' not found` });
            return true;
          }
          const result = this.deps.resultRepo?.getLatestResult(runId, taskId);
          this.sendJson(res, 200, { ok: true, task, result });
          return true;
        }

        if (method === 'POST' && taskAction === 'cancel') {
          const body = await this.readJsonBody(req);
          const cancelled = await this.deps.coordinator.cancelTask(taskId, body.reason);
          this.sendJson(res, 200, { ok: true, cancelled, task_id: taskId });
          return true;
        }
      }

      // GET /api/research/runs/:id/outbox
      if (method === 'GET' && action === 'outbox') {
        const afterSeq = parseInt(parsedUrl.searchParams.get('after_seq') || '0', 10);
        const events =
          this.deps.outboxRepo?.getEventsAfter(isNaN(afterSeq) ? 0 : afterSeq, runId) || [];
        this.sendJson(res, 200, { ok: true, events });
        return true;
      }

      // GET /api/research/runs/:id/inbox
      if (method === 'GET' && action === 'inbox') {
        const records = this.deps.inboxRepo?.listByRun(runId) || [];
        this.sendJson(res, 200, { ok: true, records });
        return true;
      }

      // POST /api/research/runs/:id/release
      if (method === 'POST' && action === 'release') {
        try {
          const body = await this.readJsonBody(req);
          const result = await this.deps.coordinator.requestRelease(runId, body);
          const statusCode = result.ok ? 200 : 400;
          this.sendJson(res, statusCode, { ...result, ok: result.ok });
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // POST /api/research/runs/:id/start
      if (method === 'POST' && action === 'start') {
        try {
          const body = await this.readJsonBody(req);
          await this.deps.coordinator.startRun(runId, body.prompt);
          const run = this.deps.coordinator.getRun(runId);
          this.sendJson(res, 200, { ok: true, run });
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // POST /api/research/runs/:id/pause
      if (method === 'POST' && action === 'pause') {
        const run = this.deps.coordinator.getRun(runId);
        if (!run) {
          this.sendJson(res, 404, { ok: false, error: `Run '${runId}' not found` });
          return true;
        }
        this.deps.coordinator.pauseRun(runId, 'User requested pause');
        const updated = this.deps.coordinator.getRun(runId);
        this.sendJson(res, 200, { ok: true, run: updated });
        return true;
      }

      // POST /api/research/runs/:id/resume
      if (method === 'POST' && action === 'resume') {
        try {
          const run = this.deps.coordinator.resumeRun
            ? this.deps.coordinator.resumeRun(runId)
            : this.deps.recoveryMgr.resumeRun(runId);
          this.sendJson(res, 200, { ok: true, run });
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // POST /api/research/runs/:id/cancel
      if (method === 'POST' && action === 'cancel') {
        try {
          const run = this.deps.recoveryMgr.cancelRun(runId);
          this.sendJson(res, 200, { ok: true, run });
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // POST /api/research/runs/:id/review
      if (method === 'POST' && action === 'review') {
        try {
          const body = (await this.readJsonBody(req)) as HostReviewDecision;
          const decision = this.deps.reviewMgr.submitReviewDecision(runId, body);
          const run = this.deps.coordinator.getRun(runId);
          this.sendJson(res, 200, { ok: true, decision, run });
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err.message });
        }
        return true;
      }

      // GET /api/research/runs/:id/events (supports JSON and SSE)
      if (method === 'GET' && action === 'events') {
        const accept = req.headers['accept'] || '';
        const afterSeq = parseInt(parsedUrl.searchParams.get('after_seq') || '0', 10);

        if (accept.includes('text/event-stream')) {
          this.deps.sseManager.handleSseConnection(runId, res, afterSeq);
          return true;
        }

        const events = this.deps.eventStore.getEvents(runId, afterSeq);
        this.sendJson(res, 200, { ok: true, events });
        return true;
      }
    }

    return false;
  }

  private sendJson(res: ServerResponse, status: number, body: any): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(body));
  }

  private readJsonBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }
}
