import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyEdits } from '../src/patch/edits.ts';
import { type PatchOptions, runPatchLoop } from '../src/patch/loop.ts';
import { runScan } from '../src/pipeline/run.ts';
import type { ClientConfig } from '../src/reason/meta-client.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

const SQL_BEFORE =
  'const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);';
const EXEC_BEFORE = 'exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {';

/**
 * Copy the seeded app so the loop can create branches and edit files freely.
 * Its own tests never import express, so the dependency is dropped: with no
 * dependencies the project-test step skips npm install and needs no network.
 */
function freshCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'va2-patch-'));
  const app = join(dir, 'app');
  cpSync('examples/seeded-app', app, { recursive: true });
  const pkgFile = join(app, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, unknown>;
  delete pkg.dependencies;
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  return app;
}

/** A fake Muse Spark that knows how to fix the seeded routes with exact edits. */
function fakePatcher(log: string[]): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
      response_format: { json_schema: { name: string } };
    };
    const prompt = body.messages[1]?.content ?? '';
    log.push(prompt);
    let plan: unknown;
    if (body.response_format.json_schema.name === 'ExploitVerdict') {
      plan = {
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
      };
    } else if (prompt.includes('Location: routes/users.js:9')) {
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
  assert.ok(
    record.green,
    `expected green: ${JSON.stringify({ remaining: record.rescan.remaining, introduced: record.rescan.introduced, verification: record.verification, tests: record.tests.passed })}`,
  );
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

/** Scan a fresh copy of the seeded app; returns the run folder. */
async function scanFresh(prefix: string): Promise<string> {
  const scan = await runScan(freshCopy(), {
    outDir: mkdtempSync(join(tmpdir(), prefix)),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  return scan.runDir;
}

function loopOptions(client: ClientConfig, overrides: Partial<PatchOptions> = {}): PatchOptions {
  return {
    backend: 'api',
    client,
    museModel: 'muse-spark-1.3',
    classes: ['sql-injection'],
    maxFindings: 1,
    runTests: false,
    useDocker: false,
    allowLocalTests: false,
    budgetUsd: 5,
    dryRun: false,
    ...overrides,
  };
}

test('a second patch run on a local target starts again from the snapshot', async () => {
  const runDir = await scanFresh('va2-patch-rerun-');
  const first = await runPatchLoop(runDir, loopOptions(fakePatcher([])));
  assert.ok(first.patchCommit, 'first run commits a patch');
  const second = await runPatchLoop(runDir, loopOptions(fakePatcher([])));
  assert.equal(second.baseCommit, first.baseCommit, 'same base commit both times');
  assert.ok(second.patchCommit, `second run commits a patch: ${JSON.stringify(second.outcomes)}`);
  assert.ok(readFileSync(join(runDir, 'patch.diff'), 'utf8').includes('$1'), 'diff kept');
});

test('a dry run never overwrites a live patch record or its stage', async () => {
  const runDir = await scanFresh('va2-patch-dry-live-');
  const live = await runPatchLoop(runDir, loopOptions(fakePatcher([])));
  assert.ok(live.patchCommit);
  const liveRecord = readFileSync(join(runDir, 'patch.json'), 'utf8');
  const liveManifest = readFileSync(join(runDir, 'manifest.json'), 'utf8');
  const dry = await runPatchLoop(runDir, loopOptions(fakePatcher([]), { dryRun: true }));
  assert.equal(dry.patchCommit, null);
  assert.equal(readFileSync(join(runDir, 'patch.json'), 'utf8'), liveRecord);
  assert.equal(readFileSync(join(runDir, 'manifest.json'), 'utf8'), liveManifest);
  assert.ok(existsSync(join(runDir, 'patch.dry-run.json')), 'the plan is written beside it');
});

test('edits that add a scanner suppression together are rejected, however they are split', async () => {
  const dir = freshCopy();
  const network = join(dir, 'routes/network.js');
  const original = readFileSync(network, 'utf8');
  // Two edits, neither of which holds the whole token, assemble it in the file.
  const split = await applyEdits(
    dir,
    [
      {
        file: 'routes/network.js',
        search: EXEC_BEFORE,
        replace: `${EXEC_BEFORE} // vibe-audit-`,
        why: 'a',
      },
      { file: 'routes/network.js', search: 'audit-\n', replace: 'audit-ignore\n', why: 'b' },
    ],
    { allowedFiles: ['routes/network.js'] },
  );
  assert.ok(
    split.every((r) => !r.applied),
    JSON.stringify(split.map((r) => r.reason)),
  );
  assert.equal(readFileSync(network, 'utf8'), original);

  // A search that already holds a suppression cannot carry a second one in.
  const files = join(dir, 'routes/files.js');
  writeFileSync(
    files,
    readFileSync(files, 'utf8').replace(
      "import path from 'node:path';",
      "import path from 'node:path'; // vibe-audit-ignore",
    ),
  );
  const piggyback = await applyEdits(
    dir,
    [
      {
        file: 'routes/files.js',
        search: "import path from 'node:path'; // vibe-audit-ignore",
        replace:
          "import path from 'node:path'; // vibe-audit-ignore\n// vibe-audit-ignore-next-line",
        why: 'c',
      },
    ],
    { allowedFiles: ['routes/files.js'] },
  );
  assert.equal(piggyback[0]?.applied, false);
  assert.ok(!readFileSync(files, 'utf8').includes('-next-line'));
});

/**
 * Wrap a fake client so calls for one schema (or all) fail with an HTTP
 * status, after the first `passFirst` of them went through.
 */
function failing(
  client: ClientConfig,
  status: number,
  schemaName: string | null,
  calls: string[],
  passFirst = 0,
): ClientConfig {
  const inner = client.fetchImpl as typeof fetch;
  let passed = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const name = (
      JSON.parse(String(init?.body)) as { response_format: { json_schema: { name: string } } }
    ).response_format.json_schema.name;
    if ((schemaName === null || name === schemaName) && passed++ >= passFirst) {
      calls.push(name);
      return new Response('{"error":"no"}', { status });
    }
    return inner(url, init);
  }) as typeof fetch;
  return { ...client, fetchImpl, maxRetries: 0 };
}

test('a 401 from the model stops the patch loop before the next finding is sent', async () => {
  const runDir = await scanFresh('va2-patch-fatal-');
  const calls: string[] = [];
  const answered: string[] = [];
  const record = await runPatchLoop(
    runDir,
    loopOptions(failing(fakePatcher(answered), 401, null, calls, 1), {
      classes: ['sql-injection', 'command-injection', 'path-traversal'],
      maxFindings: 10,
    }),
  );
  assert.ok(record.selected.length >= 3, `selected ${record.selected.length}`);
  assert.equal(answered.length, 1, 'the first finding was answered');
  assert.equal(calls.length, 1, 'one failed call, then stop: no next finding, no verification');
  assert.equal(record.outcomes.length, 2);
  assert.match(record.error ?? '', /401/);
  assert.equal(record.green, false);
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as {
    stages: { patch: string };
  };
  assert.equal(manifest.stages.patch, 'failed');
});

test('a 402 while re-judging still-flagged findings stops the verification loop', async () => {
  const runDir = await scanFresh('va2-patch-fatal-verify-');
  const calls: string[] = [];
  const record = await runPatchLoop(
    runDir,
    loopOptions(failing(fakePatcher([]), 402, 'ExploitVerdict', calls), {
      classes: ['sql-injection', 'command-injection', 'path-traversal'],
      maxFindings: 10,
    }),
  );
  assert.ok(record.patchCommit, 'the patch itself went through');
  assert.ok(record.rescan.remaining.length >= 2, `remaining ${record.rescan.remaining.length}`);
  assert.equal(calls.length, 1, 'one verification call, then stop');
  assert.match(record.error ?? '', /402/);
  assert.equal(record.green, false);
});
