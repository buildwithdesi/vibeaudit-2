import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdits } from '../src/patch/edits.ts';
import { runPatchLoop } from '../src/patch/loop.ts';
import { runScan } from '../src/pipeline/run.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

const SQL_BEFORE =
  'const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);';
const EXEC_BEFORE = 'exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {';

/** Copy the seeded app so the loop can create branches and edit files freely. */
function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'va2-patch-'));
  cpSync('examples/seeded-app', join(dir, 'app'), { recursive: true });
  return join(dir, 'app');
}

/** A fake Muse Spark that knows how to fix the seeded routes with exact edits. */
function fakePatcher(log: string[]): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const prompt = body.messages[1]?.content ?? '';
    log.push(prompt);
    let plan: unknown;
    if (prompt.includes('Location: routes/users.js:9')) {
      plan = {
        edits: [
          {
            file: 'routes/users.js',
            search: SQL_BEFORE,
            replace:
              "// Bound as a parameter so the id can never rewrite the query.\nconst rows = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);",
            why: 'parameterized query',
          },
        ],
        newDependencies: [],
        note: 'Bound the id as a parameter. Review that db.query accepts a values array.',
        confidence: 0.9,
      };
    } else if (prompt.includes('routes/network.js')) {
      plan = {
        edits: [
          {
            file: 'routes/network.js',
            search: "import { exec } from 'node:child_process';",
            replace: "import { execFile } from 'node:child_process';",
            why: 'no shell',
          },
          {
            file: 'routes/network.js',
            search: EXEC_BEFORE,
            replace: "execFile('ping', ['-c', '1', String(req.query.host)], (error, stdout) => {",
            why: 'argument array instead of a shell string',
          },
        ],
        newDependencies: [],
        note: 'Switched to execFile with an argument array.',
        confidence: 0.9,
      };
    } else {
      plan = {
        edits: [],
        newDependencies: [],
        note: 'No safe fix from the visible code.',
        confidence: 0.3,
      };
    }
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

test('edits apply only on the allowlist, atomically per file, matching the file line endings', async () => {
  const dir = freshCopy();
  const results = await applyEdits(
    dir,
    [
      {
        file: 'routes/files.js',
        search: 'req.query.file',
        replace: 'path.basename(String(req.query.file))',
        why: 'strip directories',
      },
      {
        file: 'routes/files.js',
        search: 'Router',
        replace: 'X',
        why: 'appears twice, must be rejected',
      },
      { file: '../outside.js', search: 'a', replace: 'b', why: 'escapes repo' },
      { file: 'routes/users.js', search: 'Router', replace: 'X', why: 'not on the allowlist' },
      {
        file: '.git/config',
        search: '[core]',
        replace: '[core]\n\tfsmonitor = evil',
        why: 'git config',
      },
      {
        file: 'package.json',
        search: '"test"',
        replace: '"test": "true", "x"',
        why: 'test script',
      },
      {
        file: 'routes/preview.js',
        search: 'fetch(',
        replace: '// vibe-audit-ignore ssrf-vulnerability\n  fetch(',
        why: 'suppress',
      },
    ],
    { allowedFiles: ['routes/files.js', 'routes/preview.js'] },
  );
  const reasons = results.map((r) => r.reason);
  // The two routes/files.js edits are one atomic unit: the duplicate search rejects both.
  assert.ok(reasons[0]?.startsWith('not applied: another edit for this file failed'), reasons[0]);
  assert.equal(reasons[1], 'search text appears more than once');
  assert.equal(reasons[2], 'path is not a plain relative path');
  assert.equal(reasons[3], 'file is not on the allowlist for this finding');
  assert.equal(reasons[4], 'path touches the .git directory');
  assert.equal(reasons[5], 'package.json may not be patched');
  assert.equal(reasons[6], 'replacement would suppress the scanner instead of fixing the code');
  assert.ok(
    !readFileSync(join(dir, 'routes/files.js'), 'utf8').includes('path.basename'),
    'nothing written',
  );

  // A CRLF file accepts a multi-line LF search and keeps CRLF.
  const crlf = join(dir, 'routes/network.js');
  writeFileSync(crlf, readFileSync(crlf, 'utf8').replace(/\r?\n/g, '\r\n'));
  const multi = await applyEdits(
    dir,
    [
      {
        file: 'routes/network.js',
        search: "import { exec } from 'node:child_process';\nimport { Router } from 'express';",
        replace:
          "import { execFile } from 'node:child_process';\nimport { Router } from 'express';",
        why: 'multi-line on crlf',
      },
    ],
    { allowedFiles: ['routes/network.js'] },
  );
  assert.deepEqual(
    multi.map((r) => r.reason),
    ['applied'],
  );
  const after = readFileSync(crlf, 'utf8');
  assert.ok(
    after.includes("import { execFile } from 'node:child_process';\r\n"),
    'edit landed and CRLF kept',
  );
});

