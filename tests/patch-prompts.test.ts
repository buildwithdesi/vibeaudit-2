import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FindingT } from '../src/model/finding.ts';
import { buildMuseCodePrompt, buildPatchMessages } from '../src/patch/prompts.ts';

function finding(overrides: Partial<FindingT> = {}): FindingT {
  return {
    id: 'f1',
    ruleId: 'missing-auth',
    ruleName: 'missing-auth',
    severity: 'critical',
    vulnClass: 'missing-auth',
    message: 'Route has no auth check.',
    file: 'routes/users.js',
    line: 9,
    evidence: null,
    // The engine's own fix text for some rules recommends a suppression.
    fix: 'Add auth middleware, or add // vibe-audit-ignore-next-line if the route is public.',
    cweId: null,
    cvssScore: null,
    owaspCategory: null,
    source: null,
    context: null,
    triage: null,
    reasoning: null,
    ...overrides,
  };
}

test('both patch prompts forbid closing a finding with a scanner suppression', () => {
  const [system] = buildPatchMessages({ finding: finding(), fileContent: 'x', relatedFiles: [] });
  assert.match(system?.content ?? '', /Never add a vibe-audit-ignore comment/);
  assert.match(buildMuseCodePrompt([finding()]), /Never add a vibe-audit-ignore comment/);
});

test('a finding deep in a large file is inside the code the patcher sees', () => {
  const lines = Array.from({ length: 2_000 }, (_, i) => `const line${i + 1} = ${i + 1}; // filler`);
  lines[1_899] = 'exec(`ping ${req.query.host}`); // the vulnerable line';
  const [, user] = buildPatchMessages({
    finding: finding({ line: 1_900 }),
    fileContent: lines.join('\n'),
    relatedFiles: [],
  });
  const prompt = user?.content ?? '';
  assert.ok(prompt.includes('// the vulnerable line'), 'the flagged line is shown');
  assert.ok(prompt.includes('const line1899 = 1899;'), 'with the lines around it');
  assert.ok(!prompt.includes('const line1 = 1;'), 'the top of the file is left out');
  assert.match(prompt, /\[\d+ lines above not shown\]/);
  assert.ok(prompt.length < 30_000, `prompt ${prompt.length} chars`);

  // A small file is shown whole.
  const [, small] = buildPatchMessages({
    finding: finding({ line: 2 }),
    fileContent: 'a\nb\nc',
    relatedFiles: [],
  });
  assert.ok(small?.content.includes('Full file routes/users.js:'));
  assert.ok(!small?.content.includes('not shown'));
});
