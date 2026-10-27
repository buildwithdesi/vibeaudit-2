#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { engineVersion, listEngineRules } from './engine/v1.ts';
import { runScan } from './pipeline/run.ts';
import { topClasses } from './report/summary.ts';
import { info, setLogLevel } from './util/log.ts';

const USAGE = `vibeaudit2 <command> [options]

Commands
  scan <github-url | owner/repo | folder>   Clone (or read) a repository, run the v1 engine, normalize findings
  rules                                      List the engine's live rules (the count is never hardcoded)
  version                                    Print versions

Scan options
  --out <dir>            Where run folders go (default: runs)
  --ref <branch|tag>     Branch or tag to clone
  --context <n>          Lines of code kept around each finding (default: 6)
  --sca                  Also run dependency scanning (needs network and a lockfile)
  --trust-target-config  Apply the scanned repo's own .vibe-audit.json and inline suppressions
  --json                 Print the normalized findings as JSON on stdout
  --quiet                Only print errors
  --verbose              Print stage timings
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string', default: 'runs' },
      ref: { type: 'string' },
      context: { type: 'string', default: '6' },
      sca: { type: 'boolean', default: false },
      'trust-target-config': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
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
    return command ? 0 : 2;
  }

  switch (command) {
    case 'version': {
      process.stdout.write(`vibeaudit-2 engine ${await engineVersion()}\n`);
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
    case 'scan': {
      if (!target) {
        process.stderr.write('scan needs a target.\n\n');
        process.stdout.write(USAGE);
        return 2;
      }
      const contextLines = Number.parseInt(values.context, 10);
      if (!Number.isFinite(contextLines) || contextLines < 0 || contextLines > 50) {
        process.stderr.write('--context must be a number between 0 and 50.\n');
        return 2;
      }
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
      return 0;
    }
    default: {
      process.stderr.write(`Unknown command "${command}".\n\n`);
      process.stdout.write(USAGE);
      return 2;
    }
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
