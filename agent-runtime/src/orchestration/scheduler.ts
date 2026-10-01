import { ResearchTask } from '../contracts/research.js';

export class TaskScheduler {
  constructor(private maxConcurrency = 3) {}

  public async dispatchTasks<T>(
    tasks: ResearchTask[],
    workerFn: (task: ResearchTask) => Promise<T>
  ): Promise<T[]> {
    if (tasks.length === 0) return [];

    const results: T[] = new Array(tasks.length);
    let taskIndex = 0;
    const workers: Promise<void>[] = [];

    const runWorker = async () => {
      while (taskIndex < tasks.length) {
        const currentIndex = taskIndex++;
        const task = tasks[currentIndex];
        const res = await workerFn(task);
        results[currentIndex] = res;
      }
    };

    const workerCount = Math.min(this.maxConcurrency, tasks.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(runWorker());
    }

    await Promise.all(workers);
    return results;
  }
}
