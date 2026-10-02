import {
  Agent,
  type AgentMessage,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  type AssistantMessage,
  type Tool,
} from '@earendil-works/pi-ai';

export interface ResearchToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: any, signal?: AbortSignal) => Promise<unknown>;
}

export interface ScriptedStep {
  toolCalls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
  }>;
  text?: string;
}

export function createScriptedStreamFn(steps: ScriptedStep[]): StreamFn {
  let stepIndex = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    const currentStep = steps[stepIndex] ?? steps[steps.length - 1];
    stepIndex++;

    const content: any[] = [];
    if (currentStep?.toolCalls) {
      for (const tc of currentStep.toolCalls) {
        content.push(fauxToolCall(tc.name, tc.arguments as any));
      }
    }
    if (currentStep?.text) {
      content.push(fauxText(currentStep.text));
    }

    const msg: AssistantMessage = fauxAssistantMessage(content);
    stream.end(msg);
    return stream;
  };
}

export interface PiAgentAdapterOptions {
  systemPrompt?: string;
  tools?: ResearchToolDefinition[];
  streamFn: StreamFn;
  beforeToolCall?: (
    toolCall: { name: string; arguments: any },
    signal?: AbortSignal
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (
    toolCall: { name: string; arguments: any },
    result: any,
    signal?: AbortSignal
  ) => Promise<any | undefined>;
}

export interface PiAgentResult {
  finalText: string;
  messages: AgentMessage[];
  events: string[];
}

export class PiAgentAdapter {
  private agent: Agent;
  private events: string[] = [];

  constructor(private options: PiAgentAdapterOptions) {
    const tools = (options.tools || []).map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters as any,
      execute: async (_callId: string, params: any, signal?: AbortSignal) => {
        try {
          const res = await t.execute(params, signal);
          return {
            content: [
              {
                type: 'text' as const,
                text: typeof res === 'string' ? res : JSON.stringify(res),
              },
            ],
            details: res,
          };
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: errMsg }),
              },
            ],
            isError: true,
            details: { error: errMsg },
          };
        }
      },
    }));

    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        tools,
      },
      streamFn: options.streamFn,
      beforeToolCall: options.beforeToolCall
        ? async (ctx, signal) => {
            const hookRes = await options.beforeToolCall!(
              {
                name: ctx.toolCall.name,
                arguments: ctx.toolCall.arguments,
              },
              signal
            );
            if (hookRes?.block) {
              return {
                block: true,
                reason: hookRes.reason || 'Blocked by policy/budget',
              };
            }
            return undefined;
          }
        : undefined,
      afterToolCall: options.afterToolCall
        ? async (ctx, signal) => {
            await options.afterToolCall!(
              {
                name: ctx.toolCall.name,
                arguments: ctx.toolCall.arguments,
              },
              ctx.result,
              signal
            );
            return undefined;
          }
        : undefined,
    });

    this.agent.subscribe((event) => {
      this.events.push(event.type);
    });
  }

  async run(prompt: string): Promise<PiAgentResult> {
    this.events = [];
    await this.agent.prompt(prompt);
    await this.agent.waitForIdle();

    const messages = this.agent.state.messages;
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const lastAssistant = assistantMessages[assistantMessages.length - 1];

    let finalText = '';
    if (lastAssistant && Array.isArray(lastAssistant.content)) {
      finalText = (lastAssistant.content as any[])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    }

    return {
      finalText,
      messages,
      events: [...this.events],
    };
  }

  public abort(): void {
    this.agent.abort();
  }

  get state() {
    return this.agent.state;
  }
}

