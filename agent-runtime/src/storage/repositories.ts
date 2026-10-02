import { ResearchDatabase } from './database.js';
import {
  ResearchRun,
  RunStatus,
  ResearchTask,
  TaskStatus,
  ResearchRole,
  DecisionType,
  DirectiveItem,
} from '../contracts/research.js';
import { TaskOutput } from '../contracts/task.js';

export class RunRepository {
  constructor(private db: ResearchDatabase) {}

  public createRun(run: ResearchRun): void {
    const scopeJson = JSON.stringify(run.scope || {});
    this.db.raw
      .prepare(
        `INSERT INTO runs (
          run_id, topic, scope, status, current_round, max_rounds,
          budget_total, budget_used, execution_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        run.run_id,
        run.topic,
        scopeJson,
        run.status,
        run.current_round ?? 1,
        run.max_rounds ?? 3,
        run.budget_total ?? 50,
        run.budget_used ?? 0,
        run.execution_version ?? 1,
        run.created_at,
        run.updated_at
      );
  }

  public getRun(run_id: string): ResearchRun | null {
    const row = this.db.raw
      .prepare('SELECT * FROM runs WHERE run_id = ?')
      .get(run_id) as any;

    if (!row) return null;
    let scope: Record<string, unknown> = {};
    try {
      if (row.scope) scope = JSON.parse(row.scope);
    } catch {}

    return {
      run_id: row.run_id,
      topic: row.topic,
      scope,
      status: row.status as RunStatus,
      current_round: row.current_round,
      max_rounds: row.max_rounds,
      budget_total: row.budget_total,
      budget_used: row.budget_used,
      execution_version: row.execution_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  public updateRunStatus(run_id: string, status: RunStatus, current_round?: number): void {
    const nowIso = new Date().toISOString();
    if (typeof current_round === 'number') {
      this.db.raw
        .prepare('UPDATE runs SET status = ?, current_round = ?, updated_at = ? WHERE run_id = ?')
        .run(status, current_round, nowIso, run_id);
    } else {
      this.db.raw
        .prepare('UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?')
        .run(status, nowIso, run_id);
    }
  }
}

export class TaskRepository {
  constructor(private db: ResearchDatabase) {}

  public createTask(task: ResearchTask | TaskOutput): void {
    const scopeJson = JSON.stringify(task.scope || {});
    const generation = (task as any).generation ?? 1;
    const completionCriteria = (task as any).completion_criteria ?? '';
    const requiredForReport = (task as any).required_for_report !== false ? 1 : 0;
    const dependenciesJson = JSON.stringify((task as any).dependencies || []);
    const supersededBy = (task as any).superseded_by || null;

    this.db.raw
      .prepare(
        `INSERT INTO tasks (
          task_id, run_id, role, round, question, scope, status,
          assigned_to, budget_allocated, created_at, completed_at,
          generation, completion_criteria, required_for_report, dependencies_json, superseded_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.task_id,
        task.run_id,
        task.role,
        task.round ?? 1,
        task.question,
        scopeJson,
        task.status,
        task.assigned_to || null,
        task.budget_allocated ?? 0,
        task.created_at,
        task.completed_at || null,
        generation,
        completionCriteria,
        requiredForReport,
        dependenciesJson,
        supersededBy
      );
  }

  public getTask(task_id: string): (ResearchTask & {
    generation?: number;
    completion_criteria?: string;
    required_for_report?: boolean;
    dependencies?: string[];
    superseded_by?: string | null;
  }) | null {
    const row = this.db.raw
      .prepare('SELECT * FROM tasks WHERE task_id = ?')
      .get(task_id) as any;

    if (!row) return null;
    let scope: Record<string, unknown> = {};
    try {
      if (row.scope) scope = JSON.parse(row.scope);
    } catch {}

    let dependencies: string[] = [];
    try {
      if (row.dependencies_json) dependencies = JSON.parse(row.dependencies_json);
    } catch {}

    return {
      task_id: row.task_id,
      run_id: row.run_id,
      role: row.role as ResearchRole,
      round: row.round,
      generation: row.generation ?? 1,
      question: row.question,
      scope,
      completion_criteria: row.completion_criteria ?? '',
      required_for_report:
        row.required_for_report === undefined || row.required_for_report === null
          ? true
          : Boolean(row.required_for_report),
      dependencies,
      superseded_by: row.superseded_by || null,
      status: row.status as TaskStatus,
      assigned_to: row.assigned_to,
      budget_allocated: row.budget_allocated,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };
  }

  public listTasks(run_id: string): Array<
    ResearchTask & {
      generation?: number;
      completion_criteria?: string;
      required_for_report?: boolean;
      dependencies?: string[];
      superseded_by?: string | null;
    }
  > {
    const rows = this.db.raw
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id ASC')
      .all(run_id) as any[];

    return rows.map((row) => {
      let scope: Record<string, unknown> = {};
      try {
        if (row.scope) scope = JSON.parse(row.scope);
      } catch {}

      let dependencies: string[] = [];
      try {
        if (row.dependencies_json) dependencies = JSON.parse(row.dependencies_json);
      } catch {}

      return {
        task_id: row.task_id,
        run_id: row.run_id,
        role: row.role as ResearchRole,
        round: row.round,
        generation: row.generation ?? 1,
        question: row.question,
        scope,
        completion_criteria: row.completion_criteria ?? '',
        required_for_report:
          row.required_for_report === undefined || row.required_for_report === null
            ? true
            : Boolean(row.required_for_report),
        dependencies,
        superseded_by: row.superseded_by || null,
        status: row.status as TaskStatus,
        assigned_to: row.assigned_to,
        budget_allocated: row.budget_allocated,
        created_at: row.created_at,
        completed_at: row.completed_at,
      };
    });
  }

  public updateTaskStatus(task_id: string, status: TaskStatus, completed_at?: string): void {
    if (completed_at) {
      this.db.raw
        .prepare('UPDATE tasks SET status = ?, completed_at = ? WHERE task_id = ?')
        .run(status, completed_at, task_id);
    } else {
      this.db.raw
        .prepare('UPDATE tasks SET status = ? WHERE task_id = ?')
        .run(status, task_id);
    }
  }

  public supersedeTask(task_id: string, superseded_by: string): void {
    this.db.raw
      .prepare('UPDATE tasks SET superseded_by = ? WHERE task_id = ?')
      .run(superseded_by, task_id);
  }
}

export interface SubmissionRecord {
  submission_id: string;
  run_id: string;
  task_id: string;
  role: ResearchRole;
  round: number;
  data: Record<string, unknown>;
  created_at?: string;
}

export class SubmissionRepository {
  constructor(private db: ResearchDatabase) {}

