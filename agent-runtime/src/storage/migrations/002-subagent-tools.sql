-- Migration 002: subagent tools tables and tasks schema extension

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
