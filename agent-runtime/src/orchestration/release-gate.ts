import { randomUUID } from 'node:crypto';
import { ResearchDatabase } from '../storage/database.js';
import {
  RunRepository,
  TaskRepository,
  TaskResultRepository,
  OutboxRepository,
  HostInboxRepository,
  HostDecisionRepository,
  SubmissionRepository,
  MaterialSnapshotRepository,
  type TaskResultRecord,
} from '../storage/repositories.js';
import { EvidenceStore } from '../storage/evidence-store.js';
import {
  ResearchRole,
  TaskStatus,
  type ResearchTask,
  type Claim,
  type Evidence,
} from '../contracts/research.js';
import type { ReleaseRequest } from '../contracts/research-job.js';

export interface MaterialSnapshot {
  snapshot_id: string;
  run_id: string;
  created_at: string;
  tasks: Array<ResearchTask & { generation?: number; required_for_report?: boolean }>;
  accepted_results: TaskResultRecord[];
  claims: Claim[];
  evidence_pool: Evidence[];
  gaps?: string[];
  uncalled_roles?: string[];
  restricted: boolean;
  metadata?: Record<string, unknown>;
}

export interface ReleaseVerificationResult {
  ok: boolean;
  snapshotId?: string;
  snapshot?: MaterialSnapshot;
  gaps: string[];
  restricted: boolean;
  errors?: string[];
  reason?: string;
}

export interface ReleaseGateOptions {
  db: ResearchDatabase;
  taskRepo?: TaskRepository;
  resultRepo?: TaskResultRepository;
  evidenceStore?: EvidenceStore;
  runRepo?: RunRepository;
  outboxRepo?: OutboxRepository;
  inboxRepo?: HostInboxRepository;
  snapshotRepo?: MaterialSnapshotRepository;
  submissionRepo?: SubmissionRepository;
  decisionRepo?: HostDecisionRepository;
}

export class ReleaseGate {
  private db: ResearchDatabase;
  private taskRepo: TaskRepository;
  private resultRepo: TaskResultRepository;
  private evidenceStore: EvidenceStore;
  private runRepo: RunRepository;
  private outboxRepo: OutboxRepository;
  private inboxRepo: HostInboxRepository;
  private snapshotRepo: MaterialSnapshotRepository;
  private submissionRepo: SubmissionRepository;
  private decisionRepo: HostDecisionRepository;

  public static readonly STANDARD_ROLES: ResearchRole[] = [
    ResearchRole.Authority,
    ResearchRole.Evolution,
    ResearchRole.Feedback,
  ];

  constructor(options: ReleaseGateOptions) {
    this.db = options.db;
    this.taskRepo = options.taskRepo || new TaskRepository(this.db);
    this.resultRepo = options.resultRepo || new TaskResultRepository(this.db);
    this.evidenceStore = options.evidenceStore || new EvidenceStore(this.db);
    this.runRepo = options.runRepo || new RunRepository(this.db);
    this.outboxRepo = options.outboxRepo || new OutboxRepository(this.db);
    this.inboxRepo = options.inboxRepo || new HostInboxRepository(this.db);
    this.snapshotRepo = options.snapshotRepo || new MaterialSnapshotRepository(this.db);
    this.submissionRepo = options.submissionRepo || new SubmissionRepository(this.db);
    this.decisionRepo = options.decisionRepo || new HostDecisionRepository(this.db);
  }

