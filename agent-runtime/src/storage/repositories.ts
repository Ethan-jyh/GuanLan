import { ResearchDatabase } from './database.js';
import {
  ResearchRun,
  RunStatus,
  ResearchTask,
  TaskStatus,
  ResearchRole,
  DecisionType,
  HostReviewDecision,
  DirectiveItem,
} from '../contracts/research.js';

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

  public createTask(task: ResearchTask): void {
    const scopeJson = JSON.stringify(task.scope || {});
    this.db.raw
      .prepare(
        `INSERT INTO tasks (
          task_id, run_id, role, round, question, scope, status,
          assigned_to, budget_allocated, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.task_id,
        task.run_id,
        task.role,
        task.round,
        task.question,
        scopeJson,
        task.status,
        task.assigned_to || null,
        task.budget_allocated ?? 0,
        task.created_at,
        task.completed_at || null
      );
  }

  public getTask(task_id: string): ResearchTask | null {
    const row = this.db.raw
      .prepare('SELECT * FROM tasks WHERE task_id = ?')
      .get(task_id) as any;

    if (!row) return null;
    let scope: Record<string, unknown> = {};
    try {
      if (row.scope) scope = JSON.parse(row.scope);
    } catch {}

    return {
      task_id: row.task_id,
      run_id: row.run_id,
      role: row.role as ResearchRole,
      round: row.round,
      question: row.question,
      scope,
      status: row.status as TaskStatus,
      assigned_to: row.assigned_to,
      budget_allocated: row.budget_allocated,
      created_at: row.created_at,
      completed_at: row.completed_at,
    };
  }

  public listTasks(run_id: string): ResearchTask[] {
    const rows = this.db.raw
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id ASC')
      .all(run_id) as any[];

    return rows.map((row) => {
      let scope: Record<string, unknown> = {};
      try {
        if (row.scope) scope = JSON.parse(row.scope);
      } catch {}
      return {
        task_id: row.task_id,
        run_id: row.run_id,
        role: row.role as ResearchRole,
        round: row.round,
        question: row.question,
        scope,
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

    // UNIQUE (run_id, role, round) and PRIMARY KEY (submission_id)
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
