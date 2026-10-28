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

test('masks the formats a real repo leaks: json keys, env lines, bearer tokens, url passwords', () => {
  const input = [
    '{"api_key": "abcd1234efgh5678"}',
    'API_KEY=abcd1234efgh5678',
    'password: hunter2hunter',
    "const a = 'sk-proj-abcdefghijklmnopqrstuvwxyz';",
    "const b = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';",
    "headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' }",
    "const c = 'redis://:pw12345678@cache.internal:6379';",
    "const d = 'https://user:pass1234@host.example';",
    'const key = process.env.API_KEY;',
    'META_API_KEY=LLM_123456789012345_fakefakefakefakefakefake',
  ].join('\n');
  const { text } = redactSecrets(input);
  for (const leak of [
    'abcd1234efgh5678',
    'hunter2hunter',
    'sk-proj-abc',
    'sk-ant-api03',
    'Bearer abcdefghij',
    ':pw12345678@',
    ':pass1234@',
    'fakefakefake',
  ]) {
    assert.ok(!text.includes(leak), `still present: ${leak}`);
  }
  assert.ok(text.includes('const key = process.env.API_KEY;'), 'env lookups are not secrets');
  assert.ok(text.includes('redis://:[REDACTED]@cache.internal'), 'host survives');
});

test('secret-bearing files are never read into context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'va2-ctx-'));
  await writeFile(join(dir, '.env'), 'TOKEN=abc123456789\n');
  const ctx = await readContext(dir, '.env', 1, 2);
  assert.ok(ctx);
  assert.ok(!ctx.code.includes('abc123456789'));
  assert.equal(ctx.redacted, true);
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
