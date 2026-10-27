// The seeded app's own tests. They stay green before and after a patch, which
// is the point: a fix that breaks them is not a fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { db } from '../server/db.js';
import { database } from '../server/config.js';

test('database stand-in answers queries with rows', async () => {
  const rows = await db.query('SELECT 1');
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
});

test('config exposes a host', () => {
  assert.equal(typeof database.host, 'string');
});
