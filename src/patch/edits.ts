import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * A patch is a list of exact search-and-replace edits. The model never gets
 * to write whole files: each `search` must appear exactly once in the file,
 * so an edit can only land where the model said it would. Anything else is
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

export async function applyEdits(repoDir: string, edits: readonly EditT[]): Promise<EditResult[]> {
  const root = resolve(repoDir);
  const results: EditResult[] = [];
  for (const edit of edits) {
    const abs = resolve(root, edit.file);
    if (!abs.startsWith(root + sep)) {
      results.push({ edit, applied: false, reason: 'path escapes the repository' });
      continue;
    }
    if (!edit.search.trim()) {
      results.push({ edit, applied: false, reason: 'empty search text' });
      continue;
    }
    let content: string;
    try {
      content = await readFile(abs, 'utf8'); // vibe-audit-ignore perf-no-await-parallel
    } catch {
      results.push({ edit, applied: false, reason: 'file not found' });
      continue;
    }
    const first = content.indexOf(edit.search);
    if (first < 0) {
      results.push({ edit, applied: false, reason: 'search text not found' });
      continue;
    }
    if (content.indexOf(edit.search, first + 1) >= 0) {
      results.push({ edit, applied: false, reason: 'search text appears more than once' });
      continue;
    }
    content = content.slice(0, first) + edit.replace + content.slice(first + edit.search.length);
    await writeFile(abs, content, 'utf8'); // vibe-audit-ignore perf-no-await-parallel
    results.push({ edit, applied: true, reason: 'applied' });
  }
  return results;
}
