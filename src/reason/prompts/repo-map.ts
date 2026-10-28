import type { ChatMessage } from '../meta-client.ts';
import { clip, inline, repoData, UNTRUSTED_RULE } from './shared.ts';

/**
 * Repo map: one Muse Spark call per run that turns a file tree plus the
 * findings index into a map of entry points, auth boundaries, data stores and
 * trust zones. Every exploitability call reuses this map, so the per-finding
 * prompts stay small and the expensive context is paid for once.
 */
export interface RepoMapInput {
  label: string;
  /** Relative paths, one per line, already pruned of node_modules and build output. */
  fileTree: string;
  packageJson: string | null;
  /** "path: n findings (classes)" lines. */
  findingsIndex: string;
  /** Short excerpts of the files most likely to define routing and auth. */
  keyFileExcerpts: Array<{ file: string; excerpt: string }>;
}

export const REPO_MAP_SYSTEM = `You are a senior application security reviewer mapping a codebase before a vulnerability triage. You produce a factual map, not opinions about risk.

${UNTRUSTED_RULE}

Rules for the map:
- Name only files that appear in the tree or excerpts. Never invent a path.
- An auth boundary is code that decides who may call something: middleware, session checks, API key checks, row-level policies. Say which routes or folders it covers, and say "unknown" when you cannot tell.
- A trust zone says who can reach a file's behavior: public (no login), authenticated, admin, or internal (not reachable from a request).
- Mark test, fixture, generated and vendored files as such. Findings in those files are usually not exploitable.
- In notes, record anything that changes how findings should be judged: a global auth middleware, an input validation layer, a framework that escapes output by default, environment-based guards.
- Keep every string short. This map is read by another model with a small context budget.`;

export function buildRepoMapMessages(input: RepoMapInput): ChatMessage[] {
  const excerpts = input.keyFileExcerpts
    .map((e) => repoData(e.file, clip(e.excerpt, 4_000)))
    .join('\n\n');
  const user = [
    `Repository: ${inline(input.label, 120)}`,
    '',
    'File tree:',
    repoData('file-tree', clip(input.fileTree, 16_000)),
    '',
    input.packageJson
      ? `package.json:\n${repoData('package.json', clip(input.packageJson, 3_000))}`
      : 'No package.json found.',
    '',
    'Files with deterministic findings (path: count, classes):',
    repoData('findings-index', clip(input.findingsIndex, 6_000)),
    '',
    'Key file excerpts:',
    excerpts || '(none)',
    '',
    'Produce the repository map as JSON matching the schema.',
  ].join('\n');
  return [
    { role: 'system', content: REPO_MAP_SYSTEM },
    { role: 'user', content: user },
  ];
}
