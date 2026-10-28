import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { VulnClassId } from '../src/model/classes.ts';
import type { FindingT, RunManifestT, SeverityT } from '../src/model/finding.ts';
import type { PatchRecordT } from '../src/patch/loop.ts';
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

/** Triage set these aside before reasoning, so they carry no verdict. */
function setAside(f: FindingT): FindingT {
  return {
    ...f,
    reasoning: null,
    triage: {
      keep: false,
      category: 'test-or-fixture',
      reason: 'Only a test fixture reads this.',
      confidence: 0.9,
    },
  };
}

test('findings triage set aside are counted as set aside, and never fixed first', () => {
  // Only one class is real, and triage set the secrets aside.
  const findings = demoFindings().map((f) =>
    f.vulnClass === 'secrets'
      ? setAside(f)
      : f.reasoning && f.id !== 'q1'
        ? { ...f, reasoning: { ...f.reasoning, exploitability: 'unlikely' as const } }
        : f,
  );
  const text = render(manifest(), findings, reasoningRecord(DEMO_CLASSES));
  assert.equal(fixFirstLine(text), '**Fix first:** Someone can rewrite your database commands.');
  const secrets = tableRow(text, 'Passwords and keys sitting in the code');
  assert.ok(secrets.includes('| 3 | 3 set aside |'), secrets);

  // One judged, one set aside, one left over.
  const mixed = [
    ...demoFindings().filter((f) => f.vulnClass !== 'sql-injection'),
    finding('q1', 'sql-injection', 'routes/users.js:9', 'confirmed'),
    setAside(finding('q2', 'sql-injection', 'tests/users.test.js:15')),
    finding('q3', 'sql-injection', 'routes/orders.js:4'),
  ];
  const row = tableRow(
    render(manifest(), mixed, reasoningRecord(DEMO_CLASSES)),
    'Someone can rewrite your database commands',
  );
  assert.ok(
    row.includes('| 3 | 1 of 1 checked is confirmed or likely; 1 set aside; 1 not checked yet |'),
    row,
  );
});

/**
 * The demo patch: four leads in four places, and the two SQL findings rode
 * along as same-line siblings of the two login leads. The re-scan cleared
 * four, and the two login leads stayed flagged but were judged closed.
 */
function demoPatch(): PatchRecordT {
  const lead = (id: string, file: string, vulnClass: string) => ({
    id,
    file,
    ruleId: vulnClass,
    vulnClass,
  });
  return {
    runId: '20261027T000000Z-demo-0000',
    startedAt: '2026-10-28T01:00:00.000Z',
    finishedAt: '2026-10-28T01:01:00.000Z',
    backend: 'api',
    workDir: '/nowhere/demo',
    branch: 'vibeaudit2/patch-demo',
    baseCommit: 'a'.repeat(40),
    patchCommit: 'b'.repeat(40),
    selected: [
      lead('p1', 'routes/files.js', 'path-traversal'),
      lead('c1', 'routes/network.js', 'command-injection'),
      lead('a1', 'routes/users.js', 'missing-auth'),
      lead('a2', 'routes/users.js', 'missing-auth'),
    ],
    outcomes: [],
    rejectedFiles: [],
    rescan: {
      ran: true,
      before: {
        total: 4,
        byClass: { 'path-traversal': 1, 'command-injection': 1, 'missing-auth': 2 },
      },
      after: { total: 2, byClass: { 'missing-auth': 2 } },
      resolved: ['p1', 'c1', 'q1', 'q2'],
      remaining: ['a1', 'a2'],
      introduced: 0,
    },
    tests: {
      ran: true,
      passed: true,
      runner: 'local',
      command: 'npm test',
      outputTail: '',
      durationMs: 10,
    },
    verification: ['a1', 'a2'].map((findingId) => ({
      findingId,
      exploitability: 'not-exploitable',
      confidence: 0.95,
      plainLanguage: `Closed: ${findingId}.`,
      usd: 0.01,
    })),
    rescanClean: false,
    verifiedClean: true,
    green: true,
    error: null,
    usd: 0.07,
  };
}

