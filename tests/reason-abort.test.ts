import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runScan } from '../src/pipeline/run.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';
import { DEFAULT_EFFORT, type ReasonOptions, runReasoning } from '../src/reason/orchestrate.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

/**
 * The paths that stop a reasoning run from spending money it should not:
 * a bad key or an empty balance, a billed answer that cannot be used, the
 * run cap, and verdicts that were already paid for. Every model is a fake.
 */
async function freshRun(): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'va2-abort-'));
  const { runDir } = await runScan('examples/seeded-app', {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  return runDir;
}

const ANSWERS: Record<string, unknown> = {
  RepoMap: {
    summary: 'A small Express API.',
    stack: ['express'],
    entryPoints: [{ file: 'server/index.js', kind: 'http-route', note: 'mounts all routers' }],
    authBoundaries: [],
    dataStores: [],
    trustZones: [{ zone: 'public', files: ['routes/users.js'] }],
    fileRoles: [{ file: 'routes/users.js', role: 'route' }],
    notes: [],
  },
  TriageVerdict: { keep: true, category: 'real-code', reason: 'mounted', confidence: 0.9 },
  ExploitVerdict: {
    exploitability: 'confirmed',
    confidence: 0.9,
    attackerPosition: 'anonymous-internet',
    preconditions: [],
    attackPath: ['Send a crafted id.'],
    impact: 'Reads every row.',
    blastRadius: 'whole-system',
    evidence: [{ file: 'routes/users.js', line: 9, quote: 'db.query(' }],
    severityAdjustment: 'keep',
    fixSummary: 'Use a parameterized query.',
    plainLanguage: 'Anyone can read every account.',
  },
};

const USAGE = { prompt_tokens: 2_000, completion_tokens: 3_000 };

type Reply = 'ok' | 'truncated' | 'wrong-shape' | number;

/**
 * A fake OpenAI-compatible endpoint. `reply` picks the answer for each call
 * by schema name and the count of earlier calls with that schema: 'ok', a
 * billed answer cut off at the token cap, a billed answer in the wrong shape,
 * or an HTTP status.
 */
function fakeModel(
  model: string,
  log: string[],
  reply: (schema: string, nth: number) => Reply = () => 'ok',
): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      response_format: { json_schema: { name: string } };
    };
    const schema = body.response_format.json_schema.name;
    const nth = log.filter((s) => s === schema).length;
    log.push(schema);
    const kind = reply(schema, nth);
    if (typeof kind === 'number') return new Response('{"error":"no"}', { status: kind });
    const content =
      kind === 'wrong-shape' ? '{"unexpected":true}' : JSON.stringify(ANSWERS[schema]);
    return new Response(
      JSON.stringify({
        model,
        choices: [
          {
            finish_reason: kind === 'truncated' ? 'length' : 'stop',
            message: { content: kind === 'truncated' ? content.slice(0, 20) : content },
          },
        ],
        usage: USAGE,
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { baseUrl: 'https://fake.local/v1', apiKey: 'k', model, fetchImpl };
}

function options(over: Partial<ReasonOptions>): ReasonOptions {
  return {
    reason: null,
    triage: null,
    dryRun: false,
    classes: null,
    maxFindings: 40,
    effort: DEFAULT_EFFORT,
    budget: {},
    force: false,
    ...over,
  };
}

function stages(runDir: string): { reasoning: string; triage: string } {
  return JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')).stages;
}

for (const status of [401, 402, 403]) {
  test(`a ${status} on the repo map stops the run after one call`, async () => {
    const runDir = await freshRun();
    const log: string[] = [];
    const record = await runReasoning(
      runDir,
      options({ reason: fakeModel('muse-spark-1.3', log, () => status) }),
    );
    assert.deepEqual(log, ['RepoMap'], 'no call after the fatal status');
    assert.match(record.aborted ?? '', new RegExp(`stopped before spending more.*${status}`));
    assert.equal(record.usd, 0);
    assert.equal(stages(runDir).reasoning, 'failed');
  });
}

test('a 402 on an exploitability call stops the run and records the error', async () => {
  const runDir = await freshRun();
  const log: string[] = [];
  const record = await runReasoning(
    runDir,
    options({
      reason: fakeModel('muse-spark-1.3', log, (schema) => (schema === 'RepoMap' ? 'ok' : 402)),
    }),
  );
  assert.deepEqual(log, ['RepoMap', 'ExploitVerdict']);
  assert.ok(record.aborted);
  const errors = record.decisions.filter((d) => d.outcome === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.note ?? '', /402/);
  assert.equal(record.calls, 1, 'only the repo map was billed');
  assert.equal(stages(runDir).reasoning, 'failed');
});

test('a 401 from the triage model stops the run before any exploitability call', async () => {
  const runDir = await freshRun();
  const log: string[] = [];
  const record = await runReasoning(
    runDir,
    options({
      reason: fakeModel('muse-spark-1.3', log),
      triage: fakeModel('meta/muse-glimmer-30b', log, () => 401),
    }),
  );
  assert.deepEqual(log, ['RepoMap', 'TriageVerdict']);
  assert.ok(record.aborted);
  assert.equal(stages(runDir).triage, 'failed');
});

test('billed answers that cannot be used are charged, and the run goes on', async () => {
  const runDir = await freshRun();
  const log: string[] = [];
  const record = await runReasoning(
    runDir,
    options({
      reason: fakeModel('muse-spark-1.3', log, (schema, nth) =>
        schema === 'RepoMap' ? 'wrong-shape' : nth === 0 ? 'truncated' : 'ok',
      ),
    }),
  );
  assert.equal(record.aborted, null);
  assert.equal(record.repoMap, null, 'the run continued without the map');
  const exploitCalls = log.filter((s) => s === 'ExploitVerdict').length;
  assert.equal(record.calls, 1 + exploitCalls, 'the failed map and the truncated verdict count');
  const errors = record.decisions.filter((d) => d.outcome === 'error');
  assert.equal(errors.length, 1);
  assert.ok((errors[0]?.usd ?? 0) > 0, 'the truncated verdict carries its cost');
  assert.match(errors[0]?.note ?? '', /finish_reason=length/);
  const decided = record.decisions.reduce((sum, d) => sum + d.usd, 0);
  assert.ok(record.usd > decided, 'the failed map is in the run total too');
  assert.ok(record.decisions.some((d) => d.outcome === 'reasoned'));
  assert.equal(stages(runDir).reasoning, 'done');
});

test('a triage call that fails keeps the finding for the frontier model', async () => {
  const runDir = await freshRun();
  const log: string[] = [];
  const record = await runReasoning(
    runDir,
    options({
      reason: fakeModel('muse-spark-1.3', log),
      triage: fakeModel('meta/muse-glimmer-30b', log, () => 400),
      maxFindings: 1,
    }),
  );
  assert.deepEqual(log, ['RepoMap', 'TriageVerdict', 'ExploitVerdict']);
  assert.equal(record.aborted, null);
  assert.ok(record.decisions.some((d) => d.outcome === 'reasoned'));
});

test('once the run cap is spent, triage stops and the findings are marked capped', async () => {
  const runDir = await freshRun();
  const log: string[] = [];
  const record = await runReasoning(
    runDir,
    options({
      reason: fakeModel('muse-spark-1.3', log),
      triage: fakeModel('meta/muse-glimmer-30b', log),
      budget: { perRunUsd: 0.001 },
    }),
  );
  assert.deepEqual(log, ['RepoMap'], 'the map spent the cap; no triage or verdict call followed');
  const capped = record.decisions.filter((d) => d.outcome === 'budget-exhausted');
  assert.ok(capped.length > 0);
  assert.ok(capped.every((d) => d.note === 'run-usd-cap before triage'));
  assert.equal(record.decisions.filter((d) => d.outcome === 'reasoned').length, 0);
});

test('verdicts already paid for are kept unless --force asks for new ones', async () => {
  const runDir = await freshRun();
  const first: string[] = [];
  const done = await runReasoning(
    runDir,
    options({ reason: fakeModel('muse-spark-1.3', first), maxFindings: 3 }),
  );
  assert.equal(done.decisions.filter((d) => d.outcome === 'reasoned').length, 3);

  const again: string[] = [];
  const kept = await runReasoning(
    runDir,
    options({ reason: fakeModel('muse-spark-1.3', again), maxFindings: 3 }),
  );
  assert.equal(again.filter((s) => s === 'ExploitVerdict').length, 0, 'no verdict bought twice');
  assert.equal(kept.decisions.filter((d) => d.outcome === 'already-reasoned').length, 3);

  const forced: string[] = [];
  const redone = await runReasoning(
    runDir,
    options({ reason: fakeModel('muse-spark-1.3', forced), maxFindings: 3, force: true }),
  );
  assert.equal(forced.filter((s) => s === 'ExploitVerdict').length, 3);
  assert.equal(redone.decisions.filter((d) => d.outcome === 'reasoned').length, 3);
});
