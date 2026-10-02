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
} from '@earendil-works/pi-ai';

export interface ResearchToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: any, signal?: AbortSignal, callId?: string) => Promise<unknown>;
}

export interface ScriptedStep {
  toolCalls?: Array<{
    id?: string;
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
        content.push(
          fauxToolCall(tc.name, tc.arguments as any, tc.id ? { id: tc.id } : undefined)
        );
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
    toolCall: { name: string; arguments: any; call_id?: string },
    signal?: AbortSignal
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  afterToolCall?: (
    toolCall: { name: string; arguments: any; call_id?: string },
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
      execute: async (callId: string, params: any, signal?: AbortSignal) => {
        if (signal?.aborted) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Tool execution aborted' }),
              },
            ],
            isError: true,
            details: { error: 'Tool execution aborted' },
          };
        }

        try {
          const res = await t.execute(params, signal, callId);
          if (signal?.aborted) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ error: 'Tool execution was aborted; response dropped' }),
                },
              ],
              isError: true,
              details: { error: 'Tool execution was aborted; response dropped' },
            };
          }
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
            if (signal?.aborted) {
              return { block: true, reason: 'Tool call aborted before execution' };
            }
            const hookRes = await options.beforeToolCall!(
              {
                name: ctx.toolCall.name,
                arguments: ctx.toolCall.arguments,
                call_id: ctx.toolCall.id,
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
            if (signal?.aborted) {
              return undefined;
            }
            await options.afterToolCall!(
              {
                name: ctx.toolCall.name,
                arguments: ctx.toolCall.arguments,
                call_id: ctx.toolCall.id,
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

  async run(prompt: string, signal?: AbortSignal): Promise<PiAgentResult> {
    if (signal?.aborted) {
      throw signal.reason || new Error('Task execution aborted');
    }

    const abortHandler = () => {
      this.abort();
    };

    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    try {
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
    } finally {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  public abort(): void {
    this.agent.abort();
  }

  get state() {
    return this.agent.state;
  }
}

export interface TaskCancellationOptions {
  onCancelled?: (taskId: string, reason?: string) => void;
}

export class TaskCancellationController {
  private controllers = new Map<string, AbortController>();
  private cancelledTasks = new Set<string>();
  private completedTasks = new Set<string>();

  constructor(private options: TaskCancellationOptions = {}) {}

  public createTaskSignal(taskId: string, parentSignal?: AbortSignal): AbortSignal {
    let controller = this.controllers.get(taskId);
    if (!controller) {
      controller = new AbortController();
      this.controllers.set(taskId, controller);
    }

    if (parentSignal) {
      if (parentSignal.aborted) {
        controller.abort(parentSignal.reason);
      } else {
        parentSignal.addEventListener(
          'abort',
          () => {
            controller?.abort(parentSignal.reason);
          },
          { once: true }
        );
      }
    }

    return controller.signal;
  }

  public getSignal(taskId: string): AbortSignal | undefined {
    return this.controllers.get(taskId)?.signal;
  }

  public cancelTask(taskId: string, reason = 'Task cancelled'): boolean {
    this.cancelledTasks.add(taskId);
    const controller = this.controllers.get(taskId);
    if (controller) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(reason));
      }
      this.options.onCancelled?.(taskId, reason);
      return true;
    }
    this.options.onCancelled?.(taskId, reason);
    return false;
  }

  public isCancelled(taskId: string): boolean {
    if (this.cancelledTasks.has(taskId)) return true;
    const controller = this.controllers.get(taskId);
    return controller?.signal.aborted ?? false;
  }

  public async guard<T>(taskId: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.createTaskSignal(taskId);
    if (signal.aborted || this.isCancelled(taskId)) {
      throw new Error(`Task ${taskId} was cancelled; late call rejected`);
    }

    const result = await fn(signal);

    if (signal.aborted || this.isCancelled(taskId)) {
      throw new Error(`Task ${taskId} was cancelled; late response dropped`);
    }

    return result;
  }

  public acceptResult<T>(taskId: string, result: T): { accepted: boolean; result?: T; reason?: string } {
    if (this.isCancelled(taskId)) {
      return {
        accepted: false,
        reason: `Late response dropped: task ${taskId} is cancelled`,
      };
    }
    this.completedTasks.add(taskId);
    return {
      accepted: true,
      result,
    };
  }

  public cleanup(taskId: string): void {
    this.controllers.delete(taskId);
    this.cancelledTasks.delete(taskId);
    this.completedTasks.delete(taskId);
  }
}
