import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTarget, TargetError } from '../src/intake/target.ts';

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
    'https://gitlab.com/owner/repo',
    'owner/repo/extra',
    'not a repo at all',
  ];
  for (const input of bad) {
    assert.throws(
      () => parseTarget(input),
      TargetError,
      `expected rejection for ${JSON.stringify(input)}`,
    );
  }
});
