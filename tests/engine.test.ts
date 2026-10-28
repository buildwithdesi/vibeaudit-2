import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runEngineScan } from '../src/engine/v1.ts';

const EVAL_LINE = 'export const run = (req) => eval(req.query.code);';

/** A repo that tries to hide two findings: one inline comment, one config ignore. */
async function hidingRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'va2-engine-'));
  await writeFile(join(dir, 'inline.js'), `${EVAL_LINE} // vibe-audit-ignore\n`, 'utf8');
  await mkdir(join(dir, 'hidden'));
  await writeFile(join(dir, 'hidden', 'app.js'), `${EVAL_LINE}\n`, 'utf8');
  await writeFile(join(dir, '.vibe-audit.json'), '{ "ignore": ["hidden"] }\n', 'utf8');
  return dir;
}

function evalFiles(output: Awaited<ReturnType<typeof runEngineScan>>['output']): string[] {
  return output.findings
    .filter((f) => f.ruleId === 'eval-usage')
    .map((f) => f.file.replaceAll('\\', '/'))
    .sort();
}

test('an untrusted repo cannot hide findings through its config or inline comments', async () => {
  const dir = await hidingRepo();
  const untrusted = await runEngineScan(dir);
  assert.deepEqual(evalFiles(untrusted.output), ['hidden/app.js', 'inline.js']);

  const trusted = await runEngineScan(dir, { trustTargetConfig: true });
  assert.deepEqual(evalFiles(trusted.output), []);
});
