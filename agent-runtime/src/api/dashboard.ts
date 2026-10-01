export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>「观澜 · GuanLan」全媒体多智能体态势研判工作台</title>
  <style>
    :root {
      --primary: #1a365d;
      --primary-light: #2b6cb0;
      --bg: #f7fafc;
      --card-bg: #ffffff;
      --text: #2d3748;
      --text-muted: #718096;
      --border: #e2e8f0;
      --success: #38a169;
      --warning: #dd6b20;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      background: var(--primary);
      color: #fff;
      padding: 1rem 2rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    header h1 { font-size: 1.3rem; font-weight: 600; }
    .badge {
      background: #2b6cb0;
      font-size: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-weight: 500;
    }
    main {
      max-width: 1200px;
      margin: 2rem auto;
      padding: 0 1rem;
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border-radius: 8px;
      padding: 1.5rem;
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
      margin-bottom: 1.5rem;
    }
    .card h2 {
      font-size: 1.1rem;
      margin-bottom: 1rem;
      color: var(--primary);
      border-bottom: 2px solid var(--border);
      padding-bottom: 0.5rem;
    }
    .form-group { margin-bottom: 1rem; }
    .form-group label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 0.4rem;
      color: var(--text);
    }
    input, textarea, select {
      width: 100%;
      padding: 0.6rem 0.8rem;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-size: 0.9rem;
      outline: none;
    }
    input:focus, textarea:focus { border-color: var(--primary-light); }
    button {
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 0.6rem 1.2rem;
      border-radius: 4px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    button:hover { background: var(--primary-light); }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .role-card {
      background: #edf2f7;
      border-radius: 6px;
      padding: 1rem;
      text-align: center;
      border-top: 4px solid var(--primary-light);
    }
    .role-card h3 { font-size: 0.95rem; margin-bottom: 0.4rem; }
    .role-status {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
    }
    .event-feed {
      height: 320px;
      overflow-y: auto;
      background: #1a202c;
      color: #e2e8f0;
      padding: 1rem;
      border-radius: 6px;
      font-family: monospace;
      font-size: 0.82rem;
    }
    .event-item { margin-bottom: 0.4rem; border-bottom: 1px solid #2d3748; padding-bottom: 0.2rem; }
    .event-seq { color: #63b3ed; margin-right: 0.4rem; }
    .meter-bar {
      height: 8px;
      background: #e2e8f0;
      border-radius: 4px;
      overflow: hidden;
      margin: 0.5rem 0;
    }
    .meter-fill {
      height: 100%;
      background: var(--success);
      width: 0%;
      transition: width 0.3s;
    }
  </style>
</head>
<body>
  <header>
    <h1>🌊 观澜 · GuanLan 全媒体多智能体态势研判工作台</h1>
    <span class="badge">TypeScript Orchestration Runtime</span>
  </header>

  <main>
    <div class="sidebar">
      <div class="card">
        <h2>创建研判任务</h2>
        <div class="form-group">
          <label>研判主题 / 突发事件</label>
          <input type="text" id="topicInput" placeholder="输入研判事件核心主题..." value="暴雨应急处置与网络舆情演化">
        </div>
        <div class="form-group">
          <label>地理或主体范围 (JSON)</label>
          <textarea id="scopeInput" rows="2">{"region": "涉事区域", "time_window": "48h"}</textarea>
        </div>
        <div class="form-group">
          <label>工具总预算配额</label>
          <input type="number" id="budgetInput" value="50" min="20" max="100">
        </div>
        <button id="createRunBtn" onclick="createRun()">发起三方协同研判</button>
      </div>

      <div class="card">
        <h2>预算消耗仪表</h2>
        <div>已用 / 预留额度: <span id="budgetLabel">0 / 50</span></div>
        <div class="meter-bar">
          <div class="meter-fill" id="budgetMeter"></div>
        </div>
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.5rem;">
          已为终稿写作保底锁定 10 个单位配额
        </div>
      </div>
    </div>

    <div class="content-area">
      <div class="card">
        <h2>三方智能体协同进展 (<span id="runIdLabel">等待发起...</span>)</h2>
        <div class="status-grid">
          <div class="role-card" id="cardAuthority">
            <h3>权威核查 (Authority)</h3>
            <div class="role-status" id="statusAuthority">待分配</div>
          </div>
          <div class="role-card" id="cardEvolution">
            <h3>演化脉络 (Evolution)</h3>
            <div class="role-status" id="statusEvolution">待分配</div>
          </div>
          <div class="role-card" id="cardFeedback">
            <h3>公众反馈 (Feedback)</h3>
            <div class="role-status" id="statusFeedback">待分配</div>
          </div>
        </div>

        <div style="margin-bottom: 1rem;">
          当前轮次：<strong id="roundLabel">1</strong> / 3 
          &nbsp;|&nbsp; 运行状态：<strong id="statusLabel">空闲</strong>
        </div>
      </div>

      <div class="card">
        <h2>实时有序事件流 (SSE)</h2>
        <div class="event-feed" id="eventFeed">
          <div class="event-item" style="color: #a0aec0;">[系统就绪] 等待任务启动并订阅 SSE 实时流...</div>
        </div>
      </div>
    </div>
  </main>

  <script>
    let activeRunId = null;
    let sseSource = null;

    async function createRun() {
      const topic = document.getElementById('topicInput').value.trim();
      let scope = {};
      try {
        scope = JSON.parse(document.getElementById('scopeInput').value || '{}');
      } catch (e) {
        alert('范围必须是合法 JSON');
        return;
      }
      const budget_total = parseInt(document.getElementById('budgetInput').value || '50', 10);

      const resp = await fetch('/api/research/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, scope, budget_total })
      });

      if (!resp.ok) {
        const err = await resp.json();
        alert('创建失败: ' + (err.error || '未知错误'));
        return;
      }

      const data = await resp.json();
      activeRunId = data.run.run_id;
      document.getElementById('runIdLabel').innerText = activeRunId;
      document.getElementById('statusLabel').innerText = data.run.status;
      document.getElementById('roundLabel').innerText = data.run.current_round;

      startEventStream(activeRunId);
    }

    function startEventStream(runId) {
      if (sseSource) sseSource.close();
      const feed = document.getElementById('eventFeed');
      feed.innerHTML = '';

      sseSource = new EventSource('/api/research/runs/' + runId + '/events');
      sseSource.onmessage = function(e) {
        const div = document.createElement('div');
        div.className = 'event-item';
        div.innerHTML = '<span class="event-seq">#' + (e.lastEventId || '*') + '</span> ' + e.data;
        feed.appendChild(div);
        feed.scrollTop = feed.scrollHeight;
      };
    }
  </script>
</body>
</html>`;
}
