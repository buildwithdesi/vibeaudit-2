import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RunManifest } from '../src/model/finding.ts';
import { assertRuleListComplete, runScan } from '../src/pipeline/run.ts';
import { topClasses } from '../src/report/summary.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

test('scans the seeded app end to end and finds all five planted classes', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'va2-run-'));
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
