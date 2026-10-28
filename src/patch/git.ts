import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { scrubbedEnv } from '../util/env.ts';

const run = promisify(execFile);

/**
 * Git helpers scoped to one working tree, always the pipeline's own copy and
 * never the user's checkout. Hooks are disabled, signing is off, and the
 * tree's own config cannot point git at an external diff or filter program.
 *
 * The hooks path is a regular file, this node binary, so no `<path>/<hook>`
 * can ever exist. A hooks folder next to the copy could be filled by
 * anything that writes there, such as a coding agent, and `--no-verify` does
 * not skip post-commit, post-checkout or reference-transaction hooks.
 */
const NO_HOOKS = process.execPath;

export async function git(repoDir: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const safety = [
    '-c',
    `core.hooksPath=${NO_HOOKS}`,
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

/**
 * True when the folder is the top of its own work tree, not a folder inside
 * some other repository. Asked relative to the folder, so a path through a
 * symlink (a run folder under macOS /tmp) gives the same answer.
 */
export async function isGitRepo(repoDir: string): Promise<boolean> {
  try {
    return (await git(repoDir, ['rev-parse', '--show-cdup'])).trim() === '';
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

/**
 * What the working tree changed since `ref`: tracked files that differ, and
 * every untracked file, gitignored ones included, so a planted .gitignore
 * cannot hide a new file. Names are read NUL-separated, so none comes back
 * quoted.
 */
export async function changedFiles(
  repoDir: string,
  ref: string,
): Promise<{ tracked: string[]; untracked: string[] }> {
  const tracked = await git(repoDir, [
    'diff',
    '--no-ext-diff',
    '--no-renames',
    '--name-only',
    '-z',
    ref,
  ]);
  return { tracked: nulList(tracked), untracked: await untrackedFiles(repoDir) };
}

/** Every untracked file, gitignored ones included. */
export async function untrackedFiles(repoDir: string): Promise<string[]> {
  return nulList(await git(repoDir, ['ls-files', '--others', '-z']));
}

function nulList(out: string): string[] {
  return out.split('\0').filter(Boolean);
}

export async function diffAgainst(repoDir: string, ref: string): Promise<string> {
  return git(repoDir, ['diff', '--no-ext-diff', '--no-color', ref]);
}

export async function checkout(repoDir: string, ref: string): Promise<void> {
  await git(repoDir, ['checkout', '-q', ref]);
}
