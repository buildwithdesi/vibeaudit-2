import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TestRunResult {
  ran: boolean;
  passed: boolean;
  runner: 'docker' | 'local' | 'none';
  command: string;
  outputTail: string;
  durationMs: number;
}

/**
 * Run the project's own test script after patching.
 *
 * Running a third-party repository's tests means running its code. With
 * Docker available the tests run in a throwaway container with the clone
 * mounted; without it, only `--allow-local-tests` lets them run on this
 * machine. The seeded demo app is our own code, so local is fine there.
 */
export async function runProjectTests(
  repoDir: string,
  options: { useDocker: boolean; allowLocal: boolean; timeoutMs?: number },
): Promise<TestRunResult> {
  const started = performance.now();
  const script = await testScript(repoDir);
  if (!script) {
    return {
      ran: false,
      passed: false,
      runner: 'none',
      command: '',
      outputTail: 'no test script in package.json',
      durationMs: 0,
    };
  }
  const timeout = options.timeoutMs ?? 10 * 60_000;
  const hasLockfile = existsSync(join(repoDir, 'package-lock.json'));
  const install = hasLockfile
    ? 'npm ci --ignore-scripts --no-audit --no-fund'
    : 'npm install --ignore-scripts --no-audit --no-fund';

  if (options.useDocker && (await dockerAvailable())) {
    const command = `${install} && npm test`;
    const args = [
      'run',
      '--rm',
      '-v',
      `${repoDir}:/work`,
      '-w',
      '/work',
      'node:24-alpine',
      'sh',
      '-c',
      command,
    ];
    const result = await capture('docker', args, timeout);
    return {
      ran: true,
      passed: result.code === 0,
      runner: 'docker',
      command: `docker ${args.join(' ')}`,
      outputTail: result.tail,
      durationMs: Math.round(performance.now() - started),
    };
  }
  if (!options.allowLocal) {
    return {
      ran: false,
      passed: false,
      runner: 'none',
      command: '',
      outputTail: 'tests skipped: no Docker and local runs are not allowed for this target',
      durationMs: 0,
    };
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const needsInstall =
    existsSync(join(repoDir, 'package.json')) &&
    !existsSync(join(repoDir, 'node_modules')) &&
    (await hasDependencies(repoDir));
  if (needsInstall) {
    const installResult = await capture(npm, install.split(' ').slice(1), timeout, repoDir);
    if (installResult.code !== 0) {
      return {
        ran: true,
        passed: false,
        runner: 'local',
        command: install,
        outputTail: installResult.tail,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }
  const result = await capture(npm, ['test', '--silent'], timeout, repoDir);
  return {
    ran: true,
    passed: result.code === 0,
    runner: 'local',
    command: 'npm test',
    outputTail: result.tail,
    durationMs: Math.round(performance.now() - started),
  };
}

async function testScript(repoDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.test;
    if (!script || /no test specified/i.test(script)) return null;
    return script;
  } catch {
    return null;
  }
}

async function hasDependencies(repoDir: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf8')) as {
      dependencies?: object;
      devDependencies?: object;
    };
    return (
      Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length > 0
    );
  } catch {
    return false;
  }
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await run('docker', ['info'], { windowsHide: true, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function capture(
  cmd: string,
  args: string[],
  timeout: number,
  cwd?: string,
): Promise<{ code: number; tail: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { code: 0, tail: tail(`${stdout}\n${stderr}`) };
  } catch (error) {
    const e = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
      killed?: boolean;
    };
    const code = typeof e.code === 'number' ? e.code : 1;
    return {
      code: e.killed ? 124 : code,
      tail: tail(`${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`),
    };
  }
}

function tail(text: string, lines = 40): string {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}
