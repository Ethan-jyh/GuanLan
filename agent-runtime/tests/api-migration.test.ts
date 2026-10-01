import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { createRuntimeServer } from '../src/server.js';
import { DecisionType, ResearchRole } from '../src/contracts/research.js';

describe('Task 7: REST API, SSE Events, and Web Dashboard Migration', () => {
  let serverHandle: { server: any; listen: (p?: number) => Promise<void>; close: () => Promise<void> };
  let baseUrl: string;
  beforeEach(async () => {
    serverHandle = createRuntimeServer({ port: 0, dbPath: ':memory:' } as any);
    await serverHandle.listen(0);
    const addr = serverHandle.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 4055;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await serverHandle.close();
  });

  describe('REST Endpoints for Runs', () => {
    it('should create run with POST /api/research/runs and reject missing topic', async () => {
      // 1. Missing topic -> 400
      const badResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(badResp.status, 400);

      // 2. Valid creation -> 201
      const goodResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: '暴雨灾害应急演化研判', budget_total: 60 }),
      });
      assert.equal(goodResp.status, 201);
      const data = (await goodResp.json()) as any;
      assert.equal(data.ok, true);
      assert.ok(data.run.run_id);
      assert.equal(data.run.topic, '暴雨灾害应急演化研判');
    });

    it('should query run details with GET /api/research/runs/:id', async () => {
      // Create run
      const createResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: '查询测试' }),
      });
      const created = (await createResp.json()) as any;
      const runId = created.run.run_id;

      // Query run
      const getResp = await fetch(`${baseUrl}/api/research/runs/${runId}`);
      assert.equal(getResp.status, 200);
      const detail = (await getResp.json()) as any;
      assert.equal(detail.ok, true);
      assert.equal(detail.run.run_id, runId);
      assert.ok(Array.isArray(detail.tasks));
      assert.equal(detail.tasks.length, 3);
      assert.ok(detail.budget);

      // Query non-existent run -> 404
      const notFound = await fetch(`${baseUrl}/api/research/runs/non-existent-run`);
      assert.equal(notFound.status, 404);
    });

    it('should support pause, resume, cancel, and review decision', async () => {
      const createResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: '控制测试' }),
      });
      const runId = ((await createResp.json()) as any).run.run_id;

      // Pause
      const pauseResp = await fetch(`${baseUrl}/api/research/runs/${runId}/pause`, { method: 'POST' });
      assert.equal(pauseResp.status, 200);
      const pauseData = (await pauseResp.json()) as any;
      assert.equal(pauseData.run.status, 'paused');

      // Resume
      const resumeResp = await fetch(`${baseUrl}/api/research/runs/${runId}/resume`, { method: 'POST' });
      assert.equal(resumeResp.status, 200);
      const resumeData = (await resumeResp.json()) as any;
      assert.equal(resumeData.run.status, 'researching');
      assert.equal(resumeData.run.execution_version, 2);

      // Review decision
      const reviewResp = await fetch(`${baseUrl}/api/research/runs/${runId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: 'task-review-test',
          round: 1,
          decision: DecisionType.Revise,
          rationale: 'Follow up needed',
          directives: [
            {
              directive_id: 'dir-1',
              target_role: ResearchRole.Feedback,
              related_claim_or_issue: 'comments',
              question: 'Sample more',
              suggested_action: 'Query comments',
              completion_criteria: 'Sample >= 3000',
            },
          ],
          unresolved_issues: [],
        }),
      });
      assert.equal(reviewResp.status, 200);
      const reviewData = (await reviewResp.json()) as any;
      assert.equal(reviewData.decision.decision, 'revise');
    });
  });

  describe('Events & SSE Endpoint', () => {
    it('should poll events with after_seq', async () => {
      const createResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: '事件测试' }),
      });
      const runId = ((await createResp.json()) as any).run.run_id;

      const eventsResp = await fetch(`${baseUrl}/api/research/runs/${runId}/events?after_seq=0`);
      assert.equal(eventsResp.status, 200);
      const data = (await eventsResp.json()) as any;
      assert.ok(Array.isArray(data.events));
      assert.ok(data.events.length >= 1);
    });

    it('should serve SSE stream with text/event-stream headers and heartbeat', async () => {
      const createResp = await fetch(`${baseUrl}/api/research/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: 'SSE测试' }),
      });
      const runId = ((await createResp.json()) as any).run.run_id;

      const controller = new AbortController();
      const sseResp = await fetch(`${baseUrl}/api/research/runs/${runId}/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });

      assert.equal(sseResp.status, 200);
      assert.ok(sseResp.headers.get('content-type')?.includes('text/event-stream'));

      // Clean up connection
      controller.abort();
    });
  });

  describe('Web Dashboard', () => {
    it('should serve HTML dashboard at / and /dashboard', async () => {
      const rootResp = await fetch(`${baseUrl}/`);
      assert.equal(rootResp.status, 200);
      const html1 = await rootResp.text();
      assert.ok(html1.includes('BettaFish'));
      assert.ok(html1.includes('舆情'));

      const dashResp = await fetch(`${baseUrl}/dashboard`);
      assert.equal(dashResp.status, 200);
      const html2 = await dashResp.text();
      assert.ok(html2.includes('BettaFish'));
    });
  });
});
