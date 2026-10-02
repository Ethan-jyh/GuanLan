import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  createDatabase,
  ResearchDatabase,
  DatabaseMigrations,
} from '../src/storage/database.js';
import {
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
  IdempotencyRepository,
  TaskRepository,
  buildIdempotencyKey,
  saveOutcomeWithOutbox,
} from '../src/storage/repositories.js';
import { EventStore } from '../src/storage/event-store.js';
import { TaskStatus, ResearchRole } from '../src/contracts/task.js';

describe('Task 2: Storage Layer, Migrations, Repositories & Outbox', () => {
  let db: ResearchDatabase;
  let rawDb: DatabaseSync;
  let attemptRepo: TaskAttemptRepository;
  let resultRepo: TaskResultRepository;
  let outboxRepo: OutboxRepository;
  let hostInboxRepo: HostInboxRepository;
  let idemRepo: IdempotencyRepository;
  let taskRepo: TaskRepository;
  let eventStore: EventStore;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    attemptRepo = new TaskAttemptRepository(db);
    resultRepo = new TaskResultRepository(db);
    outboxRepo = new OutboxRepository(db);
    hostInboxRepo = new HostInboxRepository(db);
    idemRepo = new IdempotencyRepository(db);
    taskRepo = new TaskRepository(db);
    eventStore = new EventStore(db);
  });

  describe('Database 002 Migrations & Schema', () => {
    it('should initialize all required 002 tables and indices', () => {
      const tables = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));

      // 001 tables
      assert.ok(tableNames.has('runs'), 'runs table missing');
      assert.ok(tableNames.has('tasks'), 'tasks table missing');
      assert.ok(tableNames.has('budget_ledger'), 'budget_ledger table missing');
      assert.ok(tableNames.has('submissions'), 'submissions table missing');
      assert.ok(tableNames.has('idempotency_records'), 'idempotency_records table missing');
      assert.ok(tableNames.has('reviews'), 'reviews table missing');
      assert.ok(tableNames.has('evidence'), 'evidence table missing');
      assert.ok(tableNames.has('research_events'), 'research_events table missing');

      // 002 tables
      assert.ok(tableNames.has('task_attempts'), 'task_attempts table missing');
      assert.ok(tableNames.has('task_results'), 'task_results table missing');
      assert.ok(tableNames.has('event_outbox'), 'event_outbox table missing');
      assert.ok(tableNames.has('host_inbox'), 'host_inbox table missing');

      // 002 indices
      const indices = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;")
        .all() as Array<{ name: string }>;
      const indexNames = new Set(indices.map((i) => i.name));

      assert.ok(indexNames.has('idx_task_attempts_task'), 'idx_task_attempts_task missing');
      assert.ok(indexNames.has('idx_task_attempts_run'), 'idx_task_attempts_run missing');
      assert.ok(indexNames.has('idx_task_attempts_status'), 'idx_task_attempts_status missing');
      assert.ok(indexNames.has('idx_task_results_run'), 'idx_task_results_run missing');
      assert.ok(indexNames.has('idx_task_results_task'), 'idx_task_results_task missing');
      assert.ok(indexNames.has('idx_outbox_undelivered'), 'idx_outbox_undelivered missing');
      assert.ok(indexNames.has('idx_outbox_run'), 'idx_outbox_run missing');
      assert.ok(indexNames.has('idx_host_inbox_run_status'), 'idx_host_inbox_run_status missing');
    });

    it('should extend tasks table with 002 columns', () => {
      const taskColumns = rawDb
        .prepare('PRAGMA table_info(tasks);')
        .all() as Array<{ name: string; type: string }>;
      const colMap = new Map(taskColumns.map((c) => [c.name, c.type]));

      assert.ok(colMap.has('generation'), 'generation column missing');
      assert.ok(colMap.has('completion_criteria'), 'completion_criteria column missing');
      assert.ok(colMap.has('required_for_report'), 'required_for_report column missing');
      assert.ok(colMap.has('dependencies_json'), 'dependencies_json column missing');
      assert.ok(colMap.has('superseded_by'), 'superseded_by column missing');
    });

    it('DatabaseMigrations should track applied migrations and be idempotent', () => {
      const applied = DatabaseMigrations.getAppliedMigrations(rawDb);
      assert.ok(applied.includes('001-research'), '001 should be applied');
      assert.ok(applied.includes('002-subagent-tools'), '002 should be applied');

      // Re-applying migrations should not throw
      assert.doesNotThrow(() => {
        DatabaseMigrations.applyMigrations(rawDb);
      });
    });
  });

  describe('TaskAttemptRepository', () => {
    it('should create an attempt and retrieve it by attempt_id', () => {
      attemptRepo.createAttempt({
        attempt_id: 'att-001',
        task_id: 'task-auth-1',
        run_id: 'run-100',
        execution_version: 1,
        status: 'running',
        worker_lease: 'worker-pod-a',
        started_at: '2026-10-02T10:00:00Z',
      });

      const attempt = attemptRepo.getAttempt('att-001');
      assert.ok(attempt);
      assert.equal(attempt.attempt_id, 'att-001');
      assert.equal(attempt.task_id, 'task-auth-1');
      assert.equal(attempt.run_id, 'run-100');
      assert.equal(attempt.execution_version, 1);
      assert.equal(attempt.status, 'running');
      assert.equal(attempt.worker_lease, 'worker-pod-a');
      assert.equal(attempt.started_at, '2026-10-02T10:00:00Z');
      assert.equal(attempt.completed_at, null);
    });

    it('should update worker lease', () => {
      attemptRepo.createAttempt({
        attempt_id: 'att-lease-1',
        task_id: 'task-1',
        run_id: 'run-100',
        execution_version: 1,
        status: 'running',
        worker_lease: 'worker-1',
        started_at: '2026-10-02T10:00:00Z',
      });

      attemptRepo.updateWorkerLease('att-lease-1', 'worker-2');
      let att = attemptRepo.getAttempt('att-lease-1');
      assert.equal(att?.worker_lease, 'worker-2');

      attemptRepo.updateWorkerLease('att-lease-1', null);
      att = attemptRepo.getAttempt('att-lease-1');
      assert.equal(att?.worker_lease, null);
    });

    it('should update attempt status with completion, usage, and error', () => {
      attemptRepo.createAttempt({
        attempt_id: 'att-done-1',
        task_id: 'task-1',
        run_id: 'run-100',
        execution_version: 1,
        status: 'running',
        started_at: '2026-10-02T10:00:00Z',
      });

      attemptRepo.updateStatus('att-done-1', 'succeeded', {
        completed_at: '2026-10-02T10:05:00Z',
        usage: { tool_attempts: 3, model_tokens: 1200 },
      });

      const done = attemptRepo.getAttempt('att-done-1');
      assert.ok(done);
      assert.equal(done.status, 'succeeded');
      assert.equal(done.completed_at, '2026-10-02T10:05:00Z');
      assert.deepEqual(done.usage, { tool_attempts: 3, model_tokens: 1200 });
      assert.equal(done.error, null);
    });

    it('should list attempts by task and by run', () => {
      attemptRepo.createAttempt({
        attempt_id: 'att-t1-v1',
        task_id: 'task-1',
        run_id: 'run-100',
        execution_version: 1,
        status: 'failed',
        started_at: '2026-10-02T10:00:00Z',
      });
      attemptRepo.createAttempt({
        attempt_id: 'att-t1-v2',
        task_id: 'task-1',
        run_id: 'run-100',
        execution_version: 2,
        status: 'running',
        started_at: '2026-10-02T10:05:00Z',
      });
      attemptRepo.createAttempt({
        attempt_id: 'att-t2-v1',
        task_id: 'task-2',
        run_id: 'run-100',
        execution_version: 1,
        status: 'running',
        started_at: '2026-10-02T10:02:00Z',
      });

      const task1Attempts = attemptRepo.listAttemptsByTask('task-1');
      assert.equal(task1Attempts.length, 2);

      const run100Attempts = attemptRepo.listAttemptsByRun('run-100');
      assert.equal(run100Attempts.length, 3);
    });
  });

  describe('TaskResultRepository & Version Immutability', () => {
    it('should save task result and retrieve by version and latest', () => {
      resultRepo.saveResult({
        result_id: 'res-001',
        run_id: 'run-100',
        task_id: 'task-1',
        attempt_id: 'att-t1-v1',
        version: 1,
        role: 'authority',
        status: 'succeeded',
        findings: { statement: 'Official announcement verified', confidence: 0.95 },
        summary: 'Official report confirmed',
        evidence_refs: ['E-001', 'E-002'],
        created_at: '2026-10-02T10:05:00Z',
      });

      const res = resultRepo.getResult('run-100', 'task-1', 1);
      assert.ok(res);
      assert.equal(res.result_id, 'res-001');
      assert.equal(res.version, 1);
      assert.equal(res.role, 'authority');
      assert.equal(res.status, 'succeeded');
      assert.deepEqual(res.evidence_refs, ['E-001', 'E-002']);
      assert.deepEqual(res.findings, { statement: 'Official announcement verified', confidence: 0.95 });

      const latest = resultRepo.getLatestResult('run-100', 'task-1');
      assert.ok(latest);
      assert.equal(latest.version, 1);
    });

    it('should enforce version immutability (cannot overwrite same version)', () => {
      resultRepo.saveResult({
        result_id: 'res-v1',
        run_id: 'run-100',
        task_id: 'task-1',
        attempt_id: 'att-1',
        version: 1,
        role: 'authority',
        status: 'succeeded',
        findings: { data: 'initial' },
        summary: 'initial',
        evidence_refs: ['E-001'],
        created_at: '2026-10-02T10:00:00Z',
      });

      // Attempting to overwrite same run_id + task_id + version must throw
      assert.throws(
        () => {
          resultRepo.saveResult({
            result_id: 'res-v1-overwrite',
            run_id: 'run-100',
            task_id: 'task-1',
            attempt_id: 'att-2',
            version: 1,
            role: 'authority',
            status: 'succeeded',
            findings: { data: 'hacked' },
            summary: 'hacked',
            evidence_refs: ['E-999'],
            created_at: '2026-10-02T10:10:00Z',
          });
        },
        /UNIQUE constraint failed|cannot overwrite|already exists/i
      );

      // Verify content was not modified
      const res = resultRepo.getResult('run-100', 'task-1', 1);
      assert.equal(res?.summary, 'initial');
    });

    it('should allow subsequent version 2 without overwriting version 1', () => {
      resultRepo.saveResult({
        result_id: 'res-v1',
        run_id: 'run-100',
        task_id: 'task-1',
        attempt_id: 'att-1',
        version: 1,
        role: 'authority',
        status: 'partial',
        findings: { stage: 1 },
        summary: 'v1 summary',
        evidence_refs: ['E-001'],
        created_at: '2026-10-02T10:00:00Z',
      });

      resultRepo.saveResult({
        result_id: 'res-v2',
        run_id: 'run-100',
        task_id: 'task-1',
        attempt_id: 'att-2',
        version: 2,
        role: 'authority',
        status: 'succeeded',
        findings: { stage: 2 },
        summary: 'v2 summary',
        evidence_refs: ['E-001', 'E-002'],
        created_at: '2026-10-02T10:10:00Z',
      });

      const v1 = resultRepo.getResult('run-100', 'task-1', 1);
      const v2 = resultRepo.getResult('run-100', 'task-1', 2);
      const latest = resultRepo.getLatestResult('run-100', 'task-1');

      assert.equal(v1?.version, 1);
      assert.equal(v2?.version, 2);
      assert.equal(latest?.version, 2);
      assert.equal(latest?.summary, 'v2 summary');
    });
  });

  describe('OutboxRepository & Monotonic Catchup', () => {
    it('should append events, fetch undelivered, and mark delivered', () => {
      const e1Id = outboxRepo.appendEvent({
        run_id: 'run-100',
        task_id: 'task-1',
        event_type: 'research_outcome',
        payload: { outcome: 'succeeded', version: 1 },
      });
      const e2Id = outboxRepo.appendEvent({
        run_id: 'run-100',
        task_id: 'task-2',
        event_type: 'task_timeout',
        payload: { reason: 'timed out after 30s' },
      });

      assert.ok(e1Id > 0);
      assert.ok(e2Id > e1Id);

      // Fetch undelivered
      const undelivered = outboxRepo.getUndeliveredEvents('run-100');
      assert.equal(undelivered.length, 2);
      assert.equal(undelivered[0].event_type, 'research_outcome');
      assert.equal(undelivered[1].event_type, 'task_timeout');
      assert.equal(undelivered[0].delivered, false);

      // Mark first delivered
      outboxRepo.markDelivered(e1Id);
      const remaining = outboxRepo.getUndeliveredEvents('run-100');
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].event_id, e2Id);
    });

    it('should support monotonic catch-up via getEventsAfter', () => {
      const id1 = outboxRepo.appendEvent({
        run_id: 'run-100',
        task_id: 't-1',
        event_type: 'type-1',
        payload: { n: 1 },
      });
      const id2 = outboxRepo.appendEvent({
        run_id: 'run-100',
        task_id: 't-2',
        event_type: 'type-2',
        payload: { n: 2 },
      });
      const id3 = outboxRepo.appendEvent({
        run_id: 'run-100',
        task_id: 't-3',
        event_type: 'type-3',
        payload: { n: 3 },
      });

      const catchup = outboxRepo.getEventsAfter(id1, 'run-100');
      assert.equal(catchup.length, 2);
      assert.equal(catchup[0].event_id, id2);
      assert.equal(catchup[1].event_id, id3);
    });
  });

  describe('HostInboxRepository: Deduplication & Status Lifecycle', () => {
    it('should record host inbox event, claim pending, and mark processed', () => {
      const id1 = hostInboxRepo.recordEvent('run-100', 1);
      const id2 = hostInboxRepo.recordEvent('run-100', 2);

      assert.ok(id1 > 0);
      assert.ok(id2 > id1);

      // Claim pending events
      const claimed = hostInboxRepo.claimPending('run-100');
      assert.equal(claimed.length, 2);
      assert.equal(claimed[0].status, 'claimed');
      assert.ok(claimed[0].claimed_at);

      // Once claimed, calling claimPending again returns empty
      const claimedAgain = hostInboxRepo.claimPending('run-100');
      assert.equal(claimedAgain.length, 0);

      // Mark processed
      hostInboxRepo.markProcessed(id1);
      hostInboxRepo.markProcessed(id2);

      const all = hostInboxRepo.listByRun('run-100');
      assert.equal(all.every((r) => r.status === 'processed'), true);
      assert.ok(all[0].processed_at);
    });

    it('should deduplicate inbox events for same run and event_seq', () => {
      const idFirst = hostInboxRepo.recordEvent('run-100', 10);
      const idSecond = hostInboxRepo.recordEvent('run-100', 10);

      // Should return same or not create duplicate entry
      assert.equal(idFirst, idSecond);
      const list = hostInboxRepo.listByRun('run-100');
      assert.equal(list.length, 1);
    });
  });

  describe('saveOutcomeWithOutbox Atomic Transaction', () => {
    it('should atomically commit result, attempt update, and outbox event', () => {
      // Setup task and attempt first
      taskRepo.createTask({
        task_id: 'task-atom-1',
        run_id: 'run-atom',
        role: ResearchRole.Authority,
        round: 1,
        question: 'Check atomic outcome',
        scope: {},
        status: TaskStatus.Running,
        budget_allocated: 10,
        created_at: '2026-10-02T10:00:00Z',
      });

      attemptRepo.createAttempt({
        attempt_id: 'att-atom-1',
        task_id: 'task-atom-1',
        run_id: 'run-atom',
        execution_version: 1,
        status: 'running',
        worker_lease: 'worker-atom',
        started_at: '2026-10-02T10:00:00Z',
      });

      saveOutcomeWithOutbox(db, {
        result: {
          result_id: 'res-atom-1',
          run_id: 'run-atom',
          task_id: 'task-atom-1',
          attempt_id: 'att-atom-1',
          version: 1,
          role: 'authority',
          status: 'succeeded',
          findings: { valid: true },
          summary: 'Atomic test succeeded',
          evidence_refs: ['E-100'],
        },
        attempt_status: 'succeeded',
        completed_at: '2026-10-02T10:05:00Z',
        attempt_usage: { tool_attempts: 2 },
        outbox_event: {
          event_type: 'research_outcome',
          payload: { task_id: 'task-atom-1', status: 'succeeded' },
        },
        task_status: TaskStatus.Succeeded,
      });

      // Verify all 4 places were updated
      const res = resultRepo.getResult('run-atom', 'task-atom-1', 1);
      assert.ok(res);
      assert.equal(res.summary, 'Atomic test succeeded');

      const att = attemptRepo.getAttempt('att-atom-1');
      assert.equal(att?.status, 'succeeded');
      assert.equal(att?.completed_at, '2026-10-02T10:05:00Z');

      const undelivered = outboxRepo.getUndeliveredEvents('run-atom');
      assert.equal(undelivered.length, 1);
      assert.equal(undelivered[0].event_type, 'research_outcome');

      const task = taskRepo.getTask('task-atom-1');
      assert.equal(task?.status, TaskStatus.Succeeded);
    });

    it('should rollback transaction completely if outcome saving fails (e.g. duplicate version)', () => {
      taskRepo.createTask({
        task_id: 'task-atom-2',
        run_id: 'run-atom',
        role: ResearchRole.Evolution,
        round: 1,
        question: 'Check atomic rollback',
        scope: {},
        status: TaskStatus.Running,
        budget_allocated: 10,
        created_at: '2026-10-02T10:00:00Z',
      });

      attemptRepo.createAttempt({
        attempt_id: 'att-atom-2a',
        task_id: 'task-atom-2',
        run_id: 'run-atom',
        execution_version: 1,
        status: 'running',
        started_at: '2026-10-02T10:00:00Z',
      });

      // Save initial version 1
      resultRepo.saveResult({
        result_id: 'res-atom-existing-v1',
        run_id: 'run-atom',
        task_id: 'task-atom-2',
        attempt_id: 'att-atom-2a',
        version: 1,
        role: 'evolution',
        status: 'partial',
        findings: {},
        summary: 'first v1',
        evidence_refs: [],
        created_at: '2026-10-02T10:00:00Z',
      });

      // Another attempt for the same task tries to save version 1 again -> must fail & rollback
      attemptRepo.createAttempt({
        attempt_id: 'att-atom-2b',
        task_id: 'task-atom-2',
        run_id: 'run-atom',
        execution_version: 1,
        status: 'running',
        started_at: '2026-10-02T10:01:00Z',
      });

      assert.throws(() => {
        saveOutcomeWithOutbox(db, {
          result: {
            result_id: 'res-atom-conflict',
            run_id: 'run-atom',
            task_id: 'task-atom-2',
            attempt_id: 'att-atom-2b',
            version: 1, // CONFLICT!
            role: 'evolution',
            status: 'succeeded',
            findings: {},
            summary: 'should be rolled back',
            evidence_refs: [],
          },
          attempt_status: 'succeeded',
          outbox_event: {
            event_type: 'research_outcome',
            payload: { conflict: true },
          },
        });
      });

      // Verify attempt 2b is still 'running' and no outbox event was committed
      const att2b = attemptRepo.getAttempt('att-atom-2b');
      assert.equal(att2b?.status, 'running');

      const outboxEvents = outboxRepo.getUndeliveredEvents('run-atom');
      assert.equal(outboxEvents.filter((e) => e.task_id === 'task-atom-2').length, 0);
    });
  });

  describe('Idempotency Key & Records', () => {
    it('should format idempotency key from run_id + execution_version + host_turn_id + tool_call_id', () => {
      const key = buildIdempotencyKey({
        run_id: 'run-xyz',
        execution_version: 2,
        host_turn_id: 'turn-3',
        tool_call_id: 'call-456',
      });

      assert.equal(key, 'run-xyz:2:turn-3:call-456');
    });

    it('should save and retrieve idempotency records', () => {
      const key = buildIdempotencyKey({
        run_id: 'run-xyz',
        execution_version: 1,
        host_turn_id: 1,
        tool_call_id: 'call-1',
      });

      idemRepo.saveRecord({
        idempotency_key: key,
        call_id: 'call-1',
        response: { status: 'accepted', task_id: 'task-abc' },
      });

      const retrieved = idemRepo.getRecord(key);
      assert.ok(retrieved);
      assert.equal(retrieved.call_id, 'call-1');
      assert.deepEqual(retrieved.response, { status: 'accepted', task_id: 'task-abc' });
    });

    it('checkOrExecute should return cached response without running execution function', () => {
      const key = buildIdempotencyKey({
        run_id: 'run-xyz',
        execution_version: 1,
        host_turn_id: 2,
        tool_call_id: 'call-2',
      });

      let executionCount = 0;
      const fn = () => {
        executionCount++;
        return { status: 'accepted', count: executionCount };
      };

      const res1 = idemRepo.checkOrExecute(key, 'call-2', fn);
      assert.equal(res1.cached, false);
      assert.equal(res1.response.count, 1);
      assert.equal(executionCount, 1);

      // Second call with same key
      const res2 = idemRepo.checkOrExecute(key, 'call-2', fn);
      assert.equal(res2.cached, true);
      assert.equal(res2.response.count, 1);
      assert.equal(executionCount, 1, 'fn should not be called second time');
    });
  });

  describe('TaskRepository Extended Fields', () => {
    it('should create and retrieve task with generation, criteria, and dependencies', () => {
      taskRepo.createTask({
        task_id: 'task-ext-1',
        run_id: 'run-ext',
        role: ResearchRole.Authority,
        round: 1,
        generation: 2,
        question: 'Supplementary check',
        scope: { field: 'test' },
        completion_criteria: 'Must find doc version 2',
        required_for_report: false,
        dependencies: ['task-ext-0'],
        superseded_by: 'task-ext-2',
        status: TaskStatus.Running,
        budget_allocated: 8,
        created_at: '2026-10-02T10:00:00Z',
      });

      const task = taskRepo.getTask('task-ext-1');
      assert.ok(task);
      assert.equal(task.task_id, 'task-ext-1');
      assert.equal(task.generation, 2);
      assert.equal(task.completion_criteria, 'Must find doc version 2');
      assert.equal(task.required_for_report, false);
      assert.deepEqual(task.dependencies, ['task-ext-0']);
      assert.equal(task.superseded_by, 'task-ext-2');
    });
  });
});
