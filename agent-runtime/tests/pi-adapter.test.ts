import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PiAgentAdapter,
  createScriptedStreamFn,
  type ResearchToolDefinition,
} from '../src/runtime/pi-adapter.js';

describe('PiAgentAdapter - Baseline verification and tool loop', () => {
  it('should execute a scripted model loop: call search tool, receive observation, then complete', async () => {
    let toolExecutionCount = 0;
    let receivedQuery = '';

    const searchTool: ResearchToolDefinition = {
      name: 'search_web',
      description: 'Search web for facts',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      execute: async (params: { query: string }) => {
        toolExecutionCount++;
        receivedQuery = params.query;
        return {
          results: [
            { title: 'Official Statement', url: 'https://example.gov/release', snippet: 'Confirmed factual event.' },
          ],
        };
      },
    };

    // Scripted model:
    // Turn 1: model emits toolCall to search_web
    // Turn 2: model observes search results and returns final completion text
    const scriptedStreamFn = createScriptedStreamFn([
      {
        toolCalls: [
          {
            name: 'search_web',
            arguments: { query: 'official flood release' },
          },
        ],
      },
      {
        text: 'Based on the official release (https://example.gov/release), the event was confirmed.',
      },
    ]);

    const adapter = new PiAgentAdapter({
      systemPrompt: 'You are an authority researcher.',
      tools: [searchTool],
      streamFn: scriptedStreamFn,
    });

    const result = await adapter.run('Please investigate the flood reports.');

    // 1. Tool was actually invoked by the agent loop
    assert.equal(toolExecutionCount, 1, 'Tool should have been executed exactly once');
    assert.equal(receivedQuery, 'official flood release', 'Tool should receive argument from model');

    // 2. Output contains the final assistant response
    assert.ok(
      result.finalText.includes('Based on the official release'),
      'Final output should incorporate tool observation'
    );

    // 3. Transcript has complete flow: user -> assistant toolCall -> toolResult -> assistant text
    assert.ok(result.messages.length >= 4, 'Transcript should contain user, assistant, toolResult, assistant');
    const toolResultMsg = result.messages.find((m: any) => m.role === 'toolResult');
    assert.ok(toolResultMsg, 'Transcript must contain a toolResult message');

    // 4. Lifecycle events are ordered correctly
    assert.ok(result.events.includes('agent_start'), 'Must emit agent_start');
    assert.ok(result.events.includes('tool_execution_start'), 'Must emit tool_execution_start');
    assert.ok(result.events.includes('tool_execution_end'), 'Must emit tool_execution_end');
    assert.ok(result.events.includes('agent_end'), 'Must emit agent_end');
  });

  it('should handle tool error signal gracefully without crashing the loop', async () => {
    const faultyTool: ResearchToolDefinition = {
      name: 'broken_tool',
      description: 'Always fails',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('Database connection timed out');
      },
    };

    const scriptedStreamFn = createScriptedStreamFn([
      {
        toolCalls: [
          {
            name: 'broken_tool',
            arguments: {},
          },
        ],
      },
      {
        text: 'The database was unavailable, reporting data_unavailable.',
      },
    ]);

    const adapter = new PiAgentAdapter({
      systemPrompt: 'You are a researcher.',
      tools: [faultyTool],
      streamFn: scriptedStreamFn,
    });

    const result = await adapter.run('Query database.');
    assert.ok(result.finalText.includes('data_unavailable'));
    const toolResultMsg = result.messages.find((m: any) => m.role === 'toolResult');
    assert.ok(toolResultMsg, 'Tool result must be recorded even on failure');
  });

  it('should support beforeToolCall and afterToolCall hooks for budget control', async () => {
    const tool: ResearchToolDefinition = {
      name: 'search_web',
      description: 'Search',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ status: 'ok' }),
    };

    let beforeHookCalled = false;
    let afterHookCalled = false;

    const scriptedStreamFn = createScriptedStreamFn([
      {
        toolCalls: [{ name: 'search_web', arguments: {} }],
      },
      {
        text: 'Done.',
      },
    ]);

    const adapter = new PiAgentAdapter({
      systemPrompt: 'You are a researcher.',
      tools: [tool],
      streamFn: scriptedStreamFn,
      beforeToolCall: async (toolCall: any) => {
        beforeHookCalled = true;
        assert.equal(toolCall.name, 'search_web');
        return undefined; // allow execution
      },
      afterToolCall: async (toolCall: any, _result: any) => {
        afterHookCalled = true;
        assert.equal(toolCall.name, 'search_web');
        return undefined;
      },
    });

    await adapter.run('Run search.');
    assert.ok(beforeHookCalled, 'beforeToolCall hook must be called');
    assert.ok(afterHookCalled, 'afterToolCall hook must be called');
  });
});
