import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { scrubbedEnv } from '../util/env.ts';

const run = promisify(execFile);

export interface TestRunResult {
  ran: boolean;
  passed: boolean;
  runner: 'docker' | 'local' | 'none';
  command: string;
  outputTail: string;
  durationMs: number;
}

/** Floating tag on purpose for the hackathon; pin a digest before any production use. */
const IMAGE = 'node:24-alpine';
const COPY_SKIP = new Set(['.git', 'node_modules']);

/**
 * Run the project's own test script after patching.
 *
 * Running a third-party repository's tests means running its code. The tests
 * run on a copy of the tree without `.git`, so nothing they write can reach a
 * later host-side git command. With Docker: install in one container with the
 * network on, then test in a second container with no network, no root, no
 * capabilities and a pid and memory cap. Without Docker, `--allow-local-tests`
 * runs them on this machine with a scrubbed environment.
 */
export async function runProjectTests(
  repoDir: string,
  options: { useDocker: boolean; allowLocal: boolean; timeoutMs?: number },
): Promise<TestRunResult> {
  const started = performance.now();
  const script = await testScript(repoDir);
  if (!script) {
    return result(false, false, 'none', '', 'no test script in package.json', started);
  }
  const timeout = options.timeoutMs ?? 10 * 60_000;
  const hasLockfile = existsSync(join(repoDir, 'package-lock.json'));
  const install = hasLockfile ? ['ci'] : ['install'];
  const installFlags = ['--ignore-scripts', '--no-audit', '--no-fund'];

  // Work on a copy with no .git and no node_modules.
  const work = mkdtempSync(join(tmpdir(), 'va2-tests-'));
  const copy = join(work, 'app');
  cpSync(repoDir, copy, {
    recursive: true,
    filter: (src) => !COPY_SKIP.has(src.split(/[\\/]/).pop() ?? ''),
  });

  try {
    if (options.useDocker && (await dockerAvailable())) {
      const name = `vibeaudit2-${Date.now().toString(36)}`;
      const mount = `type=bind,source=${copy},target=/work`;
      const hardened = [
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--pids-limit',
        '512',
        '--memory',
        '2g',
      ];
      const installArgs = [
        'run',
        '--rm',
        '--name',
        `${name}-install`,
        '--mount',
        mount,
        '-w',
        '/work',
        ...hardened,
        IMAGE,
        'npm',
        ...install,
        ...installFlags,
      ];
      const installResult = await capture(
        'docker',
        installArgs,
        timeout,
        undefined,
        `${name}-install`,
      );
      if (installResult.code !== 0) {
        return result(
          true,
          false,
          'docker',
          `docker ${installArgs.join(' ')}`,
          installResult.tail,
          started,
        );
      }
      const testArgs = [
        'run',
        '--rm',
        '--name',
        `${name}-test`,
        '--network',
        'none',
        '--mount',
        mount,
        '-w',
        '/work',
        '--user',
        'node',
        ...hardened,
        '--tmpfs',
        '/tmp',
        IMAGE,
        'npm',
        'test',
        '--silent',
      ];
      const testResult = await capture('docker', testArgs, timeout, undefined, `${name}-test`);
      return result(
        true,
        testResult.code === 0,
        'docker',
        `docker ${testArgs.join(' ')}`,
        testResult.tail,
        started,
      );
    }
    if (!options.allowLocal) {
      return result(
        false,
        false,
        'none',
        '',
        'tests skipped: Docker is not available and --allow-local-tests was not given',
        started,
      );
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (await hasDependencies(copy)) {
      const installResult = await capture(npm, [...install, ...installFlags], timeout, copy);
      if (installResult.code !== 0) {
        return result(
          true,
          false,
          'local',
          `npm ${install.join(' ')}`,
          installResult.tail,
          started,
        );
      }
    }
    const testResult = await capture(npm, ['test', '--silent'], timeout, copy);
    return result(true, testResult.code === 0, 'local', 'npm test', testResult.tail, started);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function result(
  ran: boolean,
  passed: boolean,
  runner: TestRunResult['runner'],
  command: string,
  outputTail: string,
  started: number,
): TestRunResult {
  return {
    ran,
    passed,
    runner,
    command,
    outputTail,
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
    await run('docker', ['info'], { windowsHide: true, timeout: 15_000, env: scrubbedEnv() });
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
  containerName?: string,
): Promise<{ code: number; tail: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, {
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      shell: process.platform === 'win32' && cmd.endsWith('.cmd'),
      ...(cwd ? { cwd } : {}),
      env: scrubbedEnv(),
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
    if (e.killed && containerName) {
      // The CLI client died on timeout; the container does not stop by itself.
      try {
        await run('docker', ['rm', '-f', containerName], {
          windowsHide: true,
          timeout: 30_000,
          env: scrubbedEnv(),
        });
      } catch {
        // Best effort.
      }
    }
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
