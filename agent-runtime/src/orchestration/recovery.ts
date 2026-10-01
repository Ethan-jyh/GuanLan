import { RunRepository } from '../storage/repositories.js';
import { ResearchRun, RunStatus } from '../contracts/research.js';

export class RecoveryManager {
  constructor(private runRepo: RunRepository) {}

  public autoPauseUnendedRunsOnStartup(): string[] {
    const unendedStatuses = [
      RunStatus.Planning,
      RunStatus.Researching,
      RunStatus.Reviewing,
    ];

    const pausedIds: string[] = [];

    // Query active runs through direct SQLite query on runs table
    const rows = (this.runRepo as any).db.raw
      .prepare(
        `SELECT run_id FROM runs WHERE status IN ('planning', 'researching', 'reviewing')`
      )
      .all() as Array<{ run_id: string }>;

    for (const r of rows) {
      this.runRepo.updateRunStatus(r.run_id, RunStatus.Paused);
      pausedIds.push(r.run_id);
    }

    return pausedIds;
  }

  public resumeRun(run_id: string): ResearchRun {
    const run = this.runRepo.getRun(run_id);
    if (!run) {
      throw new Error(`Run ${run_id} not found`);
    }
    if (run.status !== RunStatus.Paused) {
      throw new Error(`Cannot resume run in status '${run.status}', expected 'paused'`);
    }

    const nextVersion = (run.execution_version || 1) + 1;
    const nowIso = new Date().toISOString();

    (this.runRepo as any).db.raw
      .prepare(
        `UPDATE runs
         SET status = ?, execution_version = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(RunStatus.Researching, nextVersion, nowIso, run_id);

    return this.runRepo.getRun(run_id)!;
  }

  public cancelRun(run_id: string): ResearchRun {
    const run = this.runRepo.getRun(run_id);
    if (!run) {
      throw new Error(`Run ${run_id} not found`);
    }

    const nextVersion = (run.execution_version || 1) + 1;
    const nowIso = new Date().toISOString();

    (this.runRepo as any).db.raw
      .prepare(
        `UPDATE runs
         SET status = ?, execution_version = ?, updated_at = ?
         WHERE run_id = ?`
      )
      .run(RunStatus.Cancelled, nextVersion, nowIso, run_id);

    return this.runRepo.getRun(run_id)!;
  }

  public validateExecutionVersion(run_id: string, client_version: number): boolean {
    const run = this.runRepo.getRun(run_id);
    if (!run) return false;
    return client_version >= (run.execution_version || 1);
  }
}
