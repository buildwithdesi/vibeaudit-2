import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type TestContext, test } from 'node:test';
import { runEngineScan } from '../src/engine/v1.ts';

const HOSTILE = JSON.stringify({ ignore: ['routes', 'server'] });

function seededCopy(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'va2-cfg-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'app');
  cpSync(resolve('examples/seeded-app'), dir, { recursive: true });
  return dir;
}

function configFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.startsWith('.vibe-audit'))
    .sort();
}

test("a scanned repo's own .vibe-audit.json cannot hide findings, and is put back", async (t) => {
  const dir = seededCopy(t);
  writeFileSync(join(dir, '.vibe-audit.json'), HOSTILE);

  const trusted = await runEngineScan(dir, { trustTargetConfig: true });
  const untrusted = await runEngineScan(dir, {});
  assert.ok(
    untrusted.output.findings.some((f) => f.file.startsWith('routes/')),
    'routes findings survive the hostile config',
  );
  assert.ok(untrusted.output.findings.length > trusted.output.findings.length);
  assert.deepEqual(configFiles(dir), ['.vibe-audit.json'], 'config restored, nothing left over');
  assert.equal(readFileSync(join(dir, '.vibe-audit.json'), 'utf8'), HOSTILE);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`a scan stopped with ${signal} puts the folder's config back`, async (t) => {
    const dir = seededCopy(t);
    // Enough files that the engine is still running when the signal lands.
    for (let i = 0; i < 60; i++) {
      cpSync(join(dir, 'routes'), join(dir, `more${i}`), { recursive: true });
    }
    writeFileSync(join(dir, '.vibe-audit.json'), HOSTILE);
    const scratch = mkdtempSync(join(tmpdir(), 'va2-cfg-tmp-'));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));

    const engine = resolve('src/engine/v1.ts');
    const code = `import(${JSON.stringify(engine)}).then((m) => m.runEngineScan(${JSON.stringify(dir)}, {})).then(() => console.log('finished'))`;
    const child = spawn(process.execPath, ['-e', code], {
      env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let printed = '';
    child.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString();
    });
    const exited = new Promise<NodeJS.Signals | null>((resolveExit) =>
      child.on('exit', (_code, sig) => resolveExit(sig)),
    );

    const parked = join(dir, '.vibe-audit.json.untrusted');
    const deadline = Date.now() + 20_000;
    while (!existsSync(parked) && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    assert.ok(existsSync(parked), 'the config was parked while the engine ran');
    child.kill(signal);

    assert.equal(await exited, signal, 'the scan was interrupted, not finished');
    assert.equal(printed, '');
    assert.deepEqual(configFiles(dir), ['.vibe-audit.json'], 'config back in place');
    assert.equal(readFileSync(join(dir, '.vibe-audit.json'), 'utf8'), HOSTILE);
    assert.deepEqual(
      readdirSync(scratch).filter((name) => name.startsWith('va2-engine-')),
      [],
      'the engine capture folder is removed too',
    );
  });
}

test('a config left parked by a killed run is put back by the next scan, still ignored', async (t) => {
  const dir = seededCopy(t);
  writeFileSync(join(dir, '.vibe-audit.json.untrusted'), HOSTILE);

  const { output } = await runEngineScan(dir, {});
  assert.ok(
    output.findings.some((f) => f.file.startsWith('routes/')),
    'config still not applied',
  );
  assert.deepEqual(configFiles(dir), ['.vibe-audit.json']);
  assert.equal(readFileSync(join(dir, '.vibe-audit.json'), 'utf8'), HOSTILE);
});

test('a file already named .vibe-audit.json.untrusted is never overwritten', async (t) => {
  const dir = seededCopy(t);
  writeFileSync(join(dir, '.vibe-audit.json'), HOSTILE);
  writeFileSync(join(dir, '.vibe-audit.json.untrusted'), 'keep me');

  const { output } = await runEngineScan(dir, {});
  assert.ok(
    output.findings.some((f) => f.file.startsWith('routes/')),
    'config not applied',
  );
  assert.deepEqual(configFiles(dir), ['.vibe-audit.json', '.vibe-audit.json.untrusted']);
  assert.equal(readFileSync(join(dir, '.vibe-audit.json'), 'utf8'), HOSTILE);
  assert.equal(readFileSync(join(dir, '.vibe-audit.json.untrusted'), 'utf8'), 'keep me');
});
