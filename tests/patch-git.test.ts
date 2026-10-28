import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkout, commitAll, createBranch, ensureRepo } from '../src/patch/git.ts';

/** A small tree in a run-folder layout: <run>/repo, the way the patch loop lays it out. */
function runFolder(): { run: string; repo: string } {
  const run = mkdtempSync(join(tmpdir(), 'va2-git-'));
  const repo = join(run, 'repo');
  mkdirSync(repo);
  writeFileSync(join(repo, 'index.js'), 'export const a = 1;\n');
  return { run, repo };
}

test('no git hook runs, wherever a process in the tree plants one', async (t) => {
  if (process.platform === 'win32') t.skip('hook scripts need a POSIX shell');
  const { run, repo } = runFolder();
  await ensureRepo(repo);
  await createBranch(repo, 'vibeaudit2/patch-test');
  const proof = join(run, 'hook-ran');
  // Every hook a commit or checkout can fire, including the ones --no-verify does not skip,
  // in every folder a hooks path could point at: next to the copy, and inside .git.
  const hooks = ['post-commit', 'prepare-commit-msg', 'reference-transaction', 'post-checkout'];
  for (const dir of [join(run, 'no-hooks'), join(repo, '.git', 'hooks')]) {
    mkdirSync(dir, { recursive: true });
    for (const hook of hooks) {
      writeFileSync(join(dir, hook), `#!/bin/sh\necho ${hook} >> '${proof}'\n`);
      chmodSync(join(dir, hook), 0o755);
    }
  }
  writeFileSync(join(repo, 'index.js'), 'export const a = 2;\n');
  const commit = await commitAll(repo, 'patch');
  assert.ok(commit, 'the commit still succeeds');
  await checkout(repo, 'HEAD~1');
  assert.equal(existsSync(proof), false, 'a planted hook ran');
});
