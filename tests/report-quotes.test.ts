import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { quoteChecker } from '../src/report/proof-of-risk.ts';

/** A repo folder with a host file next to it that no quote may ever be checked against. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'va2-quotes-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'routes'), { recursive: true });
  writeFileSync(join(repo, 'routes', 'users.js'), 'const rows = await db.query(sql);\n');
  writeFileSync(join(dir, 'host.txt'), 'root:x:0:0:root:/root:/bin/bash\n');
  symlinkSync(join(dir, 'host.txt'), join(repo, 'link.txt'));
  writeFileSync(join(repo, 'big.js'), `const marker = 1;\n${'x'.repeat(3 * 1024 * 1024)}\n`);
  return repo;
}

test('quote checker never reads outside the repo, through a symlink, or a huge file', async () => {
  const repo = fixture();
  const files = ['routes/users.js', '../host.txt', 'link.txt', 'big.js'];
  const check = await quoteChecker(repo, files);
  assert.equal(check('routes/users.js', 'const rows = await db.query(sql);'), true);
  assert.equal(check('routes/users.js', 'const rows = made.up();'), false);
  // A model-supplied path that climbs out of the repo cannot hold a quote from it.
  assert.equal(check('../host.txt', 'root:x:0:0:root:/root:/bin/bash'), false);
  // Files the code-context guard refuses are not read, so they are not checked.
  assert.equal(check('link.txt', 'root:x:0:0:root:/root:/bin/bash'), null);
  assert.equal(check('big.js', 'const marker = 1;'), null);
});
