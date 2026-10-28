import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { CloneError, cloneArgs, cloneEnv, cloneGitHub } from '../src/intake/clone.ts';
import { buildGitHubTarget, type GitHubTarget, parseTarget } from '../src/intake/target.ts';
import { setLogLevel } from '../src/util/log.ts';

setLogLevel('quiet');

// Nothing here touches the network. Each test points HOME at a throwaway
// folder whose .gitconfig sends https://github.com/ to bare repos in a temp
// folder, the way a user's own git config could. cloneGitHub then runs
// unchanged, with all of its hardening.
const root = mkdtempSync(join(tmpdir(), 'va2-clone-'));
after(() => rmSync(root, { recursive: true, force: true }));

const remotes = join(root, 'remotes');
const fixtureHome = makeHome('fixture', []);
const appCommit = makeApp();
const releaseCommit = git(join(root, 'work'), ['rev-parse', 'release/1.3']);

const redirect = [`[url "${pathToFileURL(remotes).href}/"]`, '\tinsteadOf = https://github.com/'];
// The hardened clone allows https only. The redirect lands on file://, so the user config allows it.
const redirectHome = makeHome('redirect', [...redirect, '[protocol "file"]', '\tallow = always']);

let runs = 0;
function nextDest(): string {
  runs += 1;
  return join(root, 'runs', String(runs), 'repo');
}

function makeHome(name: string, gitconfig: string[]): string {
  const home = join(root, `home-${name}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.gitconfig'), `${gitconfig.join('\n')}\n`, 'utf8');
  return home;
}

function useHome(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}

/** A minimal environment for building fixtures, so a caller's GIT_DIR or global config cannot leak in. */
function gitEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@localhost',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, env: gitEnv(fixtureHome), encoding: 'utf8', input },
  ).trim();
}

/** acme/app: main holds a folder and a symlink, tag v1.0 points at it, release/1.3 adds a file. */
function makeApp(): string {
  const work = join(root, 'work');
  git(root, ['init', '-q', '-b', 'main', work]);
  mkdirSync(join(work, 'src'));
  writeFileSync(join(work, 'README.md'), '# app\n');
  writeFileSync(join(work, 'src', 'app.ts'), 'export const answer = 42;\n');
  git(work, ['add', '.']);
  // Written with plumbing, so building the fixture does not need symlink support.
  const blob = git(work, ['hash-object', '-w', '--stdin'], '/etc/passwd');
  git(work, ['update-index', '--add', '--cacheinfo', `120000,${blob},link`]);
  git(work, ['commit', '-qm', 'main']);
  git(work, ['tag', 'v1.0']);
  git(work, ['checkout', '-qb', 'release/1.3']);
  writeFileSync(join(work, 'release.txt'), '1.3\n');
  git(work, ['add', 'release.txt']);
  git(work, ['commit', '-qm', 'release']);
  git(work, ['checkout', '-q', 'main']);
  git(root, ['clone', '-q', '--bare', work, join(remotes, 'acme', 'app.git')]);
  return git(work, ['rev-parse', 'main']);
}

function app(): GitHubTarget {
  return buildGitHubTarget('acme', 'app', null);
}

function github(input: string): GitHubTarget {
  const target = parseTarget(input);
  assert.equal(target.kind, 'github', input);
  return target as GitHubTarget;
}

test('cloneArgs keeps every hardening flag and puts the URL right after --', () => {
  const dest = join(root, 'runs', 'args', 'repo');
  const args = cloneArgs(buildGitHubTarget('acme', 'app', 'release/1.3'), dest);
  const subcommand = args.indexOf('clone');
  const configs = args.slice(0, subcommand).filter((_, i) => i % 2 === 1);
  assert.deepEqual(
    args.slice(0, subcommand).filter((_, i) => i % 2 === 0),
    configs.map(() => '-c'),
    'only -c pairs come before the clone subcommand',
  );
  assert.deepEqual(configs, [
    `core.hooksPath=${join(dirname(dest), 'no-hooks')}`,
    'core.symlinks=false',
    'core.fsmonitor=false',
    'core.longpaths=true',
    'protocol.allow=never',
    'protocol.https.allow=always',
  ]);
  for (const flag of ['--depth', '--single-branch', '--no-tags']) {
    assert.ok(args.indexOf(flag) > subcommand, `${flag} is a clone option`);
  }
  assert.equal(args[args.indexOf('--depth') + 1], '1');
  assert.deepEqual(args.slice(-3), ['--', 'https://github.com/acme/app.git', dest]);
  assert.equal(args.indexOf('--'), args.length - 3, 'nothing after -- is read as an option');
  const branch = args.indexOf('--branch');
  assert.equal(args[branch + 1], 'release/1.3');
  assert.ok(branch < args.indexOf('--'));

  assert.equal(cloneArgs(app(), dest).includes('--branch'), false, 'no ref: the default branch');
});

test('cloneEnv turns credential prompts off and keeps secrets out of git', () => {
  const saved = { META_API_KEY: process.env.META_API_KEY, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  process.env.META_API_KEY = 'meta-secret';
  process.env.GITHUB_TOKEN = 'ghp_secret';
  try {
    const env = cloneEnv();
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1');
    assert.equal(env.META_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('clones the default branch shallowly and reports its commit', async () => {
  useHome(redirectHome);
  const dest = nextDest();
  const result = await cloneGitHub(app(), dest);
  assert.equal(result.dir, dest);
  assert.equal(result.commit, appCommit);
  assert.ok(existsSync(join(dest, 'src', 'app.ts')));
  assert.equal(existsSync(join(dest, 'release.txt')), false, 'only the default branch');
  assert.equal(git(dest, ['rev-parse', '--is-shallow-repository']), 'true');
});

test('a /tree/ URL clones that branch, even with a slash in its name', async () => {
  useHome(redirectHome);
  const dest = nextDest();
  const target = parseTarget('https://github.com/acme/app/tree/release/1.3');
  assert.equal(target.kind, 'github');
  if (target.kind !== 'github') return;
  await cloneGitHub(target, dest);
  assert.ok(existsSync(join(dest, 'release.txt')));
});

test('a symlink in the repository is checked out as a plain file', async () => {
  useHome(redirectHome);
  const dest = nextDest();
  await cloneGitHub(app(), dest);
  const link = join(dest, 'link');
  assert.equal(lstatSync(link).isSymbolicLink(), false);
  assert.equal(readFileSync(link, 'utf8'), '/etc/passwd');
});

test('no hook runs during the clone, not even one the user set up globally', async () => {
  const hooks = join(root, 'global-hooks');
  const marker = join(root, 'hook-ran').replaceAll('\\', '/');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\necho ran > "${marker}"\n`, {
    mode: 0o755,
  });
  const home = makeHome('hooks', [
    ...redirect,
    '[protocol "file"]',
    '\tallow = always',
    '[core]',
    `\thooksPath = ${hooks.replaceAll('\\', '/')}`,
  ]);

  // Control: a plain clone under the same config does run the hook.
  execFileSync('git', ['clone', '-q', 'https://github.com/acme/app', nextDest()], {
    env: gitEnv(home),
  });
  assert.ok(existsSync(marker), 'control: a plain clone runs the global hook');
  rmSync(marker);

  useHome(home);
  await cloneGitHub(app(), nextDest());
  assert.equal(existsSync(marker), false, 'the hardened clone ran a hook');
});

