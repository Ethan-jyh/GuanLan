import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase } from '../src/storage/database.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { LocalToolRegistry } from '../src/tools/registry.js';
import { verifySentimentConservation } from '../src/contracts/sentiment.js';

describe('Task 5: Registry & Feedback Agent Tool Integration', () => {
  it('should expose updated analyze_sentiment tool definition with target and context', () => {
    const rawDb = new DatabaseSync(':memory:');
    const db = createDatabase(rawDb);
    const evidenceStore = new EvidenceStore(db);
    const registry = new LocalToolRegistry(evidenceStore);

    const tools = registry.getToolDefinitions();
    const sentimentTool = tools.find((t) => t.name === 'analyze_sentiment');

    assert.ok(sentimentTool, 'analyze_sentiment must be registered');
    const params = sentimentTool.parameters as any;
    assert.ok(params.required.includes('texts'));
    assert.ok(params.required.includes('target'));
    assert.ok(params.properties.target);
    assert.ok(params.properties.context);
  });

  it('should execute analyze_sentiment through registry with injected provider', async () => {
    const rawDb = new DatabaseSync(':memory:');
    const db = createDatabase(rawDb);
    const evidenceStore = new EvidenceStore(db);
    const registry = new LocalToolRegistry(evidenceStore);

    registry.setSentimentProvider(async (p) => {
      return {
        ok: true,
        choice: p.text.includes('满意') ? ('positive' as const) : ('neutral' as const),
        confidence: 0.9,
        probabilities: { positive: 0.9, neutral: 0.1 },
        actualModel: 'jev-test-model',
        questionVersion: 'q1',
        attempts: 1,
      };
    });

    const res = await registry.executeTool(
      'analyze_sentiment',
      {
        texts: ['服务很满意', '业务办理平稳'],
        target: '市政大厅窗口',
        context: '某市政大厅业务高峰',
      },
      { run_id: 'run-int-1', call_id: 'call-101' }
    );

    assert.equal(res.status, 'success');
    assert.equal(res.count, 2);
    assert.equal(res.counts.positive, 1);
    assert.equal(res.counts.neutral, 1);
    assert.equal(res.model_version, 'jev-test-model');
    assert.equal(verifySentimentConservation(res), true);
  });

  it('should return error when executed through registry without target', async () => {
    const rawDb = new DatabaseSync(':memory:');
    const db = createDatabase(rawDb);
    const registry = new LocalToolRegistry(new EvidenceStore(db));

    const res = await registry.executeTool('analyze_sentiment', {
      texts: ['服务好'],
    });

    assert.equal(res.status, 'error');
    assert.ok(res.error?.includes('target'));
  });

  it('should return explicit error when executed through registry without provider or API key', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const rawDb = new DatabaseSync(':memory:');
    const db = createDatabase(rawDb);
    const registry = new LocalToolRegistry(new EvidenceStore(db));

    const res = await registry.executeTool('analyze_sentiment', {
      texts: ['好评'],
      target: '某服务',
    });

    assert.equal(res.status, 'error');
    assert.ok(res.error?.includes('TYPESAFE_API_KEY'));
  });
});
