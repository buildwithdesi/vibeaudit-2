import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FindingT } from '../src/model/finding.ts';
import { apiPatch } from '../src/patch/backends.ts';
import { rateFor } from '../src/reason/budget.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';

/**
 * The guards apiPatch runs before and after the model call. The model is a
 * fake that answers every call the same way and counts the calls.
 */
const RATE = rateFor('muse-spark-1.3');

function seededCopy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'va2-backend-')), 'app');
  cpSync('examples/seeded-app', dir, { recursive: true });
  return dir;
}

function finding(file: string): FindingT {
  return {
    id: 'f1',
    ruleId: 'sql-injection',
    ruleName: 'sql-injection',
    severity: 'critical',
    vulnClass: 'sql-injection',
    message: 'User input in SQL text.',
    file,
    line: 9,
    evidence: null,
    fix: 'Use a parameterized query.',
    cweId: null,
    cvssScore: null,
    owaspCategory: null,
    source: null,
    context: null,
    triage: null,
    reasoning: null,
  };
}

function fakeModel(answer: unknown, finishReason: string, calls: number[]): ClientConfig {
  const fetchImpl = (async () => {
    calls.push(1);
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: finishReason, message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: 2_000, completion_tokens: 500 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'muse-spark-1.3', fetchImpl };
}

const GOOD_PLAN = {
  edits: [
    {
      file: 'routes/users.js',
      search: 'WHERE id = ${req.params.id}`);',
      replace: "WHERE id = $1', [req.params.id]);",
      why: 'parameterized',
    },
  ],
  newDependencies: [],
  note: 'Bound the id.',
  confidence: 0.9,
};

test('apiPatch refuses a missing file, a path outside the repo, a symlink and a folder unsent', async () => {
  const dir = seededCopy();
  symlinkSync(join(dir, 'routes/users.js'), join(dir, 'routes/link.js'));
  const calls: number[] = [];
  const client = fakeModel(GOOD_PLAN, 'stop', calls);
  const cases: Array<[string, string]> = [
    ['routes/missing.js', 'file not found'],
    ['../outside.js', 'file path escapes the repository'],
    ['routes/link.js', 'target is not a regular file'],
    ['routes', 'target is not a regular file'],
  ];
  for (const [file, note] of cases) {
    const outcome = await apiPatch(client, dir, finding(file), RATE);
    assert.equal(outcome.note, note, file);
    assert.equal(outcome.usd, 0);
  }
  assert.equal(calls.length, 0, 'no model call for a file it cannot patch');
});

test('apiPatch refuses a file over 512 KB unsent', async () => {
  const dir = seededCopy();
  writeFileSync(join(dir, 'routes/big.js'), `// ${'x'.repeat(513 * 1024)}\n`);
  const calls: number[] = [];
  const outcome = await apiPatch(
    fakeModel(GOOD_PLAN, 'stop', calls),
    dir,
    finding('routes/big.js'),
    RATE,
  );
  assert.equal(outcome.note, 'file larger than 512 KB; patch it by hand');
  assert.equal(calls.length, 0);
});

test('apiPatch rejects a plan that adds dependencies, writes nothing, and keeps the cost', async () => {
  const dir = seededCopy();
  const before = readFileSync(join(dir, 'routes/users.js'), 'utf8');
  const outcome = await apiPatch(
    fakeModel({ ...GOOD_PLAN, newDependencies: ['left-pad'] }, 'stop', []),
    dir,
    finding('routes/users.js'),
    RATE,
  );
  assert.equal(outcome.note, 'rejected: the plan adds dependencies (left-pad)');
  assert.deepEqual(outcome.edits, []);
  assert.ok(outcome.usd > 0, 'the call was billed');
  assert.equal(readFileSync(join(dir, 'routes/users.js'), 'utf8'), before);
});

test('apiPatch keeps the billed usage of an answer it cannot use', async () => {
  const dir = seededCopy();
  const before = readFileSync(join(dir, 'routes/users.js'), 'utf8');
  const outcome = await apiPatch(
    fakeModel(GOOD_PLAN, 'length', []),
    dir,
    finding('routes/users.js'),
    RATE,
  );
  assert.match(outcome.note, /^error: .*did not finish a complete answer/);
  assert.ok(outcome.usage, 'usage kept');
  assert.ok(outcome.usd > 0, 'the cost is counted');
  assert.equal(outcome.fatal, false);
  assert.equal(readFileSync(join(dir, 'routes/users.js'), 'utf8'), before);
});

test('apiPatch applies a good plan to the finding file', async () => {
  const dir = seededCopy();
  const outcome = await apiPatch(
    fakeModel(GOOD_PLAN, 'stop', []),
    dir,
    finding('routes/users.js'),
    RATE,
  );
  assert.deepEqual(
    outcome.edits.map((e) => e.reason),
    ['applied'],
  );
  assert.ok(readFileSync(join(dir, 'routes/users.js'), 'utf8').includes('$1'));
});
