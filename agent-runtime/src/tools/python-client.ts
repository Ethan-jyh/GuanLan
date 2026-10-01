import type { Envelope } from '../contracts/research.js';

export interface PythonToolClientOptions {
  baseUrl: string;
  internalToken: string;
  transport?: (
    path: string,
    headers: Record<string, string>,
    body: any
  ) => Promise<any>;
  timeoutMs?: number;
}

export class PythonToolClient {
  private baseUrl: string;
  private token: string;
  private transport?: (
    path: string,
    headers: Record<string, string>,
    body: any
  ) => Promise<any>;
  private timeoutMs: number;

  constructor(options: PythonToolClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.internalToken;
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 15000;
  }

  async callTool(
    envelope: Envelope,
    toolName: string,
    params: Record<string, unknown>
  ): Promise<any> {
    const path = `/api/research/internal/tools/${encodeURIComponent(toolName)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Research-Internal-Token': this.token,
    };

    const body = {
      ...envelope,
      ...params,
    };

    if (this.transport) {
      return this.transport(path, headers, body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `HTTP ${response.status} from Python tool ${toolName}: ${errorText}`
        );
      }

      return await response.json();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`Timeout calling Python tool ${toolName} after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}
