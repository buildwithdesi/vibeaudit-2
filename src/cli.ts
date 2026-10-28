#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { engineVersion, listEngineRules } from './engine/v1.ts';
import { VULN_CLASS_IDS } from './model/classes.ts';
import { runPatchLoop } from './patch/loop.ts';
import { runScan } from './pipeline/run.ts';
import { clientFromEnv, type ReasoningEffort } from './reason/meta-client.ts';
import { DEFAULT_EFFORT, type ReasonOptions, runReasoning } from './reason/orchestrate.ts';
import { renderProofOfRisk } from './report/proof-of-risk.ts';
import { topClasses } from './report/summary.ts';
import { info, setLogLevel } from './util/log.ts';

const USAGE = `vibeaudit2 <command> [options]

Commands
  scan <github-url | owner/repo | folder>   Clone (or read) a repository, run the v1 engine, normalize findings
  reason <run-dir>                           Triage with an open-weight model, judge exploitability with Muse Spark
  report <run-dir>                           Write the plain-language proof-of-risk report
  patch <run-dir>                            Patch confirmed findings on a sandbox branch, re-scan, run the project's tests
  audit <target>                             scan, then reason, then report, in one go
  rules                                      List the engine's live rules (the count is never hardcoded)
  version                                    Print versions

Scan options
  --out <dir>            Where run folders go (default: runs)
  --ref <branch|tag>     Branch or tag to clone
  --context <n>          Lines of code kept around each finding (default: 6)
  --sca                  Also run dependency scanning (needs network and a lockfile)
  --trust-target-config  Apply the scanned repo's own .vibe-audit.json
  --json                 Print the normalized findings as JSON on stdout

Reason options
  --dry-run              Build and save every prompt, estimate the cost, make no API call
  --classes <a,b,c>      Vulnerability classes to judge (default: the top five in the run)
  --max-findings <n>     Cap on findings sent to the reasoning model (default: 40; patch: 10)
  --force                Judge findings again even when they already carry a verdict
  --effort <level>       Reasoning effort for exploitability: minimal, low, medium, high, xhigh, max (default: high)
  --budget-usd <n>       Dollar cap per run (default: 5)
  --no-triage            Skip the open-weight triage pass even when TRIAGE_* is configured

Patch options
  --backend <auto|api|muse-code>   auto uses the Model API; muse-code runs the Muse Code agent and must be asked for
  --run-tests            Run the project's own test script after patching
  --docker / --no-docker Run those tests in a throwaway node:24 container (default: on when Docker is available)
  --allow-local-tests    Allow the tests to run on this machine when Docker is not available
  --muse-model <id>      Model for Muse Code (default: muse-spark-1.3)

General
  --quiet                Only print errors
  --verbose              Print stage timings
`;

const EFFORTS = new Set<ReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

async function main(argv: string[]): Promise<number> {
  loadDotEnv();
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      out: { type: 'string', default: 'runs' },
      ref: { type: 'string' },
      context: { type: 'string', default: '6' },
      sca: { type: 'boolean', default: false },
      'trust-target-config': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      classes: { type: 'string' },
      'max-findings': { type: 'string' },
      force: { type: 'boolean', default: false },
      effort: { type: 'string', default: DEFAULT_EFFORT.exploit },
      'budget-usd': { type: 'string', default: '5' },
      // allowNegative turns --no-triage into triage: false.
      triage: { type: 'boolean', default: true },
      backend: { type: 'string', default: 'auto' },
      'run-tests': { type: 'boolean', default: false },
      docker: { type: 'boolean', default: true },
      'allow-local-tests': { type: 'boolean', default: false },
      'muse-model': { type: 'string', default: 'muse-spark-1.3' },
      quiet: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.quiet) setLogLevel('quiet');
  else if (values.verbose) setLogLevel('verbose');

  const [command, target] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  switch (command) {
    case 'version': {
      process.stdout.write(`vibeaudit-2 ${toolVersion()} (engine ${await engineVersion()})\n`);
      return 0;
    }
    case 'rules': {
      const rules = await listEngineRules();
      for (const rule of rules) {
        process.stdout.write(
          `${rule.severity.padEnd(8)} ${rule.id}${rule.cweId ? ` [${rule.cweId}]` : ''}\n`,
        );
      }
      process.stdout.write(`${rules.length} rules (engine ${await engineVersion()})\n`);
      return 0;
    }
    case 'scan':
    case 'audit': {
      if (!target) return usageError(`${command} needs a target.`);
      if (isNonGitHubUrl(target)) {
        process.stderr.write(
          `"${target}" is not a github.com URL. Only GitHub repositories can be cloned: pass https://github.com/<owner>/<repo>, <owner>/<repo>, or a local folder.\n`,
        );
        return 2;
      }
      const contextLines = Number.parseInt(values.context, 10);
      if (!Number.isFinite(contextLines) || contextLines < 0 || contextLines > 50) {
        process.stderr.write('--context must be a number between 0 and 50.\n');
        return 2;
      }
      // Check the reasoning flags now: a typo should not cost a scan.
      const audit = command === 'audit' ? reasonOptions(values) : null;
      if (typeof audit === 'number') return audit;
      const result = await runScan(target, {
        outDir: values.out,
        ref: values.ref ?? null,
        sca: values.sca,
        trustTargetConfig: values['trust-target-config'],
        contextLines,
      });
      const { counts } = result.manifest;
      info('');
      info(
        `${counts.total} findings: ${counts.bySeverity.critical ?? 0} critical, ${counts.bySeverity.warning ?? 0} warning, ${counts.bySeverity.info ?? 0} info`,
      );
      info(`top classes: ${topClasses(result.findings).join(', ') || 'none'}`);
      info(`summary: ${result.runDir}/summary.md`);
      if (values.json) process.stdout.write(`${JSON.stringify(result.findings, null, 2)}\n`);
      if (!audit) return 0;
      const code = await reason(result.runDir, audit);
      if (code !== 0) return code;
      await renderProofOfRisk(result.runDir);
      info(`report: ${result.runDir}/report.md`);
      return 0;
    }
    case 'reason': {
      if (!target) return usageError('reason needs a run folder.');
      const runDir = resolveRunDir(target);
      const options = reasonOptions(values);
      if (typeof options === 'number') return options;
      return reason(runDir, options);
    }
    case 'report': {
      if (!target) return usageError('report needs a run folder.');
      const runDir = resolveRunDir(target);
      await renderProofOfRisk(runDir);
      info(`report: ${runDir}/report.md`);
      return 0;
    }
    case 'patch': {
      if (!target) return usageError('patch needs a run folder.');
      const runDir = resolveRunDir(target);
      const backend = values.backend;
      if (backend !== 'auto' && backend !== 'api' && backend !== 'muse-code') {
        return usageError('--backend must be auto, api, or muse-code.');
      }
      const classes = parseClasses(values.classes);
      if (typeof classes === 'number') return classes;
      const maxFindings = Number.parseInt(values['max-findings'] ?? '10', 10);
      const budgetUsd = Number.parseFloat(values['budget-usd']);
      const record = await runPatchLoop(runDir, {
        backend,
        client: clientFromEnv('META'),
        museModel: values['muse-model'],
        classes,
        maxFindings: Number.isFinite(maxFindings) && maxFindings > 0 ? maxFindings : 10,
        runTests: values['run-tests'],
        useDocker: values.docker,
        allowLocalTests: values['allow-local-tests'],
        budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : 5,
        dryRun: values['dry-run'],
      });
      info(
        `patch record: ${runDir}/patch.json${record.branch ? ` (branch ${record.branch})` : ''}`,
      );
      if (values['dry-run']) return 0;
      if (record.green) return 0;
      if (record.rescanClean) {
        info(
          're-scan is clean but the project tests did not run or did not pass, so this is not green',
        );
      }
      return 1;
    }
    default: {
      return usageError(`Unknown command "${command}".`);
    }
  }
}

