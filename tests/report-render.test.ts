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

/** The demo run's shape: the secrets were judged fake, everything else was confirmed. */
function demoFindings(): FindingT[] {
  return [
    finding('k1', 'secrets', 'server/config.js:8', 'not-exploitable'),
    finding('k2', 'secrets', 'server/config.js:7', 'not-exploitable'),
    finding('k3', 'secrets', 'server/config.js:8', 'not-exploitable'),
    finding('q1', 'sql-injection', 'routes/users.js:9', 'confirmed'),
    finding('q2', 'sql-injection', 'routes/users.js:15', 'confirmed'),
    finding('a1', 'missing-auth', 'routes/users.js:9', 'confirmed'),
    finding('a2', 'missing-auth', 'routes/users.js:15', 'confirmed'),
    finding('c1', 'command-injection', 'routes/network.js:9', 'confirmed'),
    finding('p1', 'path-traversal', 'routes/files.js:10', 'confirmed'),
    finding('r1', 'ssrf', 'routes/preview.js:8'),
  ];
}

const DEMO_CLASSES = [
  'secrets',
  'sql-injection',
  'missing-auth',
  'command-injection',
  'path-traversal',
];

function fixFirstLine(text: string): string {
  return text.split('\n').find((l) => l.startsWith('**Fix first:**')) ?? '';
}

function tableRow(text: string, label: string): string {
  return text.split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
}

test('fix first follows the verdicts, not the raw critical count', () => {
  const text = render(manifest(), demoFindings(), reasoningRecord(DEMO_CLASSES));
  assert.equal(
    fixFirstLine(text),
    '**Fix first:** Someone can rewrite your database commands. **Next:** Anyone can reach things that should need a login.',
  );
  assert.ok(
    tableRow(text, 'Passwords and keys sitting in the code').includes(
      '| 3 | 0 of 3 checked are confirmed or likely |',
    ),
    tableRow(text, 'Passwords and keys sitting in the code'),
  );
  assert.ok(
    tableRow(text, 'Someone can rewrite your database commands').includes(
      '| 2 | 2 of 2 checked are confirmed or likely |',
    ),
  );
});

test('classes nobody judged read as not checked, and a cleared class is never fixed first', () => {
  // `reason --max-findings 2` judged only the command and the file finding.
  const findings = demoFindings().map((f) =>
    f.id === 'c1' || f.id === 'p1' ? f : { ...f, reasoning: null },
  );
  const text = render(manifest(), findings, reasoningRecord(DEMO_CLASSES));
  assert.equal(
    fixFirstLine(text),
    '**Fix first:** Someone can run commands on your server. **Next:** Someone can read files they should not see.',
  );
  for (const label of [
    'Passwords and keys sitting in the code',
    'Someone can rewrite your database commands',
    'Anyone can reach things that should need a login',
  ]) {
    assert.ok(tableRow(text, label).includes('| not checked yet |'), tableRow(text, label));
  }
  assert.ok(
    tableRow(text, 'Someone can run commands on your server').includes(
      '| 1 of 1 checked is confirmed or likely |',
    ),
  );

  // Only one class is real: the cleared secrets class must not take the second slot.
  const oneHot = demoFindings().map((f) =>
    f.reasoning && f.vulnClass !== 'secrets' && f.id !== 'q1'
      ? { ...f, reasoning: { ...f.reasoning, exploitability: 'unlikely' as const } }
      : f,
  );
  const line = fixFirstLine(render(manifest(), oneHot, reasoningRecord(DEMO_CLASSES)));
  assert.equal(line, '**Fix first:** Someone can rewrite your database commands.');
});

test('a class with some findings unjudged says how many are left', () => {
  const findings = demoFindings().map((f) => (f.id === 'q2' ? { ...f, reasoning: null } : f));
  const text = render(manifest(), findings, reasoningRecord(DEMO_CLASSES));
  assert.ok(
    tableRow(text, 'Someone can rewrite your database commands').includes(
      '| 1 of 1 checked is confirmed or likely; 1 not checked yet |',
    ),
    tableRow(text, 'Someone can rewrite your database commands'),
  );
});