test('after the patch, the counts add up and include findings fixed alongside a lead', () => {
  const text = render(manifest(), demoFindings(), reasoningRecord(DEMO_CLASSES), demoPatch());
  assert.ok(text.includes('## After the patch'));
  assert.ok(
    text.includes('Muse Spark patched 6 findings in 4 places on branch `vibeaudit2/patch-demo`.'),
    text,
  );
  assert.ok(text.includes('The scan ran again on the patched code: 4 fixed, 2 still flagged'));
  assert.ok(
    text.includes('| Problem | Patched | Fixed | Still flagged | Judged closed on review |'),
  );
  for (const row of [
    '| Someone can rewrite your database commands | 2 | 2 | 0 | 0 |',
    '| Anyone can reach things that should need a login | 2 | 0 | 2 | 2 |',
    '| Someone can run commands on your server | 1 | 1 | 0 | 0 |',
    '| Someone can read files they should not see | 1 | 1 | 0 | 0 |',
  ]) {
    assert.ok(text.includes(row), row);
  }
});

test('after a failed re-scan, the report says the scan did not run and why', () => {
  const failed: PatchRecordT = {
    ...demoPatch(),
    rescan: {
      ran: false,
      before: demoPatch().rescan.before,
      after: { total: 4, byClass: {} },
      resolved: [],
      remaining: ['p1', 'c1', 'a1', 'a2'],
      introduced: 0,
    },
    tests: { ...demoPatch().tests, ran: false, passed: false, runner: 'none', command: '' },
    verification: [],
    verifiedClean: false,
    green: false,
    error:
      'engine JSON could not be parsed: Unexpected end of JSON input near {"evidence":"key = sk_live_abcdefgh12345678',
  };
  const text = render(manifest(), demoFindings(), reasoningRecord(DEMO_CLASSES), failed);
  const after = text.slice(text.indexOf('## After the patch'));
  assert.ok(!after.includes('The scan ran again'), after);
  assert.ok(after.includes('The scan could not run again on the patched code'), after);
  assert.ok(after.includes('engine JSON could not be parsed'), 'the reason is shown');
  assert.ok(!after.includes('sk_live_abcdefgh12345678'), 'a secret in the error is masked');
  assert.ok(!after.includes('| Problem | Patched |'), 'no per-class table without a re-scan');
  assert.ok(after.includes('Result: not green.'));
});

test('a patch loop that stopped early says so even when the re-scan ran', () => {
  const stopped: PatchRecordT = {
    ...demoPatch(),
    green: false,
    error: 'stopped before spending more: the model API answered 402',
  };
  const text = render(manifest(), demoFindings(), reasoningRecord(DEMO_CLASSES), stopped);
  assert.ok(text.includes('The scan ran again on the patched code'));
  assert.ok(text.includes('the model API answered 402'), 'the stop reason is shown');
  // The tests passed, so the headline must not blame them.
  assert.ok(
    text.includes(
      "The app's own tests: passed (run on this computer, not in a sealed container). Result: closed, but not green because the patch loop stopped early (see below).",
    ),
    text.slice(text.indexOf('## After the patch')),
  );
  assert.ok(!text.includes('the tests did not run or did not pass'));
});

test('a patch that added a new flag is not called closed', () => {
  const added: PatchRecordT = {
    ...demoPatch(),
    rescan: { ...demoPatch().rescan, introduced: 1 },
    green: false,
  };
  const text = render(manifest(), demoFindings(), reasoningRecord(DEMO_CLASSES), added);
  assert.ok(text.includes('2 still flagged by a rule, 1 new.'));
  assert.ok(text.includes("The app's own tests: passed"));
  assert.ok(text.includes('Result: not green.'), text.slice(text.indexOf('## After the patch')));
});

