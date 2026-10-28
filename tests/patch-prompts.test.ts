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
