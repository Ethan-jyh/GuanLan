import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';

export interface PlannedTaskInput {
  role: 'authority' | 'evolution' | 'feedback';
  question: string;
  budget_allocated: number;
  completion_criteria: string;
  scope?: Record<string, any>;
  dependencies?: string[];
}

export interface TaskHandle {
  taskId: string;
  role: string;
  status: string;
}

export function createDelegateResearchTool(
  onDelegate: (tasks: PlannedTaskInput[]) => Promise<{ ok: boolean; handles?: TaskHandle[]; error?: string }>
): ResearchToolDefinition {
  return {
    name: 'delegate_research',
    description: '派发研究任务给专业研究角色（authority/evolution/feedback）。返回任务句柄，发起后等待系统汇合信号。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '规划下发的子任务列表',
          items: {
            type: 'object',
            properties: {
              role: {
                type: 'string',
                enum: ['authority', 'evolution', 'feedback'],
                description: '目标研究角色',
              },
              question: {
                type: 'string',
                description: '需要研究的核心问题边界',
              },
              budget_allocated: {
                type: 'number',
                description: '为该任务分配的最大工具调用预算（建议 8-15）',
              },
              completion_criteria: {
                type: 'string',
                description: '客观可检验的完成标准',
              },
              scope: {
                type: 'object',
                description: '时间、地理或主体范围限制',
              },
            },
            required: ['role', 'question', 'budget_allocated', 'completion_criteria'],
          },
        },
      },
      required: ['tasks'],
    },
    execute: async (params: { tasks: PlannedTaskInput[] }) => {
      if (!params || !params.tasks || !Array.isArray(params.tasks) || params.tasks.length === 0) {
        throw new Error('delegate_research requires a non-empty array of tasks');
      }

      const res = await onDelegate(params.tasks);
      if (!res.ok) {
        throw new Error(`Failed to delegate research tasks: ${res.error || 'Unknown error'}`);
      }

      return {
        status: 'dispatched',
        count: params.tasks.length,
        task_handles: res.handles || [],
        message: 'Tasks successfully dispatched. Awaiting convergence barrier.',
      };
    },
  };
}
