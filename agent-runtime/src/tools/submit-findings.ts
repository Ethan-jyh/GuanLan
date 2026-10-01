import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';

export function createSubmitFindingsTool(
  onSubmit: (findings: any) => Promise<{ ok: boolean; submissionId?: string; error?: string }>
): ResearchToolDefinition {
  return {
    name: 'submit_findings',
    description: '提交本次任务结构化研究成果并结束本轮调研。必须在完成证据收集与核查后调用。',
    parameters: {
      type: 'object',
      properties: {
        findings: {
          type: 'object',
          description: '符合 ResearchResult 契约规范的完整研究成果数据包',
          required: ['role', 'round', 'claims', 'evidence_pool'],
          properties: {
            role: { type: 'string' },
            round: { type: 'number' },
            claims: { type: 'array' },
            evidence_pool: { type: 'array' },
            scope: { type: 'object' },
            authority_finding: { type: 'object' },
            evolution_finding: { type: 'object' },
            feedback_finding: { type: 'object' },
            coverage_list: { type: 'array' },
            unresolved_issues: { type: 'array' },
          },
        },
      },
      required: ['findings'],
    },
    execute: async (params: { findings: any }) => {
      if (!params || !params.findings) {
        throw new Error('Missing findings payload in submit_findings');
      }

      const res = await onSubmit(params.findings);
      if (!res.ok) {
        throw new Error(`Submission rejected: ${res.error || 'Unknown error'}`);
      }

      return {
        status: 'success',
        submission_id: res.submissionId,
        message: 'Research findings successfully validated and persisted',
      };
    },
  };
}
