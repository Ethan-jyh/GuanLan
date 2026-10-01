import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { EventStore } from '../src/storage/event-store.js';
import {
  RunRepository,
  TaskRepository,
  SubmissionRepository,
  ReviewRepository,
} from '../src/storage/repositories.js';
import { RunStatus, TaskStatus, ResearchRole, DecisionType } from '../src/contracts/research.js';

describe('Task 2: Storage Layer, Evidence Store & Event Store Migration', () => {
  let db: ResearchDatabase;
  let rawDb: DatabaseSync;
  let evidenceStore: EvidenceStore;
  let eventStore: EventStore;
  let runRepo: RunRepository;
  let taskRepo: TaskRepository;
  let subRepo: SubmissionRepository;
  let reviewRepo: ReviewRepository;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    evidenceStore = new EvidenceStore(db);
    eventStore = new EventStore(db);
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    subRepo = new SubmissionRepository(db);
    reviewRepo = new ReviewRepository(db);
  });

  describe('Database Initialization & Schema', () => {
    it('should initialize all required tables and indices', () => {
      const tables = rawDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));

      assert.ok(tableNames.has('runs'));
      assert.ok(tableNames.has('tasks'));
      assert.ok(tableNames.has('budget_ledger'));
      assert.ok(tableNames.has('submissions'));
      assert.ok(tableNames.has('idempotency_records'));
      assert.ok(tableNames.has('reviews'));
      assert.ok(tableNames.has('evidence'));
      assert.ok(tableNames.has('research_events'));
    });
  });

  describe('Run & Task Repositories', () => {
    it('should create and retrieve runs by run_id with isolation', () => {
      runRepo.createRun({
        run_id: 'run-001',
        topic: 'AI舆情',
        scope: { domain: 'tech' },
        status: RunStatus.Planning,
        current_round: 1,
        max_rounds: 3,
        budget_total: 50,
        budget_used: 0,
        execution_version: 1,
        created_at: '2026-10-01T10:00:00Z',
        updated_at: '2026-10-01T10:00:00Z',
      });

      const retrieved = runRepo.getRun('run-001');
      assert.ok(retrieved);
      assert.equal(retrieved.run_id, 'run-001');
      assert.equal(retrieved.status, RunStatus.Planning);
      assert.deepEqual(retrieved.scope, { domain: 'tech' });

      // Non-existent or foreign run returns null
      assert.equal(runRepo.getRun('run-999'), null);
    });

    it('should update run status and current_round', () => {
      runRepo.createRun({
        run_id: 'run-002',
        topic: '应急事件',
        scope: {},
        status: RunStatus.Planning,
        current_round: 1,
        max_rounds: 3,
        budget_total: 50,
        budget_used: 0,
        execution_version: 1,
        created_at: '2026-10-01T10:00:00Z',
        updated_at: '2026-10-01T10:00:00Z',
      });

      runRepo.updateRunStatus('run-002', RunStatus.Researching, 2);
      const updated = runRepo.getRun('run-002');
      assert.equal(updated?.status, RunStatus.Researching);
      assert.equal(updated?.current_round, 2);
    });

    it('should create tasks and query by run_id', () => {
      taskRepo.createTask({
        task_id: 't-auth-1',
        run_id: 'run-001',
        role: ResearchRole.Authority,
        round: 1,
        question: 'Check authority report',
        scope: {},
        status: TaskStatus.Pending,
        budget_allocated: 12,
        created_at: '2026-10-01T10:00:00Z',
      });

      taskRepo.createTask({
        task_id: 't-evo-1',
        run_id: 'run-001',
        role: ResearchRole.Evolution,
        round: 1,
        question: 'Check evolution curve',
        scope: {},
        status: TaskStatus.Pending,
        budget_allocated: 12,
        created_at: '2026-10-01T10:00:00Z',
      });

      const tasksRun1 = taskRepo.listTasks('run-001');
      assert.equal(tasksRun1.length, 2);

      const tasksRun2 = taskRepo.listTasks('run-002');
      assert.equal(tasksRun2.length, 0);
    });
  });

  describe('EvidenceStore: Fingerprint, Deduplication & Run Isolation', () => {
    it('should add evidence, compute fingerprint, and deduplicate identical content', () => {
      const ev1 = evidenceStore.addEvidence({
        run_id: 'run-001',
        source_type: 'official_doc',
        source_ref: 'https://gov.example.com/doc/1',
        title: 'Notice 1',
        excerpt: 'Emergency flood response activated.',
      });

      assert.equal(ev1.evidence_id, 'E-001');
      assert.equal(ev1.title, 'Notice 1');

      // Add identical evidence in same run -> should return existing evidence
      const ev2 = evidenceStore.addEvidence({
        run_id: 'run-001',
        source_type: 'official_doc',
        source_ref: 'https://gov.example.com/doc/1',
        title: 'Notice 1 duplicate',
        excerpt: 'Emergency flood response activated.',
      });

      assert.equal(ev2.evidence_id, 'E-001');
      assert.equal(evidenceStore.listEvidence('run-001').length, 1);
    });

    it('should isolate evidence across different run_ids', () => {
      const evA = evidenceStore.addEvidence({
        run_id: 'run-A',
        source_type: 'news',
        source_ref: 'https://news.example.com/1',
        title: 'Report A',
        excerpt: 'Some text',
      });

      const evB = evidenceStore.addEvidence({
        run_id: 'run-B',
        source_type: 'news',
        source_ref: 'https://news.example.com/1',
        title: 'Report B',
        excerpt: 'Some text',
      });

      assert.equal(evA.evidence_id, 'E-001');
      assert.equal(evB.evidence_id, 'E-001');

      const listA = evidenceStore.listEvidence('run-A');
      const listB = evidenceStore.listEvidence('run-B');
      assert.equal(listA.length, 1);
      assert.equal(listB.length, 1);
      assert.equal(listA[0].title, 'Report A');
      assert.equal(listB[0].title, 'Report B');
    });
  });

  describe('EventStore: Monotonic Sequences & Incremental Catch-up', () => {
    it('should publish events with monotonic event_seq per run_id', () => {
      const s1 = eventStore.publishEvent('run-001', 'task_started', { task_id: 't-1' });
      const s2 = eventStore.publishEvent('run-001', 'tool_called', { tool: 'search' });
      const s3 = eventStore.publishEvent('run-001', 'task_completed', { task_id: 't-1' });

      assert.equal(s1, 1);
      assert.equal(s2, 2);
      assert.equal(s3, 3);

      // run-002 starts at 1
      const sRun2 = eventStore.publishEvent('run-002', 'run_started', {});
      assert.equal(sRun2, 1);
    });

    it('should fetch events incrementally using after_seq', () => {
      eventStore.publishEvent('run-001', 'e1', { n: 1 });
      eventStore.publishEvent('run-001', 'e2', { n: 2 });
      eventStore.publishEvent('run-001', 'e3', { n: 3 });

      const after1 = eventStore.getEvents('run-001', 1);
      assert.equal(after1.length, 2);
      assert.equal(after1[0].event_seq, 2);
      assert.equal(after1[1].event_seq, 3);
    });
  });

  describe('Submissions, Immutability & Transactions', () => {
    it('should save submission and prohibit overwriting version', () => {
      subRepo.saveSubmission({
        submission_id: 'sub-001',
        run_id: 'run-001',
        task_id: 't-auth-1',
        role: ResearchRole.Authority,
        round: 1,
        data: { claims: ['claim 1'] },
      });

      const fetched = subRepo.getSubmission('sub-001');
      assert.ok(fetched);
      assert.equal(fetched.role, ResearchRole.Authority);

      // Attempting to overwrite existing submission_id throws error
      assert.throws(
        () =>
          subRepo.saveSubmission({
            submission_id: 'sub-001',
            run_id: 'run-001',
            task_id: 't-auth-1',
            role: ResearchRole.Authority,
            round: 1,
            data: { claims: ['overwritten claim'] },
          }),
        /already exists|UNIQUE constraint failed|cannot overwrite/
      );
    });

    it('should rollback transaction on error', () => {
      assert.throws(() => {
        db.transaction(() => {
          subRepo.saveSubmission({
            submission_id: 'sub-tx-1',
            run_id: 'run-tx',
            task_id: 'task-1',
            role: ResearchRole.Authority,
            round: 1,
            data: { claims: [] },
          });

          // Simulate an error inside transaction
          throw new Error('Simulation of unexpected failure');
        });
      }, /Simulation of unexpected failure/);

      // Verifying submission was rolled back
      const sub = subRepo.getSubmission('sub-tx-1');
      assert.equal(sub, null);
    });
  });

  describe('Reviews Repository', () => {
    it('should save host review decision and retrieve by run and round', () => {
      reviewRepo.saveReview({
        review_id: 'rev-001',
        run_id: 'run-001',
        task_id: 'task-host-1',
        round: 1,
        decision: DecisionType.Revise,
        rationale: 'Need more feedback',
        directives: [
          {
            directive_id: 'd-1',
            target_role: ResearchRole.Feedback,
            related_claim_or_issue: 'issue 1',
            question: 'More info',
            suggested_action: 'Query comments',
            completion_criteria: 'sample > 1000',
          },
        ],
        unresolved_issues: ['unresolved 1'],
        created_at: '2026-10-01T11:00:00Z',
      });

      const retrieved = reviewRepo.getReview('run-001', 1);
      assert.ok(retrieved);
      assert.equal(retrieved.decision, DecisionType.Revise);
      assert.equal(retrieved.directives.length, 1);
      assert.equal(retrieved.unresolved_issues[0], 'unresolved 1');
    });
  });
});
