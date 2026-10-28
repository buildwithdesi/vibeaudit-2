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
  /** Cap on completion tokens. Reasoning tokens count against it, so leave real headroom. */
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
  /** Billed usage when the call reached the model but the answer was unusable. */
  readonly usage: Usage | null;
  constructor(message: string, status: number, retryable: boolean, usage: Usage | null = null) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.usage = usage;
  }
}

/** Auth or billing failures that will fail every later call the same way. */
export function isFatalStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 403;
}

export function clientFromEnv(prefix: 'META' | 'TRIAGE', env = process.env): ClientConfig | null {
  const apiKey = env[`${prefix}_API_KEY`];
  const baseUrl =
    env[`${prefix}_BASE_URL`] ?? (prefix === 'META' ? 'https://api.meta.ai/v1' : undefined);
  const model =
    env[prefix === 'META' ? 'META_REASON_MODEL' : 'TRIAGE_MODEL'] ??
    (prefix === 'META' ? 'muse-spark-1.3' : undefined);
  if (!apiKey || !baseUrl || !model) return null;
  if (!/^https:\/\//i.test(baseUrl)) throw new Error(`${prefix}_BASE_URL must start with https://`);
  if (/-contributor$/i.test(model)) {
    throw new Error(
      `${model} is a Contributor-tier model. Meta uses that tier to improve its products, so it is not allowed for scanned code.`,
    );
  }
  return { baseUrl, apiKey, model };
}

export async function completeStructured<T>(
  config: ClientConfig,
  request: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
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
    try {
      const response = await sendOnce(fetchImpl, url, config.apiKey, body, controller.signal); // vibe-audit-ignore perf-no-await-parallel
      if (response === null) {
        if (attempt <= maxRetries) {
          await sleep(backoffMs(attempt, null)); // vibe-audit-ignore perf-no-await-parallel
          continue;
        }
        throw new ModelApiError('request failed after retries', 0, true);
      }

      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 500); // vibe-audit-ignore perf-no-await-parallel
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

      return await readAnswer(response, config.model, request.schema); // vibe-audit-ignore perf-no-await-parallel
    } finally {
      clearTimeout(timer);
    }
  }
}

/** One HTTP attempt. Returns null on a network-level failure so the caller can retry. */
async function sendOnce(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response | null> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    return null;
  }
}

async function readAnswer<T>(
  response: Response,
  model: string,
  schema: z.ZodType<T>,
): Promise<StructuredResult<T>> {
  let json: ChatCompletion;
  try {
    json = (await response.json()) as ChatCompletion;
  } catch (caught) {
    throw new ModelApiError(
      `${model} returned a body that is not JSON: ${(caught as Error).message}`,
      200,
      false,
    );
  }
  const usage = readUsage(json.usage);
  const choice = json.choices?.[0];
  const content = choice?.message?.content;
  if (!choice || typeof content !== 'string' || choice.finish_reason !== 'stop') {
    throw new ModelApiError(
      `${model} did not finish a complete answer (finish_reason=${choice?.finish_reason ?? 'none'})`,
      200,
      false,
      usage,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelApiError(`${model} returned text that is not JSON`, 200, false, usage);
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new ModelApiError(
      `${model} answer did not match the schema: ${validated.error.message.slice(0, 300)}`,
      200,
      false,
      usage,
    );
  }
  return {
    data: validated.data,
    usage,
    model: json.model ?? model,
    finishReason: choice.finish_reason,
    requestId: response.headers.get('x-request-id'),
  };
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
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 1000), 60_000);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 20_000);
  return base + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