test('closed work whose tests failed says the tests are why', () => {
  const failed: PatchRecordT = {
    ...demoPatch(),
    tests: { ...demoPatch().tests, passed: false },
    green: false,
  };
  const text = render(manifest(), demoFindings(), reasoningRecord(DEMO_CLASSES), failed);
  assert.ok(
    text.includes('Result: closed, but not green because the tests did not run or did not pass.'),
  );
});

test('a scan with no findings says so plainly, with no empty table', () => {
  const text = render({ ...manifest(), filesScanned: 1 }, [], null);
  assert.ok(text.includes('The scanner checked 1 file and found nothing to report.'), text);
  assert.ok(!text.includes('| Problem |'), 'no empty table');
  assert.ok(!text.includes('Fix first'));
  assert.ok(!text.includes('0 kinds'));
  assert.ok(!text.includes('cli.ts reason'), 'nothing to reason about');
  assert.ok(text.includes('checks over 1 file ('));
  const empty = render({ ...manifest(), filesScanned: 0 }, [], null);
  assert.ok(empty.includes('The scanner found no files to check here.'), empty);
});

test('the first-pass hint names the real run folder', () => {
  const findings = [finding('s1', 'sql-injection', 'routes/users.js:9')];
  const inside = join(process.cwd(), 'custom-out', 'r1');
  assert.ok(
    render(manifest(), findings, null, null, null, inside).includes(
      `run: \`node src/cli.ts reason ${join('custom-out', 'r1')}\``,
    ),
  );
  const outside = join(tmpdir(), 'va2-elsewhere', 'r1');
  assert.ok(
    render(manifest(), findings, null, null, null, outside).includes(
      `run: \`node src/cli.ts reason ${outside}\``,
    ),
  );
});

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  const end = text.indexOf('\n## ', start + 1);
  return text.slice(start, end === -1 ? undefined : end);
}

test('the report reads plainly for a founder', () => {
  const findings = [
    ...demoFindings(),
    finding('i1', 'input-handling', 'routes/network.js:9'),
    finding('h1', 'hardening-config', '.gitignore:1', null, 'warning'),
  ];
  const run = { ...manifest(), commit: 'abcdef1234567890abcdef1234567890abcdef12' };
  const text = render(run, findings, reasoningRecord(DEMO_CLASSES), demoPatch());

  assert.ok(text.includes('(commit abcdef1)'), 'a commit is called a commit');
  assert.ok(
    text.includes(
      'The scanner raised 12 flags on 8 lines. A reasoning model looked closely at 9 of them, in the 5 kinds of problem that matter most. 6 are confirmed or likely exploitable, on 4 lines in 3 files.',
    ),
    text.split('\n')[6],
  );
  assert.ok(text.includes('| Problem | Flags | How sure we are | What it means |'));
  // The only critical the report does not show elsewhere: network.js:9 is shown as a command.
  const also = text.split('\n').find((l) => l.startsWith('**Also serious, not covered below:**'));
  assert.equal(
    also,
    '**Also serious, not covered below:** Your server can be made to call other systems (routes/preview.js, line 8). Details are in findings.json.',
  );

  // A closed verdict gets no attack steps and no reach, and does not claim a guard closed a path.
  const secrets = section(text, 'Passwords and keys sitting in the code');
  assert.ok(secrets.includes('**Verdict:** Not exploitable as the code stands. Confidence: high.'));
  assert.ok(!secrets.includes('How it happens'), secrets);
  assert.ok(!secrets.includes('How far it reaches'));
  assert.ok(secrets.includes('**Smallest fix (for your developer):** Fix k1.'));

  const sql = section(text, 'Someone can rewrite your database commands');
  assert.ok(sql.includes('**How it happens (for your developer):**'));
  assert.ok(sql.includes('**How far it reaches:** many users.'));
  assert.ok(!text.includes('Blast radius'));
  assert.ok(!/Confidence \d+%/.test(text), 'no percentage that reads as certainty');

  const after = section(text, 'After the patch');
  assert.ok(
    after.includes(
      "The app's own tests: passed (run on this computer, not in a sealed container). Result: green, meaning every patched problem is gone or was judged closed, and the app's own tests pass.",
    ),
    after,
  );
});
