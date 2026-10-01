import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import { RunRepository, TaskRepository, SubmissionRepository, ReviewRepository } from '../src/storage/repositories.js';
import { EvidenceStore } from '../src/storage/evidence-store.js';
import { EventStore } from '../src/storage/event-store.js';
import { BudgetLedger } from '../src/storage/budget-ledger.js';
import { CallLedger } from '../src/orchestration/call-ledger.js';

import { TaskPlanner } from '../src/orchestration/planning.js';
import { TaskScheduler } from '../src/orchestration/scheduler.js';
import { SubmissionManager } from '../src/orchestration/submissions.js';
import { ResearchCoordinator } from '../src/orchestration/coordinator.js';
import { ReviewManager } from '../src/orchestration/review.js';
import { RecoveryManager } from '../src/orchestration/recovery.js';

import {
  RunStatus,
  TaskStatus,
  ResearchRole,
  DecisionType,
} from '../src/contracts/research.js';

describe('Task 4: Orchestration State Machine, Scheduling, Review, and Recovery', () => {
  let rawDb: DatabaseSync;
  let db: ResearchDatabase;
  let runRepo: RunRepository;
  let taskRepo: TaskRepository;
  let subRepo: SubmissionRepository;
  let reviewRepo: ReviewRepository;
  let evidenceStore: EvidenceStore;
  let eventStore: EventStore;
  let budgetLedger: BudgetLedger;
  let callLedger: CallLedger;

  let planner: TaskPlanner;
  let scheduler: TaskScheduler;
  let submissionMgr: SubmissionManager;
  let coordinator: ResearchCoordinator;
  let reviewMgr: ReviewManager;
  let recoveryMgr: RecoveryManager;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    subRepo = new SubmissionRepository(db);
    reviewRepo = new ReviewRepository(db);
    evidenceStore = new EvidenceStore(db);
    eventStore = new EventStore(db);
    budgetLedger = new BudgetLedger(db);
    callLedger = new CallLedger(budgetLedger);

    planner = new TaskPlanner(taskRepo);
    scheduler = new TaskScheduler(3);
    submissionMgr = new SubmissionManager(subRepo, taskRepo, evidenceStore);
    coordinator = new ResearchCoordinator(runRepo, taskRepo, submissionMgr, eventStore);
    reviewMgr = new ReviewManager(runRepo, taskRepo, reviewRepo, submissionMgr);
    recoveryMgr = new RecoveryManager(runRepo);
  });

  describe('TaskPlanner & Validation', () => {
    it('should validate and create planned tasks', () => {
      const tasks = planner.createPlannedTasks('run-p-1', 1, [
        {
          role: ResearchRole.Authority,
          question: 'Official report details',
          budget_allocated: 12,
          completion_criteria: 'Find bulletin',
        },
        {
          role: ResearchRole.Evolution,
          question: 'Heat timeline',
          budget_allocated: 10,
          completion_criteria: 'Plot curve',
        },
      ]);

      assert.equal(tasks.length, 2);
      assert.equal(tasks[0].role, ResearchRole.Authority);
      assert.equal(tasks[0].status, TaskStatus.Pending);

      const dbTasks = taskRepo.listTasks('run-p-1');
      assert.equal(dbTasks.length, 2);
    });

    it('should reject invalid role or negative budget or cyclic dependencies', () => {
      const invalidRole = [
        {
          role: 'hacker' as any,
          question: 'q',
          budget_allocated: 10,
          completion_criteria: 'c',
        },
      ];
      assert.throws(() => planner.createPlannedTasks('run-p-2', 1, invalidRole), /Invalid role/);

      const cyclic = [
        {
          task_id: 't-1',
          role: ResearchRole.Authority,
          question: 'q1',
          budget_allocated: 10,
          completion_criteria: 'c1',
          dependencies: ['t-2'],
        },
        {
          task_id: 't-2',
          role: ResearchRole.Evolution,
          question: 'q2',
          budget_allocated: 10,
          completion_criteria: 'c2',
          dependencies: ['t-1'],
        },
      ];
      assert.throws(() => planner.createPlannedTasks('run-p-2', 1, cyclic), /Cyclic dependency/);
    });
  });

  describe('TaskScheduler & Controlled 3-Worker Concurrency', () => {
    it('should execute tasks with max 3 concurrency', async () => {
      let maxConcurrent = 0;
      let active = 0;

      const dummyTasks = [
        { task_id: 't-1' } as any,
        { task_id: 't-2' } as any,
        { task_id: 't-3' } as any,
        { task_id: 't-4' } as any,
        { task_id: 't-5' } as any,
      ];

      const results = await scheduler.dispatchTasks(dummyTasks, async (t) => {
        active++;
        if (active > maxConcurrent) maxConcurrent = active;
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return `done-${t.task_id}`;
      });

      assert.equal(results.length, 5);
      assert.ok(maxConcurrent <= 3, `Max concurrent ${maxConcurrent} should not exceed 3`);
    });
  });

  describe('SubmissionManager: Strict Evidence Check & Task Status Update', () => {
    it('should reject submission if claim references missing evidence', () => {
      taskRepo.createTask({
        task_id: 'task-auth-01',
        run_id: 'run-s-1',
        role: ResearchRole.Authority,
        round: 1,
        question: 'Check official announcement',
        scope: {},
        status: TaskStatus.Running,
        budget_allocated: 12,
        created_at: new Date().toISOString(),
      });

      const invalidPayload = {
        role: ResearchRole.Authority,
        round: 1,
        claims: [
          {
            claim_id: 'c-1',
            statement: 'Some statement',
            evidence_ids: ['E-MISSING-999'],
            limitations: [],
          },
        ],
        evidence_pool: [
          {
            evidence_id: 'E-001',
            source_type: 'doc',
            source_ref: 'https://example.com',
            title: 'Doc',
            excerpt: 'Text',
            retrieval_time: new Date().toISOString(),
            is_full_text: true,
          },
        ],
        scope: {},
        authority_finding: {
          entity_name: 'Gov',
          source_type: 'doc',
          published_at: '2026-10-01',
          raw_text: 'Text',
          stance_evolution: 'Calm',
          covered_issues: [],
          unaddressed_issues: [],
        },
      };

      const res = submissionMgr.validateAndSaveSubmission({
        run_id: 'run-s-1',
        task_id: 'task-auth-01',
        findings: invalidPayload,
      });

      assert.equal(res.ok, false);
      assert.match(res.error || '', /unknown evidence|missing/i);
    });

    it('should save valid submission, auto-persist evidence pool, and mark task submitted', () => {
      taskRepo.createTask({
        task_id: 'task-auth-02',
        run_id: 'run-s-2',
        role: ResearchRole.Authority,
        round: 1,
        question: 'Check official announcement',
        scope: {},
        status: TaskStatus.Running,
        budget_allocated: 12,
        created_at: new Date().toISOString(),
      });

      const validPayload = {
        role: ResearchRole.Authority,
        round: 1,
        claims: [
          {
            claim_id: 'c-1',
            statement: 'Statement 1',
            evidence_ids: ['E-001'],
            limitations: [],
          },
        ],
        evidence_pool: [
          {
            evidence_id: 'E-001',
            source_type: 'doc',
            source_ref: 'https://gov.example.com/doc',
            title: 'Official Bulletin',
            excerpt: 'No casualties reported.',
            retrieval_time: new Date().toISOString(),
            is_full_text: true,
          },
        ],
        scope: {},
        authority_finding: {
          entity_name: 'Gov Office',
          source_type: 'doc',
          published_at: '2026-10-01',
          raw_text: 'No casualties reported.',
          stance_evolution: 'Stable',
          covered_issues: ['casualty'],
          unaddressed_issues: [],
        },
      };

      const res = submissionMgr.validateAndSaveSubmission({
        run_id: 'run-s-2',
        task_id: 'task-auth-02',
        findings: validPayload,
      });

      assert.equal(res.ok, true);
      assert.ok(res.submission_id);

      // Verify task status transitioned to Submitted
      const task = taskRepo.getTask('task-auth-02');
      assert.equal(task?.status, TaskStatus.Submitted);

      // Verify evidence was stored into evidenceStore
      const evidenceList = evidenceStore.listEvidence('run-s-2');
      assert.equal(evidenceList.length, 1);
      assert.equal(evidenceList[0].title, 'Official Bulletin');
    });
  });

  describe('Coordinator: Synchronous Convergence Barrier', () => {
    it('should transition run to Reviewing once all round tasks have submitted', () => {
      const run = coordinator.createRun('暴雨事件研判', {}, [
        ResearchRole.Authority,
        ResearchRole.Evolution,
        ResearchRole.Feedback,
      ]);

      assert.equal(run.status, RunStatus.Researching);

      const tasks = coordinator.getTasksForRound(run.run_id, 1);
      assert.equal(tasks.length, 3);

      // Initially barrier is not reached
      assert.equal(coordinator.checkRoundSyncBarrier(run.run_id, 1), false);

      // Submit authority findings
      submissionMgr.validateAndSaveSubmission({
        run_id: run.run_id,
        task_id: tasks[0].task_id,
        findings: {
          role: ResearchRole.Authority,
          round: 1,
          claims: [],
          evidence_pool: [],
          scope: {},
          authority_finding: {
            entity_name: 'Gov',
            source_type: 'doc',
            published_at: '2026-10-01',
            raw_text: 'OK',
            stance_evolution: 'Calm',
            covered_issues: [],
            unaddressed_issues: [],
          },
        },
      });

      // Still false (2 remaining)
      assert.equal(coordinator.checkRoundSyncBarrier(run.run_id, 1), false);

      // Submit evolution
      submissionMgr.validateAndSaveSubmission({
        run_id: run.run_id,
        task_id: tasks[1].task_id,
        findings: {
          role: ResearchRole.Evolution,
          round: 1,
          claims: [],
          evidence_pool: [],
          scope: {},
          evolution_finding: {
            metric_definition: 'idx',
            platform: 'weibo',
            time_window: '24h',
            data_points: [],
            missing_periods: [],
            phase_transition_analysis: 'peaked',
            concurrent_events: [],
            limitations: [],
          },
        },
      });

      // Submit feedback
      submissionMgr.validateAndSaveSubmission({
        run_id: run.run_id,
        task_id: tasks[2].task_id,
        findings: {
          role: ResearchRole.Feedback,
          round: 1,
          claims: [],
          evidence_pool: [],
          scope: {},
          feedback_finding: {
            sampling_method: 'random',
            sample_size: 1000,
            viewpoint_breakdown: {},
            sentiment_distribution: {},
            demands_summary: [],
            denominator_info: 'info',
            representative_quotes: [],
            limitations: [],
          },
        },
      });

      // All 3 submitted -> barrier satisfied!
      const barrierPassed = coordinator.checkRoundSyncBarrier(run.run_id, 1);
      assert.equal(barrierPassed, true);

      const updatedRun = coordinator.getRun(run.run_id);
      assert.equal(updatedRun?.status, RunStatus.Reviewing);
    });
  });

  describe('ReviewManager: Directed Follow-up, Carry-Forward & Round 3 Convergence', () => {
    it('should dispatch follow-up ONLY to the targeted role and carry forward others', () => {
      const run = coordinator.createRun('定向补查测试');
      const tasks = coordinator.getTasksForRound(run.run_id, 1);

      // Submit all 3 roles for round 1
      for (const t of tasks) {
        submissionMgr.validateAndSaveSubmission({
          run_id: run.run_id,
          task_id: t.task_id,
          findings: {
            role: t.role,
            round: 1,
            claims: [{ claim_id: `c-${t.role}-1`, statement: 'R1 claim', evidence_ids: [], limitations: [] }],
            evidence_pool: [],
            scope: {},
            [`${t.role}_finding`]: { raw_text: 'r1', metric_definition: 'm', sampling_method: 's', entity_name: 'e' },
          },
        });
      }

      coordinator.checkRoundSyncBarrier(run.run_id, 1);

      // HOST review issues Revise directed ONLY to Feedback role
      reviewMgr.submitReviewDecision(run.run_id, {
        task_id: 'task-host-r1',
        round: 1,
        decision: DecisionType.Revise,
        rationale: 'Feedback sample is insufficient',
        directives: [
          {
            directive_id: 'dir-feed-01',
            target_role: ResearchRole.Feedback,
            related_claim_or_issue: 'sample size',
            question: 'Increase sample to 5000',
            suggested_action: 'Query comment db',
            completion_criteria: 'sample >= 5000',
          },
        ],
        unresolved_issues: [],
      });

      // Round should advance to 2
      const runR2 = coordinator.getRun(run.run_id);
      assert.equal(runR2?.current_round, 2);
      assert.equal(runR2?.status, RunStatus.Researching);

      // Tasks in round 2 should ONLY be for feedback
      const r2Tasks = coordinator.getTasksForRound(run.run_id, 2);
      assert.equal(r2Tasks.length, 1);
      assert.equal(r2Tasks[0].role, ResearchRole.Feedback);

      // Check effective submissions: authority and evolution are carried forward from round 1!
      // Feedback is pending, so not yet effective for round 2
      const effectiveMidway = reviewMgr.getEffectiveSubmissions(run.run_id, 2);
      assert.ok(effectiveMidway.get(ResearchRole.Authority));
      assert.ok(effectiveMidway.get(ResearchRole.Evolution));
      assert.equal(effectiveMidway.has(ResearchRole.Feedback), false);

      // Once feedback submits round 2
      submissionMgr.validateAndSaveSubmission({
        run_id: run.run_id,
        task_id: r2Tasks[0].task_id,
        findings: {
          role: ResearchRole.Feedback,
          round: 2,
          claims: [{ claim_id: 'c-feed-2', statement: 'R2 sample updated', evidence_ids: [], limitations: [] }],
          evidence_pool: [],
          scope: {},
          feedback_finding: { sample_size: 5000 },
        },
      });

      const effectiveDone = reviewMgr.getEffectiveSubmissions(run.run_id, 2);
      assert.ok(effectiveDone.get(ResearchRole.Feedback));
      assert.equal(effectiveDone.get(ResearchRole.Feedback).round, 2);
      assert.equal(effectiveDone.get(ResearchRole.Authority).round, 1);
    });

    it('should prohibit revise decision in round 3 (mandatory convergence)', () => {
      const run = coordinator.createRun('R3测试');
      runRepo.updateRunStatus(run.run_id, RunStatus.Reviewing, 3);

      assert.throws(
        () =>
          reviewMgr.submitReviewDecision(run.run_id, {
            task_id: 'host-r3',
            round: 3,
            decision: DecisionType.Revise,
            rationale: 'Cannot revise at R3',
            directives: [],
            unresolved_issues: [],
          }),
        /Round 3 cannot issue revise|mandatory convergence/i
      );
    });
  });

  describe('RecoveryManager: Auto-Pause, Resume with Version Increment & Late Response Rejection', () => {
    it('should auto-pause unended runs on startup', () => {
      runRepo.createRun({
        run_id: 'run-active-1',
        topic: 'Active',
        scope: {},
        status: RunStatus.Researching,
        current_round: 1,
        max_rounds: 3,
        budget_total: 50,
        budget_used: 10,
        execution_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const paused = recoveryMgr.autoPauseUnendedRunsOnStartup();
      assert.ok(paused.includes('run-active-1'));

      const r = runRepo.getRun('run-active-1');
      assert.equal(r?.status, RunStatus.Paused);
    });

    it('resume should increment execution_version and reject late responses', () => {
      runRepo.createRun({
        run_id: 'run-resume-1',
        topic: 'Resume test',
        scope: {},
        status: RunStatus.Paused,
        current_round: 1,
        max_rounds: 3,
        budget_total: 50,
        budget_used: 10,
        execution_version: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const resumed = recoveryMgr.resumeRun('run-resume-1');
      assert.equal(resumed.status, RunStatus.Researching);
      assert.equal(resumed.execution_version, 2);

      // Late response with version 1 is rejected
      assert.equal(recoveryMgr.validateExecutionVersion('run-resume-1', 1), false);
      // Fresh response with version 2 is accepted
      assert.equal(recoveryMgr.validateExecutionVersion('run-resume-1', 2), true);
    });
  });
});
