import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VulnClassId } from '../src/model/classes.ts';
import type { FindingT, RunManifestT, SeverityT } from '../src/model/finding.ts';
import type { ReasoningRecordT } from '../src/reason/orchestrate.ts';
import type { ExploitabilityT } from '../src/reason/schemas.ts';
import { render } from '../src/report/proof-of-risk.ts';

/** Built by hand, so each test states exactly which run it renders. */
function manifest(): RunManifestT {
  return {
    runId: '20261027T000000Z-demo-0000',
    createdAt: '2026-10-27T00:00:00.000Z',
    tool: { name: 'vibeaudit-2', version: 'test' },
    target: { kind: 'local', label: 'demo', url: null, ref: null, path: '/nowhere/demo' },
    commit: null,
    engine: {
      name: '@jackdog668/vibeaudit',
      version: '1.4.0',
      rulesAvailable: 104,
      rulesRun: 104,
      sca: false,
      trustTargetConfig: false,
    },
    filesScanned: 9,
    durationMs: { clone: 0, engine: 0, total: 0 },
    counts: { total: 0, bySeverity: {}, byClass: {} },
    stages: {
      intake: 'done',
      engine: 'done',
      normalize: 'done',
      triage: 'skipped',
      reasoning: 'done',
      report: 'pending',
      patch: 'pending',
    },
  };
}

function finding(
  id: string,
  vulnClass: VulnClassId,
  where: string,
  verdict: ExploitabilityT | null = null,
  severity: SeverityT = 'critical',
): FindingT {
  const [file = '', line = '1'] = where.split(':');
  return {
    id,
    ruleId: vulnClass,
    ruleName: vulnClass,
    severity,
    vulnClass,
    message: `${vulnClass} at ${where}`,
    file,
    line: Number(line),
    evidence: null,
    fix: '',
    cweId: null,
    cvssScore: null,
    owaspCategory: null,
    source: null,
    context: null,
    triage: null,
    reasoning: verdict
      ? {
          exploitability: verdict,
          confidence: 0.9,
          attackerPosition: verdict === 'not-exploitable' ? 'none' : 'anonymous-internet',
          preconditions: [],
          attackPath: [`Step one for ${id}.`],
          impact: 'Data is lost.',
          blastRadius: 'many-users',
          evidence: [{ file, line: Number(line), quote: `quote for ${id}` }],
          severityAdjustment: 'keep',
          fixSummary: `Fix ${id}.`,
          plainLanguage: `Plain words for ${id}.`,
        }
      : null,
  };
}

function reasoningRecord(classes: string[]): ReasoningRecordT {
  return {
    runId: '20261027T000000Z-demo-0000',
    startedAt: '2026-10-27T00:00:00.000Z',
    finishedAt: '2026-10-27T00:01:00.000Z',
    dryRun: false,
    models: { reason: 'muse-spark-1.3', triage: null },
    classes,
    repoMap: null,
    decisions: [],
    calls: 1,
    usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    usd: 0.01,
    estimatedUsd: 0.01,
    aborted: null,
  };
}

test('a reasoning record that names an unknown class still renders', () => {
  // `reason --classes sqli` records the typo, then selects nothing.
  const findings = [finding('s1', 'sql-injection', 'routes/users.js:9')];
  const text = render(manifest(), findings, reasoningRecord(['sqli']));
  assert.ok(!text.includes('sqli'), 'the unknown id is not shown');
  assert.ok(text.includes('## Someone can rewrite your database commands'));
  assert.ok(text.includes('This is a first pass.'), 'nothing was judged, and the report says so');
});
