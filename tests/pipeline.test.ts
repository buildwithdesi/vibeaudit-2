import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { RunManifest } from '../src/model/finding.ts';
import { assertRuleListComplete, runScan } from '../src/pipeline/run.ts';
import { topClasses } from '../src/report/summary.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

test('scans the seeded app end to end and finds all five planted classes', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'va2-run-'));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const result = await runScan('examples/seeded-app', {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });

  for (const file of ['engine-output.json', 'findings.json', 'manifest.json', 'summary.md']) {
    assert.ok(existsSync(join(result.runDir, file)), `${file} written`);
  }
  const manifest = RunManifest.parse(
    JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')),
  );
  assert.ok(manifest.engine.rulesAvailable > 0);
  assert.ok(manifest.engine.rulesRun > 0);
  assert.equal(manifest.engine.rulesAvailable, manifest.engine.rulesRun, 'the full rule list');
  assert.equal(manifest.stages.engine, 'done');
  assert.equal(manifest.stages.reasoning, 'pending');

  const classes = new Set(result.findings.map((f) => f.vulnClass));
  for (const planted of [
    'secrets',
    'sql-injection',
    'command-injection',
    'missing-auth',
    'path-traversal',
    'ssrf',
  ]) {
    assert.ok(classes.has(planted as never), `planted class found: ${planted}`);
  }
  assert.equal(topClasses(result.findings).length, 5);

  const secret = result.findings.find((f) => f.vulnClass === 'secrets' && f.context);
  assert.ok(secret?.context, 'secrets finding has context');
  assert.ok(
    !secret.context.code.includes('Winter2026Prod'),
    'context never carries the planted password',
  );
  const serialized = readFileSync(join(result.runDir, 'findings.json'), 'utf8');
  assert.ok(
    !serialized.includes('Winter2026Prod'),
    'findings.json never carries the planted password',
  );
});

test('a rule list shorter than the rules the scan ran is refused, not recorded', () => {
  assert.throws(() => assertRuleListComplete(56, 104), /56 rules listed, but the scan ran 104/);
  assert.doesNotThrow(() => assertRuleListComplete(104, 104));
});

test('a double-quoted token in engine evidence is masked without breaking engine-output.json', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'va2-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  await mkdir(app);
  await writeFile(
    join(app, 'client.js'),
    'export function load() {\n  return fetch("https://api.example.com/data?token=abcd1234abcd1234");\n}\n',
  );

  const result = await runScan(app, {
    outDir: join(root, 'runs'),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 2,
  });
  const raw = readFileSync(join(result.runDir, 'engine-output.json'), 'utf8');
  const output = JSON.parse(raw) as { findings: { file: string }[] };
  assert.ok(
    output.findings.some((f) => f.file === 'client.js'),
    'the token line was flagged',
  );
  assert.ok(!raw.includes('abcd1234abcd1234'), 'engine-output.json never carries the token');
});

test('git run on a local target gets the scrubbed env, not API keys', {
  skip: process.platform === 'win32' ? 'uses a POSIX shell script as a git shim' : false,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'va2-run-'));
  const saved = { PATH: process.env.PATH, META_API_KEY: process.env.META_API_KEY };
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const shim = join(root, 'bin');
  const record = join(root, 'git-calls.txt');
  await mkdir(shim);
  await writeFile(
    join(shim, 'git'),
    `#!/bin/sh\necho "args: $*" >> '${record}'\nenv >> '${record}'\necho ${'a'.repeat(40)}\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${shim}${delimiter}${process.env.PATH ?? ''}`;
  process.env.META_API_KEY = 'FAKEZ9-meta-key';
  const app = join(root, 'app');
  await mkdir(app);
  await writeFile(join(app, 'index.js'), 'export const x = 1;\n');

  const result = await runScan(app, {
    outDir: join(root, 'runs'),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 2,
  });
  assert.equal(result.manifest.commit, 'a'.repeat(40), 'the commit came from the shim');
  const calls = readFileSync(record, 'utf8');
  assert.match(calls, /args: .*rev-parse HEAD/);
  assert.ok(!calls.includes('FAKEZ9'), 'no API key reached git');
});

test('a local scan puts back a config an earlier, killed run left parked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'va2-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = join(root, 'app');
  await mkdir(app);
  await writeFile(join(app, 'index.js'), 'export const x = 1;\n');
  await writeFile(join(app, '.vibe-audit.json.untrusted'), '{"ignore":[]}');

  await runScan(app, {
    outDir: join(root, 'runs'),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 2,
  });
  assert.ok(existsSync(join(app, '.vibe-audit.json')), 'config back under its own name');
  assert.ok(!existsSync(join(app, '.vibe-audit.json.untrusted')));
});