async function reason(runDir: string, options: ReasonOptions): Promise<number> {
  const record = await runReasoning(runDir, options);
  return record.aborted ? 1 : 0;
}

/** The reasoning flags as options, or exit code 2 after saying which flag is wrong. */
function reasonOptions(values: {
  'dry-run': boolean;
  classes?: string | undefined;
  'max-findings'?: string | undefined;
  effort: string;
  'budget-usd': string;
  triage: boolean;
  force: boolean;
}): ReasonOptions | number {
  if (!EFFORTS.has(values.effort as ReasoningEffort)) {
    process.stderr.write(`--effort must be one of ${[...EFFORTS].join(', ')}.\n`);
    return 2;
  }
  const maxFindings = Number.parseInt(values['max-findings'] ?? '40', 10);
  const budgetUsd = Number.parseFloat(values['budget-usd']);
  if (
    !Number.isFinite(maxFindings) ||
    maxFindings < 1 ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0
  ) {
    process.stderr.write(
      '--max-findings must be a positive integer and --budget-usd a positive number.\n',
    );
    return 2;
  }
  const classes = parseClasses(values.classes);
  if (typeof classes === 'number') return classes;
  return {
    reason: clientFromEnv('META'),
    triage: values.triage ? clientFromEnv('TRIAGE') : null,
    dryRun: values['dry-run'],
    classes,
    maxFindings,
    effort: { ...DEFAULT_EFFORT, exploit: values.effort as ReasoningEffort },
    budget: { perRunUsd: budgetUsd },
    force: values.force,
  };
}

/**
 * --classes as known class ids, or null for the default. An unknown id would
 * select nothing, still pay for the repository map, and leave a reasoning
 * record the report cannot render, so it is exit code 2 instead.
 */
function parseClasses(raw: string | undefined): string[] | null | number {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const known: readonly string[] = VULN_CLASS_IDS;
  const unknown = ids.filter((id) => !known.includes(id));
  if (ids.length > 0 && unknown.length === 0) return ids;
  const problem = unknown.length
    ? `Unknown --classes value: ${unknown.join(', ')}.`
    : '--classes needs at least one class.';
  process.stderr.write(`${problem} Valid classes: ${VULN_CLASS_IDS.join(', ')}.\n`);
  return 2;
}

function resolveRunDir(input: string): string {
  const dir = resolve(input);
  if (!existsSync(resolve(dir, 'manifest.json'))) {
    throw new Error(`${dir} is not a run folder (no manifest.json). Run "scan" first.`);
  }
  return dir;
}

/** package.json sits one folder above both src/cli.ts and dist/cli.js. */
function toolVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
}

/**
 * A URL with a scheme that is not github.com. Without this, the target
 * parser reads it as a relative path and reports "Folder not found".
 */
function isNonGitHubUrl(target: string): boolean {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return false;
  if (/^https?:\/\/(?:www\.)?github\.com\//i.test(target)) return false;
  return !existsSync(resolve(target));
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n\n`);
  process.stdout.write(USAGE);
  return 2;
}

/** Read .env from the current folder when present. Never overrides variables already set. */
function loadDotEnv(): void {
  const path = resolve('.env');
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // A malformed .env should not stop a scan; the reasoning stage reports a missing key itself.
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  },
);
