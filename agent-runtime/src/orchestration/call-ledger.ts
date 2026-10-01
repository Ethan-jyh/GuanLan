import { BudgetLedger, ReserveResult } from '../storage/budget-ledger.js';

export interface ActiveCall {
  run_id: string;
  task_id?: string;
  call_id: string;
  tool_name: string;
  reservation_id: string;
  started_at: string;
}

export interface BeginCallParams {
  run_id: string;
  task_id?: string;
  call_id: string;
  tool_name: string;
  units?: number;
  is_writing_phase?: boolean;
}

export interface EndCallParams {
  call_id: string;
  success: boolean;
  error?: string;
  actual_units?: number;
  cost_estimate?: number;
}

export class CallLedger {
  private activeCalls = new Map<string, ActiveCall>();

  constructor(private budgetLedger: BudgetLedger) {}

  public beginCall(params: BeginCallParams): ReserveResult {
    const res = this.budgetLedger.reserve({
      run_id: params.run_id,
      task_id: params.task_id,
      units: params.units ?? 1,
      call_type: `tool:${params.tool_name}`,
      is_writing_phase: params.is_writing_phase,
    });

    if (res.ok && res.reservation_id) {
      this.activeCalls.set(params.call_id, {
        run_id: params.run_id,
        task_id: params.task_id,
        call_id: params.call_id,
        tool_name: params.tool_name,
        reservation_id: res.reservation_id,
        started_at: new Date().toISOString(),
      });
    }

    return res;
  }

  public endCall(params: EndCallParams): void {
    const active = this.activeCalls.get(params.call_id);
    if (!active) return;

    // Failures also settle with consumption (default 1 unit) to prevent unlimited free retries
    const units = params.actual_units ?? 1;
    this.budgetLedger.settle({
      reservation_id: active.reservation_id,
      actual_units: units,
      cost_estimate: params.cost_estimate,
    });

    this.activeCalls.delete(params.call_id);
  }

  public getActiveCall(call_id: string): ActiveCall | undefined {
    return this.activeCalls.get(call_id);
  }

  public listActiveCalls(run_id?: string): ActiveCall[] {
    const all = Array.from(this.activeCalls.values());
    if (run_id) {
      return all.filter((c) => c.run_id === run_id);
    }
    return all;
  }
}
