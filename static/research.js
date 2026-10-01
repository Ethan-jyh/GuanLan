/**
 * ResearchEngine 前端交互与状态流转脚本
 * 驱动多智能体协同研究任务全流程：
 * - 任务创建、暂停、恢复与取消
 * - 增量序号事件拉取 (after_seq) 与断点续传
 * - 三方角色状态（权威口径、舆情演化、公众反馈）实时看板
 * - 论点核验条目与专报 Artifact 导出
 */

(function () {
  'use strict';

  class ResearchApp {
    constructor() {
      this.currentRunId = localStorage.getItem('bettafish_active_research_run_id') || null;
      this.lastEventSeq = 0;
      this.pollInterval = null;
      this.isPolling = false;

      this.initDom();
      if (this.currentRunId) {
        this.fetchRunDetails(this.currentRunId);
        this.startEventPolling();
      }
    }

    initDom() {
      // 若页面尚未创建看板容器，动态挂载至专属区域
      let panel = document.getElementById('researchEnginePanel');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'researchEnginePanel';
        panel.className = 'research-engine-container';
        panel.style.cssText = 'display:none; padding:20px; border-top:2px solid #000; background:#f9f9f9;';
        panel.innerHTML = `
          <div class="research-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
            <h3 style="font-size:18px; font-weight:bold;">实验室多智能体协同研判系统 (Pi Agent)</h3>
            <div class="research-actions" style="display:flex; gap:10px;">
              <button id="btnPauseResearch" class="page-action-button" style="display:none;">暂停研判</button>
              <button id="btnResumeResearch" class="page-action-button" style="display:none;">恢复执行</button>
              <button id="btnCancelResearch" class="page-action-button" style="display:none; color:red;">取消研判</button>
            </div>
          </div>
          <div id="researchBudgetBar" style="margin-bottom:15px; font-size:13px; color:#555;">
            预算用量：<span id="budgetUsedVal">0</span> / <span id="budgetTotalVal">50</span> 次工具调用
          </div>
          <div class="research-roles-grid" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:15px; margin-bottom:20px;">
            <div class="role-card" id="cardAuthority" style="background:#fff; border:1px solid #ccc; padding:12px; border-radius:4px;">
              <h4 style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #eee; padding-bottom:4px;">权威口径 (Authority)</h4>
              <div class="role-status" style="font-size:13px; color:#666;">待命</div>
              <div class="role-findings" style="font-size:12px; margin-top:8px;"></div>
            </div>
            <div class="role-card" id="cardEvolution" style="background:#fff; border:1px solid #ccc; padding:12px; border-radius:4px;">
              <h4 style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #eee; padding-bottom:4px;">舆情演化 (Evolution)</h4>
              <div class="role-status" style="font-size:13px; color:#666;">待命</div>
              <div class="role-findings" style="font-size:12px; margin-top:8px;"></div>
            </div>
            <div class="role-card" id="cardFeedback" style="background:#fff; border:1px solid #ccc; padding:12px; border-radius:4px;">
              <h4 style="font-weight:bold; margin-bottom:8px; border-bottom:1px solid #eee; padding-bottom:4px;">公众反馈 (Feedback)</h4>
              <div class="role-status" style="font-size:13px; color:#666;">待命</div>
              <div class="role-findings" style="font-size:12px; margin-top:8px;"></div>
            </div>
          </div>
          <div id="researchEventLog" style="max-height:160px; overflow-y:auto; background:#1e1e1e; color:#eee; font-family:monospace; font-size:12px; padding:10px; border-radius:4px;">
            <div>[系统就绪] 等待任务启动...</div>
          </div>
        `;
        document.body.appendChild(panel);
      }

      this.panel = panel;
      this.btnPause = document.getElementById('btnPauseResearch');
      this.btnResume = document.getElementById('btnResumeResearch');
      this.btnCancel = document.getElementById('btnCancelResearch');

      this.btnPause.addEventListener('click', () => this.pauseRun());
      this.btnResume.addEventListener('click', () => this.resumeRun());
      this.btnCancel.addEventListener('click', () => this.cancelRun());
    }

    logEvent(text) {
      const logBox = document.getElementById('researchEventLog');
      if (logBox) {
        const item = document.createElement('div');
        item.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
        logBox.appendChild(item);
        logBox.scrollTop = logBox.scrollHeight;
      }
    }

    async createRun(topic, scope = {}) {
      try {
        const resp = await fetch('/api/research/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, scope, budget_total: 50 }),
        });
        const data = await resp.json();
        if (data.ok) {
          this.currentRunId = data.run.run_id;
          this.lastEventSeq = 0;
          localStorage.setItem('bettafish_active_research_run_id', this.currentRunId);
          this.panel.style.display = 'block';
          this.logEvent(`研判任务已创建: ${topic} (${this.currentRunId})`);
          this.fetchRunDetails(this.currentRunId);
          this.startEventPolling();
        } else {
          alert(`创建研判任务失败: ${data.error || '未知错误'}`);
        }
      } catch (err) {
        console.error('Failed to create research run:', err);
      }
    }

    async fetchRunDetails(runId) {
      try {
        const resp = await fetch(`/api/research/runs/${runId}`);
        const data = await resp.json();
        if (data.ok) {
          this.updateUiWithRunData(data.run, data.tasks, data.budget);
        }
      } catch (err) {
        console.error('Failed to fetch run details:', err);
      }
    }

    updateUiWithRunData(run, tasks = [], budget = {}) {
      this.panel.style.display = 'block';

      // 按钮状态更新
      if (run.status === 'researching' || run.status === 'reviewing') {
        this.btnPause.style.display = 'inline-block';
        this.btnResume.style.display = 'none';
        this.btnCancel.style.display = 'inline-block';
      } else if (run.status === 'paused') {
        this.btnPause.style.display = 'none';
        this.btnResume.style.display = 'inline-block';
        this.btnCancel.style.display = 'inline-block';
      } else {
        this.btnPause.style.display = 'none';
        this.btnResume.style.display = 'none';
        this.btnCancel.style.display = 'none';
      }

      // 预算更新
      if (budget) {
        document.getElementById('budgetUsedVal').textContent = budget.committed || budget.used || 0;
        document.getElementById('budgetTotalVal').textContent = run.budget_total || 50;
      }

      // 角色任务卡片更新
      tasks.forEach((t) => {
        let cardId = null;
        if (t.role === 'authority') cardId = 'cardAuthority';
        else if (t.role === 'evolution') cardId = 'cardEvolution';
        else if (t.role === 'feedback') cardId = 'cardFeedback';

        if (cardId) {
          const card = document.getElementById(cardId);
          const statusEl = card.querySelector('.role-status');
          statusEl.textContent = `第${t.round}轮: ${t.status}`;
          if (t.status === 'submitted') {
            statusEl.style.color = 'green';
          } else if (t.status === 'running') {
            statusEl.style.color = '#0066cc';
          }
        }
      });
    }

    startEventPolling() {
      if (this.isPolling) return;
      this.isPolling = true;

      this.pollInterval = setInterval(async () => {
        if (!this.currentRunId) return;
        try {
          const resp = await fetch(`/api/research/runs/${this.currentRunId}/events?after_seq=${this.lastEventSeq}`);
          const data = await resp.json();
          if (data.ok && data.events && data.events.length > 0) {
            data.events.forEach((ev) => {
              this.lastEventSeq = Math.max(this.lastEventSeq, ev.event_seq);
              this.logEvent(`[${ev.event_type}] ${JSON.stringify(ev.payload)}`);
            });
            this.fetchRunDetails(this.currentRunId);
          }
        } catch (e) {
          // 网络断连时静默等待下一次重试，不中断状态
        }
      }, 2500);
    }

    async pauseRun() {
      if (!this.currentRunId) return;
      await fetch(`/api/research/runs/${this.currentRunId}/pause`, { method: 'POST' });
      this.fetchRunDetails(this.currentRunId);
    }

    async resumeRun() {
      if (!this.currentRunId) return;
      await fetch(`/api/research/runs/${this.currentRunId}/resume`, { method: 'POST' });
      this.fetchRunDetails(this.currentRunId);
    }

    async cancelRun() {
      if (!this.currentRunId) return;
      if (confirm('确认取消当前研判任务？迟到请求将全部失效。')) {
        await fetch(`/api/research/runs/${this.currentRunId}/cancel`, { method: 'POST' });
        this.fetchRunDetails(this.currentRunId);
      }
    }
  }

  window.researchApp = new ResearchApp();
})();