  /**
   * 按照设计规范第 9 节执行 6 项标准门禁检查
   */
  public verifyRelease(
    runId: string,
    releaseRequest?: ReleaseRequest
  ): ReleaseVerificationResult {
    const errors: string[] = [];
    const gaps: string[] = [];
    let isRestricted = Boolean(releaseRequest?.restricted);

    // 0. 确认 Run 存在
    const run = this.runRepo.getRun(runId);
    if (!run) {
      return {
        ok: false,
        gaps: [],
        restricted: false,
        errors: [`Run '${runId}' not found`],
        reason: `Run '${runId}' not found`,
      };
    }

    const allTasks = this.taskRepo.listTasks(runId);
    const allResults = this.resultRepo.listResultsByRun(runId);
    const decisions = this.decisionRepo.listDecisions(runId);

    // 组合允许的缺口理由文本集合
    const allowedGapsTexts = (releaseRequest?.allowed_gaps || []).concat(
      releaseRequest?.unresolved_issues || []
    );
    const rationaleText = (releaseRequest?.rationale || '').toLowerCase();

    // ----------------------------------------------------
    // Criterion 1: 所有 required_for_report=true 的任务具有已接受成果或明确的缺口记录
    // ----------------------------------------------------
    const requiredTasks = allTasks.filter((t) => t.required_for_report !== false);

    for (const task of requiredTasks) {
      // 检查该任务是否已获得接受成果
      const taskResults = allResults.filter((r) => r.task_id === task.task_id);
      const hasAcceptedResult =
        task.status === TaskStatus.Succeeded ||
        taskResults.some((r) => r.status === 'succeeded' || r.status === 'partial');

      // 如果未直接接受，检查是否被后继更高 generation 任务替代并成功/部分成功
      const hasSucceededSuccessor =
        task.superseded_by &&
        allTasks.some(
          (t) =>
            t.task_id === task.superseded_by &&
            (t.status === TaskStatus.Succeeded ||
              t.status === TaskStatus.Partial ||
              allResults.some(
                (r) =>
                  r.task_id === t.task_id &&
                  (r.status === 'succeeded' || r.status === 'partial')
              ))
        );

      if (!hasAcceptedResult && !hasSucceededSuccessor) {
        // 查找是否有明确的缺口豁免
        const isJustified =
          allowedGapsTexts.some(
            (g) =>
              g.toLowerCase().includes(task.task_id.toLowerCase()) ||
              g.toLowerCase().includes(task.role.toLowerCase())
          ) ||
          rationaleText.includes(task.task_id.toLowerCase()) ||
          rationaleText.includes(task.role.toLowerCase()) ||
          Boolean((task.scope as any)?.acceptable_gap) ||
          Boolean((task.scope as any)?.gap_justification);

        if (isJustified) {
          const gapDesc = `Required task '${task.task_id}' (${task.role}) missing accepted result, justified via allowed gaps`;
          gaps.push(gapDesc);
          isRestricted = true;
        } else {
          errors.push(
            `Required task '${task.task_id}' (${task.role}) has no accepted result and no acceptable gap justification`
          );
        }
      }
    }

    // ----------------------------------------------------
    // Criterion 2: 未调用角色具有明确 not_applicable 记录，无虚构数据
    // ----------------------------------------------------
    const calledRoles = new Set<string>(allTasks.map((t) => t.role));
    const uncalledRoles: string[] = [];

    for (const stdRole of ReleaseGate.STANDARD_ROLES) {
      if (!calledRoles.has(stdRole)) {
        // 检查是否有明确的 not_applicable 豁免或记录
        const isNotApplicable =
          allowedGapsTexts.some(
            (g) =>
              g.toLowerCase().includes(stdRole.toLowerCase()) &&
              (g.toLowerCase().includes('not_applicable') ||
                g.toLowerCase().includes('not applicable') ||
                g.includes('不适用') ||
                g.includes('豁免'))
          ) ||
          (rationaleText.includes(stdRole.toLowerCase()) &&
            (rationaleText.includes('not_applicable') ||
              rationaleText.includes('not applicable') ||
              rationaleText.includes('不适用'))) ||
          decisions.some(
            (d) =>
              (d.rationale || '').toLowerCase().includes(stdRole.toLowerCase()) &&
              ((d.rationale || '').toLowerCase().includes('not_applicable') ||
                (d.rationale || '').includes('不适用'))
          ) ||
          Boolean((run.scope as any)?.not_applicable_roles?.includes?.(stdRole));

        if (isNotApplicable) {
          uncalledRoles.push(stdRole);
          gaps.push(`Role '${stdRole}' uncalled with explicit not_applicable justification`);
          isRestricted = true;
        } else {
          errors.push(
            `Uncalled role '${stdRole}' has no explicit not_applicable justification (forged findings prevention)`
          );
        }
      }
    }

    // ----------------------------------------------------
    // Criterion 3: 没有处于 running 或 queued 的必要任务，且无未处理的完成事件
    // ----------------------------------------------------
    for (const t of allTasks) {
      const isReq = t.required_for_report !== false;
      const isActive =
        t.status === TaskStatus.Running ||
        t.status === TaskStatus.Queued ||
        t.status === TaskStatus.Pending;

      if (isReq && isActive) {
        errors.push(`Required task '${t.task_id}' (${t.role}) is still in progress (${t.status})`);
      }
    }

    // 检查 host_inbox 中是否有 pending 或 claimed 的未结事件
    const pendingInbox = this.inboxRepo.listPending(runId);
    if (pendingInbox.length > 0) {
      errors.push(`Unhandled inbox events (${pendingInbox.length}) remain for run '${runId}'`);
    }

    // 检查 event_outbox 中是否有未送达事件
    const undeliveredOutbox = this.outboxRepo.getUndeliveredEvents(runId);
    if (undeliveredOutbox.length > 0) {
      errors.push(
        `Undelivered outbox events (${undeliveredOutbox.length}) remain for run '${runId}'`
      );
    }

    // ----------------------------------------------------
    // Criterion 4: 成果中所有主张引用均可在证据库中解析
    // ----------------------------------------------------
    const acceptedResults = allResults.filter(
      (r) => r.status === 'succeeded' || r.status === 'partial'
    );
    const existingEvidenceList = this.evidenceStore.listEvidence(runId);
    const validEvidenceIds = new Set(existingEvidenceList.map((e) => e.evidence_id));

    for (const res of acceptedResults) {
      const claims: Claim[] = [];
      const findings = res.findings as any;
      if (findings && Array.isArray(findings.claims)) {
        claims.push(...findings.claims);
      }

      for (const clm of claims) {
        for (const evId of clm.evidence_ids || []) {
          if (!validEvidenceIds.has(evId)) {
            errors.push(
              `Claim '${clm.claim_id || clm.statement}' references non-existent evidence '${evId}' in EvidenceStore`
            );
          }
        }
      }
    }

    // ----------------------------------------------------
    // Criterion 5: 放行申请绑定材料版本快照，无新成果使其过期
    // ----------------------------------------------------
    let boundSnapshot: MaterialSnapshot | null = null;
    if (releaseRequest?.snapshot_id) {
      boundSnapshot = this.snapshotRepo.getSnapshot<MaterialSnapshot>(
        releaseRequest.snapshot_id
      );
      if (!boundSnapshot) {
        errors.push(`Snapshot '${releaseRequest.snapshot_id}' not found`);
      } else if (boundSnapshot.run_id !== runId) {
        errors.push(
          `Cross-run isolation violation: snapshot '${boundSnapshot.snapshot_id}' belongs to run '${boundSnapshot.run_id}', not '${runId}'`
        );
        boundSnapshot = null;
      } else {
        // 检查是否有在快照创建后提交的成果
        const newerResults = allResults.filter(
          (r) => (r.created_at || '') > boundSnapshot!.created_at
        );
        if (newerResults.length > 0) {
          errors.push(
            `Snapshot '${releaseRequest.snapshot_id}' is invalidated by ${newerResults.length} newer task result(s) created after snapshot (${boundSnapshot.created_at})`
          );
        }
      }
    }

    // ----------------------------------------------------
    // Criterion 6: 支持受限交付 (restricted: true)，无理由缺失则拒绝放行
    // ----------------------------------------------------
    if (errors.length > 0) {
      return {
        ok: false,
        gaps,
        restricted: false,
        errors,
        reason: errors.join('; '),
      };
    }

    // 门禁全部通过！生成或返回快照
    if (boundSnapshot) {
      return {
        ok: true,
        snapshotId: boundSnapshot.snapshot_id,
        snapshot: boundSnapshot,
        gaps,
        restricted: isRestricted,
      };
    }

    // 若无前置快照，当前时刻冻结新材料快照并持久化
    const frozen = this.freezeMaterialSnapshot(runId, {
      gaps,
      restricted: isRestricted,
      uncalledRoles,
    });

    return {
      ok: true,
      snapshotId: frozen.snapshot_id,
      snapshot: frozen,
      gaps,
      restricted: isRestricted,
    };
  }

