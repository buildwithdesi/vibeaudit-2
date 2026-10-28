import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
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
import { join } from 'node:path';
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

test('no command or an unknown one exits 2 with the usage', async () => {
  const bare = await cli([]);
  assert.equal(bare.code, 2);
  assert.match(bare.stdout, /vibeaudit2 <command>/);

  const unknown = await cli(['bogus']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown command "bogus"/);
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
