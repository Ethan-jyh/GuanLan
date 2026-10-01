import {
  PiAgentAdapter,
  type ResearchToolDefinition,
  type PiAgentResult,
} from '../runtime/pi-adapter.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { HOST_SYSTEM_PROMPT } from '../prompts/host.js';
import type { BudgetGate } from '../runtime/budget-gate.js';

export interface HostAgentOptions {
  systemPrompt?: string;
  delegateTool: ResearchToolDefinition;
  additionalTools?: ResearchToolDefinition[];
  streamFn: StreamFn;
  budgetGate?: BudgetGate;
}

export class HostAgent {
  private adapter: PiAgentAdapter;

  constructor(public options: HostAgentOptions) {
    const allTools = [options.delegateTool, ...(options.additionalTools || [])];

    this.adapter = new PiAgentAdapter({
      systemPrompt: options.systemPrompt || HOST_SYSTEM_PROMPT,
      tools: allTools,
      streamFn: options.streamFn,
      beforeToolCall: options.budgetGate
        ? async (toolCall) => options.budgetGate!.beforeToolCall(toolCall)
        : undefined,
      afterToolCall: options.budgetGate
        ? async (toolCall, result) => options.budgetGate!.afterToolCall(toolCall, result)
        : undefined,
    });
  }

  async run(prompt: string): Promise<PiAgentResult> {
    return this.adapter.run(prompt);
  }

  get state() {
    return this.adapter.state;
  }
}

export function createHostAgent(options: HostAgentOptions): HostAgent {
  return new HostAgent(options);
}
