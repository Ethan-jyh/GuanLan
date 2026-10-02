import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../storage/budget-ledger.js';
export { TaskCancellationController, type TaskCancellationOptions } from './pi-adapter.js';

export interface BudgetGateOptions {
  runId?: string;
  taskId?: string;
  taskBudgetAllocated?: number;
  checkQuota?: () => Promise<boolean>;
  checkTaskQuota?: (taskId: string) => Promise<boolean>;
  checkGlobalQuota?: (runId: string) => Promise<boolean>;
  reserve?: (
    toolName: string,
    callId?: string
  ) => Promise<{ ok: boolean; reservationId?: string; reason?: string }>;
  settle?: (reservationId: string, actualUnits?: number) => Promise<void>;
}

export interface ToolCallSpec {
  name: string;
  arguments: any;
  call_id?: string;
}

export class BudgetGate {
  private activeReservations: Map<string, string> = new Map();

  constructor(private options: BudgetGateOptions = {}) {}

  public get activeReservationCount(): number {
    return this.activeReservations.size;
  }

  public getActiveReservation(callId: string): string | undefined {
    return this.activeReservations.get(callId);
  }

  public async checkTaskQuota(taskId?: string): Promise<boolean> {
    const targetTaskId = taskId ?? this.options.taskId;
    if (!targetTaskId) return true;
    if (this.options.checkTaskQuota) {
      return this.options.checkTaskQuota(targetTaskId);
    }
    return true;
  }

  public async checkGlobalQuota(runId?: string): Promise<boolean> {
    const targetRunId = runId ?? this.options.runId;
    if (!targetRunId) return true;
    if (this.options.checkGlobalQuota) {
      return this.options.checkGlobalQuota(targetRunId);
    }
    return true;
  }

  public bindToBudgetLedger(
    ledger: BudgetLedger,
    runId: string,
    taskId?: string,
    isWritingPhase = false,
    taskBudgetAllocated?: number
  ): void {
    this.options.runId = runId;
    this.options.taskId = taskId;
    this.options.taskBudgetAllocated = taskBudgetAllocated;

    this.options.checkGlobalQuota = async (rId: string) => {
      return ledger.getRemaining(rId, isWritingPhase) > 0;
    };

    if (taskId) {
      this.options.checkTaskQuota = async (tId: string) => {
        return ledger.getTaskRemaining(tId, taskBudgetAllocated) > 0;
      };
    }

    this.options.checkQuota = async () => {
      const globalOk = ledger.getRemaining(runId, isWritingPhase) > 0;
      if (!globalOk) return false;
      if (taskId) {
        return ledger.getTaskRemaining(taskId, taskBudgetAllocated) > 0;
      }
      return true;
    };

    this.options.reserve = async (toolName: string, callId?: string) => {
      const res = ledger.reserve({
        run_id: runId,
        task_id: taskId,
        units: 1,
        call_type: `tool:${toolName}`,
        is_writing_phase: isWritingPhase,
        task_budget_allocated: taskBudgetAllocated,
        idempotency_key: callId,
      });

      if (!res.ok) {
        return { ok: false, reason: res.error || 'Quota exceeded' };
      }
      return { ok: true, reservationId: res.reservation_id };
    };

    this.options.settle = async (reservationId: string, actualUnits = 1) => {
      ledger.settle({
        reservation_id: reservationId,
        actual_units: actualUnits,
      });
    };
  }

  async beforeToolCall(
    toolCall: ToolCallSpec,
    signal?: AbortSignal
  ): Promise<{ block?: boolean; reason?: string } | undefined> {
    if (signal?.aborted) {
      return {
        block: true,
        reason: 'Call aborted before execution',
      };
    }

    // 1. Task-level quota check
    const hasTaskQuota = await this.checkTaskQuota(this.options.taskId);
    if (!hasTaskQuota) {
      return {
        block: true,
        reason: `Task budget quota exhausted for task ${this.options.taskId || 'unknown'} before calling ${toolCall.name}`,
      };
    }

    // 2. Global-level quota check
    const hasGlobalQuota = await this.checkGlobalQuota(this.options.runId);
    if (!hasGlobalQuota) {
      return {
        block: true,
        reason: `Global budget quota exhausted for run ${this.options.runId || 'unknown'} before calling ${toolCall.name}`,
      };
    }

    // 3. Optional generic checkQuota check
    if (this.options.checkQuota) {
      const hasQuota = await this.options.checkQuota();
      if (!hasQuota) {
        return {
          block: true,
          reason: `Budget quota exhausted before calling ${toolCall.name}`,
        };
      }
    }

    // 4. Enforce that reservation keys in activeReservations use toolCall.call_id.
    // If call_id is missing, generate a unique ID; NEVER fall back to toolCall.name.
    const key = toolCall.call_id || `call-gen-${randomUUID()}`;
    if (!toolCall.call_id) {
      toolCall.call_id = key;
    }

    if (this.options.reserve) {
      const res = await this.options.reserve(toolCall.name, toolCall.call_id);
      if (!res.ok) {
        return {
          block: true,
          reason: res.reason || `Budget reservation denied for ${toolCall.name}`,
        };
      }
      if (res.reservationId) {
        this.activeReservations.set(key, res.reservationId);
      }
    }

    return undefined;
  }

  async afterToolCall(
    toolCall: ToolCallSpec,
    _result: any,
    signal?: AbortSignal
  ): Promise<void> {
    // Only resolve by call_id; NEVER fall back to toolCall.name
    if (!toolCall.call_id) {
      return;
    }
    if (signal?.aborted) {
      this.activeReservations.delete(toolCall.call_id);
      return;
    }
    const resId = this.activeReservations.get(toolCall.call_id);
    if (resId && this.options.settle) {
      await this.options.settle(resId, 1);
      this.activeReservations.delete(toolCall.call_id);
    }
  }
}
