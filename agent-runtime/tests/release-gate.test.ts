import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import {
  RunRepository,
  TaskRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
  SubmissionRepository,
  ReviewRepository,
} from '../src/storage/repositories.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { TaskPlanner } from '../src/orchestration/planning.js';
import { ReviewManager } from '../src/orchestration/review.js';
import { SubmissionManager } from '../src/orchestration/submissions.js';
import {
  ReleaseGate,
  freezeMaterialSnapshot,
  type MaterialSnapshot,
  type ReleaseVerificationResult,
} from '../src/orchestration/release-gate.js';
import { buildReportInput } from '../src/reporting/input.js';
import {
  ResearchRole,
  RunStatus,
  TaskStatus,
  DecisionType,
  type ResearchTask,
} from '../src/contracts/research.js';
import type { ReleaseRequest } from '../src/contracts/research-job.js';

describe('Task 6: Revision Limit (generation <= 3), Material Snapshot & Release Gate', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let runRepo: RunRepository;
  let taskRepo: TaskRepository;
  let attemptRepo: TaskAttemptRepository;
  let resultRepo: TaskResultRepository;
  let outboxRepo: OutboxRepository;
  let inboxRepo: HostInboxRepository;
  let decisionRepo: HostDecisionRepository;
  let submissionRepo: SubmissionRepository;
  let reviewRepo: ReviewRepository;
  let evidenceStore: EvidenceStore;
  let releaseGate: ReleaseGate;

  const runId = 'run-test-gate-001';

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    attemptRepo = new TaskAttemptRepository(db);
    resultRepo = new TaskResultRepository(db);
    outboxRepo = new OutboxRepository(db);
    inboxRepo = new HostInboxRepository(db);
    decisionRepo = new HostDecisionRepository(db);
    submissionRepo = new SubmissionRepository(db);
    reviewRepo = new ReviewRepository(db);
    evidenceStore = new EvidenceStore(db);

    releaseGate = new ReleaseGate({
      db,
      taskRepo,
      resultRepo,
      evidenceStore,
      runRepo,
      outboxRepo,
      inboxRepo,
    });

    // Create base run
    const nowIso = new Date().toISOString();
    runRepo.createRun({
      run_id: runId,
      topic: 'Test Topic: Public Incident',
      scope: {},
      status: RunStatus.Researching,
      current_round: 1,
      max_rounds: 3,
      budget_total: 50,
      budget_used: 0,
      execution_version: 1,
      created_at: nowIso,
      updated_at: nowIso,
    });
  });

  describe('1. Revision Limit (generation <= 3)', () => {
    it('initial research task for a question starts at generation = 1', () => {
      const planner = new TaskPlanner(taskRepo);
      const planned = planner.createPlannedTasks(runId, 1, [
        {
          role: ResearchRole.Authority,
          question: 'What is the official response timing?',
          budget_allocated: 10,
          completion_criteria: 'Find statement from official account',
          scope: {},
        },
      ]);

      assert.equal(planned.length, 1);
      assert.equal(planned[0].generation, 1);

      const saved = taskRepo.getTask(planned[0].task_id);
      assert.ok(saved);
      assert.equal(saved?.generation, 1);
    });

    it('follow-up tasks targeting the same core question increment generation up to 3', () => {
      const planner = new TaskPlanner(taskRepo);
      const question = 'What is the official response timing?';

      // Gen 1
      const [t1] = planner.createPlannedTasks(runId, 1, [
        {
          role: ResearchRole.Authority,
          question,
          budget_allocated: 10,
          completion_criteria: 'Initial search',
          scope: {},
        },
      ]);
      assert.equal(t1.generation, 1);

      // Follow-up: Gen 2
      const t2 = planner.planFollowUpTask(runId, t1.task_id, {
        completion_criteria: 'Deeper query on timestamp discrepancies',
      });
      assert.equal(t2.generation, 2);

      // Follow-up: Gen 3
      const t3 = planner.planFollowUpTask(runId, t2.task_id, {
        completion_criteria: 'Final cross-examination with archive',
      });
      assert.equal(t3.generation, 3);

      // Next follow-up should be blocked (generation > 3 prohibited)
      assert.throws(
        () => {
          planner.planFollowUpTask(runId, t3.task_id, {
            completion_criteria: 'Another attempt that should fail',
          });
        },
        (err: any) => {
          return /generation/i.test(err.message) && /(limit|exceed|3)/i.test(err.message);
        }
      );
    });

    it('createPlannedTasks blocks follow-up tasks targeting same question when generation > 3', () => {
      const planner = new TaskPlanner(taskRepo);
      const question = 'What is the core timeline?';

      // Explicitly set generation: 3
      planner.createPlannedTasks(runId, 1, [
        {
          task_id: 'task-auth-gen3',
          role: ResearchRole.Authority,
          question,
          budget_allocated: 10,
          completion_criteria: 'Round 3 findings',
          scope: {},
          generation: 3,
        },
      ]);

      // Planning a new task with same question should infer gen 4 and throw
      assert.throws(
        () => {
          planner.createPlannedTasks(runId, 2, [
            {
              role: ResearchRole.Authority,
              question,
              budget_allocated: 10,
              completion_criteria: 'Further follow-up',
              scope: {},
            },
          ]);
        },
        (err: any) => {
          return /generation/i.test(err.message);
        }
      );

      // Planning with explicit generation > 3 should also fail validation
      assert.throws(
        () => {
          planner.createPlannedTasks(runId, 2, [
            {
              role: ResearchRole.Authority,
              question: 'Completely new question',
              budget_allocated: 10,
              completion_criteria: 'Invalid gen',
              scope: {},
              generation: 4,
            },
          ]);
        },
        (err: any) => {
          return /generation/i.test(err.message);
        }
      );
    });

    it('ReviewManager revise directive increments generation and rejects when exceeding generation 3', () => {
      const subMgr = new SubmissionManager(submissionRepo, taskRepo, evidenceStore);
      const revMgr = new ReviewManager(runRepo, taskRepo, reviewRepo, subMgr);

      // Seed initial task gen 1
      taskRepo.createTask({
        task_id: 'task-auth-r1',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: 'Official statement',
        scope: {},
        status: TaskStatus.Succeeded,
        budget_allocated: 10,
        created_at: new Date().toISOString(),
      });

      // Revise round 1 -> creates task gen 2
      revMgr.submitReviewDecision(runId, {
        task_id: 'task-auth-r1',
        round: 1,
        decision: DecisionType.Revise,
        rationale: 'Need deeper investigation',
        unresolved_issues: [],
        directives: [
          {
            directive_id: 'dir-1',
            target_role: ResearchRole.Authority,
            related_claim_or_issue: 'issue-1',
            question: 'Official statement clarification',
            suggested_action: 'check archive',
            completion_criteria: 'verify date',
          },
        ],
      });

      const tasksAfterR1 = taskRepo.listTasks(runId);
      const r2Task = tasksAfterR1.find((t) => t.round === 2);
      assert.ok(r2Task);
      assert.equal(r2Task?.generation, 2);

      // Revise round 2 -> creates task gen 3
      revMgr.submitReviewDecision(runId, {
        task_id: r2Task!.task_id,
        round: 2,
        decision: DecisionType.Revise,
        rationale: 'Still ambiguous',
        unresolved_issues: [],
        directives: [
          {
            directive_id: 'dir-2',
            target_role: ResearchRole.Authority,
            related_claim_or_issue: 'issue-2',
            question: 'Final official statement check',
            suggested_action: 'check press release',
            completion_criteria: 'confirm timestamp',
          },
        ],
      });

      const tasksAfterR2 = taskRepo.listTasks(runId);
      const r3Task = tasksAfterR2.find((t) => t.round === 3);
      assert.ok(r3Task);
      assert.equal(r3Task?.generation, 3);

      // Revise on round 3 is blocked by mandatory convergence
      assert.throws(() => {
        revMgr.submitReviewDecision(runId, {
          task_id: r3Task!.task_id,
          round: 3,
          decision: DecisionType.Revise,
          rationale: 'Endless revision',
          unresolved_issues: [],
          directives: [
            {
              directive_id: 'dir-3',
              target_role: ResearchRole.Authority,
              related_claim_or_issue: 'issue-3',
              question: 'Exceeding limit',
              suggested_action: 'retry',
              completion_criteria: 'impossible',
            },
          ],
        });
      }, /mandatory convergence/i);
    });

    it('technical retries (attempts) do NOT increment task generation', () => {
      const taskId = 'task-auth-retry-001';
      taskRepo.createTask({
        task_id: taskId,
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: 'Official statement',
        scope: {},
        status: TaskStatus.Running,
        budget_allocated: 10,
        created_at: new Date().toISOString(),
      });

      // Attempt 1: failed (e.g. timeout / network error)
      attemptRepo.createAttempt({
        attempt_id: 'att-1',
        task_id: taskId,
        run_id: runId,
        execution_version: 1,
        status: 'failed',
        started_at: new Date().toISOString(),
      });

      // Attempt 2: retry of the SAME task
      attemptRepo.createAttempt({
        attempt_id: 'att-2',
        task_id: taskId,
        run_id: runId,
        execution_version: 2,
        status: 'succeeded',
        started_at: new Date().toISOString(),
      });

      // Task's generation must remain 1
      const task = taskRepo.getTask(taskId);
      assert.equal(task?.generation, 1);

      const attempts = attemptRepo.listAttemptsByTask(taskId);
      assert.equal(attempts.length, 2);
    });
  });

  describe('2. ReleaseGate: 6-Criteria Verification', () => {
    function setupValidBaseline() {
      const nowIso = new Date().toISOString();

      // 1. Evidence in store
      evidenceStore.addEvidence({
        run_id: runId,
        source_type: 'official_gov',
        source_ref: 'https://example.gov.cn/notice/1',
        title: 'Official Notification',
        excerpt: 'The investigation concluded on October 1st.',
      }); // E-001
      evidenceStore.addEvidence({
        run_id: runId,
        source_type: 'news',
        source_ref: 'https://example.com/news/1',
        title: 'Media Coverage',
        excerpt: 'Public sentiment peaked on September 28.',
      }); // E-002
      evidenceStore.addEvidence({
        run_id: runId,
        source_type: 'social_media',
        source_ref: 'https://weibo.com/p/1',
        title: 'User Comments',
        excerpt: 'Users voiced concerns over transparency.',
      }); // E-003

      // 2. Three required tasks for authority, evolution, feedback
      const roles = [ResearchRole.Authority, ResearchRole.Evolution, ResearchRole.Feedback];
      for (let i = 0; i < roles.length; i++) {
        const role = roles[i];
        const taskId = `task-${role}-ok`;
        const evidenceId = `E-00${i + 1}`;

        taskRepo.createTask({
          task_id: taskId,
          run_id: runId,
          role,
          round: 1,
          generation: 1,
          question: `Core question for ${role}`,
          scope: {},
          status: TaskStatus.Succeeded,
          required_for_report: true,
          budget_allocated: 10,
          created_at: nowIso,
          completed_at: nowIso,
        });

        resultRepo.saveResult({
          result_id: `result-${taskId}-v1`,
          run_id: runId,
          task_id: taskId,
          attempt_id: `att-${taskId}-1`,
          version: 1,
          role,
          status: 'succeeded',
          findings: {
            claims: [
              {
                claim_id: `claim-${role}-1`,
                statement: `Key conclusion for ${role}`,
                evidence_ids: [evidenceId],
              },
            ],
          },
          summary: `Summary for ${role}`,
          evidence_refs: [evidenceId],
          created_at: nowIso,
        });
      }
    }

    it('passes release verification on clean baseline and generates material snapshot', () => {
      setupValidBaseline();

      const verification = releaseGate.verifyRelease(runId);
      assert.equal(verification.ok, true);
      assert.equal(verification.restricted, false);
      assert.equal(verification.gaps.length, 0);
      assert.ok(verification.snapshotId);
      assert.ok(verification.snapshot);
      assert.equal(verification.snapshot?.tasks.length, 3);
      assert.equal(verification.snapshot?.accepted_results.length, 3);
      assert.equal(verification.snapshot?.claims.length, 3);
      assert.equal(verification.snapshot?.evidence_pool.length, 3);
    });

    it('Criterion 1: rejects release when required task has no accepted result and no gap justification', () => {
      setupValidBaseline();

      // Add a 4th required task that failed
      const nowIso = new Date().toISOString();
      taskRepo.createTask({
        task_id: 'task-essential-failed',
        run_id: runId,
        role: ResearchRole.Evolution,
        round: 1,
        generation: 1,
        question: 'Critical evolution curve',
        scope: {},
        status: TaskStatus.Failed,
        required_for_report: true,
        budget_allocated: 10,
        created_at: nowIso,
      });

      const verification = releaseGate.verifyRelease(runId);
      assert.equal(verification.ok, false);
      assert.ok(
        verification.errors?.some(
          (e: string) => e.includes('task-essential-failed') && /no accepted result/i.test(e)
        )
      );
    });

    it('Criterion 1: accepts release as restricted delivery when missing item is in allowed_gaps', () => {
      setupValidBaseline();

      // Add a required task that failed
      const nowIso = new Date().toISOString();
      taskRepo.createTask({
        task_id: 'task-evo-failed',
        run_id: runId,
        role: ResearchRole.Evolution,
        round: 1,
        generation: 1,
        question: 'Historical volume curve',
        scope: {},
        status: TaskStatus.Failed,
        required_for_report: true,
        budget_allocated: 10,
        created_at: nowIso,
      });

      const releaseReq: ReleaseRequest = {
        run_id: runId,
        allowed_gaps: ['task-evo-failed: historical volume data unavailable due to platform restriction'],
        rationale: 'Official responses and public attitudes are sufficient for delivery',
        restricted: true,
        target_format: 'docx',
        unresolved_issues: [],
      };

      const verification = releaseGate.verifyRelease(runId, releaseReq);
      assert.equal(verification.ok, true);
      assert.equal(verification.restricted, true);
      assert.ok(verification.gaps.length > 0);
      assert.ok(verification.snapshotId);
    });

    it('Criterion 2: rejects release when standard role is uncalled without explicit not_applicable justification', () => {
      // Setup only authority and evolution; omit feedback
      const nowIso = new Date().toISOString();
      evidenceStore.addEvidence({
        run_id: runId,
        source_type: 'official_gov',
        source_ref: 'https://example.gov.cn/notice/1',
        title: 'Official Notification',
        excerpt: 'The investigation concluded on October 1st.',
      });

      taskRepo.createTask({
        task_id: 'task-auth-ok',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: 'Official statement',
        scope: {},
        status: TaskStatus.Succeeded,
        required_for_report: true,
        budget_allocated: 10,
        created_at: nowIso,
      });
      resultRepo.saveResult({
        result_id: 'res-auth-1',
        run_id: runId,
        task_id: 'task-auth-ok',
        attempt_id: 'att-1',
        version: 1,
        role: 'authority',
        status: 'succeeded',
        findings: { claims: [] },
        created_at: nowIso,
      });

      taskRepo.createTask({
        task_id: 'task-evo-ok',
        run_id: runId,
        role: ResearchRole.Evolution,
        round: 1,
        generation: 1,
        question: 'Event evolution',
        scope: {},
        status: TaskStatus.Succeeded,
        required_for_report: true,
        budget_allocated: 10,
        created_at: nowIso,
      });
      resultRepo.saveResult({
        result_id: 'res-evo-1',
        run_id: runId,
        task_id: 'task-evo-ok',
        attempt_id: 'att-2',
        version: 1,
        role: 'evolution',
        status: 'succeeded',
        findings: { claims: [] },
        created_at: nowIso,
      });

      // Feedback was NOT called, and no not_applicable justification provided
      const verification = releaseGate.verifyRelease(runId);
      assert.equal(verification.ok, false);
      assert.ok(
        verification.errors?.some(
          (e: string) => e.includes('feedback') && /not_applicable/i.test(e)
        ),
        'Should report uncalled role feedback missing not_applicable justification'
      );

      // Now provide explicit not_applicable justification in release request
      const releaseReq: ReleaseRequest = {
        allowed_gaps: ['feedback: not_applicable (private institutional memo, no public discourse)'],
        rationale: 'Feedback role is not applicable for internal regulatory inquiry',
        restricted: true,
        target_format: 'docx',
        unresolved_issues: [],
      };

      const verificationWithJustification = releaseGate.verifyRelease(runId, releaseReq);
      assert.equal(verificationWithJustification.ok, true);
      assert.equal(verificationWithJustification.restricted, true);
    });

    it('Criterion 3: rejects release when tasks are running or queued, or inbox/outbox has pending events', () => {
      setupValidBaseline();

      // Add a running task
      taskRepo.createTask({
        task_id: 'task-still-running',
        run_id: runId,
        role: ResearchRole.Feedback,
        round: 1,
        generation: 1,
        question: 'Late survey',
        scope: {},
        status: TaskStatus.Running,
        required_for_report: true,
        budget_allocated: 10,
        created_at: new Date().toISOString(),
      });

      let verification = releaseGate.verifyRelease(runId);
      assert.equal(verification.ok, false);
      assert.ok(
        verification.errors?.some(
          (e: string) => e.includes('task-still-running') && /in progress|running/i.test(e)
        )
      );

      // Mark running task cancelled
      taskRepo.updateTaskStatus('task-still-running', TaskStatus.Cancelled);

      // Now create an unhandled inbox event
      inboxRepo.recordEvent(runId, 999);

      verification = releaseGate.verifyRelease(runId);
      assert.equal(verification.ok, false);
      assert.ok(
        verification.errors?.some((e: string) => /unhandled|inbox/i.test(e)),
        'Should detect unhandled inbox event'
      );
    });

    it('Criterion 4: rejects release when claims reference non-existent evidence IDs', () => {
      setupValidBaseline();

      // Add a result with phantom evidence ID 'E-999'
      const nowIso = new Date().toISOString();
      const taskId = 'task-auth-phantom';
      taskRepo.createTask({
        task_id: taskId,
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: 'Phantom claim check',
        scope: {},
        status: TaskStatus.Succeeded,
        required_for_report: true,
        budget_allocated: 10,
        created_at: nowIso,
      });

      resultRepo.saveResult({
        result_id: `res-${taskId}-1`,
        run_id: runId,
        task_id: taskId,
        attempt_id: 'att-p1',
        version: 1,
        role: 'authority',
        status: 'succeeded',
        findings: {
          claims: [
            {
              claim_id: 'claim-phantom-1',
              statement: 'Unverifiable claim pointing to ghost evidence',
              evidence_ids: ['E-999'],
            },
          ],
        },
        summary: 'Phantom evidence result',
        evidence_refs: ['E-999'],
        created_at: nowIso,
      });

      const verification = releaseGate.verifyRelease(runId);
      assert.equal(verification.ok, false);
      assert.ok(
        verification.errors?.some(
          (e: string) => e.includes('E-999') && /evidence/i.test(e)
        ),
        'Should detect unresolved evidence ID E-999'
      );
    });

    it('Criterion 5: validates snapshot binding and invalidates when newer results appear', () => {
      setupValidBaseline();

      // Freeze a baseline snapshot
      const snapshot = releaseGate.freezeMaterialSnapshot(runId);
      assert.ok(snapshot.snapshot_id);

      // Verify with this bound snapshot -> passes
      const res1 = releaseGate.verifyRelease(runId, {
        snapshot_id: snapshot.snapshot_id,
        rationale: 'Verifying bound snapshot',
        allowed_gaps: [],
        unresolved_issues: [],
        restricted: false,
        target_format: 'docx',
      });
      assert.equal(res1.ok, true);
      assert.equal(res1.snapshotId, snapshot.snapshot_id);

      // Now insert a new task result after the snapshot creation time
      const laterIso = new Date(Date.now() + 5000).toISOString();
      resultRepo.saveResult({
        result_id: 'res-late-001',
        run_id: runId,
        task_id: 'task-authority-ok',
        attempt_id: 'att-late-1',
        version: 2,
        role: 'authority',
        status: 'succeeded',
        findings: { claims: [] },
        created_at: laterIso,
      });

      // Verify with the old snapshot_id -> must be rejected as invalidated
      const res2 = releaseGate.verifyRelease(runId, {
        snapshot_id: snapshot.snapshot_id,
        rationale: 'Verifying stale snapshot',
        allowed_gaps: [],
        unresolved_issues: [],
        restricted: false,
        target_format: 'docx',
      });
      assert.equal(res2.ok, false);
      assert.ok(
        res2.errors?.some((e: string) => /invalidated|newer/i.test(e)),
        'Old snapshot must be invalidated by new task results'
      );
    });
  });

  describe('3. MaterialSnapshot Immutability (freezeMaterialSnapshot)', () => {
    it('freezeMaterialSnapshot saves frozen snapshot to SQLite and is immune to late results', () => {
      const nowIso = new Date().toISOString();

      evidenceStore.addEvidence({
        run_id: runId,
        source_type: 'official',
        source_ref: 'https://example.gov.cn/doc1',
        title: 'Doc 1',
        excerpt: 'Evidence text',
      });

      taskRepo.createTask({
        task_id: 'task-snap-1',
        run_id: runId,
        role: ResearchRole.Authority,
        round: 1,
        generation: 1,
        question: 'Core question',
        scope: {},
        status: TaskStatus.Succeeded,
        required_for_report: true,
        budget_allocated: 10,
        created_at: nowIso,
      });

      resultRepo.saveResult({
        result_id: 'res-snap-1',
        run_id: runId,
        task_id: 'task-snap-1',
        attempt_id: 'att-1',
        version: 1,
        role: 'authority',
        status: 'succeeded',
        findings: {
          claims: [
            {
              claim_id: 'c-1',
              statement: 'Early finding',
              evidence_ids: ['E-001'],
            },
          ],
        },
        evidence_refs: ['E-001'],
        created_at: nowIso,
      });

      // Freeze snapshot
      const snapshot = releaseGate.freezeMaterialSnapshot(runId);
      assert.ok(snapshot.snapshot_id.startsWith('snap-'));
      assert.equal(snapshot.accepted_results.length, 1);
      assert.equal(snapshot.claims.length, 1);

      // Simulate late-arriving result
      const lateIso = new Date(Date.now() + 2000).toISOString();
      resultRepo.saveResult({
        result_id: 'res-late-arrived',
        run_id: runId,
        task_id: 'task-snap-1',
        attempt_id: 'att-late',
        version: 2,
        role: 'authority',
        status: 'succeeded',
        findings: {
          claims: [
            {
              claim_id: 'c-late',
              statement: 'Late finding that must not alter snapshot',
              evidence_ids: ['E-001'],
            },
          ],
        },
        created_at: lateIso,
      });

      // Re-read snapshot from release gate
      const retrieved = releaseGate.getMaterialSnapshot(snapshot.snapshot_id);
      assert.ok(retrieved);
      assert.equal(retrieved?.snapshot_id, snapshot.snapshot_id);
      assert.equal(retrieved?.accepted_results.length, 1);
      assert.equal(retrieved?.claims.length, 1);
      assert.equal(retrieved?.claims[0].claim_id, 'c-1');
      // Must NOT contain c-late
      assert.ok(!retrieved?.claims.some((c: any) => c.claim_id === 'c-late'));
    });

    it('standalone freezeMaterialSnapshot function works directly with db or repositories', () => {
      const nowIso = new Date().toISOString();
      taskRepo.createTask({
        task_id: 'task-standalone',
        run_id: runId,
        role: ResearchRole.Evolution,
        round: 1,
        generation: 1,
        question: 'Standalone check',
        scope: {},
        status: TaskStatus.Succeeded,
        budget_allocated: 10,
        created_at: nowIso,
      });

      const snap = freezeMaterialSnapshot(runId, { db });
      assert.ok(snap.snapshot_id);
      assert.equal(snap.run_id, runId);
    });
  });

  describe('4. Reporting Input Integration (buildReportInput)', () => {
    it('buildReportInput consumes frozen MaterialSnapshot seamlessly', () => {
      const snapshot: MaterialSnapshot = {
        snapshot_id: 'snap-rep-001',
        run_id: runId,
        created_at: new Date().toISOString(),
        tasks: [],
        accepted_results: [
          {
            result_id: 'res-1',
            run_id: runId,
            task_id: 'task-1',
            attempt_id: 'att-1',
            version: 2,
            role: 'authority',
            status: 'succeeded',
            findings: {
              raw_text: 'Official notice summary',
            },
            evidence_refs: ['E-001'],
            created_at: new Date().toISOString(),
          },
        ],
        claims: [
          {
            claim_id: 'claim-1',
            statement: 'Investigation concluded on Oct 1.',
            evidence_ids: ['E-001'],
            limitations: [],
          },
        ],
        evidence_pool: [
          {
            evidence_id: 'E-001',
            source_type: 'official',
            source_ref: 'https://example.gov.cn/notice',
            title: 'Notice',
            excerpt: 'The investigation concluded on Oct 1.',
            retrieval_time: new Date().toISOString(),
            is_full_text: false,
          },
        ],
        gaps: ['Evolution data gap accepted'],
        uncalled_roles: ['feedback'],
        restricted: true,
      };

      const repInput = buildReportInput(
        runId,
        'Public Incident Report',
        { scope_key: 'val' },
        snapshot
      );

      assert.equal(repInput.run_id, runId);
      assert.equal(repInput.topic, 'Public Incident Report');
      assert.equal(repInput.research_versions['authority'], 2);
      assert.equal(repInput.claims.length, 1);
      assert.equal(repInput.evidence_pool.length, 1);
      assert.ok(repInput.unresolved_issues.includes('Evolution data gap accepted'));
    });

    it('buildReportInput rejects foreign run snapshot to preserve isolation', () => {
      const foreignSnapshot: MaterialSnapshot = {
        snapshot_id: 'snap-foreign',
        run_id: 'foreign-run-id',
        created_at: new Date().toISOString(),
        tasks: [],
        accepted_results: [],
        claims: [],
        evidence_pool: [],
        gaps: [],
        uncalled_roles: [],
        restricted: false,
      };

      assert.throws(
        () => {
          buildReportInput(runId, 'Topic', {}, foreignSnapshot);
        },
        /cross-run isolation/i
      );
    });
  });
});
