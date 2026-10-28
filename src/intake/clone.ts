import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { scrubbedEnv } from '../util/env.ts';
import type { GitHubTarget } from './target.ts';

const run = promisify(execFile);

export class CloneError extends Error {
  override name = 'CloneError';
}

export interface CloneResult {
  dir: string;
  commit: string;
}

/**
 * Shallow-clone a public GitHub repository into `dest`.
 *
 * The clone is treated as hostile input. Nothing from it ever executes here:
 * hooks point at an empty folder, symlinks are not created, no credential
 * prompt can hang the run, and the URL always follows `--` so it can never be
 * read as a flag. The scan stage only reads files.
 */
export async function cloneGitHub(
  target: GitHubTarget,
  dest: string,
  options: { timeoutMs?: number } = {},
): Promise<CloneResult> {
  const timeout = options.timeoutMs ?? 120_000;
  await mkdir(noHooksDir(dest), { recursive: true });

  const env = cloneEnv();
  try {
    await run('git', cloneArgs(target, dest), {
      timeout,
      env,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new CloneError(`git clone of ${target.webUrl} failed: ${describe(error)}`);
  }

  const { stdout } = await run('git', ['-C', dest, 'rev-parse', 'HEAD'], {
    timeout: 15_000,
    env,
    windowsHide: true,
  });
  return { dir: dest, commit: stdout.trim() };
}

/** The full `git` argument list for the clone, kept pure so the hardening can be checked offline. */
export function cloneArgs(target: GitHubTarget, dest: string): string[] {
  const args = [
    '-c',
    `core.hooksPath=${noHooksDir(dest)}`,
    '-c',
    'core.symlinks=false',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.longpaths=true',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--no-tags',
    '--quiet',
  ];
  if (target.ref) args.push('--branch', target.ref);
  args.push('--', target.cloneUrl, dest);
  return args;
}

/** Scrubbed of keys and tokens, no credential prompt, no system-wide git config, no LFS downloads. */
export function cloneEnv(): NodeJS.ProcessEnv {
  return scrubbedEnv({ GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1' });
}

/** An empty hooks folder next to the clone. The patch stage points its own git calls at it too. */
function noHooksDir(dest: string): string {
  return join(dirname(dest), 'no-hooks');
}

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { stderr?: string; message?: string; killed?: boolean };
    if (e.killed) return 'timed out';
    const text = (e.stderr || e.message || '').trim();
    return text.split('\n').slice(-3).join(' ').slice(0, 400) || 'unknown error';
  }
  return String(error);
}
