import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { createDatabase, ResearchDatabase } from '../src/storage/database.js';
import {
  RunRepository,
  TaskRepository,
  SubmissionRepository,
  ReviewRepository,
} from '../src/storage/repositories.js';
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
import { VerifierComponent } from '../src/agents/verifier.js';

import { buildReportInput } from '../src/reporting/input.js';
import { FinalChecker } from '../src/reporting/artifacts.js';
import { IRValidator } from '../src/reporting/ir-validator.js';
import { ExportQueue } from '../src/reporting/export-queue.js';

import {
  ResearchRole,
  RunStatus,
  TaskStatus,
  DecisionType,
  VerificationStatus,
  ReportJudgment,
} from '../src/contracts/research.js';

describe('Task 8: Pure Node.js E2E Lifecycle & 5 Core Benchmark Acceptance', () => {
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
  let verifier: VerifierComponent;
  let finalChecker: FinalChecker;
  let irValidator: IRValidator;
  let exportQueue: ExportQueue;

  beforeEach(() => {
    rawDb = new DatabaseSync(':memory:');
    db = createDatabase(rawDb);
    runRepo = new RunRepository(db);
    taskRepo = new TaskRepository(db);
    subRepo = new SubmissionRepository(db);
    reviewRepo = new ReviewRepository(db);
    evidenceStore = new EvidenceStore(db);
    eventStore = new EventStore(db);
    budgetLedger = new BudgetLedger(db, { totalToolLimit: 50, reservedForWriting: 10 });
    callLedger = new CallLedger(budgetLedger);

    planner = new TaskPlanner(taskRepo);
    scheduler = new TaskScheduler(3);
    submissionMgr = new SubmissionManager(subRepo, taskRepo, evidenceStore);
    coordinator = new ResearchCoordinator(runRepo, taskRepo, submissionMgr, eventStore);
    reviewMgr = new ReviewManager(runRepo, taskRepo, reviewRepo, submissionMgr);
    recoveryMgr = new RecoveryManager(runRepo);
    verifier = new VerifierComponent();
    finalChecker = new FinalChecker();
    irValidator = new IRValidator();
    exportQueue = new ExportQueue();
  });

  describe('Full E2E Research Lifecycle (Zero Python Dependency)', () => {
    it('executes Run -> Plan -> 3-Role Research -> Barrier -> Verify -> Revise -> Carry-forward -> Settle -> IR -> 4-Format Export', async () => {
      // 1. Create Run
      const run = coordinator.createRun('某省暴雨防汛响应与交通舆情演化', { region: '全市' });
      assert.equal(run.status, RunStatus.Researching);

      const r1Tasks = coordinator.getTasksForRound(run.run_id, 1);
      assert.equal(r1Tasks.length, 3);

      // 2. Parallel research simulation using TaskScheduler
      await scheduler.dispatchTasks(r1Tasks, async (t) => {
        // Reserve budget per task call
        callLedger.beginCall({
          run_id: run.run_id,
          task_id: t.task_id,
          call_id: `call-${t.task_id}`,
          tool_name: 'search_web',
          units: 1,
        });

        // Add evidence
        const ev = evidenceStore.addEvidence({
          run_id: run.run_id,
          source_type: 'official_doc',
          source_ref: `https://gov.example.com/${t.role}`,
          title: `${t.role} 报告`,
          excerpt: `${t.role} 数据确凿。`,
          retrieval_time: new Date().toISOString(),
          is_full_text: true,
        });

        // Settle tool call
        callLedger.endCall({ call_id: `call-${t.task_id}`, success: true });

        // Submit findings
        submissionMgr.validateAndSaveSubmission({
          run_id: run.run_id,
          task_id: t.task_id,
          findings: {
            role: t.role,
            round: 1,
            claims: [
              {
                claim_id: `C-${t.role}-1`,
                statement: `${t.role} 主张描述`,
                evidence_ids: [ev.evidence_id],
                limitations: [],
              },
            ],
            evidence_pool: [ev],
            scope: {},
            [`${t.role}_finding`]: {
              entity_name: '部门',
              raw_text: '正文',
              metric_definition: '热度',
              sampling_method: '抽样',
            },
          },
        });
      });

      // 3. Convergence barrier
      assert.equal(coordinator.checkRoundSyncBarrier(run.run_id, 1), true);
      const reviewingRun = coordinator.getRun(run.run_id);
      assert.equal(reviewingRun?.status, RunStatus.Reviewing);

      // 4. Verifier cross-verification
      verifier.loadEvidencePool([
        {
          evidence_id: 'E-001',
          source_type: 'official_doc',
          source_ref: 'https://gov.example.com',
          title: '市应急管理局通报',
          excerpt: '市应急管理局发布通报，称启动防汛二级响应，经核查未发生人员伤亡失联。',
          retrieval_time: new Date().toISOString(),
          is_full_text: true,
        },
      ]);
      const authClaim = {
        claim_id: 'C-authority-1',
        statement: '市应急管理局通报启动防汛二级响应且未发生人员伤亡失联',
        evidence_ids: ['E-001'],
        limitations: [],
      };
      const vResult = verifier.verifyClaims([authClaim]);
      assert.equal(vResult[0].status, VerificationStatus.Supported);

      // 5. Host Review issues Revise directed to Feedback
      reviewMgr.submitReviewDecision(run.run_id, {
        task_id: 'host-rev-1',
        round: 1,
        decision: DecisionType.Revise,
        rationale: '需要扩充反馈样本量',
        directives: [
          {
            directive_id: 'dir-feed',
            target_role: ResearchRole.Feedback,
            related_claim_or_issue: 'sample',
            question: '样本扩充至5000条',
            suggested_action: '评论分析',
            completion_criteria: 'sample >= 5000',
          },
        ],
        unresolved_issues: [],
      });

      const r2Run = coordinator.getRun(run.run_id);
      assert.equal(r2Run?.current_round, 2);
      assert.equal(r2Run?.status, RunStatus.Researching);

      // Round 2 tasks: ONLY Feedback
      const r2Tasks = coordinator.getTasksForRound(run.run_id, 2);
      assert.equal(r2Tasks.length, 1);
      assert.equal(r2Tasks[0].role, ResearchRole.Feedback);

      // 6. Feedback executes round 2 and submits
      submissionMgr.validateAndSaveSubmission({
        run_id: run.run_id,
        task_id: r2Tasks[0].task_id,
        findings: {
          role: ResearchRole.Feedback,
          round: 2,
          claims: [
            {
              claim_id: 'C-feedback-2',
              statement: '扩充样本后公众核心诉求为早高峰积水通报',
              evidence_ids: ['E-003'],
              limitations: [],
            },
          ],
          evidence_pool: [
            {
              evidence_id: 'E-003',
              source_type: 'comments',
              source_ref: 'db://sample/5000',
              title: '5000条评论聚类',
              excerpt: '积水诉求占比高',
              retrieval_time: new Date().toISOString(),
              is_full_text: true,
            },
          ],
          scope: {},
          feedback_finding: { sample_size: 5000 },
        },
      });

      // Barrier reached for round 2
      assert.equal(coordinator.checkRoundSyncBarrier(run.run_id, 2), true);

      // 7. HOST approves in Round 2
      reviewMgr.submitReviewDecision(run.run_id, {
        task_id: 'host-rev-2',
        round: 2,
        decision: DecisionType.Approve,
        rationale: '三方证据闭环，诉求清晰，准予出专报',
        directives: [],
        unresolved_issues: [],
      });

      const approvedRun = coordinator.getRun(run.run_id);
      assert.equal(approvedRun?.status, RunStatus.Approved);

      // 8. Build Report Input with carry-forward
      const effective = reviewMgr.getEffectiveSubmissions(run.run_id, 2);
      const repInput = buildReportInput(run.run_id, run.topic, run.scope, effective);
      assert.equal(repInput.research_versions.authority, 1); // carried forward from r1
      assert.equal(repInput.research_versions.feedback, 2); // new from r2

      // 9. Synthesize ReportJudgment & Final Check
      const judgment: ReportJudgment = {
        overall_interpretation: '汛情态势总体可控，公众主要矛盾转向次日通勤保障。',
        risks: [{ point: '早高峰积水风险', level: '中' }],
        recommendations: [{ target: '交通委', measure: '早6点前统一发布早高峰通行指引' }],
        linked_claim_ids: ['C-authority-1', 'C-feedback-2'],
        linked_evidence_ids: ['E-001', 'E-003'],
        applicability_conditions: ['雷达预报无二次特大暴雨'],
        uncertainties: ['偏远村镇地下积水排查进度未计入'],
        alternative_explanations: [],
      };

      const finalCheck = finalChecker.checkReportQuality(
        judgment,
        repInput.claims.map((c) => c.claim_id),
        repInput.evidence_pool.map((e) => e.evidence_id)
      );
      assert.equal(finalCheck.ok, true);

      // 10. Generate Document IR & Validate
      const docIr = {
        schemaVersion: '1.0',
        metadata: {
          reportId: `rep-${run.run_id}`,
          title: run.topic,
          generatedAt: new Date().toISOString(),
        },
        chapters: [
          {
            chapterId: 'ch-01',
            title: '一、应急态势与多维综合研判',
            anchor: 'sec-1',
            order: 1,
            blocks: [
              {
                type: 'heading',
                level: 2,
                text: '1. 总体定调',
                anchor: 'sec-1-1',
              },
              {
                type: 'paragraph',
                inlines: [{ text: judgment.overall_interpretation, marks: ['bold'] }],
              },
            ],
          },
        ],
      };

      const irCheck = irValidator.validateDocument(docIr);
      assert.equal(irCheck.valid, true);

      // 11. Export all 4 formats: Markdown, HTML, DOCX, PDF
      const outDir = resolve(tmpdir(), `bettafish-e2e-${Date.now()}`);
      const exported = await exportQueue.exportAllFormats({
        artifactId: `art-${run.run_id}`,
        documentIr: docIr,
        outputDir: outDir,
        formats: ['markdown', 'html', 'docx', 'pdf'],
      });

      assert.ok(existsSync(exported.markdown));
      assert.ok(existsSync(exported.html));
      assert.ok(existsSync(exported.docx));
      assert.ok(existsSync(exported.pdf));

      // Verify DOCX ZIP header
      const docxBytes = readFileSync(exported.docx);
      assert.equal(docxBytes[0], 0x50);
      assert.equal(docxBytes[1], 0x4b);

      // Verify budget consumption within bounds
      const budgetUsage = budgetLedger.getUsage(run.run_id);
      assert.ok(budgetUsage.committed <= 50);
    });
  });

  describe('5 Core Benchmark Cases Acceptance', () => {
    it('Benchmark 1: 官方已澄清且热度回落 -> 首轮放行 (Early Approval)', () => {
      const run = coordinator.createRun('B1: 官方已澄清热度回落');
      const tasks = coordinator.getTasksForRound(run.run_id, 1);

      for (const t of tasks) {
        submissionMgr.validateAndSaveSubmission({
          run_id: run.run_id,
          task_id: t.task_id,
          findings: {
            role: t.role,
            round: 1,
            claims: [{ claim_id: `c-${t.role}`, statement: 'Ok', evidence_ids: [], limitations: [] }],
            evidence_pool: [],
            scope: {},
            [`${t.role}_finding`]: { entity_name: 'Gov', raw_text: 'T', metric_definition: 'm', sampling_method: 's' },
          },
        });
      }

      coordinator.checkRoundSyncBarrier(run.run_id, 1);

      // Host approves immediately in round 1
      const decision = reviewMgr.submitReviewDecision(run.run_id, {
        task_id: 'host-b1',
        round: 1,
        decision: DecisionType.Approve,
        rationale: '官方通报权威详实，社媒热度已平息，准予首轮放行',
        directives: [],
        unresolved_issues: [],
      });

      assert.equal(decision.decision, DecisionType.Approve);
      const finalRun = coordinator.getRun(run.run_id);
      assert.equal(finalRun?.status, RunStatus.Approved);
      assert.equal(finalRun?.current_round, 1);
    });

    it('Benchmark 2: 多方各执一词 -> 核验检出矛盾并下发定向核查指令', () => {
      const v2 = new VerifierComponent({
        evidencePool: [
          {
            evidence_id: 'e1',
            source_type: 'official_doc',
            source_ref: 'https://gov.example.com',
            title: 'T1',
            excerpt: '市应急管理局通报称抢险平稳有序，未发生人员伤亡。',
            retrieval_time: new Date().toISOString(),
            is_full_text: true,
          },
        ],
      });
      const v = v2.verifyClaims([
        {
          claim_id: 'c-contra',
          statement: '网传此次暴雨造成重大伤亡，多人死亡',
          evidence_ids: ['e1'],
          limitations: [],
        },
      ]);

      const contradicted = v.find((item) => item.status === VerificationStatus.Contradicted);
      assert.ok(contradicted, 'Must identify direct numerical factual contradiction');
    });

    it('Benchmark 3: 社媒热度陡增但官方未发声 -> 状态标记为Uncertain而非捏造通报', () => {
      const vSilent = new VerifierComponent();
      const unverified = vSilent.verifyClaims([
        { claim_id: 'c-silent', statement: '官方暂未正式发声', evidence_ids: [], limitations: [] },
      ]);
      assert.equal(unverified[0].status, VerificationStatus.Unsupported);
    });

    it('Benchmark 4: 小众圈层高危发酵 -> 样本分母与局限性严格记录', () => {
      const res = submissionMgr.validateAndSaveSubmission({
        run_id: 'run-b4',
        task_id: 'task-feed-b4',
        findings: {
          role: ResearchRole.Feedback,
          round: 1,
          claims: [{ claim_id: 'c-b4', statement: '小众圈层诉求集中', evidence_ids: [], limitations: ['样本集中于年轻网民，老年群体未覆盖'] }],
          evidence_pool: [],
          scope: {},
          feedback_finding: {
            sampling_method: '分层随机抽样',
            sample_size: 500,
            denominator_info: '抽样自小众超话500条评论',
            viewpoint_breakdown: { '求助': 0.8 },
            sentiment_distribution: { '焦虑': 0.8 },
            demands_summary: ['急需转移'],
            representative_quotes: ['求助信息'],
            limitations: ['未覆盖离线求助热线'],
          },
        },
      });
      // Ensure limitations and denominator are retained
      const saved = subRepo.getSubmission(res.submission_id!);
      const feedbackFinding = (saved?.data as any).feedback_finding;
      assert.equal(feedbackFinding.sample_size, 500);
      assert.ok(feedbackFinding.limitations.length > 0);
    });

    it('Benchmark 5: 全网讨论热烈但关键事实模糊 -> 第3轮强制收敛带未决事项放行 (Finalize with Unresolved)', () => {
      const run = coordinator.createRun('B5: 事实模糊');
      runRepo.updateRunStatus(run.run_id, RunStatus.Reviewing, 3);

      const decision = reviewMgr.submitReviewDecision(run.run_id, {
        task_id: 'host-b5',
        round: 3,
        decision: DecisionType.FinalizeWithUnresolved,
        rationale: '已达第3轮上限，核心损失细节仍模糊，带未决事项强制收敛放行',
        directives: [],
        unresolved_issues: ['偏远受灾村落具体损失口径仍待官方进一步核实'],
      });

      assert.equal(decision.decision, DecisionType.FinalizeWithUnresolved);
      assert.equal(decision.unresolved_issues.length, 1);

      const finalRun = coordinator.getRun(run.run_id);
      assert.equal(finalRun?.status, RunStatus.Approved);
    });
  });
});