  public saveSubmission(params: SubmissionRecord): void {
    const nowIso = params.created_at || new Date().toISOString();
    const dataJson = JSON.stringify(params.data);

    try {
      this.db.raw
        .prepare(
          `INSERT INTO submissions (submission_id, run_id, task_id, role, round, data_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          params.submission_id,
          params.run_id,
          params.task_id,
          params.role,
          params.round,
          dataJson,
          nowIso
        );
    } catch (err: any) {
      if (err.message && (err.message.includes('UNIQUE') || err.message.includes('PRIMARY KEY'))) {
        throw new Error(`Submission already exists and cannot overwrite: ${err.message}`);
      }
      throw err;
    }
  }

  public getSubmission(submission_id: string): SubmissionRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM submissions WHERE submission_id = ?')
      .get(submission_id) as any;

    if (!row) return null;
    return {
      submission_id: row.submission_id,
      run_id: row.run_id,
      task_id: row.task_id,
      role: row.role as ResearchRole,
      round: row.round,
      data: JSON.parse(row.data_json),
      created_at: row.created_at,
    };
  }

  public listSubmissions(run_id: string, round?: number): SubmissionRecord[] {
    const sql =
      typeof round === 'number'
        ? 'SELECT * FROM submissions WHERE run_id = ? AND round = ? ORDER BY submission_id ASC'
        : 'SELECT * FROM submissions WHERE run_id = ? ORDER BY submission_id ASC';
    const params = typeof round === 'number' ? [run_id, round] : [run_id];
    const rows = this.db.raw.prepare(sql).all(...params) as any[];

    return rows.map((r) => ({
      submission_id: r.submission_id,
      run_id: r.run_id,
      task_id: r.task_id,
      role: r.role as ResearchRole,
      round: r.round,
      data: JSON.parse(r.data_json),
      created_at: r.created_at,
    }));
  }
}

export interface ReviewRecord {
  review_id: string;
  run_id: string;
  task_id: string;
  round: number;
  decision: DecisionType;
  rationale: string;
  directives: DirectiveItem[];
  unresolved_issues: string[];
  created_at?: string;
}

export class ReviewRepository {
  constructor(private db: ResearchDatabase) {}

  public saveReview(record: ReviewRecord): void {
    const nowIso = record.created_at || new Date().toISOString();
    const directivesJson = JSON.stringify(record.directives || []);
    const issuesJson = JSON.stringify(record.unresolved_issues || []);

    this.db.raw
      .prepare(
        `INSERT INTO reviews (
          review_id, run_id, task_id, round, decision, rationale,
          directives_json, unresolved_issues_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.review_id,
        record.run_id,
        record.task_id,
        record.round,
        record.decision,
        record.rationale,
        directivesJson,
        issuesJson,
        nowIso
      );
  }

  public getReview(run_id: string, round: number): ReviewRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM reviews WHERE run_id = ? AND round = ?')
      .get(run_id, round) as any;

    if (!row) return null;
    return {
      review_id: row.review_id,
      run_id: row.run_id,
      task_id: row.task_id,
      round: row.round,
      decision: row.decision as DecisionType,
      rationale: row.rationale,
      directives: JSON.parse(row.directives_json),
      unresolved_issues: JSON.parse(row.unresolved_issues_json),
      created_at: row.created_at,
    };
  }
}

// -------------------------------------------------------------
// Subagent As Tools Repositories (Task 2)
// -------------------------------------------------------------

export interface TaskAttemptRecord {
  attempt_id: string;
  task_id: string;
  run_id: string;
  execution_version: number;
  status: string;
  worker_lease?: string | null;
  started_at: string;
  completed_at?: string | null;
  error?: Record<string, unknown> | null;
  usage?: Record<string, unknown> | null;
}

export class TaskAttemptRepository {
  constructor(private db: ResearchDatabase) {}

