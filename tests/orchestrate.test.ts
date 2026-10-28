import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runScan } from '../src/pipeline/run.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';
import { DEFAULT_EFFORT, runReasoning } from '../src/reason/orchestrate.ts';
import { renderProofOfRisk } from '../src/report/proof-of-risk.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

async function freshRun(): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), 'va2-reason-'));
  const result = await runScan('examples/seeded-app', {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  return result.runDir;
}

/** A fake Meta endpoint that answers every schema with a plausible object and counts calls. */
function fakeClient(model: string, log: Array<{ schema: string; prompt: string }>): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      response_format: { json_schema: { name: string } };
      messages: Array<{ content: string }>;
    };
    const name = body.response_format.json_schema.name;
    log.push({ schema: name, prompt: body.messages.map((m) => m.content).join('\n') });
    const answer =
      name === 'RepoMap'
        ? {
            summary: 'A small Express API with user, network, file and preview routes.',
            stack: ['express'],
            entryPoints: [
              { file: 'server/index.js', kind: 'http-route', note: 'mounts all routers' },
            ],
            authBoundaries: [],
            dataStores: [{ name: 'db', accessedFrom: ['routes/users.js'] }],
            trustZones: [{ zone: 'public', files: ['routes/users.js', 'routes/network.js'] }],
            fileRoles: [{ file: 'routes/users.js', role: 'route' }],
            notes: ['No authentication middleware anywhere.'],
          }
        : name === 'TriageVerdict'
          ? {
              keep: !/config\.js/.test(body.messages[1]?.content ?? ''),
              category: 'real-code',
              reason: 'mounted in server/index.js',
              confidence: 0.9,
            }
          : {
              exploitability: 'confirmed',
              confidence: 0.95,
              attackerPosition: 'anonymous-internet',
              preconditions: [],
              attackPath: ['Send a crafted id in the URL.', 'The id lands inside the SQL text.'],
              impact: 'Read or delete any row in the users table.',
              blastRadius: 'whole-system',
              evidence: [
                {
                  file: 'routes/users.js',
                  line: 9,
                  quote: 'db.query(`SELECT * FROM users WHERE id = ${req.params.id}`)',
                },
              ],
              severityAdjustment: 'keep',
              fixSummary: 'Use a parameterized query.',
              plainLanguage:
                'Anyone on the internet can read or erase every user account. No login is needed.',
            };
    return new Response(
      JSON.stringify({
        model,
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }],
        usage: {
          prompt_tokens: 2000,
          completion_tokens: 300,
          completion_tokens_details: { reasoning_tokens: 100 },
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { baseUrl: 'https://fake.local/v1', apiKey: 'k', model, fetchImpl };
}

test('dry run writes every prompt, estimates cost, and makes no call', async () => {
  const runDir = await freshRun();
  const log: Array<{ schema: string; prompt: string }> = [];
  const record = await runReasoning(runDir, {
    reason: fakeClient('muse-spark-1.3', log),
    triage: fakeClient('meta/muse-glimmer-30b', log),
    dryRun: true,
    classes: null,
    maxFindings: 40,
    effort: DEFAULT_EFFORT,
    budget: {},
    force: false,
  });
  assert.equal(log.length, 0, 'no API call in a dry run');
  assert.equal(record.calls, 0);
  assert.ok(record.estimatedUsd > 0 && record.estimatedUsd < 1, `estimate ${record.estimatedUsd}`);
  const prompts = readdirSync(join(runDir, 'prompts'));
  assert.ok(prompts.includes('repo-map.md'));
  assert.ok(prompts.some((p) => p.startsWith('exploit-')));
  assert.ok(prompts.some((p) => p.startsWith('triage-')));
  const mapPrompt = readFileSync(join(runDir, 'prompts', 'repo-map.md'), 'utf8');
  assert.ok(mapPrompt.includes('routes/users.js'), 'file tree reaches the prompt');
  assert.ok(!mapPrompt.includes('Winter2026Prod'), 'planted password never reaches a prompt');
});

test('live run fills triage and reasoning slots, respects the budget, and feeds the report', async () => {
  const runDir = await freshRun();
  const log: Array<{ schema: string; prompt: string }> = [];
  const record = await runReasoning(runDir, {
    reason: fakeClient('muse-spark-1.3', log),
    triage: fakeClient('meta/muse-glimmer-30b', log),
    dryRun: false,
    classes: null,
    maxFindings: 12,
    effort: DEFAULT_EFFORT,
    budget: { maxFindingsPerFile: 2 },
    force: false,
  });
  assert.equal(log.filter((l) => l.schema === 'RepoMap').length, 1, 'one repo map call');
  assert.ok(record.repoMap, 'repo map stored');
  const outcomes = record.decisions.map((d) => d.outcome);
  assert.ok(outcomes.includes('reasoned'));
  assert.ok(outcomes.includes('triage-dropped'), 'config.js finding dropped by the fake triage');
  assert.ok(outcomes.includes('not-selected'));
  assert.ok(record.usd > 0);
  for (const l of log)
    assert.ok(!l.prompt.includes('Winter2026Prod'), 'no planted secret in any prompt');

  const findings = JSON.parse(readFileSync(join(runDir, 'findings.json'), 'utf8')) as Array<{
    reasoning: unknown;
    triage: unknown;
  }>;
  assert.ok(
    findings.some((f) => f.reasoning),
    'reasoning written back into findings.json',
  );
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as {
    stages: { reasoning: string; triage: string };
  };
  assert.equal(manifest.stages.reasoning, 'done');
  assert.equal(manifest.stages.triage, 'done');

  const report = await renderProofOfRisk(runDir);
  assert.ok(existsSync(join(runDir, 'report.md')));
  assert.ok(report.includes('# Proof of risk: seeded-app'));
  assert.ok(report.includes('Anyone on the internet can read or erase every user account.'));
  assert.ok(report.includes('**The proof, in the code:**'));
  assert.ok(report.includes('Someone can rewrite your database commands'));
  assert.ok(!report.includes('Winter2026Prod'));
});

test('report renders without a reasoning stage and says so', async () => {
  const runDir = await freshRun();
  const report = await renderProofOfRisk(runDir);
  assert.ok(report.includes('This is a first pass.'));
  assert.ok(report.includes('_Not checked for exploitability on this scan._'));
});
