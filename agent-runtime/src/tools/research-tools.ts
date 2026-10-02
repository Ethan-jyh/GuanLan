import { randomUUID } from 'node:crypto';
import type { ResearchToolDefinition } from '../runtime/pi-adapter.js';
import type { ResearchDatabase } from '../storage/database.js';
import {
  TaskRepository,
  TaskAttemptRepository,
  TaskResultRepository,
  type TaskResultRecord,
} from '../storage/repositories.js';
import {
  ResearchRole,
  TaskStatus,
  type ResearchSubagentRole,
  type ResearchJobParams,
  type TaskReceipt,
  type AcceptedTaskReceipt,
  type RejectedTaskReceipt,
  ResearchJobParamsSchema,
} from '../contracts/research.js';
import { ResearchWorkerPool } from '../orchestration/research-worker.js';

export type SubagentRole = ResearchSubagentRole | 'authority' | 'evolution' | 'feedback';

export type ResearchEnqueueFunction =
  | ((role: any, params: ResearchJobParams) => Promise<any> | any)
  | ((params: ResearchJobParams) => Promise<any> | any);

export interface ResearchRoleToolOptions {
  db?: ResearchDatabase;
  run_id?: string;
  workerPool?: ResearchWorkerPool;
  enqueueFn?: ResearchEnqueueFunction;
}

export type EnqueueOrOptions =
  | ResearchEnqueueFunction
  | ResearchRoleToolOptions
  | ResearchWorkerPool;

const ROLE_DESCRIPTIONS: Record<string, string> = {
  authority:
    '创建权威口径研究作业（官方通报溯源、定调演化与回应覆盖清单）。返回即时任务回执，后台异步执行，不阻塞等待完成。',
  evolution:
    '创建传播演化研究作业（热度曲线、转折点与同期事件比对）。返回即时任务回执，后台异步执行，不阻塞等待完成。',
  feedback:
    '创建公众反馈研究作业（评论抽样、情绪诉求与代表性言论）。返回即时任务回执，后台异步执行，不阻塞等待完成。',
};

export function createResearchRoleTool(
  role: SubagentRole,
  enqueueOrOptions: EnqueueOrOptions
): ResearchToolDefinition {
  const roleStr = String(role) as ResearchSubagentRole;
  const toolName = `research_${roleStr}`;
  const description = ROLE_DESCRIPTIONS[roleStr] || `创建 ${roleStr} 独立研究作业`;

  return {
    name: toolName,
    description,
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '本次研究的核心问题边界',
        },
        scope: {
          type: 'object',
          description: '时间、地域或主体范围限制',
        },
        completion_criteria: {
          type: 'string',
          description: '客观可核验的完成标准',
        },
        requested_budget_units: {
          type: 'number',
          description: '申请的最大工具调用预算（建议 8-15）',
          default: 10,
        },
        required_for_report: {
          type: 'boolean',
          description: '该研究结果是否为最终专报发布所必须',
          default: true,
        },
        dependencies: {
          type: 'array',
          items: { type: 'string' },
          description: '依赖的前置任务 ID 列表',
        },
      },
      required: ['question', 'completion_criteria'],
    },
    execute: async (params: any): Promise<TaskReceipt> => {
      // 1. Strict validation
      const parseResult = ResearchJobParamsSchema.safeParse(params);
      if (!parseResult.success) {
        const issues = parseResult.error.issues
          .map((i) => `${i.path.join('.') || 'param'}: ${i.message}`)
          .join(', ');
        return {
          status: 'rejected',
          role: roleStr,
          result_pending: false,
          reason: `Invalid ResearchJobParams: ${issues}`,
        };
      }

      const jobParams = parseResult.data;

      // 2. Delegate to function / workerPool / options
      if (typeof enqueueOrOptions === 'function') {
        const fn = enqueueOrOptions as any;
        if (fn.length === 1) {
          return await fn(jobParams);
        }
        return await fn(roleStr, jobParams);
      }

      if (enqueueOrOptions instanceof ResearchWorkerPool) {
        return await enqueueOrOptions.enqueueTask(roleStr, jobParams);
      }

      const opts = enqueueOrOptions as ResearchRoleToolOptions;
      if (opts.enqueueFn) {
        const fn = opts.enqueueFn as any;
        if (fn.length === 1) {
          return await fn(jobParams);
        }
        return await fn(roleStr, jobParams);
      }

      if (opts.workerPool) {
        return await opts.workerPool.enqueueTask(roleStr, jobParams, {
          run_id: opts.run_id,
        });
      }

      if (opts.db) {
        const runId = opts.run_id || 'default-run';
        const taskId = `task-${roleStr}-${randomUUID().slice(0, 8)}`;
        const attemptId = `attempt-${randomUUID().slice(0, 8)}`;
        const nowIso = new Date().toISOString();

        opts.db.transaction(() => {
          const taskRepo = new TaskRepository(opts.db!);
          const attemptRepo = new TaskAttemptRepository(opts.db!);

          taskRepo.createTask({
            task_id: taskId,
            run_id: runId,
            role: roleStr as ResearchRole,
            round: 1,
            generation: 1,
            question: jobParams.question,
            scope: jobParams.scope,
            completion_criteria: jobParams.completion_criteria,
            required_for_report: jobParams.required_for_report,
            dependencies: jobParams.dependencies,
            status: TaskStatus.Queued,
            budget_allocated: jobParams.requested_budget_units,
            created_at: nowIso,
          });

          attemptRepo.createAttempt({
            attempt_id: attemptId,
            task_id: taskId,
            run_id: runId,
            execution_version: 1,
            status: 'running',
            started_at: nowIso,
          });
        });

        return {
          status: 'accepted',
          task_id: taskId,
          attempt_id: attemptId,
          role: roleStr,
          result_pending: true,
          message: 'Task accepted and recorded in database',
        };
      }

      return {
        status: 'rejected',
        role: roleStr,
        result_pending: false,
        reason: 'No enqueue handler or database provided for research role tool',
      };
    },
  };
}

