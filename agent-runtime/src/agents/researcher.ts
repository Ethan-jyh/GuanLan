import {
  PiAgentAdapter,
  type ResearchToolDefinition,
  type PiAgentResult,
} from '../runtime/pi-adapter.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ResearchRole } from '../contracts/research.js';
import type { BudgetGate } from '../runtime/budget-gate.js';

export interface ResearcherAgentOptions {
  role: ResearchRole;
  systemPrompt: string;
  tools: ResearchToolDefinition[];
  submitTool: ResearchToolDefinition;
  streamFn: StreamFn;
  budgetGate?: BudgetGate;
}

export class ResearcherAgent {
  private adapter: PiAgentAdapter;

  constructor(public options: ResearcherAgentOptions) {
    const allTools = [...options.tools, options.submitTool];

    this.adapter = new PiAgentAdapter({
      systemPrompt: options.systemPrompt,
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

  async run(prompt: string, signal?: AbortSignal): Promise<PiAgentResult> {
    if (signal?.aborted) {
      throw signal.reason || new Error('Task execution aborted');
    }
    if (signal) {
      signal.addEventListener('abort', () => this.abort(), { once: true });
    }
    return this.adapter.run(prompt);
  }

  public abort(): void {
    this.adapter.abort();
  }

  get state() {
    return this.adapter.state;
  }
}

export function createResearcherAgent(options: ResearcherAgentOptions): ResearcherAgent {
  return new ResearcherAgent(options);
}
