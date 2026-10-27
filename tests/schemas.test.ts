import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExploitVerdict, RepoMap, TriageVerdict, toResponseFormat } from '../src/reason/schemas.ts';

/**
 * Meta's strict subset: root is a plain object, every object sets
 * additionalProperties false and lists every key as required, no allOf or
 * oneOf anywhere, no recursion. Walk the generated schema and check.
 */
function checkStrict(node: unknown, path: string, depth: number): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  assert.ok(depth <= 10, `${path}: nesting deeper than 10`);
  assert.ok(!('allOf' in obj), `${path}: allOf is not allowed`);
  assert.ok(!('oneOf' in obj), `${path}: oneOf is not allowed`);
  assert.ok(!('$ref' in obj), `${path}: $ref would need flattening`);
  if (obj.type === 'object') {
    assert.equal(obj.additionalProperties, false, `${path}: additionalProperties must be false`);
    const props = (obj.properties ?? {}) as Record<string, unknown>;
    assert.deepEqual(obj.required, Object.keys(props), `${path}: required must list every key`);
    for (const [key, value] of Object.entries(props))
      checkStrict(value, `${path}.${key}`, depth + 1);
  }
  if (obj.items) checkStrict(obj.items, `${path}[]`, depth + 1);
  if (Array.isArray(obj.anyOf)) {
    for (const [i, v] of obj.anyOf.entries()) checkStrict(v, `${path}|${i}`, depth);
  }
}

for (const [name, schema] of [
  ['TriageVerdict', TriageVerdict],
  ['ExploitVerdict', ExploitVerdict],
  ['RepoMap', RepoMap],
] as const) {
  test(`${name} converts to a strict-subset response_format`, () => {
    const format = toResponseFormat(schema, name);
    assert.equal(format.type, 'json_schema');
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.schema.type, 'object');
    assert.ok(!('anyOf' in format.json_schema.schema), 'no union at the root');
    checkStrict(format.json_schema.schema, name, 1);
  });
}

test('a verdict parses back through the same Zod schema', () => {
  const sample = {
    keep: true,
    category: 'real-code',
    reason: 'route is mounted in server/index.js',
    confidence: 0.9,
  };
  assert.deepEqual(TriageVerdict.parse(sample), sample);
  assert.throws(() => TriageVerdict.parse({ ...sample, confidence: 2 }));
});
