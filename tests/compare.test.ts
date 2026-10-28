import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FindingT } from '../src/model/finding.ts';
import { compareScans, mapOldLine, parseUnifiedDiff } from '../src/patch/compare.ts';

const DIFF = [
  'diff --git a/routes/users.js b/routes/users.js',
  '--- a/routes/users.js',
  '+++ b/routes/users.js',
  '@@ -9 +9,2 @@',
  '-  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);',
  '+  // Bound as a parameter.',
  "+  const rows = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);",
  '@@ -14,0 +16,3 @@',
  '+function guard() {',
  '+  return true;',
  '+}',
].join('\n');

function finding(id: string, ruleId: string, file: string, line: number | null): FindingT {
  return {
    id,
    ruleId,
    ruleName: ruleId,
    severity: 'critical',
    vulnClass: 'sql-injection',
    message: 'm',
    file,
    line,
    evidence: null,
    fix: '',
    cweId: null,
    cvssScore: null,
    owaspCategory: null,
    source: null,
    context: null,
    triage: null,
    reasoning: null,
  };
}

test('maps old lines through replaced and inserted hunks', () => {
  const hunks = parseUnifiedDiff(DIFF).get('routes/users.js') ?? [];
  assert.equal(hunks.length, 2);
  assert.deepEqual(mapOldLine(hunks, 3), { start: 3, end: 3 });
  assert.deepEqual(
    mapOldLine(hunks, 9),
    { start: 9, end: 10 },
    'replaced line maps to the new range',
  );
  assert.deepEqual(mapOldLine(hunks, 12), { start: 13, end: 13 }, 'one line added above');
  assert.deepEqual(
    mapOldLine(hunks, 15),
    { start: 19, end: 19 },
    'three more lines inserted after old 14',
  );
});

test('survivors are matched, fixed findings resolve, and nothing shifted counts as new', () => {
  const before = [
    finding('sql9', 'sql-injection', 'routes/users.js', 9),
    finding('idor9', 'idor-vulnerability', 'routes/users.js', 9),
    finding('sql15', 'sql-injection', 'routes/users.js', 15),
    finding('csrf14', 'missing-csrf', 'routes/users.js', 14),
    finding('gitignore', 'missing-gitignore', '.gitignore', null),
  ];
  // After the patch: the SQL on old line 9 is fixed, but idor still fires on the new line 10,
  // the DELETE on old line 15 is now line 19, csrf moved to 15, and a brand new finding appeared.
  const after = [
    finding('x1', 'idor-vulnerability', 'routes/users.js', 10),
    finding('x2', 'sql-injection', 'routes/users.js', 19),
    finding('x3', 'missing-csrf', 'routes/users.js', 15),
    finding('x4', 'missing-gitignore', '.gitignore', null),
    finding('x5', 'eval-usage', 'routes/users.js', 17),
  ];
  const result = compareScans(before, after, new Set(['sql9', 'sql15']), parseUnifiedDiff(DIFF));
  assert.deepEqual(result.resolved, ['sql9']);
  assert.deepEqual(result.remaining, ['sql15']);
  assert.equal(result.introduced, 1, 'only the eval finding is new');
});
