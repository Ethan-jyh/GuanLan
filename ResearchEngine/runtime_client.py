# -*- coding: utf-8 -*-
"""
ResearchEngine 与 Node.js/TypeScript Pi Runtime 通信客户端
用于向 Pi Agent 服务下发调研任务
"""

import json
import urllib.request
import urllib.error
from typing import Dict, Any, Optional

from .schema import Envelope


class RuntimeClient:
    """Pi Runtime HTTP 调度客户端"""

    def __init__(self, base_url: str = "http://127.0.0.1:4000", timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def execute_task(
        self,
        envelope: Envelope,
        role: str,
        question: str,
        scripted_steps: Optional[list] = None,
    ) -> Dict[str, Any]:
        """向 Pi Runtime 派发执行任务"""
        url = f"{self.base_url}/api/runtime/execute-task"
        payload = {
            "envelope": envelope.model_dump(),
            "role": role,
            "question": question,
            "scriptedSteps": scripted_steps or [],
        }

        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = resp.read().decode("utf-8")
                return json.loads(data)
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            return {"status": "error", "error": f"HTTP {e.code}: {err_body}"}
        except Exception as e:
            return {"status": "error", "error": str(e)}
