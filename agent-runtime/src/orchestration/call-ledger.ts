import { BudgetLedger, ReserveResult, BudgetUsage } from '../storage/budget-ledger.js';

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
  task_budget_allocated?: number;
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
      task_budget_allocated: params.task_budget_allocated,
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

  public beginSubCall(params: {
    parent_call_id: string;
    sub_call_id: string;
    units?: number;
    call_type?: string;
  }): ReserveResult {
    const parent = this.activeCalls.get(params.parent_call_id);
    if (!parent) {
      return { ok: false, error: `Parent call ${params.parent_call_id} not found` };
    }

    const res = this.budgetLedger.reserve({
      run_id: parent.run_id,
      task_id: parent.task_id,
      units: params.units ?? 1,
      call_type: params.call_type ?? `${parent.tool_name}:http`,
    });

    if (res.ok && res.reservation_id) {
      this.activeCalls.set(params.sub_call_id, {
        run_id: parent.run_id,
        task_id: parent.task_id,
        call_id: params.sub_call_id,
        tool_name: `${parent.tool_name}:sub`,
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

  public listActiveCalls(run_id?: string, task_id?: string): ActiveCall[] {
    let all = Array.from(this.activeCalls.values());
    if (run_id) {
      all = all.filter((c) => c.run_id === run_id);
    }
    if (task_id) {
      all = all.filter((c) => c.task_id === task_id);
    }
    return all;
  }

  public getTaskUsage(taskId: string): BudgetUsage {
    return this.budgetLedger.getTaskUsage(taskId);
  }

  public getTaskRemaining(taskId: string, budgetAllocated?: number): number {
    return this.budgetLedger.getTaskRemaining(taskId, budgetAllocated);
  }

  public checkTaskQuota(taskId: string, budgetAllocated?: number): boolean {
    return this.budgetLedger.getTaskRemaining(taskId, budgetAllocated) > 0;
  }

  public checkGlobalQuota(runId: string, isWritingPhase = false): boolean {
    return this.budgetLedger.getRemaining(runId, isWritingPhase) > 0;
  }

  public getTasksUsage(runId: string): Map<string, BudgetUsage> {
    return this.budgetLedger.getTasksUsage(runId);
  }
}
