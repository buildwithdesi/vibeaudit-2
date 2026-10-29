import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { scrubbedEnv } from '../util/env.ts';
import { info } from '../util/log.ts';
import type { GitHubTarget } from './target.ts';

const run = promisify(execFile);

export class CloneError extends Error {
  override name = 'CloneError';
}

export interface CloneResult {
  dir: string;
  commit: string;
  /** The branch or tag that was cloned, null for the default branch. */
  ref: string | null;
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
  let ref = target.ref;
  try {
    ref = await resolveRef(target, dest, env, timeout);
    await run('git', cloneArgs({ ...target, ref }, dest), {
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
  return { dir: dest, commit: stdout.trim(), ref };
}

/**
 * A /tree/ or /blob/ URL does not say where the branch ends and the folder
 * path starts: ".../tree/main/src" is branch "main" and folder "src", while
 * ".../tree/release/1.3" is branch "release/1.3". GitHub decides by looking at
 * the repository's refs, and so does this: the longest leading part that is a
 * real branch or tag wins. If none is, git reports the ref as asked for. The
 * whole repository is cloned and scanned either way.
 */
async function resolveRef(
  target: GitHubTarget,
  dest: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Promise<string | null> {
  const ref = target.ref;
  if (!ref?.includes('/')) return ref;
  const parts = ref.split('/');
  const candidates = parts.map((_, i) => parts.slice(0, parts.length - i).join('/'));
  const patterns = candidates.flatMap((name) => [`refs/heads/${name}`, `refs/tags/${name}`]);
  const { stdout } = await run(
    'git',
    [...hardening(dest), 'ls-remote', '--heads', '--tags', '--', target.cloneUrl, ...patterns],
    { timeout, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const found = new Set(
    stdout.split('\n').map((line) => line.split('\t')[1]?.replace(/^refs\/(?:heads|tags)\//, '')),
  );
  const match = candidates.find((name) => found.has(name));
  if (!match) return ref;
  if (match !== ref)
    info(`"${ref}" is ref "${match}" plus a path; the whole repository is scanned`);
  return match;
}

/** The full `git` argument list for the clone, kept pure so the hardening can be checked offline. */
export function cloneArgs(target: GitHubTarget, dest: string): string[] {
  const args = [
    ...hardening(dest),
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

/** Config for every git call that talks to the remote: no hooks, no symlinks, https only. */
function hardening(dest: string): string[] {
  return [
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
  ];
}

/** Scrubbed of keys and tokens, no credential prompt, no system-wide git config, no LFS downloads. */
export function cloneEnv(): NodeJS.ProcessEnv {
  return scrubbedEnv({ GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_NOSYSTEM: '1' });
}

/**
 * An empty hooks folder next to the clone, for the clone's own git calls. The
 * patch stage does not use it: src/patch/git.ts points core.hooksPath at a file.
 */
function noHooksDir(dest: string): string {
  return join(dirname(dest), 'no-hooks');
}

function describe(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { stderr?: string; message?: string; killed?: boolean };
    if (e.killed) return 'timed out';
    const text = (e.stderr || e.message || '').trim();
    // GitHub answers 401 to an anonymous clone of a private or missing repository, and prompts are off.
    if (/could not read Username|Authentication failed|Repository not found/i.test(text)) {
      return 'the repository is private or does not exist. Only public repositories can be cloned.';
    }
    return text.split('\n').slice(-3).join(' ').slice(0, 400) || 'unknown error';
  }
  return String(error);
}
