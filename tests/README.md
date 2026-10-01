# 「观澜」系统测试套件

本项目的自动化测试分为两大层次：

### 1. 核心运行时测试套件 (`agent-runtime/tests/`)
涵盖领域契约、SQLite 数据库、证据指纹库、预算账本、DAG 调度、会商同步屏障、定向跟进审查、终稿质量门禁、IR 结构校验与多格式导出：

```bash
cd agent-runtime
npm test
# 91 项自动化测试 100% 通过
```

### 2. Python 基础设施与工具测试 (`tests/`)
涵盖网络重试与底层工具库测试：

```bash
pytest tests/
```
