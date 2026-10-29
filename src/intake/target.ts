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

// The tail of a /tree/ or /blob/ URL is a branch or tag, often followed by a folder or file path.
const GITHUB_URL_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/(?<owner>[^/\s]+)\/(?<repo>[^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/(?<ref>[^#?\s]+))?\/?(?:[#?].*)?$/i;
// git@github.com:owner/repo.git and ssh://git@github.com/owner/repo.git only name the repo. The clone is still https.
const SSH_URL_RE =
  /^(?:ssh:\/\/git@github\.com\/|git@github\.com:)(?<owner>[^/\s]+)\/(?<repo>[^/\s#?]+?)(?:\.git)?\/?$/i;
const GITHUB_PREFIX_RE =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])/i;
const SHORTHAND_RE = /^(?<owner>[^/\s]+)\/(?<repo>[^/\s]+)$/;
// https://, git://, file://: a URL, never a folder name, whatever host or form it has.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

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

  const url = GITHUB_URL_RE.exec(raw) ?? SSH_URL_RE.exec(raw);
  // Without this, git://github.com/... or https://user@github.com/... reads as a relative path.
  if (!url && SCHEME_RE.test(raw)) {
    throw new TargetError(
      `"${raw}" is not a supported GitHub URL. Pass https://github.com/<owner>/<repo>, <owner>/<repo>, or a local folder.`,
    );
  }
  if (looksLikePath(raw)) throw new TargetError(`Folder not found: ${asPath}`);
  const match = url ?? SHORTHAND_RE.exec(raw);
  if (!match?.groups) {
    throw new TargetError(`"${raw}" is not a GitHub URL, owner/repo, or an existing folder.`);
  }
  return buildGitHubTarget(
    match.groups.owner ?? '',
    match.groups.repo ?? '',
    refFromUrlPath(match.groups.ref ?? null),
  );
}

/**
 * "main/src/app.ts" from a /blob/ URL: the branch and the path after it,
 * decoded. A branch can contain "/", so the split point is only known once
 * the repository's refs are listed, which the clone does. Here the tail is
 * cut before the first segment that no ref could contain, like a file name
 * with a space, and the trailing slash is dropped.
 */
function refFromUrlPath(path: string | null): string | null {
  if (path === null) return null;
  const decoded = decode(path);
  let ref = '';
  for (const segment of decoded.split('/').filter(Boolean)) {
    const next = ref ? `${ref}/${segment}` : segment;
    if (!REF_RE.test(next)) break;
    ref = next;
  }
  if (!ref) throw new TargetError(`"${decoded}" is not a safe branch or tag name.`);
  return ref;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new TargetError(`"${text}" has a malformed %-escape.`);
  }
}

/** Drive letters, dots, slashes at the start, backslashes, or more than one slash: a path, not owner/repo. */
function looksLikePath(raw: string): boolean {
  if (/^(?:[A-Za-z]:|[./~\\])/.test(raw)) return true;
  if (raw.includes('\\')) return true;
  if (GITHUB_PREFIX_RE.test(raw)) return false;
  if ((raw.match(/\//g) ?? []).length > 1) return true;
  // "examples/seeded-ap": the first segment is a folder here, so it is a mistyped path, not an owner.
  const first = raw.split('/')[0] ?? '';
  return first !== '' && existsSync(resolve(first)) && statSync(resolve(first)).isDirectory();
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
  const ref = refRaw ? decode(refRaw) : null;
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
