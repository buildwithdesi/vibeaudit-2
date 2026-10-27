import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listEngineRules } from '../src/engine/v1.ts';
import { classOf, VULN_CLASSES } from '../src/model/classes.ts';

test('every live engine rule maps to a vulnerability class', async () => {
  const rules = await listEngineRules();
  assert.ok(rules.length > 0, 'engine returned rules');
  const unmapped = rules.map((r) => r.id).filter((id) => classOf(id) === 'other');
  assert.deepEqual(unmapped, [], `rules missing from the class map: ${unmapped.join(', ')}`);
});

test('the class map carries no rule the engine does not ship', async () => {
  const live = new Set((await listEngineRules()).map((r) => r.id));
  const stale = VULN_CLASSES.flatMap((c) => c.rules).filter((id) => !live.has(id));
  assert.deepEqual(
    stale,
    [],
    `class map lists rules the engine no longer has: ${stale.join(', ')}`,
  );
});

test('each rule appears in exactly one class', () => {
  const seen = new Map<string, number>();
  for (const cls of VULN_CLASSES) for (const id of cls.rules) seen.set(id, (seen.get(id) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dupes, []);
});

test('dependency findings from adapters fall into supply chain', () => {
  assert.equal(classOf('GHSA-xxxx', 'osv-scanner'), 'supply-chain');
  assert.equal(classOf('something-new'), 'other');
});