test('patch loop: branch, exact edits, re-scan shows findings gone, project tests pass', async () => {
  const app = freshCopy();
  const outDir = mkdtempSync(join(tmpdir(), 'va2-patch-run-'));
  const scan = await runScan(app, {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  const log: string[] = [];
  const record = await runPatchLoop(scan.runDir, {
    backend: 'api',
    client: fakePatcher(log),
    museModel: 'muse-spark-1.3',
    classes: ['sql-injection', 'command-injection'],
    maxFindings: 10,
    runTests: true,
    useDocker: false,
    allowLocalTests: true,
    budgetUsd: 5,
    dryRun: false,
  });

  assert.equal(record.backend, 'api');
  assert.ok(record.branch?.startsWith('vibeaudit2/patch-'));
  assert.equal(record.error, null);
  assert.ok(record.patchCommit, 'patch committed on the sandbox branch');
  assert.ok(existsSync(join(scan.runDir, 'patch.diff')));
  assert.ok(existsSync(join(scan.runDir, 'findings.after.json')));
  for (const p of log)
    assert.ok(!p.includes('Winter2026Prod'), 'no planted secret reaches the patch prompt');

  const diff = readFileSync(join(scan.runDir, 'patch.diff'), 'utf8');
  assert.ok(diff.includes("db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);"));
  assert.ok(diff.includes("+  execFile('ping', ['-c', '1', String(req.query.host)]"));

  // The template-literal SQL on line 9 and the exec on line 9 are gone; the
  // concatenated DELETE on line 15 was not selected (the fake has no fix for it).
  assert.ok(record.rescan.resolved.length >= 2, `resolved ${record.rescan.resolved.length}`);
  assert.equal(record.rescan.introduced, 0, 'a line-shifting edit must not count survivors as new');
  assert.ok(record.tests.ran && record.tests.passed, `tests: ${record.tests.outputTail}`);
  assert.equal(record.tests.runner, 'local');
  assert.equal(record.rescanClean, record.rescan.remaining.length === 0);
  assert.ok(record.workDir?.endsWith('repo'), 'patched the copy, not the source folder');
  assert.ok(
    !readFileSync(join(app, 'routes/users.js'), 'utf8').includes('$1'),
    'source folder untouched',
  );
  assert.ok(record.usd > 0);

  const manifest = JSON.parse(readFileSync(join(scan.runDir, 'manifest.json'), 'utf8')) as {
    stages: { patch: string };
  };
  assert.equal(manifest.stages.patch, 'done');
});

test('dry run plans without touching the tree', async () => {
  const app = freshCopy();
  const outDir = mkdtempSync(join(tmpdir(), 'va2-patch-dry-'));
  const scan = await runScan(app, {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  const before = readFileSync(join(app, 'routes/users.js'), 'utf8');
  const record = await runPatchLoop(scan.runDir, {
    backend: 'api',
    client: fakePatcher([]),
    museModel: 'muse-spark-1.3',
    classes: null,
    maxFindings: 10,
    runTests: false,
    useDocker: false,
    allowLocalTests: false,
    budgetUsd: 5,
    dryRun: true,
  });
  assert.equal(record.patchCommit, null);
  assert.ok(record.selected.length > 0);
  assert.equal(readFileSync(join(app, 'routes/users.js'), 'utf8'), before);
});
