import { randomUUID } from 'node:crypto';
import { TaskRepository } from '../storage/repositories.js';
import { ResearchRole, ResearchTask, TaskStatus } from '../contracts/research.js';

export interface PlannedTaskInput {
  task_id?: string;
  role: ResearchRole;
  question: string;
  budget_allocated: number;
  completion_criteria: string;
  scope?: Record<string, unknown>;
  dependencies?: string[];
}

export class TaskPlanner {
  public static readonly ALLOWED_RESEARCH_ROLES = new Set<string>([
    ResearchRole.Authority,
    ResearchRole.Evolution,
    ResearchRole.Feedback,
  ]);

  constructor(private taskRepo: TaskRepository) {}

  public validatePlannedTasks(
    plannedTasks: PlannedTaskInput[],
    maxBudgetPerTask = 15,
    totalAvailableBudget?: number
  ): { ok: boolean; error?: string } {
    if (!plannedTasks || plannedTasks.length === 0) {
      return { ok: false, error: 'Planned tasks list cannot be empty' };
    }

    let totalBudget = 0;
    for (let idx = 0; idx < plannedTasks.length; idx++) {
      const item = plannedTasks[idx];
      if (!item.role || !TaskPlanner.ALLOWED_RESEARCH_ROLES.has(item.role)) {
        return {
          ok: false,
          error: `Invalid role '${item.role}' at index ${idx}. Must be one of ${Array.from(
            TaskPlanner.ALLOWED_RESEARCH_ROLES
          ).join(', ')}`,
        };
      }

      if (typeof item.budget_allocated !== 'number' || item.budget_allocated <= 0) {
        return {
          ok: false,
          error: `Invalid budget_allocated '${item.budget_allocated}' for role '${item.role}'. Must be a positive integer.`,
        };
      }

      if (item.budget_allocated > maxBudgetPerTask) {
        return {
          ok: false,
          error: `Budget allocated ${item.budget_allocated} exceeds maximum allowed budget per task (${maxBudgetPerTask})`,
        };
      }
      totalBudget += item.budget_allocated;

      if (!item.question || !item.question.trim()) {
        return { ok: false, error: `Missing question for role '${item.role}'` };
      }

      if (!item.completion_criteria || !item.completion_criteria.trim()) {
        return { ok: false, error: `Missing completion_criteria for role '${item.role}'` };
      }
    }

    if (totalAvailableBudget !== undefined && totalBudget > totalAvailableBudget) {
      return {
        ok: false,
        error: `Total planned budget ${totalBudget} exceeds available budget ${totalAvailableBudget}`,
      };
    }

    // Check DAG cycle
    const taskIdMap = new Map<string, PlannedTaskInput>();
    for (const t of plannedTasks) {
      const id = t.task_id || t.role;
      taskIdMap.set(id, t);
    }

    const visited = new Map<string, number>(); // 0: unvisited, 1: visiting, 2: visited

    const hasCycle = (nodeId: string): boolean => {
      visited.set(nodeId, 1);
      const node = taskIdMap.get(nodeId);
      if (node && node.dependencies) {
        for (const dep of node.dependencies) {
          if (taskIdMap.has(dep)) {
            const state = visited.get(dep) || 0;
            if (state === 1) return true;
            if (state === 0 && hasCycle(dep)) return true;
          }
        }
      }
      visited.set(nodeId, 2);
      return false;
    };

    for (const nodeId of taskIdMap.keys()) {
      if ((visited.get(nodeId) || 0) === 0) {
        if (hasCycle(nodeId)) {
          return { ok: false, error: 'Cyclic dependency detected in planned tasks' };
        }
      }
    }

    return { ok: true };
  }

  public createPlannedTasks(
    runId: string,
    roundNum: number,
    plannedTasks: PlannedTaskInput[],
    maxBudgetPerTask = 15,
    totalAvailableBudget?: number
  ): ResearchTask[] {
    const val = this.validatePlannedTasks(
      plannedTasks,
      maxBudgetPerTask,
      totalAvailableBudget
    );
    if (!val.ok) {
      throw new Error(`Task plan validation failed: ${val.error}`);
    }

    const nowIso = new Date().toISOString();
    const created: ResearchTask[] = [];

    for (const item of plannedTasks) {
      const taskId =
        item.task_id || `task-${item.role}-${randomUUID().substring(0, 8)}`;

      const task: ResearchTask = {
        task_id: taskId,
        run_id: runId,
        role: item.role,
        round: roundNum,
        question: item.question,
        scope: item.scope || {},
        status: TaskStatus.Pending,
        budget_allocated: item.budget_allocated,
        created_at: nowIso,
      };

      this.taskRepo.createTask(task);
      created.push(task);
    }

    return created;
  }
}
