import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { scrubbedEnv } from '../util/env.ts';

const run = promisify(execFile);

/**
 * Git helpers scoped to one working tree, always the pipeline's own copy and
 * never the user's checkout. Hooks are disabled through an empty hooks
 * folder, signing is off, and the tree's own config cannot point git at an
 * external diff or filter program.
 */
async function hooksDir(repoDir: string): Promise<string> {
  const dir = join(repoDir, '..', 'no-hooks');
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function git(repoDir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const safety = [
    '-c',
    `core.hooksPath=${await hooksDir(repoDir)}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'user.name=vibeaudit2',
    '-c',
    'user.email=vibeaudit2@localhost',
  ];
  const { stdout } = await run('git', ['-C', repoDir, ...safety, ...args], {
    env: scrubbedEnv({ GIT_CONFIG_NOSYSTEM: '1' }),
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    const top = (await git(repoDir, ['rev-parse', '--show-toplevel'])).trim().replace(/\\/g, '/');
    return top.toLowerCase() === repoDir.replace(/\\/g, '/').toLowerCase();
  } catch {
    return false;
  }
}

/** The pipeline's copy may not be a repository yet (local targets are copied in). Make it one. */
export async function ensureRepo(repoDir: string): Promise<void> {
  if (await isGitRepo(repoDir)) return;
  await git(repoDir, ['init', '-q']);
  await git(repoDir, ['add', '-A']);
  await git(repoDir, ['commit', '-q', '--no-verify', '-m', 'vibeaudit2: snapshot before patching']);
}

export async function createBranch(repoDir: string, name: string): Promise<void> {
  await git(repoDir, ['checkout', '-q', '-B', name]);
}

export async function commitAll(repoDir: string, message: string): Promise<string | null> {
  await git(repoDir, ['add', '-A']);
  const status = await git(repoDir, ['status', '--porcelain']);
  if (!status.trim()) return null;
  await git(repoDir, ['commit', '-q', '--no-verify', '-m', message]);
  return (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
}

export async function changedFiles(repoDir: string, ref: string): Promise<string[]> {
  const out = await git(repoDir, ['diff', '--no-ext-diff', '--name-only', ref]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function diffAgainst(repoDir: string, ref: string): Promise<string> {
  return git(repoDir, ['diff', '--no-ext-diff', '--no-color', ref]);
}

export async function checkout(repoDir: string, ref: string): Promise<void> {
  await git(repoDir, ['checkout', '-q', ref]);
}
