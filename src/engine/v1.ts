import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { V1Output, type V1OutputT } from '../model/finding.ts';
import { scrubbedEnv } from '../util/env.ts';
import { undoOnExit } from '../util/exit.ts';

/**
 * The v1 engine (`@jackdog668/vibeaudit`) is prior work. 2.0 never copies its
 * source. It runs the published CLI as a child process, exactly the way a user
 * would, and reads the JSON it prints. That keeps the boundary between prior
 * work and hackathon work visible in the code itself.
 */
const require = createRequire(import.meta.url);

export const ENGINE_NAME = '@jackdog668/vibeaudit';

function enginePackageDir(): string {
  // The package exports only its entry module, so resolve that and walk up.
  const entry = require.resolve(ENGINE_NAME);
  return dirname(dirname(entry));
}

export function engineBinPath(): string {
  return join(enginePackageDir(), 'bin', 'vibe-audit.js');
}

export async function engineVersion(): Promise<string> {
  const raw = await readFile(join(enginePackageDir(), 'package.json'), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? 'unknown';
}

export class EngineError extends Error {
  override name = 'EngineError';
}

export interface EngineRule {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  cweId: string | null;
}

const SEVERITY_WORD: Record<string, EngineRule['severity']> = {
  CRIT: 'critical',
  WARN: 'warning',
  INFO: 'info',
};

/** Ask the engine for its live rule list. Never hardcode the count; it drifts. */
export async function listEngineRules(): Promise<EngineRule[]> {
  const { stdout } = await runEngine(['--list-rules'], 60_000);
  const rules: EngineRule[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s+(CRIT|WARN|INFO)\s+([a-z0-9-]+)(?:\s+\[(CWE-\d+)\])?/.exec(line);
    if (!match) continue;
    rules.push({
      id: match[2] ?? '',
      severity: SEVERITY_WORD[match[1] ?? ''] ?? 'info',
      cweId: match[3] ?? null,
    });
  }
  if (rules.length === 0) throw new EngineError('The engine returned no rules from --list-rules.');
  return rules;
}

export interface EngineScanOptions {
  /** Run dependency scanning (npm audit, OSV). Needs network and a lockfile. Off by default. */
  sca?: boolean;
  /** Let the scanned repo's own .vibe-audit.json and inline suppressions apply. Off for untrusted repos. */
  trustTargetConfig?: boolean;
  /**
   * Put back a config that a killed earlier run left parked. Only for the
   * user's own folder: in a fresh clone, a file under the parked name is the
   * repo's own and must stay as it is.
   */
  recoverParkedConfig?: boolean;
  timeoutMs?: number;
}

export interface EngineScanResult {
  output: V1OutputT;
  durationMs: number;
  exitCode: number;
}

export async function runEngineScan(
  repoDir: string,
  options: EngineScanOptions = {},
): Promise<EngineScanResult> {
  const args = [repoDir, '--format', 'json'];
  if (!options.sca) args.push('--skip-sca');

  // Engine 1.4.0 always applies the scanned folder's own .vibe-audit.json
  // and has no switch to skip it. For an untrusted repo that is a way to
  // hide findings, so the file is moved aside for the duration of the run
  // unless the caller opts in.
  // Inline "vibe-audit-ignore" comments are still honored by 1.4.0; that
  // gap is recorded in the README until a v1 release adds a trust switch.
  const restoreConfig = options.trustTargetConfig
    ? null
    : hideTargetConfig(repoDir, options.recoverParkedConfig === true);
  const started = performance.now();
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await runEngine(args, options.timeoutMs ?? 10 * 60_000);
  } finally {
    restoreConfig?.();
  }
  const { stdout, stderr, exitCode } = result;
  const durationMs = Math.round(performance.now() - started);

  // Exit code 1 means "criticals found", which is a successful scan for us.
  if (exitCode !== 0 && exitCode !== 1) {
    throw new EngineError(`engine exited with code ${exitCode}: ${stderr.trim().slice(-500)}`);
  }
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) throw new EngineError(`engine printed no JSON: ${stderr.trim().slice(-500)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch (error) {
    throw new EngineError(`engine JSON could not be parsed: ${(error as Error).message}`);
  }
  const output = V1Output.parse(parsed);
  return { output, durationMs, exitCode };
}

const TARGET_CONFIG = '.vibe-audit.json';
const PARKED_CONFIG = '.vibe-audit.json.untrusted';
/** The name used when PARKED_CONFIG is taken. Only this tool ever writes it. */
const PARKED_SUFFIXED = /^\.vibe-audit\.json\.untrusted-[0-9a-f]{8}$/;

/**
 * Park the folder's config under another name for the run. A local target is
 * the user's own folder, so the move is undone however the process ends,
 * Ctrl-C and kill included. A run killed outright (SIGKILL) leaves the file
 * parked; with `recover`, the next scan of that folder puts it back before
 * parking it again. Returns the restore step, or null when there is no
 * config to hide.
 */
function hideTargetConfig(repoDir: string, recover: boolean): (() => void) | null {
  const original = join(repoDir, TARGET_CONFIG);
  const parked = join(repoDir, PARKED_CONFIG);
  if (recover && !present(original)) {
    const leftover = parkedLeftover(repoDir);
    if (leftover) renameSync(leftover, original);
  }
  if (!present(original)) return null;
  // Never overwrite a file that already sits under the parked name.
  const moved = present(parked) ? `${parked}-${randomBytes(4).toString('hex')}` : parked;
  // Register first, then move: an interrupt that lands right after the move
  // must already find the restore step, or the process dies without it.
  let isParked = false;
  const restore = undoOnExit(() => {
    if (isParked) renameSync(moved, original);
  });
  try {
    renameSync(original, moved);
    isParked = true;
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}

/**
 * The config a killed run left parked. The suffixed name means the plain
 * parked name was already taken when it was parked, so it wins; two suffixed
 * names are ambiguous, and both are left alone.
 */
function parkedLeftover(repoDir: string): string | null {
  const suffixed = readdirSync(repoDir).filter((name) => PARKED_SUFFIXED.test(name));
  if (suffixed.length > 1) return null;
  const [name] = suffixed;
  if (name !== undefined) return join(repoDir, name);
  const parked = join(repoDir, PARKED_CONFIG);
  return present(parked) ? parked : null;
}

function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

/**
 * The v1 bin calls process.exit() as soon as it has printed. On Linux and
 * macOS a write to a pipe is asynchronous, so whatever is still queued when
 * the process exits is lost: the rule list came back short under load and
 * any scan JSON past about 145 KB failed to parse. Writes to a file are
 * synchronous on every platform, so the child writes straight into temp
 * files, which are read back only after it has exited.
 */
async function runEngine(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let dir: string | null = null;
  let child: ChildProcess | null = null;
  // Registered before anything exists, so an interrupt at any point finds it:
  // stop the engine and drop its files.
  const cleanup = undoOnExit(() => {
    child?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  try {
    dir = mkdtempSync(join(tmpdir(), 'va2-engine-'));
    const outPath = join(dir, 'stdout');
    const errPath = join(dir, 'stderr');
    const exitCode = await spawnToFiles(args, outPath, errPath, timeoutMs, (spawned) => {
      child = spawned;
    });
    return {
      stdout: await readFile(outPath, 'utf8'),
      stderr: await readFile(errPath, 'utf8'),
      exitCode,
    };
  } finally {
    try {
      cleanup();
    } catch {
      // Best effort: a failed cleanup must not hide the engine's own result or error.
    }
  }
}

/**
 * Settles once: on 'close', on 'error', or on the timeout. The listeners never
 * read the capture files, so a 'close' that arrives after an error or a kill
 * is a no-op even though the files are already gone by then.
 */
function spawnToFiles(
  args: string[],
  outPath: string,
  errPath: string,
  timeoutMs: number,
  onSpawn: (child: ChildProcess) => void,
): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const outFd = openSync(outPath, 'w');
    let child: ChildProcess;
    try {
      const errFd = openSync(errPath, 'w');
      try {
        child = spawn(process.execPath, [engineBinPath(), ...args], {
          env: scrubbedEnv(),
          windowsHide: true,
          stdio: ['ignore', outFd, errFd],
        });
      } finally {
        closeSync(errFd);
      }
    } finally {
      // The child holds its own copies of both descriptors once spawn returns.
      closeSync(outFd);
    }
    onSpawn(child);
    const timer = setTimeout(() => {
      child.kill();
      reject(new EngineError(`engine timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new EngineError(`engine could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code ?? -1);
    });
  });
}
