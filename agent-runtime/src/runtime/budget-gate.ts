export interface BudgetGateOptions {
  checkQuota?: () => Promise<boolean>;
  reserve?: (
    toolName: string
  ) => Promise<{ ok: boolean; reservationId?: string; reason?: string }>;
  settle?: (reservationId: string, actualUnits?: number) => Promise<void>;
}

export class BudgetGate {
  private activeReservations: Map<string, string> = new Map();

  constructor(private options: BudgetGateOptions) {}

  async beforeToolCall(toolCall: {
    name: string;
    arguments: any;
  }): Promise<{ block?: boolean; reason?: string } | undefined> {
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
      const res = await this.options.reserve(toolCall.name);
      if (!res.ok) {
        return {
          block: true,
          reason: res.reason || `Budget reservation denied for ${toolCall.name}`,
        };
      }
      if (res.reservationId) {
        this.activeReservations.set(toolCall.name, res.reservationId);
      }
    }

    return undefined;
  }

  async afterToolCall(
    toolCall: { name: string; arguments: any },
    _result: any
  ): Promise<void> {
    const resId = this.activeReservations.get(toolCall.name);
    if (resId && this.options.settle) {
      await this.options.settle(resId, 1);
      this.activeReservations.delete(toolCall.name);
    }
  }
}
