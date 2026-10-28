import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runPatchLoop } from '../src/patch/loop.ts';
import { runScan } from '../src/pipeline/run.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';
import { renderProofOfRisk } from '../src/report/proof-of-risk.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

const SQL_BEFORE =
  'const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);';

/** A fake Muse Spark: fixes the SQL on users.js line 9, has no fix for line 15, and re-judges everything closed. */
function fakePatcher(): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
      response_format: { json_schema: { name: string } };
    };
    const prompt = body.messages[1]?.content ?? '';
    const plan =
      body.response_format.json_schema.name === 'ExploitVerdict'
        ? {
            exploitability: 'not-exploitable',
            confidence: 0.9,
            attackerPosition: 'none',
            preconditions: [],
            attackPath: [],
            impact: 'none',
            blastRadius: 'single-user',
            evidence: [],
            severityAdjustment: 'lower',
            fixSummary: 'already fixed',
            plainLanguage: 'The patched code closes this path.',
          }
        : {
            edits: prompt.includes('routes/users.js:9')
              ? [
                  {
                    file: 'routes/users.js',
                    search: SQL_BEFORE,
                    replace:
                      "const rows = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);",
                    why: 'parameterized query',
                  },
                ]
              : [],
            newDependencies: [],
            note: 'Bound the id as a parameter.',
            confidence: 0.9,
          };
    return new Response(
      JSON.stringify({
        model: 'muse-spark-1.3',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 1500, completion_tokens: 200 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'muse-spark-1.3', fetchImpl };
}

test('the report after a real patch loop: counts add up, every fixed class has a row', async () => {
  const app = join(mkdtempSync(join(tmpdir(), 'va2-report-patch-')), 'app');
  cpSync('examples/seeded-app', app, { recursive: true });
  const scan = await runScan(app, {
    outDir: mkdtempSync(join(tmpdir(), 'va2-report-patch-run-')),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  // The login and SQL findings share lines 9 and 15, so each lead carries a sibling.
  const record = await runPatchLoop(scan.runDir, {
    backend: 'api',
    client: fakePatcher(),
    museModel: 'muse-spark-1.3',
    classes: ['sql-injection', 'missing-auth'],
    maxFindings: 10,
    runTests: false,
    useDocker: false,
    allowLocalTests: false,
    budgetUsd: 5,
    dryRun: false,
  });
  assert.ok(record.patchCommit, `patch committed: ${record.error}`);

  const report = await renderProofOfRisk(scan.runDir);
  assert.ok(report.includes('## After the patch'));
  assert.ok(!report.includes('Winter2026Prod'), 'no planted secret in the report');

  const head =
    /patched (\d+) findings?(?: in (\d+) places?)? on branch .*?: (\d+) fixed, (\d+) still flagged/.exec(
      report,
    );
  assert.ok(head, 'the after-the-patch headline is there');
  const [patched, places, fixed, flagged] = [head[1], head[2], head[3], head[4]].map(Number);
  assert.equal(fixed, record.rescan.resolved.length);
  assert.equal(flagged, record.rescan.remaining.length);
  assert.equal(patched, fixed + flagged, 'every patched finding is fixed or still flagged');
  assert.equal(places, record.selected.length);
  assert.ok(patched > record.selected.length, 'siblings counted alongside their leads');

  const after = report.slice(report.indexOf('## After the patch'));
  for (const row of [
    /\| Someone can rewrite your database commands \| 2 \| 1 \| 1 \|/,
    /\| Anyone can reach things that should need a login \| 2 \| 0 \| 2 \|/,
  ]) {
    assert.match(after, row);
  }
  assert.ok(
    readFileSync(join(scan.runDir, 'patch.diff'), 'utf8').includes('$1'),
    'the fix is in the diff',
  );
});
