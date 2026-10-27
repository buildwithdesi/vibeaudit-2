import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readContext, redactSecrets } from '../src/normalize/context.ts';

test('masks credential-shaped values but keeps the surrounding code', () => {
  const input = [
    "const stripe = 'sk_live_fake12345';",
    "const password = 'Winter2026Prod!';",
    "const url = 'postgres://app:Winter2026Prod@db.internal:5432/app';",
    'const total = price * qty;',
  ].join('\n');
  const { text, redacted } = redactSecrets(input);
  assert.equal(redacted, true);
  assert.ok(!text.includes('sk_live_fake'), 'stripe key masked');
  assert.ok(!text.includes('Winter2026Prod'), 'password masked');
  assert.ok(text.includes('postgres://app:[REDACTED]@db.internal'), 'connection string keeps host');
  assert.ok(text.includes('const total = price * qty;'), 'ordinary code untouched');
});

test('reads numbered lines around a finding and refuses paths outside the repo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'va2-ctx-'));
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  lines[9] = "const token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';";
  await writeFile(join(dir, 'a.js'), lines.join('\n'));

  const ctx = await readContext(dir, 'a.js', 10, 2);
  assert.ok(ctx);
  assert.equal(ctx.startLine, 8);
  assert.equal(ctx.endLine, 12);
  assert.equal(ctx.redacted, true);
  assert.ok(ctx.code.includes('    8  line 8'));
  assert.ok(!ctx.code.includes('ghp_abcdefghij'));

  assert.equal(await readContext(dir, '../outside.js', 1, 2), null);
  assert.equal(await readContext(dir, 'missing.js', 1, 2), null);
  assert.equal(await readContext(dir, 'a.js', null, 2), null);
});
