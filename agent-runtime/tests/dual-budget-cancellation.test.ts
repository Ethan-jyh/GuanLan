import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import { CallLedger } from '../src/orchestration/call-ledger.js';
import { BudgetGate, type ToolCallSpec } from '../src/runtime/budget-gate.js';
import {
  PiAgentAdapter,
  createScriptedStreamFn,
  type ResearchToolDefinition,
  TaskCancellationController,
} from '../src/runtime/pi-adapter.js';

describe('Task 4: PiAdapter Native Call ID, Dual-Tier Budget Gate & Task Cancellation', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let ledger: BudgetLedger;
  let callLedger: CallLedger;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    ledger = new BudgetLedger(db, {
      totalToolLimit: 50,
      reservedForWriting: 10,
    });
    callLedger = new CallLedger(ledger);
  });

  describe('1. PiAdapter Native callId Propagation', () => {
    it('should pass Pi native callId to beforeToolCall, execute, and afterToolCall', async () => {
      let beforeCallId: string | undefined;
      let executeCallId: string | undefined;
      let afterCallId: string | undefined;

      const dummyTool: ResearchToolDefinition = {
        name: 'search_web',
        description: 'Test search web',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (params: any, signal?: AbortSignal, callId?: string) => {
          executeCallId = callId;
          return { found: true, query: params.q };
        },
      };

      const scriptedStreamFn = createScriptedStreamFn([
        {
          toolCalls: [
            {
              id: 'pi-call-101',
              name: 'search_web',
              arguments: { q: 'quantum computing' },
            },
          ],
        },
        {
          text: 'Search completed.',
        },
      ]);

      const adapter = new PiAgentAdapter({
        systemPrompt: 'You are a test researcher',
        tools: [dummyTool],
        streamFn: scriptedStreamFn,
        beforeToolCall: async (toolCall: any) => {
          beforeCallId = toolCall.call_id;
          return undefined;
        },
        afterToolCall: async (toolCall: any, _result: any) => {
          afterCallId = toolCall.call_id;
          return undefined;
        },
      });

      await adapter.run('Search for quantum computing');

      assert.ok(beforeCallId, 'beforeToolCall must receive call_id');
      assert.ok(executeCallId, 'execute must receive callId');
      assert.ok(afterCallId, 'afterToolCall must receive call_id');

      assert.equal(beforeCallId, 'pi-call-101');
      assert.equal(executeCallId, 'pi-call-101');
      assert.equal(afterCallId, 'pi-call-101');
    });

    it('should pass auto-generated Pi callId when toolCall id is not explicitly specified', async () => {
      let capturedExecuteCallId: string | undefined;
      let capturedBeforeCallId: string | undefined;

      const dummyTool: ResearchToolDefinition = {
        name: 'echo_tool',
        description: 'Echo params',
        parameters: { type: 'object', properties: {} },
        execute: async (_params: any, _signal?: AbortSignal, callId?: string) => {
          capturedExecuteCallId = callId;
          return { ok: true };
        },
      };

      const scriptedStreamFn = createScriptedStreamFn([
        {
          toolCalls: [
            {
              name: 'echo_tool',
              arguments: {},
            },
          ],
        },
        { text: 'Done' },
      ]);

      const adapter = new PiAgentAdapter({
        systemPrompt: 'Test prompt',
        tools: [dummyTool],
        streamFn: scriptedStreamFn,
        beforeToolCall: async (toolCall: any) => {
          capturedBeforeCallId = toolCall.call_id;
          return undefined;
        },
      });

      await adapter.run('Run echo');

      assert.ok(capturedBeforeCallId, 'beforeToolCall must receive non-empty call_id');
      assert.ok(capturedExecuteCallId, 'execute must receive non-empty callId');
      assert.equal(capturedBeforeCallId, capturedExecuteCallId);
    });
  });

  describe('2. Concurrent Same-Tool Reservations & Isolation', () => {
    it('should isolate reservations for concurrent calls to the same tool using call_id', async () => {
      const gate = new BudgetGate({});
      gate.bindToBudgetLedger(ledger, 'run-iso-1', 'task-iso-1');

      const toolCall1 = {
        name: 'search',
        arguments: { q: 'topic A' },
        call_id: 'call-search-101',
      };
      const toolCall2 = {
        name: 'search',
        arguments: { q: 'topic B' },
        call_id: 'call-search-102',
      };

      // Both reserve concurrently
      const block1 = await gate.beforeToolCall(toolCall1);
      const block2 = await gate.beforeToolCall(toolCall2);

      assert.equal(block1, undefined);
      assert.equal(block2, undefined);

      // Verify active reservations are distinct
      const res1 = gate.getActiveReservation('call-search-101');
      const res2 = gate.getActiveReservation('call-search-102');
      assert.ok(res1, 'Call 1 must have active reservation');
      assert.ok(res2, 'Call 2 must have active reservation');
      assert.notEqual(res1, res2, 'Reservations must be separate and not overwrite each other');

      // Settle call 1
      await gate.afterToolCall(toolCall1, { found: true });

      // Call 1 settled, Call 2 must remain active
      assert.equal(gate.getActiveReservation('call-search-101'), undefined);
      assert.equal(gate.getActiveReservation('call-search-102'), res2, 'Call 2 reservation must still be active');

      // Settle call 2
      await gate.afterToolCall(toolCall2, { found: true });
      assert.equal(gate.getActiveReservation('call-search-102'), undefined);

      // Ledger check
      const usage = ledger.getUsage('run-iso-1');
      assert.equal(usage.used, 2);
      assert.equal(usage.reserved, 0);
    });

    it('should never fall back to tool.name when call_id is missing and generate unique IDs', async () => {
      const gate = new BudgetGate({});
      gate.bindToBudgetLedger(ledger, 'run-iso-2', 'task-iso-2');

      const callA: ToolCallSpec = { name: 'search', arguments: {} };
      const callB: ToolCallSpec = { name: 'search', arguments: {} };

      await gate.beforeToolCall(callA);
      await gate.beforeToolCall(callB);

      assert.ok(callA.call_id, 'callA must have received unique call_id');
      assert.ok(callB.call_id, 'callB must have received unique call_id');
      assert.notEqual(callA.call_id, 'search', 'call_id must NEVER fall back to tool.name');
      assert.notEqual(callB.call_id, 'search', 'call_id must NEVER fall back to tool.name');
      assert.notEqual(callA.call_id, callB.call_id, 'Both calls must receive distinct unique IDs');

      assert.equal(gate.activeReservationCount, 2);
    });
  });

  describe('3. Dual-Tier Budget Enforcement (Task Quota & Global Quota)', () => {
    it('should block tool calls when task-level quota is exceeded', async () => {
      const gate = new BudgetGate({});
      // Bind with task quota limit of 2
      gate.bindToBudgetLedger(ledger, 'run-dual-1', 'task-dual-1', false, 2);

      // Call 1
      const res1 = await gate.beforeToolCall({
        name: 'search',
        arguments: {},
        call_id: 'call-d-1',
      });
      assert.equal(res1, undefined);
      await gate.afterToolCall({ name: 'search', arguments: {}, call_id: 'call-d-1' }, {});

      // Call 2
      const res2 = await gate.beforeToolCall({
        name: 'search',
        arguments: {},
        call_id: 'call-d-2',
      });
      assert.equal(res2, undefined);
      await gate.afterToolCall({ name: 'search', arguments: {}, call_id: 'call-d-2' }, {});

      // Task remaining should be 0
      const taskRemaining = ledger.getTaskRemaining('task-dual-1', 2);
      assert.equal(taskRemaining, 0);

      // Call 3 - exceeds task budget
      const res3 = await gate.beforeToolCall({
        name: 'search',
        arguments: {},
        call_id: 'call-d-3',
      });
      assert.ok(res3?.block, 'Tool call 3 must be blocked by task quota');
      assert.ok(
        res3?.reason?.toLowerCase().includes('task') && res3?.reason?.toLowerCase().includes('quota'),
        `Reason should mention task quota: ${res3?.reason}`
      );
    });

    it('should block tool calls when global research quota is exhausted while protecting report writing reserve', async () => {
      // Small ledger: 15 total limit, 5 reserved for writing -> 10 max research units
      const smallLedger = new BudgetLedger(db, {
        totalToolLimit: 15,
        reservedForWriting: 5,
      });

      const gate = new BudgetGate({});
      gate.bindToBudgetLedger(smallLedger, 'run-global-1', 'task-g-1', false, 20);

      // Consume 10 units
      for (let i = 0; i < 10; i++) {
        const reserveRes = smallLedger.reserve({
          run_id: 'run-global-1',
          task_id: 'task-g-1',
          units: 1,
        });
        assert.ok(reserveRes.ok);
        smallLedger.settle({ reservation_id: reserveRes.reservation_id!, actual_units: 1 });
      }

      // Research quota is now exhausted (10 used)
      assert.equal(smallLedger.getRemaining('run-global-1', false), 0);
      // But writing phase has 5 units remaining!
      assert.equal(smallLedger.getRemaining('run-global-1', true), 5);

      // 11th research tool call must be blocked by global quota
      const blocked = await gate.beforeToolCall({
        name: 'search',
        arguments: {},
        call_id: 'call-g-11',
      });
      assert.ok(blocked?.block, 'Must block research call when research quota is exhausted');
      assert.ok(
        blocked?.reason?.toLowerCase().includes('global') || blocked?.reason?.toLowerCase().includes('exhausted'),
        `Reason should indicate budget exhausted: ${blocked?.reason}`
      );

      // A writing phase gate CAN still reserve
      const writeGate = new BudgetGate({});
      writeGate.bindToBudgetLedger(smallLedger, 'run-global-1', undefined, true);
      const writeAllowed = await writeGate.beforeToolCall({
        name: 'write_section',
        arguments: {},
        call_id: 'call-w-1',
      });
      assert.equal(writeAllowed, undefined, 'Writing phase must still have access to reserved quota');
    });

    it('should aggregate per-task usage in BudgetLedger and CallLedger', () => {
      ledger.reserve({ run_id: 'run-agg', task_id: 'task-A', units: 3 });
      ledger.reserve({ run_id: 'run-agg', task_id: 'task-B', units: 4 });

      const usageA = ledger.getTaskUsage('task-A');
      assert.equal(usageA.reserved, 3);
      assert.equal(usageA.committed, 3);

      const usageB = ledger.getTaskUsage('task-B');
      assert.equal(usageB.reserved, 4);
      assert.equal(usageB.committed, 4);

      const taskUsageMap = ledger.getTasksUsage('run-agg');
      assert.equal(taskUsageMap.get('task-A')?.committed, 3);
      assert.equal(taskUsageMap.get('task-B')?.committed, 4);

      // CallLedger helpers
      assert.equal(callLedger.getTaskUsage('task-A').committed, 3);
      assert.equal(callLedger.checkTaskQuota('task-A', 5), true);
      assert.equal(callLedger.checkTaskQuota('task-A', 3), false);
    });
  });

  describe('4. Task Cancellation & Late Response Rejection', () => {
    it('should abort task signal when cancelTask is called on TaskCancellationController', () => {
      const controller = new TaskCancellationController();
      const signal = controller.createTaskSignal('task-cancel-1');

      assert.equal(signal.aborted, false);
      assert.equal(controller.isCancelled('task-cancel-1'), false);

      const cancelled = controller.cancelTask('task-cancel-1', 'User stopped the investigation');
      assert.equal(cancelled, true);
      assert.equal(signal.aborted, true);
      assert.equal(controller.isCancelled('task-cancel-1'), true);
      assert.ok(String(signal.reason).includes('User stopped the investigation'));
    });

    it('should drop late responses and reject writes from cancelled task attempts', async () => {
      const controller = new TaskCancellationController();
      const signal = controller.createTaskSignal('task-late-1');

      // Simulate an async operation that takes time
      let toolExecuted = false;
      const slowOperation = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        toolExecuted = true;
        return { data: 'secret findings' };
      };

      // Start operation guarded by controller
      const execPromise = controller.guard('task-late-1', async () => {
        return slowOperation();
      });

      // Cancel task while operation is in-flight
      controller.cancelTask('task-late-1', 'Task timed out');

      // The guarded execution should reject/drop the late response
      await assert.rejects(
        execPromise,
        /cancelled|dropped/i,
        'Late response must be rejected when task was cancelled'
      );
      assert.equal(toolExecuted, true, 'Tool ran, but its result must be dropped');

      // acceptResult must also drop results for cancelled task
      const resultAcceptance = controller.acceptResult('task-late-1', { findings: 'stale' });
      assert.equal(resultAcceptance.accepted, false);
      assert.ok(resultAcceptance.reason?.includes('dropped'));
    });

    it('should pass AbortSignal to tools in PiAgentAdapter and abort on controller signal', async () => {
      let toolReceivedAbort = false;

      const slowTool: ResearchToolDefinition = {
        name: 'slow_search',
        description: 'Slow tool',
        parameters: { type: 'object', properties: {} },
        execute: async (_params: any, signal?: AbortSignal) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              toolReceivedAbort = true;
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { data: 'late' };
        },
      };

      const scriptedStreamFn = createScriptedStreamFn([
        {
          toolCalls: [{ name: 'slow_search', arguments: {} }],
        },
        { text: 'Done' },
      ]);

      const adapter = new PiAgentAdapter({
        systemPrompt: 'Test',
        tools: [slowTool],
        streamFn: scriptedStreamFn,
      });

      const abortCtrl = new AbortController();
      const runPromise = adapter.run('Run search', abortCtrl.signal);

      // Abort quickly
      setTimeout(() => {
        abortCtrl.abort(new Error('Manual abort'));
      }, 10);

      await runPromise;

      assert.equal(toolReceivedAbort, true, 'Tool must receive abort signal event');
    });

    it('should enforce result immutability in acceptResult and reject overwrite of completed tasks', () => {
      const controller = new TaskCancellationController();

      const firstResult = controller.acceptResult('task-imm-1', { summary: 'initial findings' });
      assert.equal(firstResult.accepted, true);

      // Attempting to submit a second result for the same task must be rejected
      const secondResult = controller.acceptResult('task-imm-1', { summary: 'overwriting findings' });
      assert.equal(secondResult.accepted, false);
      assert.ok(
        secondResult.reason?.includes('already completed') && secondResult.reason?.includes('cannot be overwritten'),
        `Reason should indicate task already completed: ${secondResult.reason}`
      );
    });

    it('should return aborted signal when createTaskSignal is called for pre-cancelled task', () => {
      const controller = new TaskCancellationController();

      // Cancel task before signal was ever created
      controller.cancelTask('task-precancel-1', 'Pre-emptive cancellation');

      // Now create signal
      const signal = controller.createTaskSignal('task-precancel-1');
      assert.equal(signal.aborted, true, 'Signal must start in aborted state for pre-cancelled task');
      assert.ok(
        String(signal.reason).includes('Pre-emptive cancellation'),
        `Signal reason should reflect pre-cancellation: ${signal.reason}`
      );
    });

    it('should clean up in-memory reservation key on abort in BudgetGate.afterToolCall', async () => {
      const gate = new BudgetGate({});
      gate.bindToBudgetLedger(ledger, 'run-clean-1', 'task-clean-1');

      const toolCall: ToolCallSpec = {
        name: 'search',
        arguments: {},
        call_id: 'call-abort-key',
      };

      await gate.beforeToolCall(toolCall);
      assert.equal(gate.activeReservationCount, 1);
      assert.ok(gate.getActiveReservation('call-abort-key'));

      const abortCtrl = new AbortController();
      abortCtrl.abort(new Error('Tool timed out'));

      // afterToolCall with aborted signal
      await gate.afterToolCall(toolCall, null, abortCtrl.signal);

      // In-memory key must be cleaned up to avoid leak
      assert.equal(gate.activeReservationCount, 0, 'Abandoned reservation key must be deleted on abort');
      assert.equal(gate.getActiveReservation('call-abort-key'), undefined);
    });

    it('should forward callId as idempotency_key in BudgetGate and default taskLimit to 12', async () => {
      const gate = new BudgetGate({});
      gate.bindToBudgetLedger(ledger, 'run-idem-1', 'task-default-limit');

      // 1. Check idempotency: reserve twice with the same call_id
      const call1: ToolCallSpec = { name: 'search', arguments: {}, call_id: 'idem-call-1' };
      await gate.beforeToolCall(call1);
      const res1 = gate.getActiveReservation('idem-call-1');

      // Calling reserve directly with same idempotency key should return same reservation_id
      const dupReserve = ledger.reserve({
        run_id: 'run-idem-1',
        task_id: 'task-default-limit',
        idempotency_key: 'idem-call-1',
      });
      assert.equal(dupReserve.ok, true);
      assert.equal(dupReserve.reservation_id, res1);

      // 2. Check default task limit of 12 for standalone task without DB row
      // We already used 1 unit above, reserve 11 more
      for (let i = 2; i <= 12; i++) {
        const res = ledger.reserve({
          run_id: 'run-idem-1',
          task_id: 'task-default-limit',
          units: 1,
        });
        assert.equal(res.ok, true, `Unit ${i} should succeed within default limit 12`);
      }

      // 13th unit must exceed the default limit of 12
      const overLimitRes = ledger.reserve({
        run_id: 'run-idem-1',
        task_id: 'task-default-limit',
        units: 1,
      });
      assert.equal(overLimitRes.ok, false);
      assert.ok(overLimitRes.error?.includes('Task budget quota exceeded'));
      assert.ok(overLimitRes.error?.includes('max_allowed=12'));
    });
  });
});
