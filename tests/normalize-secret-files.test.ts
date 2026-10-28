import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isSecretFile, readContext } from '../src/normalize/context.ts';

test('credential files are recognized by name and never read', async (t) => {
  for (const file of [
    '.envrc',
    '.dev.vars',
    'env.local',
    'config/production.env',
    'credentials.json',
    'gcp-credentials.json',
    '.aws/credentials',
    'serviceAccountKey.json',
    'firebase-service-account.json',
    'secrets.yaml',
    'config/secrets.yml',
    'secrets.json',
    '.git-credentials',
    '.pypirc',
    '.htpasswd',
    '.env.local',
    'id_rsa',
    'certs/server.pem',
  ]) {
    assert.equal(isSecretFile(file), true, file);
  }

  const dir = await mkdtemp(join(tmpdir(), 'va2-ctx-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, '.aws'));
  await writeFile(join(dir, '.aws', 'credentials'), 'aws_secret_access_key = FAKEZ9abcdefgh\n');
  const ctx = await readContext(dir, '.aws/credentials', 1, 2);
  assert.ok(ctx);
  assert.ok(!ctx.code.includes('FAKEZ9'));
});

test('source files that merely mention credentials stay readable', () => {
  for (const file of [
    'src/credentials.ts',
    'tests/credentials.test.js',
    'docs/credentials.md',
    'lib/secrets.ts',
    'secretsManager.ts',
    'service-account.ts',
    'src/env.ts',
    'environment.ts',
    'routes/auth.js',
    'package.json',
  ]) {
    assert.equal(isSecretFile(file), false, file);
  }
});
