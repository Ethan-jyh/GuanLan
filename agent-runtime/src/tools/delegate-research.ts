import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';
import type { ResearchDatabase } from '../storage/database.js';
import type {
  ResearchSubagentRole,
  ResearchJobParams,
  TaskReceipt,
} from '../contracts/research.js';
import { ResearchWorkerPool } from '../orchestration/research-worker.js';

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

export type DelegateResearchHandler = (
  tasks: PlannedTaskInput[]
) => Promise<{
  ok: boolean;
  handles?: TaskHandle[];
  receipts?: TaskReceipt[];
  error?: string;
}>;

export interface DelegateResearchOptions {
  onDelegate?: DelegateResearchHandler;
  db?: ResearchDatabase;
  run_id?: string;
  workerPool?: ResearchWorkerPool;
  enqueueTask?: (
    role: ResearchSubagentRole,
    params: ResearchJobParams
  ) => Promise<TaskReceipt> | TaskReceipt;
}

export function createDelegateResearchTool(
  handlerOrOptions: DelegateResearchHandler | DelegateResearchOptions
): ResearchToolDefinition {
  return {
    name: 'delegate_research',
    description:
      '批量派发研究任务给专业研究角色（authority/evolution/feedback）。拆解为独立任务入队，返回任务句柄与即时回执列表。',
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
              dependencies: {
                type: 'array',
                items: { type: 'string' },
                description: '依赖的前置任务 ID 列表',
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

      const handles: TaskHandle[] = [];
      const receipts: TaskReceipt[] = [];

      // 1. If options object with workerPool or enqueueTask
      const isOpts = typeof handlerOrOptions === 'object' && handlerOrOptions !== null;
      const opts = isOpts ? (handlerOrOptions as DelegateResearchOptions) : null;

      if (opts && (opts.workerPool || opts.enqueueTask)) {
        for (const task of params.tasks) {
          const role = task.role as ResearchSubagentRole;
          const jobParams: ResearchJobParams = {
            question: task.question,
            scope: task.scope || {},
            completion_criteria: task.completion_criteria,
            requested_budget_units: task.budget_allocated,
            required_for_report: true,
            dependencies: task.dependencies || [],
          };

          let receipt: TaskReceipt;
          if (opts.workerPool) {
            receipt = await opts.workerPool.enqueueTask(role, jobParams, {
              run_id: opts.run_id,
            });
          } else {
            receipt = await opts.enqueueTask!(role, jobParams);
          }

          receipts.push(receipt);
          handles.push({
            taskId: receipt.task_id || `task-${role}`,
            role: receipt.role || role,
            status: receipt.status,
          });
        }

        return {
          status: 'dispatched',
          count: params.tasks.length,
          task_handles: handles,
          receipts,
          message: 'Tasks successfully dispatched into independent research jobs.',
        };
      }

      // 2. Delegate to onDelegate handler
      const onDelegate =
        typeof handlerOrOptions === 'function'
          ? handlerOrOptions
          : opts?.onDelegate;

      if (!onDelegate) {
        throw new Error('No onDelegate handler or worker pool configured for delegate_research');
      }

      const res = await onDelegate(params.tasks);
      if (!res.ok) {
        throw new Error(`Failed to delegate research tasks: ${res.error || 'Unknown error'}`);
      }

      const returnedHandles = res.handles || [];
      const returnedReceipts =
        res.receipts ||
        returnedHandles.map((h) => ({
          status: (h.status === 'dispatched' ? 'accepted' : h.status) as any,
          task_id: h.taskId,
          attempt_id: `attempt-${h.taskId}`,
          role: h.role as ResearchSubagentRole,
          result_pending: true,
        }));

      return {
        status: 'dispatched',
        count: params.tasks.length,
        task_handles: returnedHandles,
        receipts: returnedReceipts,
        message: 'Tasks successfully dispatched. Awaiting convergence barrier.',
      };
    },
  };
}
