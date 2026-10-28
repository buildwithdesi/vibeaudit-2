import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';

// The engine and every other child process get scrubbedEnv(), which points
// npm at empty config files in a temp folder. That folder used to outlive
// every process that created it.

function scratchDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'va2-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runChild(t: TestContext, scratch: string, body: string) {
  const env = resolve('src/util/env.ts');
  const code = `import(${JSON.stringify(env)}).then((m) => { ${body} });`;
  const child = spawn(process.execPath, ['-e', code], {
    env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // A failed assertion must not leave the child running and the test file hanging.
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  return child;
}

test('the empty npm config folder is removed when the process exits', async (t) => {
  const scratch = scratchDir(t);
  const child = runChild(
    t,
    scratch,
    "const env = m.scrubbedEnv(); console.log(require('node:fs').existsSync(env.npm_config_userconfig));",
  );
  let printed = '';
  child.stdout.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
  });
  const code = await new Promise((resolveExit) => child.on('exit', resolveExit));
  assert.equal(code, 0);
  assert.equal(printed.trim(), 'true', 'the config file existed while the process ran');
  assert.deepEqual(readdirSync(scratch), []);
});

// On Windows, kill() ends a process outright; no signal handler runs.
const NO_SIGNALS =
  process.platform === 'win32' ? 'kill() cannot deliver a catchable signal' : false;

test('the empty npm config folder is removed when the process is killed', {
  skip: NO_SIGNALS,
}, async (t) => {
  const scratch = scratchDir(t);
  const child = runChild(
    t,
    scratch,
    "m.scrubbedEnv(); console.log('ready'); setInterval(() => {}, 1000);",
  );
  await new Promise<void>((resolveReady) =>
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('ready')) resolveReady();
    }),
  );
  assert.equal(
    readdirSync(scratch).filter((name) => name.startsWith('va2-npmrc-')).length,
    1,
    'one folder exists while the process runs',
  );
  const exited = new Promise((resolveExit) =>
    child.on('exit', (_code, signal) => resolveExit(signal)),
  );
  child.kill('SIGTERM');
  assert.equal(await exited, 'SIGTERM', 'the process still dies by the signal');
  assert.deepEqual(readdirSync(scratch), []);
});
