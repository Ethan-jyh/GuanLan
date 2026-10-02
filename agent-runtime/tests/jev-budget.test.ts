import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import { CallLedger } from '../src/orchestration/call-ledger.js';
import { analyzeSentiment } from '../src/tools/feedback.js';
import { verifySentimentConservation } from '../src/contracts/sentiment.js';

describe('Task 4: Jev Budget, Cancellation & CallLedger Integration', () => {
  it('should stop dispatching new items when budget is exhausted', async () => {
    const rawDb = new DatabaseSync(':memory:');
    const db = createDatabase(rawDb);
    // Allow total limit of 2 units
    const budgetLedger = new BudgetLedger(db, { totalToolLimit: 2, reservedForWriting: 0 });

    const mockProvider = async () => ({
      ok: true,
      choice: 'positive' as const,
      confidence: 0.9,
      actualModel: 'jev-test',
      questionVersion: 'q1',
      attempts: 1,
    });

    const res = await analyzeSentiment(
      {
        texts: ['条目1', '条目2', '条目3', '条目4'],
        target: '某政策',
      },
      {
        provider: mockProvider,
        budgetLedger,
        runId: 'run-b1',
        maxConcurrency: 1, // Sequential to cleanly test threshold
        enableCache: false,
      }
    );

    assert.equal(res.count, 4);
    assert.equal(res.counts.positive, 2, 'Only 2 items could reserve quota');
    assert.equal(res.counts.skipped, 2, 'Remaining 2 items were skipped due to budget exhaustion');
    assert.equal(verifySentimentConservation(res), true);
    assert.ok(res.items[2].reason?.includes('Budget exhausted'));
    assert.ok(res.items[3].reason?.includes('Budget exhausted'));
  });

  it('should track sub-calls through CallLedger and settle tokens', async () => {
    const rawDb = new DatabaseSync(':memory:');
    const db = createDatabase(rawDb);
    const budgetLedger = new BudgetLedger(db, { totalToolLimit: 10, reservedForWriting: 0 });
    const callLedger = new CallLedger(budgetLedger);

    // Start parent call
    const parentCall = callLedger.beginCall({
      run_id: 'run-b2',
      call_id: 'parent-call-1',
      tool_name: 'analyze_sentiment',
      units: 1,
    });
    assert.equal(parentCall.ok, true);

    const mockProvider = async () => ({
      ok: true,
      choice: 'neutral' as const,
      confidence: 0.8,
      actualModel: 'jev-test',
      questionVersion: 'q1',
      usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      attempts: 1,
    });

    const res = await analyzeSentiment(
      {
        texts: ['已知悉情况', '收到通知'],
        target: '通报',
      },
      {
        provider: mockProvider,
        callLedger,
        parentCallId: 'parent-call-1',
        enableCache: false,
      }
    );

    assert.equal(res.count, 2);
    assert.equal(res.counts.neutral, 2);
    assert.equal(verifySentimentConservation(res), true);

    // End parent call
    callLedger.endCall({ call_id: 'parent-call-1', success: true });
    assert.equal(callLedger.listActiveCalls('run-b2').length, 0);
  });

  it('should abort remaining items when AbortSignal is cancelled', async () => {
    const controller = new AbortController();

    const mockProvider = async (p: { text: string }) => {
      if (p.text === '条目1') {
        controller.abort(); // Cancel while in progress
      }
      return {
        ok: true,
        choice: 'positive' as const,
        confidence: 0.9,
        actualModel: 'jev-test',
        questionVersion: 'q1',
        attempts: 1,
      };
    };

    const res = await analyzeSentiment(
      {
        texts: ['条目1', '条目2', '条目3'],
        target: '某服务',
      },
      {
        provider: mockProvider,
        signal: controller.signal,
        maxConcurrency: 1,
        enableCache: false,
      }
    );

    assert.equal(res.count, 3);
    assert.equal(res.counts.positive, 1);
    assert.equal(res.counts.skipped, 2, 'Items after abort should be skipped');
    assert.equal(verifySentimentConservation(res), true);
  });
});
