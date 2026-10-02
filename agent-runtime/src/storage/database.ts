import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_001_SQL = `
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    scope TEXT,
    status TEXT NOT NULL,
    current_round INTEGER NOT NULL DEFAULT 1,
    max_rounds INTEGER NOT NULL DEFAULT 3,
    budget_total INTEGER NOT NULL DEFAULT 50,
    budget_used INTEGER NOT NULL DEFAULT 0,
    execution_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    role TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    question TEXT NOT NULL,
    scope TEXT,
    status TEXT NOT NULL,
    assigned_to TEXT,
    budget_allocated INTEGER NOT NULL DEFAULT 12,
    created_at TEXT NOT NULL,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);

CREATE TABLE IF NOT EXISTS budget_ledger (
    ledger_id INTEGER PRIMARY KEY AUTOINCREMENT,
    reservation_id TEXT UNIQUE NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT,
    call_type TEXT NOT NULL,
    units_reserved INTEGER NOT NULL DEFAULT 0,
    units_used INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    cost_estimate REAL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_budget_run ON budget_ledger(run_id);
CREATE INDEX IF NOT EXISTS idx_budget_idem ON budget_ledger(idempotency_key);

CREATE TABLE IF NOT EXISTS submissions (
    submission_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    role TEXT NOT NULL,
    round INTEGER NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (run_id, role, round)
);
CREATE INDEX IF NOT EXISTS idx_submissions_run ON submissions(run_id);

CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_key TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
    review_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    round INTEGER NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT NOT NULL,
    directives_json TEXT NOT NULL,
    unresolved_issues_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, round)
);
CREATE INDEX IF NOT EXISTS idx_reviews_run ON reviews(run_id);

CREATE TABLE IF NOT EXISTS evidence (
    evidence_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    retrieval_time TEXT NOT NULL,
    source_date TEXT,
    is_full_text INTEGER NOT NULL DEFAULT 0,
    coverage_scope TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, evidence_id),
    UNIQUE (run_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence(run_id);

CREATE TABLE IF NOT EXISTS research_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON research_events(run_id, event_seq);
`;

const MIGRATION_002_SQL = `
CREATE TABLE IF NOT EXISTS task_attempts (
    attempt_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    execution_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    worker_lease TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_json TEXT,
    usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_run ON task_attempts(run_id);
CREATE INDEX IF NOT EXISTS idx_task_attempts_status ON task_attempts(status);

CREATE TABLE IF NOT EXISTS task_results (
    result_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    findings_json TEXT,
    summary TEXT,
    evidence_refs_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(run_id, task_id, version)
);
CREATE INDEX IF NOT EXISTS idx_task_results_run ON task_results(run_id);
CREATE INDEX IF NOT EXISTS idx_task_results_task ON task_results(task_id);

CREATE TABLE IF NOT EXISTS event_outbox (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_undelivered ON event_outbox(delivered, run_id);
CREATE INDEX IF NOT EXISTS idx_outbox_run ON event_outbox(run_id);

CREATE TABLE IF NOT EXISTS host_inbox (
    inbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    event_seq INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_at TEXT,
    processed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_host_inbox_run_status ON host_inbox(run_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_inbox_run_seq ON host_inbox(run_id, event_seq) WHERE event_seq IS NOT NULL;
`;

export class DatabaseMigrations {
  constructor(private db: DatabaseSync | ResearchDatabase) {}

  public apply(): void {
    const raw = this.db instanceof ResearchDatabase ? this.db.raw : this.db;
    DatabaseMigrations.applyMigrations(raw);
  }

  public static getAppliedMigrations(db: DatabaseSync): string[] {
    try {
      const rows = db
        .prepare('SELECT name FROM schema_migrations ORDER BY version ASC;')
        .all() as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } catch {
      return [];
    }
  }

  public static applyMigrations(db: DatabaseSync): void {
    // 1. Ensure schema_migrations table exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
      );
    `);

    const applied = new Set(DatabaseMigrations.getAppliedMigrations(db));
    const nowIso = new Date().toISOString();

    // Migration 001
    if (!applied.has('001-research')) {
      const sql001 = DatabaseMigrations.loadMigrationSql('001-research.sql', MIGRATION_001_SQL);
      db.exec(sql001);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(1, '001-research', nowIso);
    }

    // Migration 002
    if (!applied.has('002-subagent-tools')) {
      const sql002 = DatabaseMigrations.loadMigrationSql('002-subagent-tools.sql', MIGRATION_002_SQL);
      db.exec(sql002);

      // Add columns to tasks table if not existing
      DatabaseMigrations.extendTasksTable(db);

      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(2, '002-subagent-tools', nowIso);
    } else {
      // Even if 002 recorded, ensure tasks columns are present
      DatabaseMigrations.extendTasksTable(db);
    }
  }

  private static extendTasksTable(db: DatabaseSync): void {
    try {
      const columns = db
        .prepare('PRAGMA table_info(tasks);')
        .all() as Array<{ name: string }>;
      const colNames = new Set(columns.map((c) => c.name));

      if (!colNames.has('generation')) {
        db.exec('ALTER TABLE tasks ADD COLUMN generation INTEGER DEFAULT 1;');
      }
      if (!colNames.has('completion_criteria')) {
        db.exec('ALTER TABLE tasks ADD COLUMN completion_criteria TEXT;');
      }
      if (!colNames.has('required_for_report')) {
        db.exec('ALTER TABLE tasks ADD COLUMN required_for_report INTEGER DEFAULT 1;');
      }
      if (!colNames.has('dependencies_json')) {
        db.exec('ALTER TABLE tasks ADD COLUMN dependencies_json TEXT;');
      }
      if (!colNames.has('superseded_by')) {
        db.exec('ALTER TABLE tasks ADD COLUMN superseded_by TEXT;');
      }
    } catch {
      // If tasks table doesn't exist yet, ignore
    }
  }

  private static loadMigrationSql(filename: string, fallback: string): string {
    try {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const possiblePaths = [
        resolve(currentDir, 'migrations', filename),
        resolve(currentDir, '../../src/storage/migrations', filename),
        resolve(currentDir, '../../../src/storage/migrations', filename),
      ];
      for (const p of possiblePaths) {
        if (existsSync(p)) {
          return readFileSync(p, 'utf-8');
        }
      }
    } catch {
      // Fallback
    }
    return fallback;
  }
}

export class ResearchDatabase {
  public readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
    this.init();
  }

  private init() {
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    DatabaseMigrations.applyMigrations(this.raw);
  }

  public transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.raw.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK;');
      } catch {
        // Rollback error ignored if already aborted
      }
      throw err;
    }
  }

  public close() {
    this.raw.close();
  }
}

export function createDatabase(dbOrPath: DatabaseSync | string = ':memory:'): ResearchDatabase {
  if (typeof dbOrPath === 'string') {
    const raw = new DatabaseSync(dbOrPath);
    return new ResearchDatabase(raw);
  }
  return new ResearchDatabase(dbOrPath);
}
