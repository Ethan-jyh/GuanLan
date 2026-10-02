import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';

export interface SubmitFindingsContext {
  run_id: string;
  task_id: string;
  attempt_id: string;
  role: string;
  execution_version: number;
}

export type SubmitFindingsHandler = (
  findings: any,
  context?: SubmitFindingsContext
) => Promise<{ ok: boolean; submissionId?: string; error?: string }>;

export function createSubmitFindingsTool(
  onSubmit: SubmitFindingsHandler,
  context?: SubmitFindingsContext
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

      if (context) {
        // Enforce role isolation
        if (params.findings.role && params.findings.role !== context.role) {
          throw new Error(
            `Submission rejected: Role mismatch (expected '${context.role}', got '${params.findings.role}')`
          );
        }

        // Enforce task isolation
        if (params.findings.task_id && params.findings.task_id !== context.task_id) {
          throw new Error(
            `Submission rejected: Task_id mismatch (expected '${context.task_id}', got '${params.findings.task_id}')`
          );
        }

        // Enforce run isolation
        if (params.findings.run_id && params.findings.run_id !== context.run_id) {
          throw new Error(
            `Submission rejected: Run_id mismatch (expected '${context.run_id}', got '${params.findings.run_id}')`
          );
        }

        // Guarantee immutable bound context on findings
        params.findings.role = context.role;
        params.findings.task_id = context.task_id;
        params.findings.run_id = context.run_id;
        params.findings.attempt_id = context.attempt_id;
        params.findings.execution_version = context.execution_version;
      }

      const res = await onSubmit(params.findings, context);
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
