# -*- coding: utf-8 -*-
"""
ResearchEngine 任务并发调度器
严格限制并发上限为 3，管理子任务的并行分发与执行生命周期
"""

from concurrent.futures import ThreadPoolExecutor, as_completed, Future
from typing import List, Callable, Any, Dict
from .schema import ResearchTask


class TaskScheduler:
    """受控并发任务调度器"""

    def __init__(self, max_workers: int = 3):
        self.max_workers = max_workers
        self.executor = ThreadPoolExecutor(max_workers=self.max_workers)

    def dispatch_tasks(
        self,
        run_id: str,
        tasks: List[ResearchTask],
        worker_fn: Callable[[ResearchTask], Any],
    ) -> Future:
        """
        并行分发当前批次的全部子任务。
        返回一个代表整个批次执行完毕的 Future 对象。
        """
        def _batch_runner():
            futures = [self.executor.submit(worker_fn, task) for task in tasks]
            results = []
            for f in as_completed(futures):
                results.append(f.result())
            return results

        return self.executor.submit(_batch_runner)

    def shutdown(self, wait: bool = True):
        self.executor.shutdown(wait=wait)
