import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { ResearchCoordinator } from '../orchestration/coordinator.js';
import { RecoveryManager } from '../orchestration/recovery.js';
import { ReviewManager } from '../orchestration/review.js';
import { BudgetLedger } from '../storage/budget-ledger.js';
import { EventStore } from '../storage/event-store.js';
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
      const run = this.deps.coordinator.createRun(topic, body.scope || {}, body.roles, budgetTotal);
      this.sendJson(res, 201, { ok: true, run });
      return true;
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

        const tasks = this.deps.coordinator.getTasksForRound(runId, run.current_round);
        const budget = this.deps.budgetLedger.getUsage(runId);

        this.sendJson(res, 200, { ok: true, run, tasks, budget });
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
          const run = this.deps.recoveryMgr.resumeRun(runId);
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
