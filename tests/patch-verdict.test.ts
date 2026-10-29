import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greenBlockers, isClosed, type PatchRecordT } from '../src/patch/loop.ts';

type Verdict = Pick<PatchRecordT, 'error' | 'tests' | 'rescanClean' | 'verifiedClean' | 'rescan'>;

function verdict(overrides: Partial<Verdict> = {}): Verdict {
  return {
    error: null,
    tests: {
      ran: true,
      passed: true,
      runner: 'local',
      command: 'npm test',
      outputTail: '',
      durationMs: 1,
    },
    rescanClean: true,
    verifiedClean: false,
    rescan: {
      ran: true,
      before: { total: 1, byClass: {} },
      after: { total: 0, byClass: {} },
      resolved: ['a'],
      remaining: [],
      introduced: 0,
    },
    ...overrides,
  };
}

test('green blockers name an early stop first, then the tests', () => {
  assert.deepEqual(greenBlockers(verdict()), []);
  assert.deepEqual(greenBlockers(verdict({ error: '402' })), ['the patch loop stopped early']);
  const notRun = { ...verdict().tests, ran: false, passed: false };
  assert.deepEqual(greenBlockers(verdict({ tests: notRun })), [
    'the tests did not run or did not pass',
  ]);
  assert.deepEqual(greenBlockers(verdict({ error: '402', tests: notRun })), [
    'the patch loop stopped early',
    'the tests did not run or did not pass',
  ]);
});

test('closed means a clean re-scan, or every flag judged closed with nothing new', () => {
  assert.equal(isClosed(verdict()), true);
  assert.equal(isClosed(verdict({ rescanClean: false })), false);
  assert.equal(isClosed(verdict({ rescanClean: false, verifiedClean: true })), true);
  const introduced = { ...verdict().rescan, introduced: 1 };
  assert.equal(
    isClosed(verdict({ rescanClean: false, verifiedClean: true, rescan: introduced })),
    false,
  );
});