  public createAttempt(attempt: TaskAttemptRecord): void {
    const errorJson = attempt.error ? JSON.stringify(attempt.error) : null;
    const usageJson = attempt.usage ? JSON.stringify(attempt.usage) : null;

    this.db.raw
      .prepare(
        `INSERT INTO task_attempts (
          attempt_id, task_id, run_id, execution_version, status,
          worker_lease, started_at, completed_at, error_json, usage_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attempt.attempt_id,
        attempt.task_id,
        attempt.run_id,
        attempt.execution_version,
        attempt.status,
        attempt.worker_lease ?? null,
        attempt.started_at,
        attempt.completed_at ?? null,
        errorJson,
        usageJson
      );
  }

  public getAttempt(attempt_id: string): TaskAttemptRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM task_attempts WHERE attempt_id = ?')
      .get(attempt_id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  public updateWorkerLease(attempt_id: string, worker_lease: string | null): void {
    this.db.raw
      .prepare('UPDATE task_attempts SET worker_lease = ? WHERE attempt_id = ?')
      .run(worker_lease, attempt_id);
  }

  public updateStatus(
    attempt_id: string,
    status: string,
    options?: {
      completed_at?: string | null;
      error?: Record<string, unknown> | null;
      usage?: Record<string, unknown> | null;
    }
  ): void {
    const updates: string[] = ['status = ?'];
    const params: any[] = [status];

    if (options && options.completed_at !== undefined) {
      updates.push('completed_at = ?');
      params.push(options.completed_at);
    }
    if (options && options.error !== undefined) {
      updates.push('error_json = ?');
      params.push(options.error ? JSON.stringify(options.error) : null);
    }
    if (options && options.usage !== undefined) {
      updates.push('usage_json = ?');
      params.push(options.usage ? JSON.stringify(options.usage) : null);
    }

    params.push(attempt_id);
    this.db.raw
      .prepare(`UPDATE task_attempts SET ${updates.join(', ')} WHERE attempt_id = ?`)
      .run(...params);
  }

  public listAttemptsByTask(task_id: string): TaskAttemptRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY execution_version ASC, started_at ASC')
      .all(task_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public listAttemptsByRun(run_id: string): TaskAttemptRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM task_attempts WHERE run_id = ? ORDER BY started_at ASC')
      .all(run_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public listActiveAttempts(run_id?: string): TaskAttemptRecord[] {
    const sql = run_id
      ? "SELECT * FROM task_attempts WHERE run_id = ? AND status = 'running' ORDER BY started_at ASC"
      : "SELECT * FROM task_attempts WHERE status = 'running' ORDER BY started_at ASC";
    const params = run_id ? [run_id] : [];
    const rows = this.db.raw.prepare(sql).all(...params) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): TaskAttemptRecord {
    let error: Record<string, unknown> | null = null;
    try {
      if (row.error_json) error = JSON.parse(row.error_json);
    } catch {}

    let usage: Record<string, unknown> | null = null;
    try {
      if (row.usage_json) usage = JSON.parse(row.usage_json);
    } catch {}

    return {
      attempt_id: row.attempt_id,
      task_id: row.task_id,
      run_id: row.run_id,
      execution_version: row.execution_version,
      status: row.status,
      worker_lease: row.worker_lease,
      started_at: row.started_at,
      completed_at: row.completed_at,
      error,
      usage,
    };
  }
}

export interface TaskResultRecord {
  result_id: string;
  run_id: string;
  task_id: string;
  attempt_id: string;
  version: number;
  role: string;
  status: string;
  findings?: Record<string, unknown> | unknown[] | null;
  summary?: string | null;
  evidence_refs?: string[] | null;
  created_at?: string;
}

export class TaskResultRepository {
  constructor(private db: ResearchDatabase) {}

  public saveResult(record: TaskResultRecord): void {
    const nowIso = record.created_at || new Date().toISOString();
    const findingsJson = record.findings ? JSON.stringify(record.findings) : null;
    const evidenceRefsJson = record.evidence_refs ? JSON.stringify(record.evidence_refs) : null;

    try {
      this.db.raw
        .prepare(
          `INSERT INTO task_results (
            result_id, run_id, task_id, attempt_id, version, role,
            status, findings_json, summary, evidence_refs_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.result_id,
          record.run_id,
          record.task_id,
          record.attempt_id,
          record.version,
          record.role,
          record.status,
          findingsJson,
          record.summary ?? null,
          evidenceRefsJson,
          nowIso
        );
    } catch (err: any) {
      if (
        err.message &&
        (err.message.includes('UNIQUE constraint failed') ||
          err.message.includes('PRIMARY KEY'))
      ) {
        throw new Error(
          `Task result already exists and cannot overwrite (run_id: ${record.run_id}, task_id: ${record.task_id}, version: ${record.version}): ${err.message}`
        );
      }
      throw err;
    }
  }