test('only https is allowed: a remote that resolves to file:// is refused', async () => {
  // The same redirect, but the user config no longer allows file://.
  useHome(makeHome('https-only', redirect));
  await assert.rejects(cloneGitHub(app(), nextDest()), (error: unknown) => {
    assert.ok(error instanceof CloneError);
    assert.match(error.message, /^git clone of https:\/\/github\.com\/acme\/app failed: /);
    assert.match(error.message, /transport 'file' not allowed/);
    return true;
  });
});

test('a /tree/ or /blob/ URL with a path clones the branch or tag in front of the path', async () => {
  useHome(redirectHome);
  const cases: [string, string, string][] = [
    ['https://github.com/acme/app/tree/main/src', 'main', appCommit],
    ['https://github.com/acme/app/blob/main/src/app.ts', 'main', appCommit],
    ['https://github.com/acme/app/tree/release/1.3', 'release/1.3', releaseCommit],
    ['https://github.com/acme/app/tree/release/1.3/src', 'release/1.3', releaseCommit],
    ['https://github.com/acme/app/blob/v1.0/README.md', 'v1.0', appCommit],
  ];
  for (const [url, ref, commit] of cases) {
    const result = await cloneGitHub(github(url), nextDest());
    assert.equal(result.ref, ref, url);
    assert.equal(result.commit, commit, url);
  }
  assert.equal((await cloneGitHub(app(), nextDest())).ref, null);
});

test('a ref that matches no branch or tag still fails with the name that was asked for', async () => {
  useHome(redirectHome);
  await assert.rejects(
    cloneGitHub(github('https://github.com/acme/app/tree/nope/src'), nextDest()),
    /Remote branch nope\/src not found/,
  );
});

test('a private or missing repository is named as such, not as a git auth error', async () => {
  // GitHub answers 401 for both. With prompts off, git can only say it could not read a username.
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitHub"' });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  useHome(
    makeHome('private', [
      `[url "http://127.0.0.1:${port}/"]`,
      '\tinsteadOf = https://github.com/',
      '[protocol "http"]',
      '\tallow = always',
    ]),
  );
  const proxies = { http_proxy: process.env.http_proxy, HTTP_PROXY: process.env.HTTP_PROXY };
  delete process.env.http_proxy;
  delete process.env.HTTP_PROXY;
  try {
    for (const input of ['acme/secret', 'https://github.com/acme/secret/tree/main/src']) {
      await assert.rejects(cloneGitHub(github(input), nextDest()), (error: unknown) => {
        assert.ok(error instanceof CloneError);
        assert.match(
          error.message,
          /^git clone of https:\/\/github\.com\/acme\/secret failed: the repository is private or does not exist/,
        );
        return true;
      });
    }
  } finally {
    server.closeAllConnections();
    server.close();
    for (const [key, value] of Object.entries(proxies)) {
      if (value !== undefined) process.env[key] = value;
    }
  }
});
