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
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .task-card {
      background: #edf2f7;
      border-radius: 6px;
      padding: 1rem;
      border-top: 4px solid var(--primary-light);
      position: relative;
    }
    .task-card h3 {
      font-size: 0.9rem;
      margin-bottom: 0.3rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .task-role {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-bottom: 0.5rem;
    }
    .task-question {
      font-size: 0.8rem;
      color: var(--text);
      margin-bottom: 0.5rem;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .task-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.75rem;
      color: var(--text-muted);
      border-top: 1px dashed var(--border);
      padding-top: 0.4rem;
    }
    .status-badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-badge.queued { background: #e2e8f0; color: #4a5568; }
    .status-badge.running { background: #feebc8; color: #c05621; }
    .status-badge.succeeded { background: #c6f6d5; color: #22543d; }
    .status-badge.failed { background: #fed7d7; color: #9b2c2c; }
    .status-badge.partial { background: #e9d8fd; color: #553c9a; }
    .status-badge.cancelled { background: #edf2f7; color: #718096; }
    .status-badge.timed_out { background: #fed7d7; color: #9b2c2c; }
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
    <span class="badge">Subagent Tools & Serialized Dispatch</span>
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
          <label>运行模式</label>
          <select id="modeInput">
            <option value="async" selected>异步智能体按需派发 (Subagents as Tools)</option>
            <option value="legacy">经典三角色并行同步 (Legacy Fixed)</option>
          </select>
        </div>
        <div class="form-group">
          <label>地理或主体范围 (JSON)</label>
          <textarea id="scopeInput" rows="2">{"region": "涉事区域", "time_window": "48h"}</textarea>
        </div>
        <div class="form-group">
          <label>工具总预算配额</label>
          <input type="number" id="budgetInput" value="50" min="20" max="100">
        </div>
        <button id="createRunBtn" onclick="createRun()">发起态势研判</button>
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
        <h2>独立子任务进展 (<span id="runIdLabel">等待发起...</span>)</h2>
        <div class="status-grid" id="tasksContainer">
          <div class="task-card" style="grid-column: 1 / -1; text-align: center; color: var(--text-muted);">
            暂无已派发的研究任务。发起研判后 HOST 将根据需要规划并派发任务。
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
      const mode = document.getElementById('modeInput').value;
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
        body: JSON.stringify({ topic, scope, budget_total, mode })
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

      renderTasks(data.tasks || []);
      startEventStream(activeRunId);
      pollTasks(activeRunId);
    }

    async function pollTasks(runId) {
      if (!runId || runId !== activeRunId) return;
      try {
        const resp = await fetch('/api/research/runs/' + runId + '/tasks');
        if (resp.ok) {
          const data = await resp.json();
          renderTasks(data.tasks || []);
        }
      } catch {}
    }

    function renderTasks(tasks) {
      const container = document.getElementById('tasksContainer');
      if (!tasks || tasks.length === 0) {
        container.innerHTML = '<div class="task-card" style="grid-column: 1 / -1; text-align: center; color: var(--text-muted);">暂无已派发的研究任务。</div>';
        return;
      }

      container.innerHTML = tasks.map(t => {
        const statusClass = (t.status || 'pending').toLowerCase();
        const roleName = t.role === 'authority' ? '权威核查' : (t.role === 'evolution' ? '演化脉络' : (t.role === 'feedback' ? '公众反馈' : t.role));
        return \`
          <div class="task-card" id="card-\${t.task_id}">
            <h3>
              <span>\${roleName}</span>
              <span class="status-badge \${statusClass}">\${t.status}</span>
            </h3>
            <div class="task-role">ID: \${t.task_id}</div>
            <div class="task-question">\${t.question || '-'}</div>
            <div class="task-meta">
              <span>轮次: \${t.round || 1} (代: \${t.generation || 1})</span>
              <span>预算: \${t.budget_allocated || 0}</span>
            </div>
          </div>
        \`;
      }).join('');
    }

    function startEventStream(runId) {
      if (sseSource) sseSource.close();
      const feed = document.getElementById('eventFeed');
      feed.innerHTML = '';

      sseSource = new EventSource('/api/research/runs/' + runId + '/events');
      
      sseSource.addEventListener('task_transition', function(e) {
        const data = JSON.parse(e.data || '{}');
        appendFeedItem(e.lastEventId, 'TASK [' + (data.task_id || '') + ']: ' + (data.from || '') + ' -> ' + data.to);
        pollTasks(runId);
      });

      sseSource.addEventListener('host_decision', function(e) {
        const data = JSON.parse(e.data || '{}');
        appendFeedItem(e.lastEventId, 'HOST DECISION: ' + data.decision_type + ' - ' + (data.rationale || ''));
      });

      sseSource.onmessage = function(e) {
        appendFeedItem(e.lastEventId, e.data);
      };
    }

    function appendFeedItem(seq, text) {
      const feed = document.getElementById('eventFeed');
      const div = document.createElement('div');
      div.className = 'event-item';
      div.innerHTML = '<span class="event-seq">#' + (seq || '*') + '</span> ' + text;
      feed.appendChild(div);
      feed.scrollTop = feed.scrollHeight;
    }
  </script>
</body>
</html>`;
}
