import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGitHubTarget, parseTarget, TargetError } from '../src/intake/target.ts';

test('parses the common GitHub URL shapes', () => {
  const cases = [
    'https://github.com/OWASP/NodeGoat',
    'https://github.com/OWASP/NodeGoat.git',
    'http://www.github.com/OWASP/NodeGoat/',
    'github.com/OWASP/NodeGoat?tab=readme',
    'OWASP/NodeGoat',
  ];
  for (const input of cases) {
    const target = parseTarget(input);
    assert.equal(target.kind, 'github');
    if (target.kind !== 'github') return;
    assert.equal(target.owner, 'OWASP');
    assert.equal(target.repo, 'NodeGoat');
    assert.equal(target.ref, null);
    assert.equal(target.cloneUrl, 'https://github.com/OWASP/NodeGoat.git');
  }
});

test('reads a branch from a /tree/ URL', () => {
  const target = parseTarget('https://github.com/OWASP/NodeGoat/tree/release/1.3');
  assert.equal(target.kind, 'github');
  if (target.kind === 'github') assert.equal(target.ref, 'release/1.3');
});

test('a /tree/ or /blob/ URL keeps the branch and any path after it, decoded', () => {
  // Branch names can contain "/", so where the branch ends is settled at clone time
  // against the repository's real refs. Parsing only drops what no ref can contain.
  const cases: [string, string][] = [
    ['https://github.com/OWASP/NodeGoat/tree/main/', 'main'],
    ['https://github.com/OWASP/NodeGoat/tree/main/app/routes', 'main/app/routes'],
    ['https://github.com/OWASP/NodeGoat/blob/main/README.md', 'main/README.md'],
    ['https://github.com/OWASP/NodeGoat/blob/v1.3/app/My%20File.js#L10', 'v1.3/app'],
    ['https://github.com/OWASP/NodeGoat/tree/feature%2Fx', 'feature/x'],
  ];
  for (const [input, ref] of cases) {
    const target = parseTarget(input);
    assert.equal(target.kind, 'github', input);
    if (target.kind !== 'github') return;
    assert.equal(target.label, 'OWASP/NodeGoat', input);
    assert.equal(target.ref, ref, input);
  }
});

test('reads SSH clone URLs, and still clones over https', () => {
  const cases = [
    'git@github.com:OWASP/NodeGoat.git',
    'git@github.com:OWASP/NodeGoat',
    'ssh://git@github.com/OWASP/NodeGoat.git',
  ];
  for (const input of cases) {
    const target = parseTarget(input);
    assert.equal(target.kind, 'github', input);
    if (target.kind !== 'github') return;
    assert.equal(target.owner, 'OWASP');
    assert.equal(target.repo, 'NodeGoat');
    assert.equal(target.ref, null);
    assert.equal(target.cloneUrl, 'https://github.com/OWASP/NodeGoat.git');
  }
});

test('a URL the GitHub patterns cannot read is "not a supported GitHub URL", not a missing folder', () => {
  const cases = [
    'git://github.com/OWASP/NodeGoat',
    'https://user@github.com/OWASP/NodeGoat',
    'https://github.com:443/OWASP/NodeGoat',
    'https://github.com',
    'https://gitlab.com/owner/repo',
    'ssh://git@github.example/owner/repo',
    'file:///srv/repo',
  ];
  for (const input of cases) {
    assert.throws(
      () => parseTarget(input),
      { name: 'TargetError', message: /^"[^"]+" is not a supported GitHub URL\./ },
      input,
    );
  }
});

test('a malformed %-escape is a TargetError, not a URIError', () => {
  assert.throws(() => parseTarget('https://github.com/owner/repo/tree/%E0%A4%A'), TargetError);
  assert.throws(() => buildGitHubTarget('owner', 'repo', '%E0%A4%A'), TargetError);
});

test('an existing folder is a local target', () => {
  const target = parseTarget('examples/seeded-app');
  assert.equal(target.kind, 'local');
  if (target.kind === 'local') assert.equal(target.label, 'seeded-app');
});

test('rejects anything that could become a git flag or escape a path', () => {
  const bad = [
    '',
    '--upload-pack=touch /tmp/pwned',
    '-oProxyCommand=calc',
    'https://github.com/-owner/repo',
    'https://github.com/owner/..',
    'https://github.com/owner/repo/tree/-evil',
    'https://github.com/owner/repo/tree/a..b',
    'https://github.com/owner/repo/blob/-evil/README.md',
    'https://github.com/owner/repo/tree/%2D%2Dupload-pack=x',
    'git@github.com:-owner/repo.git',
    'git@gitlab.com:owner/repo.git',
    'ssh://git@github.com/owner/repo/extra',
    'https://gitlab.com/owner/repo',
    'owner/repo/extra',
    'not a repo at all',
    'examples/seeded-ap',
    './nope',
    'C:\\nope\\dir',
  ];
  for (const input of bad) {
    assert.throws(
      () => parseTarget(input),
      TargetError,
      `expected rejection for ${JSON.stringify(input)}`,
    );
  }
});
