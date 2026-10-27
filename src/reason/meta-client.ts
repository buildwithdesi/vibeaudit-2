import type { z } from 'zod';
import type { Usage } from './budget.ts';
import { toResponseFormat } from './schemas.ts';

/**
 * Minimal client for any OpenAI-compatible chat completions endpoint with
 * JSON-schema structured output. The Meta Model API (Muse Spark) and the
 * hosted Muse Glimmer endpoints all speak this shape, so one client serves
 * both the triage and the reasoning stage. Plain fetch, no SDK.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra body fields some providers need, for example OpenRouter's provider routing. */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface StructuredRequest<T> {
  messages: ChatMessage[];
  schema: z.ZodType<T>;
  schemaName: string;
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens: number;
}

export interface StructuredResult<T> {
  data: T;
  usage: Usage;
  model: string;
  finishReason: string;
  requestId: string | null;
}

export class ModelApiError extends Error {
  override name = 'ModelApiError';
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

export function clientFromEnv(prefix: 'META' | 'TRIAGE', env = process.env): ClientConfig | null {
  const apiKey = env[`${prefix}_API_KEY`];
  const baseUrl =
    env[`${prefix}_BASE_URL`] ?? (prefix === 'META' ? 'https://api.meta.ai/v1' : undefined);
  const model =
    env[prefix === 'META' ? 'META_REASON_MODEL' : 'TRIAGE_MODEL'] ??
    (prefix === 'META' ? 'muse-spark-1.3' : undefined);
  if (!apiKey || !baseUrl || !model) return null;
  return { baseUrl, apiKey, model };
}

export async function completeStructured<T>(
  config: ClientConfig,
  request: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    max_completion_tokens: request.maxOutputTokens,
    response_format: toResponseFormat(request.schema, request.schemaName),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(config.extraBody ?? {}),
  };

  let attempt = 0;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 180_000);
    let response: Response;
    try {
      const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
      // biome-ignore format: the trailing marker must stay on the await line for the v1 engine
      response = await fetchImpl(url, { // vibe-audit-ignore perf-no-await-parallel
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt <= maxRetries) {
        await sleep(backoffMs(attempt, null)); // vibe-audit-ignore perf-no-await-parallel
        continue;
      }
      throw new ModelApiError(`request failed: ${(error as Error).message}`, 0, true);
    }
    clearTimeout(timer);

    if (!response.ok) {
      const text = (await response.text()).slice(0, 500); // vibe-audit-ignore perf-no-await-parallel
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt <= maxRetries) {
        await sleep(backoffMs(attempt, response.headers.get('retry-after'))); // vibe-audit-ignore perf-no-await-parallel
        continue;
      }
      // 400 schema problems, 401 bad key, 402 billing: never retry, surface clearly.
      throw new ModelApiError(
        `${config.model} returned ${response.status}: ${text}`,
        response.status,
        retryable,
      );
    }

    const json = (await response.json()) as ChatCompletion; // vibe-audit-ignore perf-no-await-parallel
    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (!choice || typeof content !== 'string' || choice.finish_reason !== 'stop') {
      throw new ModelApiError(
        `${config.model} did not finish a complete answer (finish_reason=${choice?.finish_reason ?? 'none'})`,
        200,
        false,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new ModelApiError(`${config.model} returned text that is not JSON`, 200, false);
    }
    const data = request.schema.parse(parsed);
    return {
      data,
      usage: readUsage(json.usage),
      model: json.model ?? config.model,
      finishReason: choice.finish_reason,
      requestId: response.headers.get('x-request-id'),
    };
  }
}

interface ChatCompletion {
  model?: string;
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function readUsage(usage: ChatCompletion['usage']): Usage {
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const header = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 60_000);
  return Math.min(1000 * 2 ** (attempt - 1), 20_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
