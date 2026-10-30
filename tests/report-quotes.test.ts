import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { FindingT, RunManifestT } from '../src/model/finding.ts';
import { quoteChecker, renderProofOfRisk } from '../src/report/proof-of-risk.ts';

/** A repo folder with a host file next to it that no quote may ever be checked against. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'va2-quotes-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'routes'), { recursive: true });
  writeFileSync(join(repo, 'routes', 'users.js'), 'const rows = await db.query(sql);\n');
  writeFileSync(join(dir, 'host.txt'), 'root:x:0:0:root:/root:/bin/bash\n');
  writeFileSync(join(repo, 'big.js'), `const marker = 1;\n${'x'.repeat(3 * 1024 * 1024)}\n`);
  return repo;
}

/** False where symlinks need Developer Mode or admin rights (Windows), so that case is skipped, not failed. */
function link(target: string, path: string, type?: 'junction'): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (caught) {
    if ((caught as { code?: string }).code === 'EPERM') return false;
    throw caught;
  }
}

const NO_LINKS = 'symlinks need Developer Mode or admin rights on Windows';

test('quote checker never reads outside the repo or a huge file', async () => {
  const repo = fixture();
  const files = ['routes/users.js', '../host.txt', 'big.js'];
  const check = await quoteChecker(repo, files);
  assert.equal(check('routes/users.js', 'const rows = await db.query(sql);'), true);
  assert.equal(check('routes/users.js', 'const rows = made.up();'), false);
  // A model-supplied path that climbs out of the repo cannot hold a quote from it.
  assert.equal(check('../host.txt', 'root:x:0:0:root:/root:/bin/bash'), false);
  // Files the code-context guard refuses are not read, so they are not checked.
  assert.equal(check('big.js', 'const marker = 1;'), null);
});

test('quote checker never reads through a symlinked file', async (t) => {
  const repo = fixture();
  if (!link(join(repo, '..', 'host.txt'), join(repo, 'link.txt'))) return t.skip(NO_LINKS);
  const check = await quoteChecker(repo, ['link.txt']);
  assert.equal(check('link.txt', 'root:x:0:0:root:/root:/bin/bash'), null);
});

test('a path written with a leading slash is read inside the repo, as before', async () => {
  const check = await quoteChecker(fixture(), ['/routes/users.js', '\\routes\\users.js']);
  assert.equal(check('/routes/users.js', 'const rows = await db.query(sql);'), true);
  assert.equal(check('\\routes\\users.js', 'const rows = await db.query(sql);'), true);
  assert.equal(check('/routes/users.js', 'const rows = made.up();'), false);
});

test('a repo folder that is itself a symlink is still checked', async (t) => {
  const repo = fixture();
  const linked = join(repo, '..', 'linked-repo');
  // A junction needs no extra rights on Windows; elsewhere the type is ignored.
  if (!link(repo, linked, 'junction')) return t.skip(NO_LINKS);
  const check = await quoteChecker(linked, ['routes/users.js', '../host.txt']);
  assert.equal(check('routes/users.js', 'const rows = await db.query(sql);'), true);
  assert.equal(check('routes/users.js', 'const rows = made.up();'), false);
  assert.equal(check('../host.txt', 'root:x:0:0:root:/root:/bin/bash'), false);
});

const CONFIG_JS = [
  'export const database = {',
  "  password: 'Winter2026Prod!',",
  "  connectionString: 'postgres://app:Winter2026Prod@db.internal:5432/app',",
  '};',
  '',
].join('\n');

test('a quote of masked code matches the file it came from', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'va2-quotes-'));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server', 'config.js'), CONFIG_JS);
  const check = await quoteChecker(dir, ['server/config.js']);
  // The model only ever saw the masked file, so this is what it quotes.
  assert.equal(check('server/config.js', "password: '[REDACTED:15]',"), true);
  assert.equal(check('server/config.js', "password: '[REDACTED]',"), true);
  assert.equal(
    check(
      'server/config.js',
      "connectionString: 'postgres://app:[REDACTED]@db.internal:5432/app',",
    ),
    true,
  );
  assert.equal(check('server/config.js', "password: '[REDACTED:15]', admin: true,"), false);
});

test('a repo that is not on this machine leaves every quote unchecked, not made up', async () => {
  const check = await quoteChecker('/nonexistent/va2/repo', ['routes/users.js']);
  assert.equal(check('routes/users.js', 'const rows = await db.query(sql);'), null);
});

function verdictFinding(quote: string): FindingT {
  return {
    id: 'k1',
    ruleId: 'hardcoded-credentials',
    ruleName: 'Hardcoded credentials',
    severity: 'critical',
    vulnClass: 'secrets',
    message: 'A password is written into the code.',
    file: 'server/config.js',
    line: 2,
    evidence: null,
    fix: '',
    cweId: null,
    cvssScore: null,
    owaspCategory: null,
    source: null,
    context: null,
    triage: null,
    reasoning: {
      exploitability: 'not-exploitable',
      confidence: 0.9,
      attackerPosition: 'none',
      preconditions: [],
      attackPath: [],
      impact: 'none',
      blastRadius: 'single-user',
      evidence: [{ file: 'server/config.js', line: 2, quote }],
      severityAdjustment: 'lower',
      fixSummary: 'Load the password from the environment.',
      plainLanguage: 'The password is fake.',
    },
  };
}

/** A GitHub run folder moved off the machine that cloned it: target.path is gone, repo/ came along. */
function movedRun(quote: string, withRepo: boolean): string {
  const runDir = mkdtempSync(join(tmpdir(), 'va2-moved-run-'));
  const manifest: RunManifestT = {
    runId: 'moved',
    createdAt: '2026-10-27T00:00:00.000Z',
    tool: { name: 'vibeaudit-2', version: 'test' },
    target: {
      kind: 'github',
      label: 'owner/app',
      url: 'https://github.com/owner/app',
      ref: null,
      path: 'C:\\Users\\someone\\runs\\moved\\repo',
    },
    commit: null,
    engine: {
      name: '@jackdog668/vibeaudit',
      version: '1.4.0',
      rulesAvailable: 104,
      rulesRun: 104,
      sca: false,
      trustTargetConfig: false,
    },
    filesScanned: 1,
    durationMs: { clone: 0, engine: 0, total: 0 },
    counts: { total: 1, bySeverity: { critical: 1 }, byClass: { secrets: 1 } },
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
  writeFileSync(join(runDir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(runDir, 'findings.json'), JSON.stringify([verdictFinding(quote)]));
  if (withRepo) {
    mkdirSync(join(runDir, 'repo', 'server'), { recursive: true });
    writeFileSync(join(runDir, 'repo', 'server', 'config.js'), CONFIG_JS);
  }
  return runDir;
}

const FLAG = 'not matched word for word';

test('the report checks quotes in a moved run folder, and never calls a masked quote made up', async () => {
  const real = "password: '[REDACTED:15]',";
  assert.ok(!(await renderProofOfRisk(movedRun(real, true))).includes(FLAG));
  assert.ok(!(await renderProofOfRisk(movedRun(real, false))).includes(FLAG), 'no repo: unchecked');
  const invented = "password: process.env.DB_PASSWORD ?? 'admin',";
  assert.ok((await renderProofOfRisk(movedRun(invented, true))).includes(FLAG));
});
