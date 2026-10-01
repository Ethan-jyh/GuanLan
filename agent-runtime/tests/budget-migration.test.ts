import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import { CallLedger } from '../src/orchestration/call-ledger.js';
import { BudgetGate } from '../src/runtime/budget-gate.js';

describe('Task 3: Budget Ledger & BudgetGate Binding Migration', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let ledger: BudgetLedger;
  let callLedger: CallLedger;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    // Initialize run with budget 50, reserved for writing 10 -> research tool limit = 40
    ledger = new BudgetLedger(db, {
      totalToolLimit: 50,
      reservedForWriting: 10,
    });
    callLedger = new CallLedger(ledger);
  });

  describe('BudgetLedger Quota & Atomic Reservation', () => {
    it('should reserve and settle quota correctly', () => {
      const res = ledger.reserve({
        run_id: 'run-b-1',
        task_id: 'task-1',
        units: 2,
        call_type: 'tool_call',
      });
      assert.equal(res.ok, true);
      assert.ok(res.reservation_id);

      const usageAfterReserve = ledger.getUsage('run-b-1');
      assert.equal(usageAfterReserve.reserved, 2);
      assert.equal(usageAfterReserve.used, 0);
      assert.equal(usageAfterReserve.committed, 2);

      ledger.settle({
        reservation_id: res.reservation_id!,
        actual_units: 2,
      });

      const usageAfterSettle = ledger.getUsage('run-b-1');
      assert.equal(usageAfterSettle.reserved, 0);
      assert.equal(usageAfterSettle.used, 2);
      assert.equal(usageAfterSettle.committed, 2);
    });

    it('should support idempotency keys to prevent duplicate deductions', () => {
      const res1 = ledger.reserve({
        run_id: 'run-b-1',
        task_id: 'task-1',
        units: 3,
        idempotency_key: 'idem-key-123',
      });
      assert.equal(res1.ok, true);

      // Same idempotency key returns same reservation without adding committed units
      const res2 = ledger.reserve({
        run_id: 'run-b-1',
        task_id: 'task-1',
        units: 3,
        idempotency_key: 'idem-key-123',
      });
      assert.equal(res2.ok, true);
      assert.equal(res2.reservation_id, res1.reservation_id);

      const usage = ledger.getUsage('run-b-1');
      assert.equal(usage.committed, 3);
    });

    it('should block reservations when research quota (total - writing reserve) is exceeded', () => {
      // Research quota = 40 (50 total - 10 reserved for writing)
      const res1 = ledger.reserve({
        run_id: 'run-b-2',
        task_id: 'task-1',
        units: 38,
      });
      assert.equal(res1.ok, true);

      // Requesting 3 more exceeds 40 -> rejected
      const res2 = ledger.reserve({
        run_id: 'run-b-2',
        task_id: 'task-1',
        units: 3,
      });
      assert.equal(res2.ok, false);
      assert.match(res2.error || '', /quota exceeded/i);

      // But writing phase CAN use the remaining 10 units up to total 50
      const resWriting = ledger.reserve({
        run_id: 'run-b-2',
        task_id: 'task-report',
        units: 5,
        is_writing_phase: true,
      });
      assert.equal(resWriting.ok, true);
    });

    it('two calls competing for the last quota: exactly one succeeds and one fails', () => {
      // Allocate 39 of 40
      ledger.reserve({ run_id: 'run-compete', units: 39 });

      // Two calls competing for 1 unit
      const r1 = ledger.reserve({ run_id: 'run-compete', units: 1 });
      const r2 = ledger.reserve({ run_id: 'run-compete', units: 1 });

      assert.equal(r1.ok, true);
      assert.equal(r2.ok, false);
      assert.match(r2.error || '', /quota exceeded/i);
    });
  });

  describe('CallLedger & Concurrent Tool Calls with Same Name', () => {
    it('should track reservations by call_id preventing same-name tool collisions', async () => {
      // Simulate two concurrent calls to 'search' tool
      const call1 = callLedger.beginCall({
        run_id: 'run-c-1',
        task_id: 't-1',
        call_id: 'call-uuid-1',
        tool_name: 'search',
        units: 1,
      });
      const call2 = callLedger.beginCall({
        run_id: 'run-c-1',
        task_id: 't-1',
        call_id: 'call-uuid-2',
        tool_name: 'search',
        units: 1,
      });

      assert.equal(call1.ok, true);
      assert.equal(call2.ok, true);
      assert.notEqual(call1.reservation_id, call2.reservation_id);

      // Settle call 1
      callLedger.endCall({
        call_id: 'call-uuid-1',
        success: true,
      });

      // Call 2 is still active and reserved
      const active = callLedger.getActiveCall('call-uuid-2');
      assert.ok(active);
      assert.equal(active.tool_name, 'search');

      // Settle call 2
      callLedger.endCall({
        call_id: 'call-uuid-2',
        success: true,
      });

      const usage = ledger.getUsage('run-c-1');
      assert.equal(usage.used, 2);
      assert.equal(usage.reserved, 0);
    });

    it('should record consumption on failed tool calls rather than silent refund', () => {
      callLedger.beginCall({
        run_id: 'run-fail',
        task_id: 't-1',
        call_id: 'call-failing',
        tool_name: 'timeline_search',
        units: 1,
      });

      // Tool call failed due to network or upstream error
      callLedger.endCall({
        call_id: 'call-failing',
        success: false,
        error: 'Timeout fetching data',
      });

      // Consumption should be counted as used
      const usage = ledger.getUsage('run-fail');
      assert.equal(usage.used, 1);
      assert.equal(usage.reserved, 0);
    });

    it('should not unconditionally wipe unknown reservations upon recovery', () => {
      // Create a reservation simulating uncompleted call before crash
      ledger.reserve({
        run_id: 'run-crash',
        task_id: 't-crash',
        units: 5,
        call_type: 'external_fetch',
      });

      const beforeRecovery = ledger.getUsage('run-crash');
      assert.equal(beforeRecovery.committed, 5);

      // On system restart / recovery, reserved units remain committed
      ledger.preserveUncertainReservations('run-crash');

      const afterRecovery = ledger.getUsage('run-crash');
      assert.equal(afterRecovery.committed, 5);
    });
  });

  describe('BudgetGate Binding to Ledger', () => {
    it('BudgetGate should enforce budget when bound to BudgetLedger by call_id', async () => {
      const gate = new BudgetGate({});
      gate.bindToBudgetLedger(ledger, 'run-gate-1', 'task-1');

      // First tool call
      const block1 = await gate.beforeToolCall({
        name: 'search',
        arguments: { query: 'test1' },
        call_id: 'call-gate-1',
      });
      assert.equal(block1, undefined);

      await gate.afterToolCall(
        { name: 'search', arguments: {}, call_id: 'call-gate-1' },
        { result: 'ok' }
      );

      const usage = ledger.getUsage('run-gate-1');
      assert.equal(usage.used, 1);
    });
  });
});
