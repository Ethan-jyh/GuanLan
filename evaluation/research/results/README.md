# 评测结果与基准报告存档 (Evaluation Results)

本目录用于存放 `evaluation/research/run.py` 运行生成的实验评测记录。

## 评测输出结构 (Result Schema)
每次评测执行后将生成形如 `eval_YYYYMMDD_HHMMSS.json` 的详细数据包，包含：

```json
{
  "timestamp": "2026-10-01T18:00:00Z",
  "evaluated_modes": ["single", "multi_no_verify", "multi_verify"],
  "cases": ["CASE-001", "CASE-002"],
  "summary": {
    "total_cases": 2,
    "pass_rate": 1.0,
    "avg_tool_calls": 26.5,
    "avg_cost_estimate": 0.042
  },
  "case_results": [
    {
      "case_id": "CASE-001",
      "mode": "multi_verify",
      "status": "completed",
      "rounds": 2,
      "tool_calls": 28,
      "verifications": {
        "supported": 3,
        "uncertain": 0,
        "contradicted": 0
      },
      "docx_generated": true,
      "score": 96.5
    }
  ]
}
```
