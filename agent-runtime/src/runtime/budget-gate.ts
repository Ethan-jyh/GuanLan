import { BudgetLedger } from '../storage/budget-ledger.js';

export interface BudgetGateOptions {
  checkQuota?: () => Promise<boolean>;
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

  public bindToBudgetLedger(
    ledger: BudgetLedger,
    runId: string,
    taskId?: string,
    isWritingPhase = false
  ): void {
    this.options.checkQuota = async () => {
      return ledger.getRemaining(runId, isWritingPhase) > 0;
    };

    this.options.reserve = async (toolName: string, callId?: string) => {
      const res = ledger.reserve({
        run_id: runId,
        task_id: taskId,
        units: 1,
        call_type: `tool:${toolName}`,
        is_writing_phase: isWritingPhase,
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

  async beforeToolCall(toolCall: ToolCallSpec): Promise<{ block?: boolean; reason?: string } | undefined> {
    const key = toolCall.call_id || toolCall.name;

    if (this.options.checkQuota) {
      const hasQuota = await this.options.checkQuota();
      if (!hasQuota) {
        return {
          block: true,
          reason: `Budget quota exhausted before calling ${toolCall.name}`,
        };
      }
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
    _result: any
  ): Promise<void> {
    const key = toolCall.call_id || toolCall.name;
    const resId = this.activeReservations.get(key);
    if (resId && this.options.settle) {
      await this.options.settle(resId, 1);
      this.activeReservations.delete(key);
    }
  }
}
