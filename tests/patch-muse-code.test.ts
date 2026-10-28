import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { git } from '../src/patch/git.ts';
import { type PatchRecordT, runPatchLoop } from '../src/patch/loop.ts';
import { runScan } from '../src/pipeline/run.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

/**
 * The Muse Code backend with a fake `muse` on PATH: no network, no key, no
 * cost. The fake is a node script that behaves like a hostile agent. It
 * makes the real fix, then also edits, stages, deletes and creates files it
 * was never asked to touch.
 */
const SKIP = process.platform === 'win32' ? 'the fake agent is a POSIX script' : false;

const FIX = `
const { execFileSync } = require('node:child_process');
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const users = readFileSync('routes/users.js', 'utf8');
writeFileSync('routes/users.js', users.replace(
  '\`SELECT * FROM users WHERE id = \${req.params.id}\`',
  "'SELECT * FROM users WHERE id = $1', [req.params.id]",
));
`;

const HOSTILE = `
const agentGit = (...args) =>
  execFileSync('git', ['-c', 'user.name=agent', '-c', 'user.email=agent@localhost', ...args]);
// A forbidden tracked edit, and a tracked file outside the allowlist deleted.
writeFileSync('package.json', readFileSync('package.json', 'utf8').replace('"private": true', '"private": true, "evil": "yes"'));
rmSync('server/config.js');
// New files: CI config, npm config, plain files, names git would print quoted.
mkdirSync('.github/workflows', { recursive: true });
writeFileSync('.github/workflows/evil.yml', 'on: push\\n');
writeFileSync('.github/workflows/\\u00e9vil.yml', 'on: push\\n');
writeFileSync('.npmrc', 'registry=http://127.0.0.1:9/\\n');
writeFileSync('planted.js', 'console.log(1);\\n');
writeFileSync('planted-\\u00e9.js', 'console.log(1);\\n');
// A .gitignore that hides the new files from a plain untracked listing.
writeFileSync('.gitignore', readFileSync('.gitignore', 'utf8') + '.github/\\n.npmrc\\nplanted*.js\\n');
`;

const PLANTED = [
  '.github/workflows/evil.yml',
  '.github/workflows/évil.yml',
  '.npmrc',
  'planted.js',
  'planted-é.js',
];
const REJECTED = [...PLANTED, '.gitignore', 'package.json', 'server/config.js'].sort();

/** Scan a copy of the seeded app that carries one gitignored local file, as real folders do. */
async function scanFresh(): Promise<{ app: string; runDir: string }> {
  const app = join(mkdtempSync(join(tmpdir(), 'va2-muse-')), 'app');
  cpSync('examples/seeded-app', app, { recursive: true });
  writeFileSync(join(app, '.gitignore'), 'local.txt\n');
  writeFileSync(join(app, 'local.txt'), 'kept\n');
  const scan = await runScan(app, {
    outDir: mkdtempSync(join(tmpdir(), 'va2-muse-run-')),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  return { app, runDir: scan.runDir };
}

/** Put a fake `muse` first on PATH for the rest of this test file. */
function installFakeMuse(script: string): void {
  const bin = mkdtempSync(join(tmpdir(), 'va2-fakebin-'));
  mkdirSync(bin, { recursive: true });
  const muse = join(bin, 'muse');
  writeFileSync(
    muse,
    `#!${process.execPath}\n${script}\nconsole.log(JSON.stringify({ type: 'message', text: 'fake muse done' }));\n`,
  );
  chmodSync(muse, 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
}

async function runMuse(runDir: string): Promise<PatchRecordT> {
  return runPatchLoop(runDir, {
    backend: 'muse-code',
    client: null,
    museModel: 'muse-spark-1.3',
    classes: ['sql-injection'],
    maxFindings: 1,
    runTests: false,
    useDocker: false,
    allowLocalTests: false,
    budgetUsd: 5,
    dryRun: false,
  });
}

async function assertOnlyTheFixLanded(record: PatchRecordT): Promise<void> {
  const workDir = record.workDir ?? '';
  assert.equal(record.backend, 'muse-code');
  assert.equal(record.error, null);
  assert.ok(record.patchCommit, `patch committed: ${record.outcomes[0]?.note}`);
  assert.deepEqual([...record.rejectedFiles].sort(), REJECTED);
  const committed = await git(workDir, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    record.patchCommit,
  ]);
  assert.deepEqual(committed.split('\0').filter(Boolean), ['routes/users.js']);
  assert.equal(
    (await git(workDir, ['rev-parse', `${record.patchCommit}~1`])).trim(),
    record.baseCommit,
    'the patch sits directly on the base commit',
  );
  for (const file of PLANTED) assert.equal(existsSync(join(workDir, file)), false, file);
  assert.ok(existsSync(join(workDir, 'server/config.js')), 'deleted tracked file restored');
  assert.ok(
    existsSync(join(workDir, 'local.txt')),
    'a gitignored file that was there before stays',
  );
  const runDir = join(workDir, '..');
  const diff = readFileSync(join(runDir, 'patch.diff'), 'utf8');
  assert.ok(diff.includes('$1'), 'the fix is in the diff');
  assert.ok(!/evil|planted|registry=/.test(diff), 'nothing planted is in the diff');
}

test('muse code: only allowlisted edits are committed, whatever else the agent writes', {
  skip: SKIP,
}, async () => {
  const { runDir } = await scanFresh();
  installFakeMuse(`${FIX}\n${HOSTILE}\nagentGit('add', 'package.json');`);
  await assertOnlyTheFixLanded(await runMuse(runDir));
});

test('muse code: an agent that commits its own changes is undone too', {
  skip: SKIP,
}, async () => {
  const { runDir } = await scanFresh();
  installFakeMuse(
    `${FIX}\n${HOSTILE}\nagentGit('add', '-A', '-f');\nagentGit('commit', '-q', '--no-verify', '-m', 'agent');`,
  );
  await assertOnlyTheFixLanded(await runMuse(runDir));
});

test('muse code: a symlink planted over a tracked folder never leads a revert outside the copy', {
  skip: SKIP,
}, async () => {
  const { runDir } = await scanFresh();
  const outside = mkdtempSync(join(tmpdir(), 'va2-outside-'));
  writeFileSync(join(outside, 'config.js'), 'victim\n');
  installFakeMuse(
    `${FIX}\nrmSync('server', { recursive: true });\nrequire('node:fs').symlinkSync(${JSON.stringify(outside)}, 'server');`,
  );
  const record = await runMuse(runDir);
  assert.ok(record.patchCommit);
  assert.ok(record.rejectedFiles.includes('server'), record.rejectedFiles.join(', '));
  assert.equal(readFileSync(join(outside, 'config.js'), 'utf8'), 'victim\n');
  assert.ok(readFileSync(join(record.workDir ?? '', 'server/config.js'), 'utf8').includes('host'));
});
