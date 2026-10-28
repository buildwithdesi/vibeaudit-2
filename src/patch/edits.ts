import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, posix, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * A patch is a list of exact search-and-replace edits. The model never gets
 * to write whole files: each `search` must appear exactly once in the file,
 * every edit for a file is checked in memory before anything is written, and
 * the file must be on the allowlist for the finding. Anything else is
 * rejected and reported, never applied.
 */
export const Edit = z.object({
  file: z
    .string()
    .describe('path relative to the repository root, exactly as given in the finding'),
  search: z.string().describe('verbatim text to replace; must appear exactly once in the file'),
  replace: z.string().describe('the replacement text'),
  why: z.string().describe('one sentence: what this edit closes'),
});
export type EditT = z.infer<typeof Edit>;

export const PatchPlan = z.object({
  edits: z.array(Edit),
  newDependencies: z
    .array(z.string())
    .describe('packages the fix needs; must be empty unless unavoidable'),
  note: z.string().describe('what changed and what a reviewer should double-check, two sentences'),
  confidence: z.number().min(0).max(1),
});
export type PatchPlanT = z.infer<typeof PatchPlan>;

export interface EditResult {
  edit: EditT;
  applied: boolean;
  reason: string;
}

/** Files no patch may ever touch, whatever the model says. */
const FORBIDDEN_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.vibe-audit.json',
  '.gitattributes',
  '.gitmodules',
]);

export function forbiddenPathReason(relativeFile: string): string | null {
  const normalized = relativeFile.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const raw of segments) {
    const segment = raw.replace(/[. ]+$/, '').toLowerCase();
    if (segment === '.git' || segment === 'git~1') return 'path touches the .git directory';
    if (segment === '.github') return 'path touches .github';
    if (segment === '..' || segment === '') return 'path is not a plain relative path';
  }
  const name = basename(normalized);
  if (FORBIDDEN_NAMES.has(name)) return `${name} may not be patched`;
  if (name.startsWith('.env')) return 'environment files may not be patched';
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return 'key material may not be patched';
  return null;
}

export interface ApplyOptions {
  /** Only these files may be edited. Usually the finding's own file. */
  allowedFiles: readonly string[];
}

export async function applyEdits(
  repoDir: string,
  edits: readonly EditT[],
  options: ApplyOptions,
): Promise<EditResult[]> {
  const root = resolve(repoDir);
  const allowed = new Set(options.allowedFiles.map((f) => posix.normalize(f.replace(/\\/g, '/'))));
  const results: EditResult[] = [];

  // Group by file so a plan either applies whole for that file or not at all.
  const byFile = new Map<string, EditT[]>();
  for (const edit of edits) {
    const key = posix.normalize(edit.file.replace(/\\/g, '/'));
    const list = byFile.get(key) ?? [];
    list.push(edit);
    byFile.set(key, list);
  }

  for (const [file, fileEdits] of byFile) {
    const rejectAll = (reason: string): void => {
      for (const edit of fileEdits) results.push({ edit, applied: false, reason });
    };
    const forbidden = forbiddenPathReason(file);
    if (forbidden) {
      rejectAll(forbidden);
      continue;
    }
    if (!allowed.has(file)) {
      rejectAll('file is not on the allowlist for this finding');
      continue;
    }
    const abs = resolve(root, file);
    if (!abs.startsWith(root + sep)) {
      rejectAll('path escapes the repository');
      continue;
    }
    let content: string;
    try {
      const info = await lstat(abs); // vibe-audit-ignore perf-no-await-parallel
      if (info.isSymbolicLink() || !info.isFile()) {
        rejectAll('target is not a regular file');
        continue;
      }
      if (info.size > 2 * 1024 * 1024) {
        rejectAll('file is larger than 2 MB');
        continue;
      }
      const real = await realpath(abs); // vibe-audit-ignore perf-no-await-parallel
      const realRoot = await realpath(root); // vibe-audit-ignore perf-no-await-parallel
      if (!real.startsWith(realRoot + sep)) {
        rejectAll('path resolves outside the repository');
        continue;
      }
      content = await readFile(abs, 'utf8'); // vibe-audit-ignore perf-no-await-parallel
    } catch {
      rejectAll('file not found');
      continue;
    }

    // Match the file's own line endings so multi-line searches land on CRLF files.
    const crlf = content.includes('\r\n');
    const normalize = (text: string): string =>
      crlf ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n');

    let working = content;
    const staged: Array<{ edit: EditT; reason: string }> = [];
    let failed = false;
    for (const edit of fileEdits) {
      const search = normalize(edit.search);
      const replace = normalize(edit.replace);
      if (!search.trim()) {
        staged.push({ edit, reason: 'empty search text' });
        failed = true;
        break;
      }
      if (/vibe-audit-ignore/i.test(replace) && !/vibe-audit-ignore/i.test(search)) {
        staged.push({
          edit,
          reason: 'replacement would suppress the scanner instead of fixing the code',
        });
        failed = true;
        break;
      }
      const first = working.indexOf(search);
      if (first < 0) {
        staged.push({ edit, reason: 'search text not found' });
        failed = true;
        break;
      }
      if (working.indexOf(search, first + 1) >= 0) {
        staged.push({ edit, reason: 'search text appears more than once' });
        failed = true;
        break;
      }
      working = working.slice(0, first) + replace + working.slice(first + search.length);
      staged.push({ edit, reason: 'applied' });
    }
    if (failed) {
      const why = staged[staged.length - 1]?.reason ?? 'rejected';
      for (const edit of fileEdits) {
        const own = staged.find((s) => s.edit === edit);
        results.push({
          edit,
          applied: false,
          reason:
            own && own.reason !== 'applied'
              ? own.reason
              : `not applied: another edit for this file failed (${why})`,
        });
      }
      continue;
    }
    await writeFile(abs, working, 'utf8'); // vibe-audit-ignore perf-no-await-parallel
    for (const edit of fileEdits) results.push({ edit, applied: true, reason: 'applied' });
  }
  return results;
}
