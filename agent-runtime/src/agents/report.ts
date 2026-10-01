import {
  PiAgentAdapter,
  type ResearchToolDefinition,
  type PiAgentResult,
} from '../runtime/pi-adapter.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { REPORT_SYSTEM_PROMPT } from '../prompts/report.js';
import type { ReportJudgment } from '../contracts/research.js';
import type { BudgetGate } from '../runtime/budget-gate.js';

export function createSubmitJudgmentTool(
  onSubmit: (judgment: ReportJudgment) => Promise<{ ok: boolean; error?: string }>
): ResearchToolDefinition {
  return {
    name: 'submit_judgment',
    description: '提交多维情报综合研判结论 (ReportJudgment)，包含全景解释、风险点、针对性应对策略及证据链引用。',
    parameters: {
      type: 'object',
      properties: {
        judgment: {
          type: 'object',
          description: '符合 ReportJudgment 规范的结构化研判对象',
          required: [
            'overall_interpretation',
            'risks',
            'recommendations',
            'linked_claim_ids',
            'linked_evidence_ids',
          ],
          properties: {
            overall_interpretation: { type: 'string' },
            risks: { type: 'array' },
            recommendations: { type: 'array' },
            linked_claim_ids: { type: 'array' },
            linked_evidence_ids: { type: 'array' },
            applicability_conditions: { type: 'array' },
            alternative_explanations: { type: 'array' },
            uncertainties: { type: 'array' },
          },
        },
      },
      required: ['judgment'],
    },
    execute: async (params: { judgment: ReportJudgment }) => {
      if (!params || !params.judgment) {
        throw new Error('Missing judgment payload in submit_judgment');
      }

      const res = await onSubmit(params.judgment);
      if (!res.ok) {
        throw new Error(`Judgment submission rejected: ${res.error || 'Unknown error'}`);
      }

      return {
        status: 'success',
        message: 'ReportJudgment successfully submitted and verified',
      };
    },
  };
}

export interface ReportAgentOptions {
  systemPrompt?: string;
  submitJudgmentTool: ResearchToolDefinition;
  additionalTools?: ResearchToolDefinition[];
  streamFn: StreamFn;
  budgetGate?: BudgetGate;
}

export class ReportAgent {
  private adapter: PiAgentAdapter;

  constructor(public options: ReportAgentOptions) {
    const allTools = [options.submitJudgmentTool, ...(options.additionalTools || [])];

    this.adapter = new PiAgentAdapter({
      systemPrompt: options.systemPrompt || REPORT_SYSTEM_PROMPT,
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

export function createReportAgent(options: ReportAgentOptions): ReportAgent {
  return new ReportAgent(options);
}
