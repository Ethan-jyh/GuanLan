import http from 'node:http';
import { ResearchRole } from './contracts/research.js';
import { createResearcherAgent } from './agents/researcher.js';
import { AUTHORITY_SYSTEM_PROMPT } from './prompts/authority.js';
import { createSubmitFindingsTool } from './tools/submit-findings.js';
import { PythonToolClient } from './tools/python-client.js';
import { createScriptedStreamFn } from './runtime/pi-adapter.js';

export interface RuntimeServerOptions {
  port?: number;
  pythonBaseUrl?: string;
  internalToken?: string;
}

export function createRuntimeServer(options: RuntimeServerOptions = {}) {
  const port = options.port ?? 4000;
  const pythonBaseUrl = options.pythonBaseUrl ?? 'http://127.0.0.1:5000';
  const token = options.internalToken ?? 'bettafish-internal-secret';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'bettafish-agent-runtime' }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/runtime/execute-task') {
      let bodyStr = '';
      req.on('data', (chunk) => {
        bodyStr += chunk;
      });

      req.on('end', async () => {
        try {
          const payload = JSON.parse(bodyStr || '{}');
          const { envelope, role, question, scriptedSteps } = payload;

          if (!envelope || !role || !question) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing envelope, role, or question' }));
            return;
          }

          const pythonClient = new PythonToolClient({
            baseUrl: pythonBaseUrl,
            internalToken: token,
          });

          // 封装调用 Python 的搜索和正文读取工具
          const searchTool = {
            name: 'search_web',
            description: 'Search official web',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            execute: async (params: { query: string }) => {
              return pythonClient.callTool(envelope, 'search_web', params);
            },
          };

          const readSourceTool = {
            name: 'read_source',
            description: 'Read source full text',
            parameters: {
              type: 'object',
              properties: { url_or_ref: { type: 'string' } },
              required: ['url_or_ref'],
            },
            execute: async (params: { url_or_ref: string }) => {
              return pythonClient.callTool(envelope, 'read_source', params);
            },
          };

          // 提交工具
          let lastSubmissionResult: any = null;
          const submitTool = createSubmitFindingsTool(async (findings) => {
            const resp = await fetch(`${pythonBaseUrl}/api/research/internal/submissions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Research-Internal-Token': token,
              },
              body: JSON.stringify({
                run_id: envelope.run_id,
                task_id: envelope.task_id,
                ...findings,
              }),
            });
            const data: any = await resp.json();
            if (data.status === 'success' || data.submission_id) {
              lastSubmissionResult = data;
              return { ok: true, submissionId: data.submission_id };
            }
            return { ok: false, error: data.error || 'Submission failed' };
          });

          // 默认根据角色配置系统提示词
          let systemPrompt = AUTHORITY_SYSTEM_PROMPT;
          // 若传入 scriptedSteps 则使用 scriptedStreamFn，否则回退
          const streamFn = createScriptedStreamFn(scriptedSteps || [{ text: 'No actions' }]);

          const agent = createResearcherAgent({
            role: role as ResearchRole,
            systemPrompt,
            tools: [searchTool, readSourceTool],
            submitTool,
            streamFn,
          });

          const result = await agent.run(question);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              status: 'completed',
              finalText: result.finalText,
              events: result.events,
              submission: lastSubmissionResult,
            })
          );
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return {
    server,
    listen: (customPort?: number) =>
      new Promise<void>((resolve) => {
        server.listen(customPort ?? port, () => resolve());
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (process.env.NODE_ENV !== 'test' && import.meta.url === `file://${process.argv[1]}`) {
  const runtime = createRuntimeServer({ port: 4000 });
  runtime.listen(4000).then(() => {
    console.log('Pi Agent Runtime Server listening on http://localhost:4000');
  });
}
