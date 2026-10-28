import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ClientConfig,
  clientFromEnv,
  completeStructured,
  isFatalStatus,
  ModelApiError,
} from '../src/reason/meta-client.ts';
import { TriageVerdict } from '../src/reason/schemas.ts';

/**
 * The Meta client is the only code that spends money. These tests drive it
 * through a fake fetch: which settings it refuses, which failures it retries,
 * and which unusable answers still carry the usage that was billed.
 */
const verdict = { keep: true, category: 'real-code', reason: 'mounted', confidence: 0.8 };
const usage = {
  prompt_tokens: 1_500,
  completion_tokens: 3_700,
  prompt_tokens_details: { cached_tokens: 200 },
  completion_tokens_details: { reasoning_tokens: 3_400 },
};

function completion(content: string, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      model: 'muse-spark-1.3',
      choices: [{ finish_reason: finishReason, message: { content } }],
      usage,
    }),
    { status: 200 },
  );
}

/** A fake endpoint that answers from a script, one entry per call, and counts the calls. */
function scripted(steps: Array<() => Response | Promise<Response>>): {
  config: ClientConfig;
  calls: () => number;
} {
  let calls = 0;
  const fetchImpl = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (!step) throw new Error('no scripted response');
    return step();
  }) as typeof fetch;
  return {
    config: { baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'muse-spark-1.3', fetchImpl },
    calls: () => calls,
  };
}

function ask(config: ClientConfig) {
  return completeStructured(config, {
    messages: [{ role: 'user', content: 'hi' }],
    schema: TriageVerdict,
    schemaName: 'TriageVerdict',
    maxOutputTokens: 4_000,
  });
}

test('clientFromEnv is null without a key and fills the Meta defaults with one', () => {
  assert.equal(clientFromEnv('META', {}), null);
  assert.equal(clientFromEnv('TRIAGE', { TRIAGE_API_KEY: 'k', TRIAGE_MODEL: 'glimmer' }), null);
  assert.deepEqual(clientFromEnv('META', { META_API_KEY: 'k' }), {
    baseUrl: 'https://api.meta.ai/v1',
    apiKey: 'k',
    model: 'muse-spark-1.3',
  });
});

test('clientFromEnv refuses a Contributor-tier model and a base URL that is not https', () => {
  assert.throws(
    () =>
      clientFromEnv('META', { META_API_KEY: 'k', META_REASON_MODEL: 'muse-spark-1.3-contributor' }),
    /Contributor-tier/,
  );
  assert.throws(
    () =>
      clientFromEnv('TRIAGE', {
        TRIAGE_API_KEY: 'k',
        TRIAGE_BASE_URL: 'https://openrouter.ai/api/v1',
        TRIAGE_MODEL: 'muse-spark-1.2-Contributor',
      }),
    /Contributor-tier/,
  );
  assert.throws(
    () => clientFromEnv('META', { META_API_KEY: 'k', META_BASE_URL: 'http://api.meta.ai/v1' }),
    /must start with https/,
  );
});

test('only auth and billing failures count as fatal', () => {
  assert.deepEqual([401, 402, 403, 400, 429, 500].map(isFatalStatus), [
    true,
    true,
    true,
    false,
    false,
    false,
  ]);
});

test('a rate limit is retried after the retry-after delay', async () => {
  const api = scripted([
    () => new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } }),
    () => completion(JSON.stringify(verdict)),
  ]);
  const started = Date.now();
  const result = await ask(api.config);
  assert.ok(Date.now() - started < 900, 'waited the 10 ms asked for, not the 1 s default backoff');
  assert.equal(api.calls(), 2);
  assert.equal(result.data.keep, true);
  assert.deepEqual(result.usage, {
    promptTokens: 1_500,
    cachedTokens: 200,
    completionTokens: 3_700,
    reasoningTokens: 3_400,
  });
});

test('server errors stop after maxRetries and stay marked retryable', async () => {
  const api = scripted([
    () => new Response('down', { status: 503, headers: { 'retry-after': '0.01' } }),
  ]);
  const caught = await ask({ ...api.config, maxRetries: 2 }).catch((e: unknown) => e);
  assert.ok(caught instanceof ModelApiError);
  assert.equal(caught.status, 503);
  assert.equal(caught.retryable, true);
  assert.equal(caught.usage, null);
  assert.equal(api.calls(), 3, 'one call plus two retries');
});

test('a 400 is never retried', async () => {
  const api = scripted([() => new Response('bad schema', { status: 400 })]);
  const caught = await ask(api.config).catch((e: unknown) => e);
  assert.ok(caught instanceof ModelApiError);
  assert.equal(caught.status, 400);
  assert.equal(caught.retryable, false);
  assert.equal(api.calls(), 1);
});

test('a network failure is retried, and gives up with status 0 when retries run out', async () => {
  const flaky = scripted([
    () => {
      throw new TypeError('fetch failed');
    },
    () => completion(JSON.stringify(verdict)),
  ]);
  const result = await ask({ ...flaky.config, maxRetries: 1 });
  assert.equal(result.data.keep, true);
  assert.equal(flaky.calls(), 2);

  const down = scripted([
    () => {
      throw new TypeError('fetch failed');
    },
  ]);
  const caught = await ask({ ...down.config, maxRetries: 0 }).catch((e: unknown) => e);
  assert.ok(caught instanceof ModelApiError);
  assert.equal(caught.status, 0);
  assert.equal(down.calls(), 1);
});

test('a request that outlives timeoutMs is aborted', async () => {
  let calls = 0;
  const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }) as typeof fetch;
  const caught = await ask({
    baseUrl: 'https://fake.local/v1',
    apiKey: 'k',
    model: 'muse-spark-1.3',
    fetchImpl,
    timeoutMs: 20,
    maxRetries: 0,
  }).catch((e: unknown) => e);
  assert.ok(caught instanceof ModelApiError);
  assert.match(caught.message, /failed after retries/);
  assert.equal(calls, 1);
});

test('unusable answers that reached the model carry the billed usage', async () => {
  const cases: Array<[string, Response, RegExp]> = [
    ['truncated', completion('{"keep":', 'length'), /finish_reason=length/],
    ['not JSON', completion('I think you should keep it.'), /not JSON/],
    ['wrong shape', completion(JSON.stringify({ keep: 'yes' })), /did not match the schema/],
  ];
  for (const [name, response, message] of cases) {
    const api = scripted([() => response]);
    const caught = await ask(api.config).catch((e: unknown) => e);
    assert.ok(caught instanceof ModelApiError, name);
    assert.match(caught.message, message, name);
    assert.equal(caught.retryable, false, name);
    assert.equal(caught.usage?.completionTokens, 3_700, `${name}: usage kept for charging`);
    assert.equal(api.calls(), 1, `${name}: not retried`);
  }
});

test('a body that is not JSON at all fails without usage', async () => {
  const api = scripted([() => new Response('<html>gateway</html>', { status: 200 })]);
  const caught = await ask(api.config).catch((e: unknown) => e);
  assert.ok(caught instanceof ModelApiError);
  assert.match(caught.message, /body that is not JSON/);
  assert.equal(caught.usage, null);
});
