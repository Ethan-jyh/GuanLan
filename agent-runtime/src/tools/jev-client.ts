import {
  JevSentimentChoice,
  JevSystemOneResponse,
  JevSystemOneResponseSchema,
} from '../contracts/sentiment.js';
import {
  JEV_SENTIMENT_QUESTION,
  JEV_SENTIMENT_QUESTION_VERSION,
} from './jev-questions.js';

export interface JevAttemptInfo {
  attempt: number;
  statusCode?: number;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

export interface JevClientOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  clock?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  onAttempt?: (info: JevAttemptInfo) => void;
}

export interface JevClassifyParams {
  text: string;
  target: string;
  context?: string;
}

export interface JevClassificationResult {
  ok: boolean;
  choice?: JevSentimentChoice;
  confidence?: number;
  probabilities?: Record<string, number>;
  rationale?: string;
  actualModel: string;
  questionVersion: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  attempts: number;
  error?: string;
}

export class JevClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'JevClientError';
  }
}

export class JevClient {
  private apiKey?: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private maxRetries: number;
  private transport: (url: string, init: RequestInit) => Promise<Response>;
  private clock: () => number;
  private sleepFn: (ms: number) => Promise<void>;
  private onAttempt?: (info: JevAttemptInfo) => void;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
    this.baseUrl = (options.baseUrl ?? 'https://api.typesafe.ai/v1').replace(/\/+$/, '');
    this.model = options.model ?? 'jev-latest';
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.maxRetries = options.maxRetries ?? 2;
    this.transport = options.transport ?? (fetch as any);
    this.clock = options.clock ?? (() => Date.now());
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onAttempt = options.onAttempt;
  }

  public async classifySentiment(params: JevClassifyParams): Promise<JevClassificationResult> {
    if (!this.apiKey) {
      throw new JevClientError(
        'TYPESAFE_API_KEY is missing. Please configure TYPESAFE_API_KEY in .env or constructor options.',
        401,
        false
      );
    }

    if (!params.target || !params.target.trim()) {
      throw new JevClientError('Target is required for sentiment classification.', 400, false);
    }

    const endpoint = `${this.baseUrl}/systemone`;
    const payload = {
      model: this.model,
      state: {
        target: params.target,
        text: params.text,
        context: params.context || '',
      },
      questions: {
        sentiment: JEV_SENTIMENT_QUESTION,
      },
    };

    let attempt = 0;
    let lastError: any = null;

    while (attempt <= this.maxRetries) {
      attempt++;
      const startTime = this.clock();
      let statusCode: number | undefined;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        let response: Response;
        try {
          response = await this.transport(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          statusCode = response.status;
        } finally {
          clearTimeout(timeoutId);
        }

        const durationMs = this.clock() - startTime;

        if (statusCode === 401 || statusCode === 403) {
          const errText = await response.text().catch(() => '');
          this.onAttempt?.({
            attempt,
            statusCode,
            durationMs,
            error: `Authentication failed (${statusCode}): ${errText}`,
          });
          throw new JevClientError(`Authentication failed with status ${statusCode}`, statusCode, false);
        }

        if (statusCode === 429) {
          const retryAfterSec = parseInt(response.headers?.get('retry-after') || '1', 10);
          this.onAttempt?.({
            attempt,
            statusCode,
            durationMs,
            error: 'Rate limit exceeded (429)',
          });

          if (attempt <= this.maxRetries) {
            await this.sleepFn(Math.min(retryAfterSec * 1000, 5000));
            continue;
          }
          throw new JevClientError('Rate limit exceeded (429), max retries reached', 429, true);
        }

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          this.onAttempt?.({
            attempt,
            statusCode,
            durationMs,
            error: `Server returned ${statusCode}: ${errText}`,
          });

          const is5xx = statusCode >= 500 && statusCode < 600;
          if (is5xx && attempt <= this.maxRetries) {
            await this.sleepFn(500 * Math.pow(2, attempt - 1));
            continue;
          }
          throw new JevClientError(`HTTP error ${statusCode}: ${errText}`, statusCode, is5xx);
        }

        const rawJson = await response.json();
        const parsed: JevSystemOneResponse = JevSystemOneResponseSchema.parse(rawJson);

        const sentimentAns = parsed.answers.sentiment;
        if (!sentimentAns || !sentimentAns.choice) {
          throw new JevClientError('Jev response missing answers.sentiment.choice', 502, false);
        }

        this.onAttempt?.({
          attempt,
          statusCode: 200,
          durationMs,
          inputTokens: parsed.usage?.input_tokens,
          outputTokens: parsed.usage?.output_tokens,
        });

        return {
          ok: true,
          choice: sentimentAns.choice,
          confidence: sentimentAns.confidence ?? 0.5,
          probabilities: sentimentAns.probabilities,
          rationale: sentimentAns.rationale,
          actualModel: parsed.model || this.model,
          questionVersion: JEV_SENTIMENT_QUESTION_VERSION,
          usage: {
            inputTokens: parsed.usage?.input_tokens,
            outputTokens: parsed.usage?.output_tokens,
            totalTokens: parsed.usage?.total_tokens,
          },
          attempts: attempt,
        };
      } catch (err: any) {
        lastError = err;
        const durationMs = this.clock() - startTime;

        if (err instanceof JevClientError && !err.isRetryable) {
          throw err;
        }

        const isAbort = err?.name === 'AbortError';
        if (isAbort) {
          this.onAttempt?.({
            attempt,
            durationMs,
            error: `Timeout after ${this.timeoutMs}ms`,
          });
          if (attempt <= this.maxRetries) {
            continue;
          }
          throw new JevClientError(`Jev request timed out after ${this.timeoutMs}ms`, 408, true);
        }

        this.onAttempt?.({
          attempt,
          statusCode,
          durationMs,
          error: err?.message || 'Network error',
        });

        if (attempt <= this.maxRetries) {
          await this.sleepFn(500 * Math.pow(2, attempt - 1));
          continue;
        }
      }
    }

    throw lastError || new JevClientError('Unknown error during Jev classification', 500, false);
  }
}
