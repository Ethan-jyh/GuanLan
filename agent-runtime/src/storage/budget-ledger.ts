import { ResearchDatabase } from './database.js';

export interface BudgetLedgerOptions {
  totalToolLimit?: number;
  reservedForWriting?: number;
}

export interface ReserveParams {
  run_id: string;
  task_id?: string;
  units?: number;
  call_type?: string;
  idempotency_key?: string;
  is_writing_phase?: boolean;
}

export interface ReserveResult {
  ok: boolean;
  reservation_id?: string;
  error?: string;
}

export interface SettleParams {
  reservation_id: string;
  actual_units?: number;
  cost_estimate?: number;
}

export interface BudgetUsage {
  used: number;
  reserved: number;
  committed: number;
}

export class BudgetLedger {
  public readonly totalToolLimit: number;
  public readonly reservedForWriting: number;

  constructor(
    private db: ResearchDatabase,
    options: BudgetLedgerOptions = {}
  ) {
    this.totalToolLimit = options.totalToolLimit ?? 50;
    this.reservedForWriting = options.reservedForWriting ?? 10;
  }

  public get maxResearchToolQuota(): number {
    return Math.max(0, this.totalToolLimit - this.reservedForWriting);
  }

  public reserve(params: ReserveParams): ReserveResult {
    const units = params.units ?? 1;
    const callType = params.call_type ?? 'tool_call';
    const nowIso = new Date().toISOString();
    const reservationId = `res-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

    const maxAllowed = params.is_writing_phase
      ? this.totalToolLimit
      : this.maxResearchToolQuota;

    return this.db.transaction(() => {
      // 1. Check idempotency
      if (params.idempotency_key) {
        const existing = this.db.raw
          .prepare(
            'SELECT reservation_id, status FROM budget_ledger WHERE idempotency_key = ?'
          )
          .get(params.idempotency_key) as any;

        if (existing) {
          return { ok: true, reservation_id: existing.reservation_id };
        }
      }

      // 2. Calculate current committed quota
      const stats = this.db.raw
        .prepare(
          `SELECT 
            COALESCE(SUM(units_used), 0) AS total_used,
            COALESCE(SUM(CASE WHEN status = 'reserved' THEN units_reserved ELSE 0 END), 0) AS total_reserved
          FROM budget_ledger
          WHERE run_id = ? AND status IN ('reserved', 'settled')`
        )
        .get(params.run_id) as any;

      const usedSoFar = (stats?.total_used || 0) + (stats?.total_reserved || 0);

      if (usedSoFar + units > maxAllowed) {
        return {
          ok: false,
          error: `Budget quota exceeded: committed=${usedSoFar}, requesting=${units}, max_allowed=${maxAllowed}`,
        };
      }

      // 3. Insert reservation
      this.db.raw
        .prepare(
          `INSERT INTO budget_ledger (
            reservation_id, run_id, task_id, call_type, units_reserved,
            units_used, status, idempotency_key, created_at
          ) VALUES (?, ?, ?, ?, ?, 0, 'reserved', ?, ?)`
        )
        .run(
          reservationId,
          params.run_id,
          params.task_id || null,
          callType,
          units,
          params.idempotency_key || null,
          nowIso
        );

      return { ok: true, reservation_id: reservationId };
    });
  }

  public settle(params: SettleParams): void {
    const actualUnits = params.actual_units ?? 1;
    const nowIso = new Date().toISOString();

    this.db.raw
      .prepare(
        `UPDATE budget_ledger
         SET status = 'settled',
             units_used = ?,
             units_reserved = 0,
             cost_estimate = ?,
             settled_at = ?
         WHERE reservation_id = ?`
      )
      .run(
        actualUnits,
        params.cost_estimate ?? null,
        nowIso,
        params.reservation_id
      );
  }

  public cancel(reservation_id: string): void {
    this.db.raw
      .prepare(
        `UPDATE budget_ledger
         SET status = 'cancelled',
             units_reserved = 0
         WHERE reservation_id = ?`
      )
      .run(reservation_id);
  }

  public getUsage(run_id: string): BudgetUsage {
    const row = this.db.raw
      .prepare(
        `SELECT 
          COALESCE(SUM(units_used), 0) AS total_used,
          COALESCE(SUM(CASE WHEN status = 'reserved' THEN units_reserved ELSE 0 END), 0) AS total_reserved
        FROM budget_ledger
        WHERE run_id = ? AND status IN ('reserved', 'settled')`
      )
      .get(run_id) as any;

    const used = row?.total_used || 0;
    const reserved = row?.total_reserved || 0;
    return {
      used,
      reserved,
      committed: used + reserved,
    };
  }

  public getRemaining(run_id: string, is_writing_phase = false): number {
    const usage = this.getUsage(run_id);
    const limit = is_writing_phase ? this.totalToolLimit : this.maxResearchToolQuota;
    return Math.max(0, limit - usage.committed);
  }

  public preserveUncertainReservations(run_id: string): void {
    // Retain reserved state for crash recovery; reservations remain intact
    // Explicitly verify reserved records are not wiped
    const countRow = this.db.raw
      .prepare(
        "SELECT COUNT(*) as cnt FROM budget_ledger WHERE run_id = ? AND status = 'reserved'"
      )
      .get(run_id) as any;
    // Log or preserve count
    return countRow?.cnt || 0;
  }
}