  public getResult(run_id: string, task_id: string, version: number): TaskResultRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM task_results WHERE run_id = ? AND task_id = ? AND version = ?')
      .get(run_id, task_id, version) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  public getLatestResult(run_id: string, task_id: string): TaskResultRecord | null {
    const row = this.db.raw
      .prepare(
        'SELECT * FROM task_results WHERE run_id = ? AND task_id = ? ORDER BY version DESC LIMIT 1'
      )
      .get(run_id, task_id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  public getResultById(result_id: string): TaskResultRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM task_results WHERE result_id = ?')
      .get(result_id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  public listResultsByTask(task_id: string): TaskResultRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM task_results WHERE task_id = ? ORDER BY version ASC')
      .all(task_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public listResultsByRun(run_id: string): TaskResultRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM task_results WHERE run_id = ? ORDER BY created_at ASC')
      .all(run_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): TaskResultRecord {
    let findings: Record<string, unknown> | unknown[] | null = null;
    try {
      if (row.findings_json) findings = JSON.parse(row.findings_json);
    } catch {}

    let evidence_refs: string[] | null = null;
    try {
      if (row.evidence_refs_json) evidence_refs = JSON.parse(row.evidence_refs_json);
    } catch {}

    return {
      result_id: row.result_id,
      run_id: row.run_id,
      task_id: row.task_id,
      attempt_id: row.attempt_id,
      version: row.version,
      role: row.role,
      status: row.status,
      findings,
      summary: row.summary,
      evidence_refs,
      created_at: row.created_at,
    };
  }
}

export interface OutboxEventRecord {
  event_id: number;
  run_id: string;
  task_id?: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  delivered: boolean;
  created_at: string;
}

export class OutboxRepository {
  constructor(private db: ResearchDatabase) {}

  public appendEvent(event: {
    run_id: string;
    task_id?: string | null;
    event_type: string;
    payload: Record<string, unknown>;
    created_at?: string;
  }): number {
    const nowIso = event.created_at || new Date().toISOString();
    const payloadJson = JSON.stringify(event.payload || {});

    const result = this.db.raw
      .prepare(
        `INSERT INTO event_outbox (run_id, task_id, event_type, payload_json, delivered, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(event.run_id, event.task_id || null, event.event_type, payloadJson, nowIso);

    return Number(result.lastInsertRowid);
  }

  public markDelivered(event_id: number): void {
    this.db.raw
      .prepare('UPDATE event_outbox SET delivered = 1 WHERE event_id = ?')
      .run(event_id);
  }

  public markDeliveredBatch(event_ids: number[]): void {
    if (event_ids.length === 0) return;
    const placeholders = event_ids.map(() => '?').join(', ');
    this.db.raw
      .prepare(`UPDATE event_outbox SET delivered = 1 WHERE event_id IN (${placeholders})`)
      .run(...event_ids);
  }

  public getUndeliveredEvents(run_id?: string, limit?: number): OutboxEventRecord[] {
    let sql = 'SELECT * FROM event_outbox WHERE delivered = 0';
    const params: any[] = [];

    if (run_id) {
      sql += ' AND run_id = ?';
      params.push(run_id);
    }
    sql += ' ORDER BY event_id ASC';
    if (typeof limit === 'number' && limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this.db.raw.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  public getEventsAfter(
    after_event_id: number,
    run_id?: string,
    limit?: number
  ): OutboxEventRecord[] {
    let sql = 'SELECT * FROM event_outbox WHERE event_id > ?';
    const params: any[] = [after_event_id];

    if (run_id) {
      sql += ' AND run_id = ?';
      params.push(run_id);
    }
    sql += ' ORDER BY event_id ASC';
    if (typeof limit === 'number' && limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
    }

    const rows = this.db.raw.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  public getEvent(event_id: number): OutboxEventRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM event_outbox WHERE event_id = ?')
      .get(event_id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: any): OutboxEventRecord {
    let payload: Record<string, unknown> = {};
    try {
      if (row.payload_json) payload = JSON.parse(row.payload_json);
    } catch {}

    return {
      event_id: row.event_id,
      run_id: row.run_id,
      task_id: row.task_id,
      event_type: row.event_type,
      payload,
      delivered: Boolean(row.delivered),
      created_at: row.created_at,
    };
  }
}

export interface HostInboxRecord {
  inbox_id: number;
  run_id: string;
  event_seq?: number | null;
  status: string;
  claimed_at?: string | null;
  processed_at?: string | null;
}

export class HostInboxRepository {
  constructor(private db: ResearchDatabase) {}

  public recordEvent(run_id: string, event_seq?: number | null): number {
    if (event_seq !== undefined && event_seq !== null) {
      return this.db.transaction(() => {
        const existing = this.db.raw
          .prepare('SELECT inbox_id FROM host_inbox WHERE run_id = ? AND event_seq = ?')
          .get(run_id, event_seq) as any;

        if (existing) {
          return existing.inbox_id as number;
        }

        try {
          const result = this.db.raw
            .prepare(
              `INSERT INTO host_inbox (run_id, event_seq, status, claimed_at, processed_at)
               VALUES (?, ?, 'pending', NULL, NULL)`
            )
            .run(run_id, event_seq);
          return Number(result.lastInsertRowid);
        } catch (err: any) {
          if (
            err.message &&
            (err.message.includes('UNIQUE constraint failed') || err.message.includes('constraint failed'))
          ) {
            const conflictRow = this.db.raw
              .prepare('SELECT inbox_id FROM host_inbox WHERE run_id = ? AND event_seq = ?')
              .get(run_id, event_seq) as any;
            if (conflictRow) {
              return conflictRow.inbox_id as number;
            }
          }
          throw err;
        }
      });
    }

    const result = this.db.raw
      .prepare(
        `INSERT INTO host_inbox (run_id, event_seq, status, claimed_at, processed_at)
         VALUES (?, NULL, 'pending', NULL, NULL)`
      )
      .run(run_id);

    return Number(result.lastInsertRowid);
  }

  public claimPending(run_id: string, limit?: number): HostInboxRecord[] {
    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      let selectSql = "SELECT * FROM host_inbox WHERE run_id = ? AND status = 'pending' ORDER BY inbox_id ASC";
      const selectParams: any[] = [run_id];
      if (typeof limit === 'number' && limit > 0) {
        selectSql += ' LIMIT ?';
        selectParams.push(limit);
      }

      const rows = this.db.raw.prepare(selectSql).all(...selectParams) as any[];
      if (rows.length === 0) return [];

      const ids = rows.map((r) => r.inbox_id);
      const placeholders = ids.map(() => '?').join(', ');
      this.db.raw
        .prepare(`UPDATE host_inbox SET status = 'claimed', claimed_at = ? WHERE inbox_id IN (${placeholders})`)
        .run(nowIso, ...ids);

      return rows.map((r) => ({
        inbox_id: r.inbox_id,
        run_id: r.run_id,
        event_seq: r.event_seq,
        status: 'claimed',
        claimed_at: nowIso,
        processed_at: r.processed_at,
      }));
    });
  }

  public markProcessed(inbox_id: number): void {
    const nowIso = new Date().toISOString();
    this.db.raw
      .prepare("UPDATE host_inbox SET status = 'processed', processed_at = ? WHERE inbox_id = ?")
      .run(nowIso, inbox_id);
  }

  public markBatchProcessed(inbox_ids: number[]): void {
    if (inbox_ids.length === 0) return;
    const nowIso = new Date().toISOString();
    const placeholders = inbox_ids.map(() => '?').join(', ');
    this.db.raw
      .prepare(
        `UPDATE host_inbox SET status = 'processed', processed_at = ? WHERE inbox_id IN (${placeholders})`
      )
      .run(nowIso, ...inbox_ids);
  }

  public unclaim(inbox_id: number): void {
    this.db.raw
      .prepare("UPDATE host_inbox SET status = 'pending', claimed_at = NULL WHERE inbox_id = ?")
      .run(inbox_id);
  }

  public unclaimBatch(inbox_ids: number[]): void {
    if (inbox_ids.length === 0) return;
    const placeholders = inbox_ids.map(() => '?').join(', ');
    this.db.raw
      .prepare(
        `UPDATE host_inbox SET status = 'pending', claimed_at = NULL WHERE inbox_id IN (${placeholders})`
      )
      .run(...inbox_ids);
  }

  public listPending(run_id: string): HostInboxRecord[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM host_inbox WHERE run_id = ? AND status = 'pending' ORDER BY inbox_id ASC")
      .all(run_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public listByRun(run_id: string): HostInboxRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM host_inbox WHERE run_id = ? ORDER BY inbox_id ASC')
      .all(run_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): HostInboxRecord {
    return {
      inbox_id: row.inbox_id,
      run_id: row.run_id,
      event_seq: row.event_seq,
      status: row.status,
      claimed_at: row.claimed_at,
      processed_at: row.processed_at,
    };
  }
}

export interface HostDecisionRecord {
  decision_id: string;
  run_id: string;
  turn_number: number;
  decision_type: string;
  rationale?: string;
  task_id?: string | null;
  action_payload?: Record<string, unknown> | null;
  inbox_event_ids?: number[] | null;
  created_at: string;
}

export class HostDecisionRepository {
  constructor(private db: ResearchDatabase) {}

  public saveDecision(decision: HostDecisionRecord): void {
    const nowIso = decision.created_at || new Date().toISOString();
    const actionJson = decision.action_payload ? JSON.stringify(decision.action_payload) : null;
    const inboxJson = decision.inbox_event_ids ? JSON.stringify(decision.inbox_event_ids) : null;

    this.db.raw
      .prepare(
        `INSERT INTO host_decisions (
          decision_id, run_id, turn_number, decision_type, rationale,
          task_id, action_payload_json, inbox_event_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        decision.decision_id,
        decision.run_id,
        decision.turn_number,
        decision.decision_type,
        decision.rationale || null,
        decision.task_id || null,
        actionJson,
        inboxJson,
        nowIso
      );
  }

  public listDecisions(run_id: string): HostDecisionRecord[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM host_decisions WHERE run_id = ? ORDER BY turn_number ASC')
      .all(run_id) as any[];

    return rows.map((r) => this.mapRow(r));
  }

  public getDecisionCount(run_id: string): number {
    const row = this.db.raw
      .prepare('SELECT COUNT(*) as cnt FROM host_decisions WHERE run_id = ?')
      .get(run_id) as any;

    return Number(row?.cnt || 0);
  }

  public getLatestDecision(run_id: string): HostDecisionRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM host_decisions WHERE run_id = ? ORDER BY turn_number DESC LIMIT 1')
      .get(run_id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  public getDecision(decision_id: string): HostDecisionRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM host_decisions WHERE decision_id = ?')
      .get(decision_id) as any;

    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: any): HostDecisionRecord {
    let action_payload: Record<string, unknown> | null = null;
    try {
      if (row.action_payload_json) action_payload = JSON.parse(row.action_payload_json);
    } catch {}

    let inbox_event_ids: number[] | null = null;
    try {
      if (row.inbox_event_ids_json) inbox_event_ids = JSON.parse(row.inbox_event_ids_json);
    } catch {}

    return {
      decision_id: row.decision_id,
      run_id: row.run_id,
      turn_number: row.turn_number,
      decision_type: row.decision_type,
      rationale: row.rationale || undefined,
      task_id: row.task_id || null,
      action_payload,
      inbox_event_ids,
      created_at: row.created_at,
    };
  }
}


export interface IdempotencyRecord {
  idempotency_key: string;
  call_id: string;
  response: Record<string, unknown>;
  created_at?: string;
}

export function buildIdempotencyKey(params: {
  run_id: string;
  execution_version: number;
  host_turn_id: string | number;
  tool_call_id: string;
}): string {
  return `${params.run_id}:${params.execution_version}:${params.host_turn_id}:${params.tool_call_id}`;
}

export class IdempotencyRepository {
  constructor(private db: ResearchDatabase) {}

  public getRecord(key: string): IdempotencyRecord | null {
    const row = this.db.raw
      .prepare('SELECT * FROM idempotency_records WHERE idempotency_key = ?')
      .get(key) as any;

    if (!row) return null;
    return {
      idempotency_key: row.idempotency_key,
      call_id: row.call_id,
      response: JSON.parse(row.response_json),
      created_at: row.created_at,
    };
  }

  public saveRecord(record: IdempotencyRecord): void {
    const nowIso = record.created_at || new Date().toISOString();
    const responseJson = JSON.stringify(record.response);

    this.db.raw
      .prepare(
        `INSERT INTO idempotency_records (idempotency_key, call_id, response_json, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(record.idempotency_key, record.call_id, responseJson, nowIso);
  }

  public checkOrExecute<T extends Record<string, unknown>>(
    key: string,
    call_id: string,
    executeFn: () => T
  ): { cached: boolean; response: T } {
    const existing = this.getRecord(key);
    if (existing) {
      return { cached: true, response: existing.response as T };
    }

    const result = executeFn();
    this.saveRecord({
      idempotency_key: key,
      call_id,
      response: result,
    });

    return { cached: false, response: result };
  }
}

export interface SaveOutcomeParams {
  result: TaskResultRecord;
  attempt_status: string;
  completed_at?: string;
  attempt_error?: Record<string, unknown> | null;
  attempt_usage?: Record<string, unknown> | null;
  outbox_event?: {
    event_type: string;
    payload: Record<string, unknown>;
  };
  task_status?: TaskStatus;
}

export function saveOutcomeWithOutbox(db: ResearchDatabase, params: SaveOutcomeParams): void {
  db.transaction(() => {
    // 1. Save Task Result (checks immutability constraint)
    const resultRepo = new TaskResultRepository(db);
    resultRepo.saveResult(params.result);

    // 2. Update Task Attempt status, usage, error, completion
    const attemptRepo = new TaskAttemptRepository(db);
    attemptRepo.updateStatus(params.result.attempt_id, params.attempt_status, {
      completed_at: params.completed_at || params.result.created_at || new Date().toISOString(),
      error: params.attempt_error,
      usage: params.attempt_usage,
    });

    // 3. Append Outbox Event
    if (params.outbox_event) {
      const outboxRepo = new OutboxRepository(db);
      outboxRepo.appendEvent({
        run_id: params.result.run_id,
        task_id: params.result.task_id,
        event_type: params.outbox_event.event_type,
        payload: params.outbox_event.payload,
        created_at: params.completed_at || params.result.created_at,
      });
    }

    // 4. Optionally update Task status
    if (params.task_status) {
      const taskRepo = new TaskRepository(db);
      taskRepo.updateTaskStatus(
        params.result.task_id,
        params.task_status,
        params.completed_at || params.result.created_at
      );
    }
  });
}
