import { DatabaseSync } from 'node:sqlite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATION_SQL = `
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

export class ResearchDatabase {
  public readonly raw: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.raw = db;
    this.init();
  }

  private init() {
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec(MIGRATION_SQL);
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
