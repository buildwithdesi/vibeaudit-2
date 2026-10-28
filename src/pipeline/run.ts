import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ENGINE_NAME, engineVersion, listEngineRules, runEngineScan } from '../engine/v1.ts';
import { cloneGitHub } from '../intake/clone.ts';
import { buildGitHubTarget, parseTarget, type ScanTarget } from '../intake/target.ts';
import type { FindingT, RunManifestT } from '../model/finding.ts';
import { redactSecrets } from '../normalize/context.ts';
import { countBy, normalizeFindings } from '../normalize/index.ts';
import { renderSummary } from '../report/summary.ts';
import { slug, writeJson, writeText } from '../util/fs.ts';
import { debug, info } from '../util/log.ts';

export interface ScanOptions {
  outDir: string;
  ref: string | null;
  sca: boolean;
  trustTargetConfig: boolean;
  contextLines: number;
}

export interface ScanResult {
  runDir: string;
  manifest: RunManifestT;
  findings: FindingT[];
}

/**
 * Stage 1 to 3 of the 2.0 pipeline: intake, engine, normalize.
 * Every run leaves a folder behind with the clone, the raw engine output,
 * the normalized findings, a manifest, and a summary. Later stages read
 * from that folder, so a run can be resumed or compared after a patch.
 */
export async function runScan(input: string, options: ScanOptions): Promise<ScanResult> {
  const totalStart = performance.now();
  const target = parseTarget(input);
  const runId = makeRunId(target);
  const runDir = resolve(options.outDir, runId);
  await mkdir(runDir, { recursive: true });
  info(`run ${runId}`);

  // Stage 1: intake.
  let repoDir: string;
  let commit: string | null = null;
  let cloneMs = 0;
  if (target.kind === 'github') {
    const cloneTarget = options.ref
      ? buildGitHubTarget(target.owner, target.repo, options.ref)
      : target;
    info(`cloning ${cloneTarget.webUrl}${cloneTarget.ref ? ` @ ${cloneTarget.ref}` : ''}`);
    const cloneStart = performance.now();
    const clone = await cloneGitHub(cloneTarget, join(runDir, 'repo'));
    cloneMs = Math.round(performance.now() - cloneStart);
    repoDir = clone.dir;
    commit = clone.commit;
    debug(`cloned ${commit} in ${cloneMs} ms`);
  } else {
    repoDir = target.path;
    commit = await localCommit(repoDir);
  }

  // Stage 2: the v1 engine, run as a black box.
  const [version, rules] = await Promise.all([engineVersion(), listEngineRules()]);
  info(`running ${ENGINE_NAME} ${version} (${rules.length} rules available)`);
  const engine = await runEngineScan(repoDir, {
    sca: options.sca,
    trustTargetConfig: options.trustTargetConfig,
  });
  await writeJson(
    join(runDir, 'engine-output.json'),
    JSON.parse(redactSecrets(JSON.stringify(engine.output)).text),
  );
  info(
    `engine: ${engine.output.summary.total} findings in ${engine.output.summary.filesScanned} files (${engine.durationMs} ms)`,
  );

  // Stage 3: normalize into 2.0 findings with masked context.
  const findings = await normalizeFindings(engine.output, repoDir, {
    contextLines: options.contextLines,
  });

  const manifest: RunManifestT = {
    runId,
    createdAt: new Date().toISOString(),
    tool: { name: 'vibeaudit-2', version: await toolVersion() },
    target: {
      kind: target.kind,
      label: target.label,
      url: target.kind === 'github' ? target.webUrl : null,
      ref: target.kind === 'github' ? (options.ref ?? target.ref) : null,
      path: repoDir,
    },
    commit,
    engine: {
      name: ENGINE_NAME,
      version,
      rulesAvailable: rules.length,
      rulesRun: engine.output.summary.rulesRun,
      sca: options.sca,
      trustTargetConfig: options.trustTargetConfig,
    },
    filesScanned: engine.output.summary.filesScanned,
    durationMs: {
      clone: cloneMs,
      engine: engine.durationMs,
      total: Math.round(performance.now() - totalStart),
    },
    counts: {
      total: findings.length,
      bySeverity: countBy(findings, (f) => f.severity),
      byClass: countBy(findings, (f) => f.vulnClass),
    },
    stages: {
      intake: 'done',
      engine: 'done',
      normalize: 'done',
      triage: 'pending',
      reasoning: 'pending',
      report: 'pending',
      patch: 'pending',
    },
  };

  await writeJson(join(runDir, 'findings.json'), findings);
  await writeJson(join(runDir, 'manifest.json'), manifest);
  await writeText(join(runDir, 'summary.md'), renderSummary(manifest, findings));
  info(`wrote ${runDir}`);
  return { runDir, manifest, findings };
}

function makeRunId(target: ScanTarget): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${slug(target.label)}-${randomBytes(2).toString('hex')}`;
}

async function localCommit(dir: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { stdout } = await promisify(execFile)('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function toolVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
