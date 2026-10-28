import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { V1Output, type V1OutputT } from '../model/finding.ts';
import { scrubbedEnv } from '../util/env.ts';

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
  // Since engine 1.5.0 a scanned repo's own .vibe-audit.json and its inline
  // "vibe-audit-ignore" comments apply only behind this flag, so an untrusted
  // repo cannot hide its findings by default.
  if (options.trustTargetConfig) args.push('--trust-target-config');

  const started = performance.now();
  const { stdout, stderr, exitCode } = await runEngine(args, options.timeoutMs ?? 10 * 60_000);
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

function runEngine(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [engineBinPath(), ...args], {
      env: scrubbedEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new EngineError(`engine timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new EngineError(`engine could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        exitCode: code ?? -1,
      });
    });
  });
}
