import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { applyEdits } from '../src/patch/edits.ts';
import {
  type PatchOptions,
  PatchRecord,
  type PatchRecordT,
  runPatchLoop,
} from '../src/patch/loop.ts';
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
/** With `truncateVerdicts`, every re-check answer stops at the output cap: billed, unusable. */
function fakePatcher(log: string[], truncateVerdicts = false): ClientConfig {
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
    } else if (prompt.includes('routes/users.js:9')) {
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
    const verdict = body.response_format.json_schema.name === 'ExploitVerdict';
    const finish = truncateVerdicts && verdict ? 'length' : 'stop';
    return new Response(
      JSON.stringify({
        model: 'muse-spark-1.3',
        choices: [{ finish_reason: finish, message: { content: JSON.stringify(plan) } }],
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

test('patch loop: branch, exact edits, findings closed by re-scan or re-check, project tests pass', async () => {
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

test('the record keeps why each rejected edit was rejected', async () => {
  const runDir = await scanFresh('va2-patch-reasons-');
  const stale = (async (_url: string | URL | Request, init?: RequestInit) => {
    const prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> })
      .messages[1]?.content;
    const file = /label="location">\n([^:\s]+)/.exec(prompt ?? '')?.[1] ?? '';
    const plan = {
      edits: [{ file, search: 'text the file does not have', replace: 'x', why: 'stale' }],
      newDependencies: [],
      note: 'A stale edit.',
      confidence: 0.5,
    };
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const client = { ...fakePatcher([]), fetchImpl: stale };
  const record = await runPatchLoop(runDir, loopOptions(client));
  assert.deepEqual(record.outcomes[0]?.rejected, ['routes/users.js: search text not found']);
  const saved = JSON.parse(readFileSync(join(runDir, 'patch.json'), 'utf8')) as PatchRecordT;
  assert.deepEqual(saved.outcomes[0]?.rejected, ['routes/users.js: search text not found']);
});

test('an older patch record without rejection reasons still loads', () => {
  const old = JSON.parse(readFileSync('demo/after/patch.json', 'utf8')) as {
    outcomes: Array<Record<string, unknown>>;
  };
  for (const o of old.outcomes) delete o.rejected;
  assert.deepEqual(PatchRecord.parse(old).outcomes[0]?.rejected, []);
});

test('patch.diff masks a credential on a context line next to the fix', async () => {
  const app = freshCopy();
  const users = join(app, 'routes/users.js');
  const key = 'sk_live_51PlantedContextKey0000';
  // Line 12 is the blank line between the two routes: line numbers stay put.
  const lines = readFileSync(users, 'utf8').split('\n');
  assert.equal(lines[11], '');
  lines[11] = `const billingKey = '${key}';`;
  writeFileSync(users, lines.join('\n'));
  const scan = await runScan(app, {
    outDir: mkdtempSync(join(tmpdir(), 'va2-patch-mask-')),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  const record = await runPatchLoop(scan.runDir, loopOptions(fakePatcher([])));
  assert.ok(record.patchCommit);
  const diff = readFileSync(join(scan.runDir, 'patch.diff'), 'utf8');
  assert.ok(diff.includes('$1'), 'the fix is in the diff');
  assert.ok(diff.includes('billingKey'), 'the context line is in the diff');
  assert.ok(!diff.includes(key), 'the credential is masked');
});

test('patch loop: a billed but unusable re-check is charged and never counts as closed', async () => {
  const app = freshCopy();
  const outDir = mkdtempSync(join(tmpdir(), 'va2-patch-run-'));
  const scan = await runScan(app, {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  const record = await runPatchLoop(scan.runDir, {
    backend: 'api',
    client: fakePatcher([], true),
    museModel: 'muse-spark-1.3',
    classes: ['sql-injection', 'command-injection'],
    maxFindings: 10,
    runTests: false,
    useDocker: false,
    allowLocalTests: false,
    budgetUsd: 5,
    dryRun: false,
  });

  assert.ok(record.rescan.remaining.length > 0, 'a rule still fires, so a re-check is bought');
  assert.equal(record.verification.length, 0, 'no usable re-check answer');
  assert.equal(record.verifiedClean, false);
  // Each unusable re-check bills 1,500 input and 200 output tokens: about $0.0027.
  const answered = record.outcomes.reduce((n, o) => n + o.usd, 0);
  assert.ok(
    record.usd - answered >= 0.0025,
    `re-check spend charged: ${record.usd} vs ${answered} for the answered patch calls`,
  );
});

/**
 * A folder named runs inside the app is the app's own code: the engine scans
 * it, so the copy must hold it. Only the pipeline's own runs folder stays out.
 * The fake fixes lib/ping.js and has nothing for src/runs/job.js.
 */
function runsFolderApp(): string {
  const app = join(mkdtempSync(join(tmpdir(), 'va2-patch-runs-')), 'app');
  const ping = (name: string): string =>
    `import { exec } from 'node:child_process';\nexport function ${name}(req) {\n  exec(\`ping -c 1 \${req.query.host}\`);\n}\n`;
  mkdirSync(join(app, 'src', 'runs'), { recursive: true });
  writeFileSync(join(app, 'src', 'runs', 'job.js'), ping('run'));
  mkdirSync(join(app, 'lib'), { recursive: true });
  writeFileSync(join(app, 'lib', 'ping.js'), ping('ping'));
  writeFileSync(
    join(app, 'package.json'),
    JSON.stringify({ name: 'a', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  return app;
}

function pingFixer(): ClientConfig {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const edits = String(init?.body).includes('lib/ping.js:3')
      ? [
          {
            file: 'lib/ping.js',
            search: 'exec(`ping -c 1 ${req.query.host}`);',
            replace: '// removed',
            why: 'no shell',
          },
        ]
      : [];
    const plan = { edits, newDependencies: [], note: 'none', confidence: 0.5 };
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { baseUrl: 'https://fake.local/v1', apiKey: 'k', model: 'muse-spark-1.3', fetchImpl };
}

const RUNS_OPTIONS = {
  classes: null,
  maxFindings: 10,
  runTests: true,
  allowLocalTests: true,
} satisfies Partial<PatchOptions>;

test('a folder named runs in the app is copied and patched; the run folder itself is not', async () => {
  const app = runsFolderApp();
  const scan = await runScan(app, {
    outDir: mkdtempSync(join(tmpdir(), 'va2-patch-runs-out-')),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  assert.ok(scan.findings.some((f) => f.file === 'src/runs/job.js'));
  const pristine = join(mkdtempSync(join(tmpdir(), 'va2-patch-runs-pristine-')), 'run');
  cpSync(scan.runDir, pristine, { recursive: true });

  const record = await runPatchLoop(scan.runDir, loopOptions(pingFixer(), RUNS_OPTIONS));
  assert.equal(record.error, null);
  assert.ok(record.workDir && existsSync(join(record.workDir, 'src/runs/job.js')));
  assert.ok(
    record.outcomes.every((o) => o.note !== 'file not found'),
    JSON.stringify(record.outcomes),
  );
  const job = record.selected.filter((s) => s.file === 'src/runs/job.js').map((s) => s.id);
  assert.ok(job.length > 0);
  for (const id of job) assert.ok(record.rescan.remaining.includes(id), `${id} still open`);
  assert.equal(record.green, false);

  // The run folder inside the target, where the CLI's default --out puts it for `scan .`.
  const inside = join(app, 'runs', basename(scan.runDir));
  cpSync(pristine, inside, { recursive: true });
  const again = await runPatchLoop(inside, loopOptions(pingFixer(), RUNS_OPTIONS));
  assert.equal(again.error, null);
  assert.ok(again.workDir && existsSync(join(again.workDir, 'src/runs/job.js')));
  assert.equal(existsSync(join(again.workDir, 'runs')), false, 'the run folder is not copied');
});

test('a finding whose file the patch never changed is never counted fixed', async () => {
  const app = runsFolderApp();
  const scan = await runScan(app, {
    outDir: mkdtempSync(join(tmpdir(), 'va2-patch-gone-')),
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  // Gone before the copy: the patcher cannot find it and the re-scan cannot see it.
  rmSync(join(app, 'src', 'runs', 'job.js'));
  const record = await runPatchLoop(scan.runDir, loopOptions(pingFixer(), RUNS_OPTIONS));
  assert.ok(record.outcomes.some((o) => o.note === 'file not found'));
  assert.ok(record.patchCommit, 'lib/ping.js was patched');
  const job = record.selected.filter((s) => s.file === 'src/runs/job.js').map((s) => s.id);
  assert.ok(job.length > 0);
  for (const id of job) {
    assert.ok(!record.rescan.resolved.includes(id), `${id} not resolved`);
    assert.ok(record.rescan.remaining.includes(id), `${id} still open`);
  }
  assert.equal(record.rescanClean, false);
  assert.equal(record.green, false);
});

test('findings triage set aside are never patched', async () => {
  const runDir = await scanFresh('va2-patch-triage-');
  const file = join(runDir, 'findings.json');
  const findings = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
  // Everything set aside except the SELECT on users.js line 9.
  for (const f of findings) {
    const keep = f.file === 'routes/users.js' && f.line === 9;
    f.triage = {
      keep,
      category: keep ? 'real-code' : 'test-or-fixture',
      reason: 'r',
      confidence: 0.9,
    };
  }
  writeFileSync(file, JSON.stringify(findings));
  const record = await runPatchLoop(
    runDir,
    loopOptions(fakePatcher([]), { classes: null, maxFindings: 10, dryRun: true }),
  );
  assert.ok(record.selected.length > 0);
  assert.ok(
    record.selected.every((s) => s.file === 'routes/users.js'),
    JSON.stringify(record.selected),
  );

  for (const f of findings)
    f.triage = { keep: false, category: 'dead-code', reason: 'r', confidence: 0.9 };
  writeFileSync(file, JSON.stringify(findings));
  const none = await runPatchLoop(
    runDir,
    loopOptions(fakePatcher([]), { classes: null, maxFindings: 10, dryRun: true }),
  );
  assert.deepEqual(none.selected, []);
});

/** Run with the log on and return what it wrote to stderr. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value: T; text: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let text = '';
  process.stderr.write = ((chunk: string | Uint8Array) => {
    text += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  setLogLevel('normal');
  try {
    return { value: await fn(), text };
  } finally {
    setLogLevel('quiet');
    process.stderr.write = write;
  }
}

test('a closed patch that stopped on an error says so, not that the tests failed', async () => {
  const runDir = await scanFresh('va2-patch-closed-error-');
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls > 1) return new Response('{"error":"insufficient credit"}', { status: 402 });
    const plan = {
      edits: [
        {
          file: 'routes/users.js',
          search: SQL_BEFORE,
          replace:
            "const rows = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);",
          why: 'p',
        },
        {
          file: 'routes/users.js',
          search: "await db.query('DELETE FROM users WHERE id = ' + req.params.id);",
          replace: "await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);",
          why: 'p',
        },
      ],
      newDependencies: [],
      note: 'both lines',
      confidence: 0.9,
    };
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }],
        usage: { prompt_tokens: 1500, completion_tokens: 200 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const client = { ...fakePatcher([]), fetchImpl, maxRetries: 0 };
  const { value: record, text } = await captureStderr(() =>
    runPatchLoop(
      runDir,
      loopOptions(client, { maxFindings: 10, runTests: true, allowLocalTests: true }),
    ),
  );
  assert.ok(record.rescanClean && record.tests.ran && record.tests.passed, text);
  assert.match(record.error ?? '', /402/);
  assert.equal(record.green, false);
  const line = text.split('\n').find((l) => l.startsWith('patch loop ')) ?? '';
  assert.match(line, /^patch loop CLOSED, not green because the patch loop stopped early: /);
  assert.doesNotMatch(line, /tests not run or failed/);
});

test('an edit may not write a secret mask placeholder into the code', async () => {
  const dir = freshCopy();
  const config = join(dir, 'server/config.js');
  const original = readFileSync(config, 'utf8');
  const masked = await applyEdits(
    dir,
    [
      {
        file: 'server/config.js',
        search: "password: 'Winter2026Prod!',",
        replace: "password: '[REDACTED:15]',",
        why: 'a',
      },
    ],
    { allowedFiles: ['server/config.js'] },
  );
  assert.equal(masked[0]?.applied, false);
  assert.match(masked[0]?.reason ?? '', /mask placeholder/);
  assert.equal(readFileSync(config, 'utf8'), original);

  // A search that already holds one cannot carry a second one in.
  writeFileSync(config, `${original}// Logs print [REDACTED] in place of a secret.\n`);
  const piggyback = await applyEdits(
    dir,
    [
      {
        file: 'server/config.js',
        search: '// Logs print [REDACTED] in place of a secret.',
        replace:
          "// Logs print [REDACTED] in place of a secret.\nexport const key = '[REDACTED:20]';",
        why: 'b',
      },
    ],
    { allowedFiles: ['server/config.js'] },
  );
  assert.equal(piggyback[0]?.applied, false);
  assert.ok(!readFileSync(config, 'utf8').includes('[REDACTED:20]'));

  // Moving text that already holds one is still fine.
  const kept = await applyEdits(
    dir,
    [
      {
        file: 'server/config.js',
        search: '// Logs print [REDACTED] in place of a secret.',
        replace: '// Log lines print [REDACTED] in place of a secret.',
        why: 'c',
      },
    ],
    { allowedFiles: ['server/config.js'] },
  );
  assert.equal(kept[0]?.applied, true, kept[0]?.reason);
});
