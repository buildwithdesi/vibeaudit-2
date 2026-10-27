import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

/** Git helpers scoped to one working tree. Every command runs with an explicit -C. */
export async function git(repoDir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await run('git', ['-C', repoDir, ...args], {
    env: ENV,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    await git(repoDir, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** Local folders scanned in place may not be repositories; the patch loop needs one for the sandbox branch. */
export async function ensureRepo(repoDir: string): Promise<void> {
  if (await isGitRepo(repoDir)) return;
  await git(repoDir, ['init', '-q']);
  await git(repoDir, ['add', '-A']);
  await git(repoDir, [
    '-c',
    'user.name=vibeaudit2',
    '-c',
    'user.email=vibeaudit2@localhost',
    'commit',
    '-q',
    '-m',
    'vibeaudit2: snapshot before patching',
  ]);
}

export async function createBranch(repoDir: string, name: string): Promise<void> {
  await git(repoDir, ['checkout', '-q', '-b', name]);
}

export async function commitAll(repoDir: string, message: string): Promise<string | null> {
  await git(repoDir, ['add', '-A']);
  const status = await git(repoDir, ['status', '--porcelain']);
  if (!status.trim()) return null;
  await git(repoDir, [
    '-c',
    'user.name=vibeaudit2',
    '-c',
    'user.email=vibeaudit2@localhost',
    'commit',
    '-q',
    '-m',
    message,
  ]);
  return (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
}

export async function diffAgainst(repoDir: string, ref: string): Promise<string> {
  return git(repoDir, ['diff', '--no-color', ref]);
}

export async function restore(repoDir: string): Promise<void> {
  await git(repoDir, ['checkout', '-q', '--', '.']);
  await git(repoDir, ['clean', '-q', '-fd']);
}
