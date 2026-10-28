import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scrubbedEnv } from '../src/util/env.ts';

/**
 * The CLI as a user runs it: `node src/cli.ts` in a child process, from an
 * empty folder (so no .env is picked up) with a scrubbed environment and no
 * API key. No test here can reach a model API: where a key is needed to get
 * past a check, it is a dummy pointed at a host that never resolves.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.ts');
const SEEDED = join(ROOT, 'examples', 'seeded-app');
const UNREACHABLE = { META_API_KEY: 'dummy', META_BASE_URL: 'https://meta.invalid/v1' };

let work = '';
let baseRun = '';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(
  args: string[],
  extraEnv: Record<string, string> = {},
  cwd = work,
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: scrubbedEnv({ HOME: work, USERPROFILE: work, ...extraEnv }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/** A private copy of the scanned run, so tests never see each other's prompts or records. */
function freshRun(name: string): string {
  const dest = join(work, 'copies', name);
  cpSync(baseRun, dest, { recursive: true });
  return dest;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function promptNames(runDir: string): string[] {
  const dir = join(runDir, 'prompts');
  return existsSync(dir) ? readdirSync(dir) : [];
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'va2-cli-'));
  const scan = await cli(['scan', SEEDED, '--out', join(work, 'runs'), '--quiet']);
  assert.equal(scan.code, 0, scan.stderr);
  const runs = readdirSync(join(work, 'runs'));
  assert.equal(runs.length, 1);
  baseRun = join(work, 'runs', runs[0] as string);
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test('--help exits 0; no command or an unknown one exits 2 with the usage', async () => {
  const help = await cli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /vibeaudit2 <command>/);

  const scanHelp = await cli(['scan', '--help']);
  assert.equal(scanHelp.code, 0);

  const bare = await cli([]);
  assert.equal(bare.code, 2);
  assert.match(bare.stdout, /vibeaudit2 <command>/);

  const unknown = await cli(['bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command "bogus"/);
});

test('version prints the tool version and the engine version', async () => {
  const tool = readJson(join(ROOT, 'package.json')).version as string;
  const engine = readJson(join(ROOT, 'node_modules', '@jackdog668', 'vibeaudit', 'package.json'))
    .version as string;
  const result = await cli(['version']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, `vibeaudit-2 ${tool} (engine ${engine})\n`);
});

test('a URL outside github.com is refused as such, not as a missing folder', async () => {
  for (const target of ['https://gitlab.com/a/b', 'ssh://git@github.example/a/b']) {
    const out = join(work, 'not-github');
    const result = await cli(['audit', target, '--out', out]);
    assert.equal(result.code, 2, target);
    assert.match(result.stderr, /Only GitHub repositories can be cloned/);
    assert.doesNotMatch(result.stderr, /Folder not found/);
    assert.equal(existsSync(out), false, 'no run folder for a refused target');
  }
});

test('reason without a key exits 1 and says how to fix it; --dry-run needs no key', async () => {
  const runDir = freshRun('reason');
  const live = await cli(['reason', runDir]);
  assert.equal(live.code, 1);
  assert.match(live.stderr, /No reasoning model configured\. Set META_API_KEY/);

  const dry = await cli(['reason', runDir, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.ok(promptNames(runDir).some((name) => name.startsWith('exploit-')));
  assert.ok(existsSync(join(runDir, 'reasoning.dry-run.json')));
  assert.equal(
    existsSync(join(runDir, 'reasoning.json')),
    false,
    'a dry run never writes a live record',
  );
});

test('report writes report.md, and refuses a folder that is not a run', async () => {
  const runDir = freshRun('report');
  const result = await cli(['report', runDir]);
  assert.equal(result.code, 0, result.stderr);
  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  assert.ok(!report.includes('Winter2026Prod'));

  const notRun = await cli(['report', work]);
  assert.equal(notRun.code, 1);
  assert.match(notRun.stderr, /is not a run folder \(no manifest\.json\)/);
});

test('a .env in the working folder is read, and never overrides the environment', async () => {
  const cwd = join(work, 'dotenv');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, '.env'), 'META_API_KEY=dummy\nMETA_REASON_MODEL=muse-spark-1.2\n');

  const fromFile = freshRun('dotenv-file');
  const loaded = await cli(['reason', fromFile, '--dry-run', '--quiet'], {}, cwd);
  assert.equal(loaded.code, 0, loaded.stderr);
  const loadedModels = readJson(join(fromFile, 'reasoning.dry-run.json')).models;
  assert.deepEqual(loadedModels, { reason: 'muse-spark-1.2', triage: null });

  const fromShell = freshRun('dotenv-shell');
  const kept = await cli(
    ['reason', fromShell, '--dry-run', '--quiet'],
    { META_REASON_MODEL: 'muse-spark-1.3' },
    cwd,
  );
  assert.equal(kept.code, 0, kept.stderr);
  const keptModels = readJson(join(fromShell, 'reasoning.dry-run.json')).models;
  assert.deepEqual(keptModels, { reason: 'muse-spark-1.3', triage: null });
});

test('a Contributor-tier model or a plain-http endpoint is refused', async () => {
  const runDir = freshRun('refused');
  const contributor = await cli(['reason', runDir, '--dry-run'], {
    META_API_KEY: 'dummy',
    META_REASON_MODEL: 'muse-spark-1.3-contributor',
  });
  assert.equal(contributor.code, 1);
  assert.match(contributor.stderr, /Contributor-tier model/);

  const http = await cli(['reason', runDir, '--dry-run'], {
    META_API_KEY: 'dummy',
    META_BASE_URL: 'http://meta.invalid/v1',
  });
  assert.equal(http.code, 1);
  assert.match(http.stderr, /META_BASE_URL must start with https:\/\//);
});

test('--no-triage skips triage even when TRIAGE_* is configured', async () => {
  const triageEnv = {
    TRIAGE_BASE_URL: 'https://triage.invalid/v1',
    TRIAGE_API_KEY: 'dummy',
    TRIAGE_MODEL: 'meta/muse-glimmer-30b',
  };
  const withTriage = freshRun('triage-on');
  const on = await cli(['reason', withTriage, '--dry-run', '--quiet'], triageEnv);
  assert.equal(on.code, 0, on.stderr);
  assert.ok(promptNames(withTriage).some((name) => name.startsWith('triage-')));

  const withoutTriage = freshRun('triage-off');
  const off = await cli(
    ['reason', withoutTriage, '--dry-run', '--no-triage', '--quiet'],
    triageEnv,
  );
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(
    promptNames(withoutTriage).filter((name) => name.startsWith('triage-')),
    [],
  );
  const record = readJson(join(withoutTriage, 'reasoning.dry-run.json'));
  assert.deepEqual(record.models, { reason: null, triage: null });
});

test('an unknown --classes value is refused before a scan or any model call', async () => {
  const runDir = freshRun('classes');
  const manifestBefore = readFileSync(join(runDir, 'manifest.json'), 'utf8');

  const reason = await cli(['reason', runDir, '--classes', 'sqli,secrets'], UNREACHABLE);
  assert.equal(reason.code, 2);
  assert.match(reason.stderr, /Unknown --classes value: sqli\./);
  assert.match(reason.stderr, /sql-injection/, 'the valid ids are listed');
  assert.equal(existsSync(join(runDir, 'reasoning.json')), false);
  assert.equal(readFileSync(join(runDir, 'manifest.json'), 'utf8'), manifestBefore);

  const patch = await cli(['patch', runDir, '--classes', 'sqli'], UNREACHABLE);
  assert.equal(patch.code, 2);
  assert.match(patch.stderr, /Unknown --classes value: sqli\./);
  assert.equal(existsSync(join(runDir, 'patch.json')), false);

  const out = join(work, 'audit-classes');
  const audit = await cli(['audit', SEEDED, '--out', out, '--classes', 'sqli'], UNREACHABLE);
  assert.equal(audit.code, 2);
  assert.match(audit.stderr, /Unknown --classes value: sqli\./);
  assert.equal(existsSync(out), false, 'audit refuses the flag before it scans');

  const empty = await cli(['reason', runDir, '--classes', ','], UNREACHABLE);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /--classes needs at least one class/);

  const valid = await cli(['reason', runDir, '--classes', 'secrets', '--dry-run', '--quiet']);
  assert.equal(valid.code, 0, valid.stderr);
  const record = readJson(join(runDir, 'reasoning.dry-run.json'));
  assert.deepEqual(record.classes, ['secrets']);
});

test('a bad --effort fails audit before it scans', async () => {
  const runDir = freshRun('effort');
  const reason = await cli(['reason', runDir, '--effort', 'turbo']);
  assert.equal(reason.code, 2);
  assert.match(reason.stderr, /--effort must be one of/);

  const out = join(work, 'audit-effort');
  const audit = await cli(['audit', SEEDED, '--out', out, '--effort', 'turbo']);
  assert.equal(audit.code, 2);
  assert.match(audit.stderr, /--effort must be one of/);
  assert.equal(existsSync(out), false);
});

test('audit without a key still writes the report, and says reasoning was skipped', async () => {
  const out = join(work, 'audit-nokey');
  const result = await cli(['audit', SEEDED, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /warning: No META_API_KEY/);
  const runs = readdirSync(out);
  assert.equal(runs.length, 1);
  const runDir = join(out, runs[0] as string);
  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  assert.ok(!report.includes('Winter2026Prod'), 'the report never carries the planted password');
  assert.equal(existsSync(join(runDir, 'reasoning.json')), false);
});

test('patch without a backend says what is missing instead of NOT GREEN', async () => {
  const runDir = freshRun('patch-nokey');
  const result = await cli(['patch', runDir]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /No patch backend\. Set META_API_KEY/);
  assert.doesNotMatch(result.stderr, /NOT GREEN|still flagged/);
  assert.equal(existsSync(join(runDir, 'patch.json')), false, 'nothing was attempted');

  // An empty PATH means no muse binary, wherever this test runs.
  const emptyPath = join(work, 'empty-path');
  mkdirSync(emptyPath, { recursive: true });
  const muse = await cli(['patch', runDir, '--backend', 'muse-code'], { PATH: emptyPath });
  assert.equal(muse.code, 1);
  assert.match(muse.stderr, /muse CLI not found on PATH/);
  assert.equal(existsSync(join(runDir, 'patch.json')), false);

  const dry = await cli(['patch', runDir, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /warning: No patch backend/);
});

test('patch prints why the project tests did not run', {
  skip: process.platform === 'win32' && 'the fake muse is a POSIX shell script',
}, async () => {
  const runDir = freshRun('patch-tests');
  // A stand-in for Muse Code that edits one file the patch loop is allowed to change.
  const bin = join(work, 'fake-muse');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'muse'),
    '#!/bin/sh\necho "// reviewed" >> server/config.js\necho \'{"type":"done"}\'\n',
  );
  chmodSync(join(bin, 'muse'), 0o755);
  const result = await cli(
    ['patch', runDir, '--backend', 'muse-code', '--run-tests', '--no-docker'],
    { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  );
  assert.equal(result.code, 1, 'tests that never ran can never be green');
  assert.match(
    result.stderr,
    /warning: project tests not run: tests skipped: Docker is not available and --allow-local-tests was not given/,
  );
  const record = readJson(join(runDir, 'patch.json'));
  assert.equal(record.backend, 'muse-code');
  assert.ok(record.patchCommit, 'the fake agent edit was committed');
});
