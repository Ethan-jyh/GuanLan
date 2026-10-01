import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PythonToolClient } from '../src/tools/python-client.js';
import { BudgetGate } from '../src/runtime/budget-gate.js';

describe('PythonToolClient & BudgetGate', () => {
  it('should format tool call request with envelope and handle success', async () => {
    // Mock transport
    const mockTransport = async (path: string, headers: Record<string, string>, body: any) => {
      assert.equal(headers['X-Research-Internal-Token'], 'test-secret');
      assert.equal(path, '/api/research/internal/tools/search_web');
      assert.equal(body.run_id, 'run-ts-001');
      return {
        status: 'success',
        results: [{ title: 'Mocked Result', url: 'https://example.com' }],
      };
    };

    const client = new PythonToolClient({
      baseUrl: 'http://127.0.0.1:5000',
      internalToken: 'test-secret',
      transport: mockTransport,
    });

    const res = await client.callTool(
      {
        schema_version: '1.0.0',
        run_id: 'run-ts-001',
        task_id: 'task-ts-001',
        call_id: 'call-01',
        execution_version: 1,
        idempotency_key: 'idem-call-01',
        timestamp: new Date().toISOString(),
      },
      'search_web',
      { query: 'test query' }
    );

    assert.equal(res.status, 'success');
    assert.equal(res.results.length, 1);
  });

  it('BudgetGate should block execution when quota exceeded', async () => {
    let currentQuota = 0; // 0 remaining
    const gate = new BudgetGate({
      checkQuota: async () => currentQuota > 0,
      reserve: async () => {
        if (currentQuota <= 0) return { ok: false, reason: 'Budget quota exhausted' };
        currentQuota--;
        return { ok: true, reservationId: 'res-1' };
      },
      settle: async () => {},
    });

    const check = await gate.beforeToolCall({ name: 'search_web', arguments: {} });
    assert.ok(check?.block, 'Should block tool call when quota exhausted');
    assert.ok(check?.reason?.includes('exhausted'));
  });
});
