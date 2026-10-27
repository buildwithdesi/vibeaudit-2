import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

/**
 * A scan target is either a GitHub repository or a folder on this machine.
 * Parsing is strict on purpose: the owner and repo strings end up inside a
 * `git clone` command, so anything that could be read as a flag is rejected.
 */
export interface GitHubTarget {
  kind: 'github';
  owner: string;
  repo: string;
  ref: string | null;
  cloneUrl: string;
  webUrl: string;
  label: string;
}

export interface LocalTarget {
  kind: 'local';
  path: string;
  label: string;
}

export type ScanTarget = GitHubTarget | LocalTarget;

export class TargetError extends Error {
  override name = 'TargetError';
}

// GitHub's own naming rules. Owner: up to 39 chars, letters, digits, hyphens, no leading hyphen.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// Repo: letters, digits, dot, underscore, hyphen. "." and ".." are not repos.
const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
// Branch or tag. No leading hyphen, no "..", none of git's forbidden characters.
const REF_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s#?]+?)(?:\.git)?(?:\/tree\/(?<ref>[^#?\s]+))?\/?(?:[#?].*)?$/i;
const SHORTHAND_RE = /^(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)$/;

export function parseTarget(input: string): ScanTarget {
  const raw = input.trim();
  if (!raw)
    throw new TargetError('Target is empty. Pass a GitHub URL, owner/repo, or a local folder.');
  if (raw.startsWith('-')) throw new TargetError('Target cannot start with "-".');

  // A folder that exists on disk wins over the owner/repo shorthand.
  const asPath = resolve(raw);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) {
    return { kind: 'local', path: asPath, label: basename(asPath) || 'local' };
  }

  const match = GITHUB_URL_RE.exec(raw) ?? SHORTHAND_RE.exec(raw);
  if (!match?.groups) {
    throw new TargetError(`"${raw}" is not a GitHub URL, owner/repo, or an existing folder.`);
  }
  return buildGitHubTarget(
    match.groups.owner ?? '',
    match.groups.repo ?? '',
    match.groups.ref ?? null,
  );
}

export function buildGitHubTarget(
  owner: string,
  repoRaw: string,
  refRaw: string | null,
): GitHubTarget {
  const repo = repoRaw.replace(/\.git$/i, '');
  if (!OWNER_RE.test(owner)) throw new TargetError(`"${owner}" is not a valid GitHub owner.`);
  if (!REPO_RE.test(repo))
    throw new TargetError(`"${repo}" is not a valid GitHub repository name.`);
  const ref = refRaw ? decodeURIComponent(refRaw) : null;
  if (ref !== null && !REF_RE.test(ref))
    throw new TargetError(`"${ref}" is not a safe branch or tag name.`);
  return {
    kind: 'github',
    owner,
    repo,
    ref,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    webUrl: `https://github.com/${owner}/${repo}`,
    label: `${owner}/${repo}`,
  };
}