export function createResearchAuthorityTool(
  enqueueOrOptions: EnqueueOrOptions
): ResearchToolDefinition {
  return createResearchRoleTool(ResearchRole.Authority, enqueueOrOptions);
}

export function createResearchEvolutionTool(
  enqueueOrOptions: EnqueueOrOptions
): ResearchToolDefinition {
  return createResearchRoleTool(ResearchRole.Evolution, enqueueOrOptions);
}

export function createResearchFeedbackTool(
  enqueueOrOptions: EnqueueOrOptions
): ResearchToolDefinition {
  return createResearchRoleTool(ResearchRole.Feedback, enqueueOrOptions);
}

export function createGetResearchResultTool(
  resultRepoOrDb: TaskResultRepository | ResearchDatabase
): ResearchToolDefinition {
  return {
    name: 'get_research_result',
    description: '按 task_id 或 result_id 获取已完成的研究成果详情。用于查询独立任务结果。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '任务 ID',
        },
        result_id: {
          type: 'string',
          description: '成果记录 ID',
        },
        version: {
          type: 'number',
          description: '指定成果版本（可选，默认最新版本）',
        },
        run_id: {
          type: 'string',
          description: '运行 ID（可选）',
        },
      },
    },
    execute: async (params: {
      task_id?: string;
      result_id?: string;
      version?: number;
      run_id?: string;
    }) => {
      let repo: TaskResultRepository;
      if ('raw' in resultRepoOrDb) {
        repo = new TaskResultRepository(resultRepoOrDb as ResearchDatabase);
      } else {
        repo = resultRepoOrDb as TaskResultRepository;
      }

      if (!params || (!params.task_id && !params.result_id)) {
        return {
          found: false,
          error: 'Either task_id or result_id must be provided',
        };
      }

      let record: TaskResultRecord | null = null;

      if (params.result_id) {
        record = repo.getResultById(params.result_id);
      } else if (params.task_id) {
        if (params.run_id && typeof params.version === 'number') {
          record = repo.getResult(params.run_id, params.task_id, params.version);
        } else if (params.run_id) {
          record = repo.getLatestResult(params.run_id, params.task_id);
        } else {
          const list = repo.listResultsByTask(params.task_id);
          if (list.length > 0) {
            record = list[list.length - 1];
          }
        }
      }

      if (!record) {
        return {
          found: false,
          message: `Research result not found for ${
            params.task_id ? `task_id=${params.task_id}` : `result_id=${params.result_id}`
          }`,
        };
      }

      return {
        found: true,
        result: record,
      };
    },
  };
}

export function createCancelResearchTaskTool(
  workerPool: ResearchWorkerPool | { cancelTask: (taskId: string, reason?: string) => boolean | Promise<boolean> }
): ResearchToolDefinition {
  return {
    name: 'cancel_research_task',
    description: '取消指定的研究任务，不影响其他正在执行的任务。',
    parameters: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: '待取消的任务 ID',
        },
        reason: {
          type: 'string',
          description: '取消原因',
        },
      },
      required: ['task_id'],
    },
    execute: async (params: { task_id: string; reason?: string }) => {
      if (!params || !params.task_id) {
        throw new Error('task_id is required to cancel a research task');
      }

      const cancelled = await workerPool.cancelTask(params.task_id, params.reason);

      return {
        status: cancelled ? 'cancelled' : 'not_found',
        task_id: params.task_id,
        cancelled,
        reason: params.reason,
      };
    },
  };
}
