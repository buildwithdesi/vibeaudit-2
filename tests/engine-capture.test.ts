import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { listEngineRules, runEngineScan } from '../src/engine/v1.ts';

// The v1 bin exits right after printing. Read through a pipe on Linux, the
// tail of its output was lost whenever the pipe was not drained in time:
// the rule list came back short under load, and any scan whose JSON passed
// about 145 KB failed to parse.

test('the rule list arrives whole under concurrent calls', async () => {
  const expected = (await listEngineRules()).length;
  const counts = (await Promise.all(Array.from({ length: 12 }, () => listEngineRules()))).map(
    (rules) => rules.length,
  );
  assert.deepEqual(
    counts,
    counts.map(() => expected),
    `rule counts differ from a single call (${expected}): ${counts.join(', ')}`,
  );
});

test('a scan whose JSON is far larger than a pipe buffer still parses', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'va2-big-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copies = 40;
  for (let i = 0; i < copies; i++) {
    cpSync(resolve('examples/seeded-app/routes'), join(dir, `copy${i}`), { recursive: true });
  }

  const { output } = await runEngineScan(dir, {});
  assert.ok(
    JSON.stringify(output, null, 2).length > 200_000,
    'the engine JSON is over 200 KB, so it cannot fit in one pipe buffer',
  );
  const perCopy = output.findings.filter((f) => f.file.startsWith('copy0/')).length;
  assert.ok(perCopy > 0, 'each copy has findings');
  assert.equal(output.findings.length, perCopy * copies, 'every copy reported in full');
});

test('failed and timed-out runs reject cleanly and leave no capture files', async (t) => {
  // A private temp folder, so other test files running in parallel cannot interfere.
  const scratch = mkdtempSync(join(tmpdir(), 'va2-capture-'));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  for (const key of Object.keys(saved)) process.env[key] = scratch;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  await listEngineRules();
  await assert.rejects(runEngineScan(join(scratch, 'missing'), {}), /exited with code 2/);
  await assert.rejects(
    runEngineScan(resolve('examples/seeded-app'), { timeoutMs: 1 }),
    /timed out/,
  );
  // The killed child still closes after the timeout; that must not touch removed files.
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.deepEqual(
    readdirSync(scratch).filter((name) => name.startsWith('va2-engine-')),
    [],
  );
});