  /**
   * 将当前所有已接受成果、主张及证据打包为冻结版本写入持久层
   * 迟到结果或后续 attempts 不可修改此快照！
   */
  public freezeMaterialSnapshot(
    runId: string,
    options?: {
      gaps?: string[];
      restricted?: boolean;
      uncalledRoles?: string[];
      metadata?: Record<string, unknown>;
    }
  ): MaterialSnapshot {
    const nowIso = new Date().toISOString();
    const snapshotId = `snap-${runId}-${randomUUID().substring(0, 8)}`;

    const tasks = this.taskRepo.listTasks(runId);
    const allResults = this.resultRepo.listResultsByRun(runId);
    const acceptedResults = allResults.filter(
      (r) => r.status === 'succeeded' || r.status === 'partial'
    );

    const claims: Claim[] = [];
    for (const res of acceptedResults) {
      const findings = res.findings as any;
      if (findings && Array.isArray(findings.claims)) {
        claims.push(...findings.claims);
      }
    }

    const evidencePool = this.evidenceStore.listEvidence(runId);

    const snapshot: MaterialSnapshot = {
      snapshot_id: snapshotId,
      run_id: runId,
      created_at: nowIso,
      tasks: tasks as any,
      accepted_results: acceptedResults,
      claims,
      evidence_pool: evidencePool,
      gaps: options?.gaps || [],
      uncalled_roles: options?.uncalledRoles || [],
      restricted: Boolean(options?.restricted),
      metadata: options?.metadata || {},
    };

    // 写入持久化 SQLite
    this.snapshotRepo.saveSnapshot(snapshot);

    return snapshot;
  }

  /**
   * 按 ID 查询已冻结的材料快照
   */
  public getMaterialSnapshot(snapshotId: string): MaterialSnapshot | null {
    return this.snapshotRepo.getSnapshot<MaterialSnapshot>(snapshotId);
  }
}

/**
 * 独立便捷函数：直接冻结材料快照
 */
export function freezeMaterialSnapshot(
  runId: string,
  deps: {
    db: ResearchDatabase;
    taskRepo?: TaskRepository;
    resultRepo?: TaskResultRepository;
    evidenceStore?: EvidenceStore;
    snapshotRepo?: MaterialSnapshotRepository;
  },
  options?: {
    gaps?: string[];
    restricted?: boolean;
    uncalledRoles?: string[];
  }
): MaterialSnapshot {
  const gate = new ReleaseGate({
    db: deps.db,
    taskRepo: deps.taskRepo,
    resultRepo: deps.resultRepo,
    evidenceStore: deps.evidenceStore,
    snapshotRepo: deps.snapshotRepo,
  });

  return gate.freezeMaterialSnapshot(runId, options);
}
