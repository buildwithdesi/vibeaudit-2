import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { RunManifest } from '../src/model/finding.ts';
import { runScan } from '../src/pipeline/run.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

// Offline, like tests/clone.test.ts: HOME points at a .gitconfig that sends
// https://github.com/ to a bare repo in a temp folder.
const root = mkdtempSync(join(tmpdir(), 'va2-pipeclone-'));
after(() => rmSync(root, { recursive: true, force: true }));

const saved = Object.fromEntries(
  ['HOME', 'USERPROFILE', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].map((k) => [
    k,
    process.env[k],
  ]),
);
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { HOME: root, USERPROFILE: root, GIT_CONFIG_NOSYSTEM: '1', PATH: process.env.PATH },
  }).trim();
}

const work = join(root, 'work');
mkdirSync(join(work, 'src'), { recursive: true });
writeFileSync(join(work, 'src', 'app.js'), 'export const run = (req) => eval(req.query.code);\n');
git(work, ['init', '-q', '-b', 'main']);
git(work, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
git(work, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'app']);
const remotes = join(root, 'remotes');
mkdirSync(join(remotes, 'o'), { recursive: true });
git(root, ['clone', '-q', '--bare', work, join(remotes, 'o', 'r.git')]);

const home = join(root, 'home');
mkdirSync(home);
writeFileSync(
  join(home, '.gitconfig'),
  [
    `[url "${pathToFileURL(remotes).href}/"]`,
    '\tinsteadOf = https://github.com/',
    '[protocol "file"]',
    '\tallow = always',
    '',
  ].join('\n'),
);

test('a /tree/<ref>/<path> URL records the ref that was cloned, not the path', async () => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const outDir = mkdtempSync(join(root, 'out-'));
  const result = await runScan('https://github.com/o/r/tree/main/src', {
    outDir,
    ref: null,
    sca: false,
    trustTargetConfig: false,
    contextLines: 4,
  });
  const manifest = RunManifest.parse(
    JSON.parse(readFileSync(join(result.runDir, 'manifest.json'), 'utf8')),
  );
  assert.equal(manifest.target.ref, 'main');
});

test('a clone that fails leaves no run folder behind', async () => {
  process.env.HOME = join(root, 'no-such-home');
  process.env.USERPROFILE = process.env.HOME;
  // Nothing listens on port 9, so the clone fails at once without the network.
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    process.env[k] = 'http://127.0.0.1:9';
  }
  const outDir = mkdtempSync(join(root, 'out-'));
  await assert.rejects(
    runScan('https://github.com/o/r', {
      outDir,
      ref: null,
      sca: false,
      trustTargetConfig: false,
      contextLines: 4,
    }),
    { name: 'CloneError' },
  );
  assert.deepEqual(readdirSync(outDir), []);
});

test('a ref that is not a safe branch or tag name is refused before a run folder exists', async () => {
  const outDir = mkdtempSync(join(root, 'out-'));
  await assert.rejects(
    runScan('https://github.com/o/r', {
      outDir,
      ref: 'a..b',
      sca: false,
      trustTargetConfig: false,
      contextLines: 4,
    }),
    /not a safe branch or tag name/,
  );
  assert.deepEqual(readdirSync(outDir), []);
});
