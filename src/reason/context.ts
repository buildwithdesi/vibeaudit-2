import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, posix, relative, resolve, sep } from 'node:path';
import type { FindingT } from '../model/finding.ts';
import { isSecretFile, redactSecrets, safeResolve } from '../normalize/context.ts';
import type { RepoMapT } from './schemas.ts';

/**
 * Everything the reasoning prompts need from the repository, gathered here so
 * the prompt builders stay pure. All text passes through the secret masker.
 */
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  'vendor',
  '.cache',
  'out',
  '__pycache__',
]);
const CODE_EXT = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.php',
  '.java',
]);
const KEY_NAME =
  /(^|\/)(server|app|index|main|routes?|router|middleware|auth|session|security|guard|policy|config)\.[a-z]+$/i;

export async function listFiles(repoDir: string, max = 4000): Promise<string[]> {
  const root = resolve(repoDir);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= max) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name)); // vibe-audit-ignore perf-no-await-parallel
      } else if (entry.isFile()) {
        const rel = relative(root, join(dir, entry.name)).split(sep).join(posix.sep);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
        if (!/[\u0000-\u001F\u007F]/.test(rel)) out.push(rel);
      }
    }
  }
  await walk(root);
  return out;
}

export function renderTree(files: readonly string[]): string {
  // Names can carry payloads too: control characters are stripped before they reach a prompt.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  return files.map((f) => f.replace(/[\u0000-\u001F\u007F-\u009F]/g, '?')).join('\n');
}

export async function readPackageJson(repoDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(repoDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const keep: Record<string, unknown> = {};
    for (const key of [
      'name',
      'description',
      'main',
      'scripts',
      'dependencies',
      'devDependencies',
    ]) {
      if (pkg[key] !== undefined) keep[key] = pkg[key];
    }
    return JSON.stringify(
      keep,
      (_key, value: unknown) => (typeof value === 'string' ? redactSecrets(value).text : value),
      1,
    );
  } catch {
    return null;
  }
}

export function renderFindingsIndex(findings: readonly FindingT[]): string {
  const byFile = new Map<string, { count: number; classes: Set<string>; critical: number }>();
  for (const f of findings) {
    const entry = byFile.get(f.file) ?? { count: 0, classes: new Set(), critical: 0 };
    entry.count += 1;
    entry.classes.add(f.vulnClass);
    if (f.severity === 'critical') entry.critical += 1;
    byFile.set(f.file, entry);
  }
  return [...byFile.entries()]
    .sort((a, b) => b[1].critical - a[1].critical || b[1].count - a[1].count)
    .slice(0, 150)
    .map(
      ([file, e]) => `${file}: ${e.count} (${e.critical} critical; ${[...e.classes].join(', ')})`,
    )
    .join('\n');
}

/** Files most likely to define routing, auth and wiring, plus the files with the most criticals. */
export async function keyFileExcerpts(
  repoDir: string,
  files: readonly string[],
  findings: readonly FindingT[],
  limit = 8,
  maxLines = 80,
): Promise<Array<{ file: string; excerpt: string }>> {
  const critical = new Map<string, number>();
  for (const f of findings)
    if (f.severity === 'critical') critical.set(f.file, (critical.get(f.file) ?? 0) + 1);
  const ranked = files
    .filter((f) => CODE_EXT.has(extname(f)))
    .map((f) => ({
      f,
      score: (KEY_NAME.test(f) ? 10 : 0) + (critical.get(f) ?? 0) - f.split('/').length * 0.1,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const out: Array<{ file: string; excerpt: string }> = [];
  for (const { f } of ranked) {
    const text = await safeRead(repoDir, f, maxLines); // vibe-audit-ignore perf-no-await-parallel
    if (text) out.push({ file: f, excerpt: text });
  }
  return out;
}

/** The file that mounts or imports the flagged file, plus any auth boundary the map names. */
export async function relatedSnippets(
  repoDir: string,
  finding: FindingT,
  files: readonly string[],
  repoMap: RepoMapT | null,
  maxLines = 60,
): Promise<Array<{ file: string; why: string; code: string }>> {
  const out: Array<{ file: string; why: string; code: string }> = [];
  const stem = basename(finding.file).replace(/\.[a-z]+$/i, '');
  const importer = await findImporter(repoDir, finding.file, stem, files);
  if (importer) {
    const code = await safeRead(repoDir, importer, maxLines);
    if (code)
      out.push({ file: importer, why: `Where ${finding.file} is imported or mounted`, code });
  }
  for (const boundary of repoMap?.authBoundaries.slice(0, 2) ?? []) {
    if (boundary.file === finding.file || boundary.file === importer) continue;
    const code = await safeRead(repoDir, boundary.file, maxLines); // vibe-audit-ignore perf-no-await-parallel
    if (code) out.push({ file: boundary.file, why: `Auth boundary: ${boundary.mechanism}`, code });
  }
  return out;
}

async function findImporter(
  repoDir: string,
  target: string,
  stem: string,
  files: readonly string[],
): Promise<string | null> {
  const needle = new RegExp(
    `(?:from\\s+|require\\()\\s*['"][^'"]*\\b${escapeRegExp(stem)}(?:\\.[a-z]+)?['"]`,
  );
  const candidates = files.filter((f) => f !== target && CODE_EXT.has(extname(f))).slice(0, 600);
  for (const f of candidates) {
    const text = await safeRead(repoDir, f, 400); // vibe-audit-ignore perf-no-await-parallel
    if (text && needle.test(text)) return f;
  }
  return null;
}

async function safeRead(repoDir: string, file: string, maxLines: number): Promise<string | null> {
  if (isSecretFile(file)) return null;
  const abs = await safeResolve(repoDir, file);
  if (!abs) return null;
  try {
    const lines = (await readFile(abs, 'utf8')).split(/\r?\n/).slice(0, maxLines);
    return redactSecrets(lines.join('\n')).text;
  } catch {
    return null;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
