import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scrubbedEnv } from '../src/util/env.ts';

/**
 * The package bin is dist/cli.js, not src/cli.ts. This builds dist with the
 * real build config, then runs the built CLI the way an installed
 * `vibeaudit2` would: scrubbed environment, no API key, an empty folder as
 * the working directory. Any file the source reads at runtime but the build
 * leaves out shows up here as a crash.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'dist', 'cli.js');
const SEEDED = join(ROOT, 'examples', 'seeded-app');

let work = '';

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function bin(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: work,
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

function onlyRun(out: string): string {
  const runs = readdirSync(out);
  assert.equal(runs.length, 1);
  return join(out, runs[0] as string);
}

before(() => {
  // Same command as `npm run build`, without depending on npm being on PATH.
  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  work = mkdtempSync(join(tmpdir(), 'va2-dist-'));
});

after(() => {
  if (work) rmSync(work, { recursive: true, force: true });
});

test('the build ships every runtime data file next to the code that reads it', () => {
  assert.ok(existsSync(join(ROOT, 'dist', 'reason', 'rates.json')));
});

test('the built CLI prints help and versions', async () => {
  const help = await bin(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /vibeaudit2 <command>/);

  const version = await bin(['version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^vibeaudit-2 \S+ \(engine \d+\.\d+\.\d+\)\n$/);
});

test('the built CLI scans, reasons in a dry run, reports, and plans a patch', async () => {
  const out = join(work, 'runs');
  const scan = await bin(['scan', SEEDED, '--out', out, '--quiet']);
  assert.equal(scan.code, 0, scan.stderr);
  const runDir = onlyRun(out);

  const live = await bin(['reason', runDir]);
  assert.equal(live.code, 1);
  assert.match(live.stderr, /No reasoning model configured/);

  const dry = await bin(['reason', runDir, '--dry-run']);
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stderr, /dry run: \d+ prompts written/);

  const report = await bin(['report', runDir]);
  assert.equal(report.code, 0, report.stderr);
  assert.ok(existsSync(join(runDir, 'report.md')));

  // A dummy key on a host that never resolves: enough to pick the api backend, no call is made.
  const plan = await bin(['patch', runDir, '--dry-run'], {
    META_API_KEY: 'dummy',
    META_BASE_URL: 'https://meta.invalid/v1',
  });
  assert.equal(plan.code, 0, plan.stderr);
  assert.match(plan.stderr, /would be patched with the api backend/);
});

test('the built CLI runs a dry-run audit through to the report', async () => {
  const out = join(work, 'audit');
  const audit = await bin(['audit', SEEDED, '--out', out, '--dry-run', '--quiet']);
  assert.equal(audit.code, 0, audit.stderr);
  const runDir = onlyRun(out);
  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  assert.ok(!report.includes('Winter2026Prod'));
});
