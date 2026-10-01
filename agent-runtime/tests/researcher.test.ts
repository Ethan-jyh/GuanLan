import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createResearcherAgent } from '../src/agents/researcher.js';
import { AUTHORITY_SYSTEM_PROMPT } from '../src/prompts/authority.js';
import { createScriptedStreamFn } from '../src/runtime/pi-adapter.js';
import { ResearchRole } from '../src/contracts/research.js';

describe('Researcher Agent - Single Agent Closed Loop', () => {
  it('should execute bounded loop: search -> observe -> submit_findings -> finish', async () => {
    let searchCalled = false;
    let submitCalled = false;
    let submittedPayload: any = null;

    const searchTool = {
      name: 'search_web',
      description: 'Search official web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (params: { query: string }) => {
        searchCalled = true;
        return {
          status: 'success',
          results: [
            {
              title: '应急管理局通报',
              url: 'https://gov.example.com/doc1',
              snippet: '市应急管理局已启动二级响应，无人员伤亡。',
              published_date: '2026-10-01T10:00:00Z',
            },
          ],
        };
      },
    };

    const submitTool = {
      name: 'submit_findings',
      description: 'Submit research findings',
      parameters: {
        type: 'object',
        properties: { findings: { type: 'object' } },
        required: ['findings'],
      },
      execute: async (params: { findings: any }) => {
        submitCalled = true;
        submittedPayload = params.findings;
        return {
          status: 'success',
          submission_id: 'sub-test-123',
        };
      },
    };

    // Scripted model sequence:
    // Turn 1: call search_web
    // Turn 2: observe search results, call submit_findings with structured payload
    // Turn 3: confirm submission complete
    const streamFn = createScriptedStreamFn([
      {
        toolCalls: [
          {
            name: 'search_web',
            arguments: { query: '市应急管理局 汛情通报' },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'submit_findings',
            arguments: {
              findings: {
                role: 'authority',
                round: 1,
                claims: [
                  {
                    claim_id: 'C1',
                    statement: '市应急管理局已启动二级响应，无人员伤亡',
                    evidence_ids: ['E1'],
                  },
                ],
                evidence_pool: [
                  {
                    evidence_id: 'E1',
                    source_type: 'official_doc',
                    source_ref: 'https://gov.example.com/doc1',
                    title: '应急管理局通报',
                    excerpt: '市应急管理局已启动二级响应，无人员伤亡。',
                    is_full_text: true,
                  },
                ],
                authority_finding: {
                  entity_name: '市应急管理局',
                  source_type: '官方发布',
                  published_at: '2026-10-01T10:00:00Z',
                  raw_text: '市应急管理局已启动二级响应，无人员伤亡。',
                  stance_evolution: '平稳',
                  covered_issues: ['响应等级', '伤亡情况'],
                  unaddressed_issues: [],
                },
              },
            },
          },
        ],
      },
      {
        text: 'Research task completed and findings submitted.',
      },
    ]);

    const researcher = createResearcherAgent({
      role: ResearchRole.Authority,
      systemPrompt: AUTHORITY_SYSTEM_PROMPT,
      tools: [searchTool],
      submitTool,
      streamFn,
    });

    const result = await researcher.run('Investigate official statement for rainstorm.');

    assert.ok(searchCalled, 'search_web tool must be called');
    assert.ok(submitCalled, 'submit_findings tool must be called');
    assert.ok(submittedPayload, 'Payload must be submitted');
    assert.equal(submittedPayload.role, 'authority');
    assert.equal(submittedPayload.claims.length, 1);
    assert.ok(result.finalText.includes('completed'));
  });
});
