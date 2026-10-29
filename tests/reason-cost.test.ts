import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runScan } from '../src/pipeline/run.ts';
import { costUsd, ReasoningBudget, rateFor } from '../src/reason/budget.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';
import { DEFAULT_EFFORT, type ReasonOptions, runReasoning } from '../src/reason/orchestrate.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

/**
 * What a run is expected to cost, and what it actually pays for. The live
 * reference is demo/after/reasoning.json: the same seeded app, reasoned by
 * muse-spark-1.3 at the default efforts, 10 calls for $0.1708.
 */
const live = JSON.parse(readFileSync('demo/after/reasoning.json', 'utf8')) as {
  calls: number;
  usd: number;
  usage: { promptTokens: number; cachedTokens: number; completionTokens: number };
};

async function freshRun(): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'va2-cost-'));
  const { runDir } = await runScan('examples/seeded-app', {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  return runDir;
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

/** A fake model that refuses every call with a 400 and counts them. */
function countingModel(log: string[]): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      response_format: { json_schema: { name: string } };
    };
    log.push(body.response_format.json_schema.name);
    return new Response('{"error":"not in this test"}', { status: 400 });
  }) as typeof fetch;
  return { baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'muse-spark-1.3', fetchImpl };
}

test('a dry run prices the seeded app close to what reasoning it live cost', async () => {
  const runDir = await freshRun();
  const record = await runReasoning(
    runDir,
    options({
      reason: { baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'muse-spark-1.3' },
      dryRun: true,
    }),
  );
  const ratio = record.estimatedUsd / live.usd;
  assert.ok(
    ratio > 0.75 && ratio < 1.5,
    `estimated $${record.estimatedUsd} against $${live.usd} live (${ratio.toFixed(2)}x)`,
  );
});

test('the run cap refuses a verdict that a typical answer would push past it', () => {
  const rate = rateFor('muse-spark-1.3');
  // The average call on the live run: about 1,570 tokens in and 3,580 out, reasoning included.
  const typical = {
    promptTokens: Math.round(live.usage.promptTokens / live.calls),
    cachedTokens: 0,
    completionTokens: Math.round(live.usage.completionTokens / live.calls),
    reasoningTokens: 0,
  };
  const budget = new ReasoningBudget({ perRunUsd: 1.9 * costUsd(typical, rate) });
  budget.record('a.js', typical, rate);
  // A second call like the first would end the run at 2x the cost of one, past the cap.
  assert.deepEqual(budget.canSpend('b.js', typical.promptTokens, rate), {
    ok: false,
    reason: 'run-usd-cap',
  });
});

test('no repo map is bought when no finding is selected', async () => {
  const runDir = await freshRun();
  const log: string[] = [];
  const record = await runReasoning(
    runDir,
    options({ reason: countingModel(log), classes: ['no-such-class'] }),
  );
  assert.deepEqual(log, []);
  assert.equal(record.calls, 0);
  assert.equal(record.usd, 0);
});

test('no repo map is bought when every selected finding keeps its verdict', async () => {
  const runDir = await freshRun();
  const findingsPath = join(runDir, 'findings.json');
  const findings = JSON.parse(readFileSync(findingsPath, 'utf8')) as Array<{ reasoning: unknown }>;
  const verdict = {
    exploitability: 'confirmed',
    confidence: 0.9,
    attackerPosition: 'anonymous-internet',
    preconditions: [],
    attackPath: ['Send a crafted id.'],
    impact: 'Reads every row.',
    blastRadius: 'whole-system',
    evidence: [],
    severityAdjustment: 'keep',
    fixSummary: 'Use a parameterized query.',
    plainLanguage: 'Anyone can read every account.',
  };
  await writeFile(
    findingsPath,
    JSON.stringify(findings.map((f) => ({ ...f, reasoning: verdict }))),
  );

  const log: string[] = [];
  const record = await runReasoning(runDir, options({ reason: countingModel(log) }));
  assert.deepEqual(log, []);
  assert.ok(record.decisions.some((d) => d.outcome === 'already-reasoned'));
  assert.equal(record.usd, 0);
});
