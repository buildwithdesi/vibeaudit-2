import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runEngineScan } from '../engine/v1.ts';
import { Finding, type FindingT, RunManifest } from '../model/finding.ts';
import { countBy, normalizeFindings } from '../normalize/index.ts';
import { rateFor } from '../reason/budget.ts';
import type { ClientConfig } from '../reason/meta-client.ts';
import { topClasses } from '../report/summary.ts';
import { writeJson, writeText } from '../util/fs.ts';
import { info, warn } from '../util/log.ts';
import { apiPatch, museAvailable, museCodePatch, type PatchOutcome } from './backends.ts';
import { commitAll, createBranch, diffAgainst, ensureRepo, git } from './git.ts';
import { runProjectTests, type TestRunResult } from './project-tests.ts';

/**
 * Stage 7: the patch loop.
 *
 *   select findings -> sandbox branch -> patch -> commit -> re-scan -> tests
 *
 * "Green" means two things at once: the re-scan no longer reports the
 * patched findings, and the project's own tests still pass. Both results
 * are written to patch.json next to the diff, so the before and after can be
 * shown side by side.
 */
export interface PatchOptions {
  backend: 'auto' | 'api' | 'muse-code';
  client: ClientConfig | null;
  museModel: string;
  classes: string[] | null;
  maxFindings: number;
  runTests: boolean;
  useDocker: boolean;
  allowLocalTests: boolean;
  /** Plan only: no edits, no branch, no tests. */
  dryRun: boolean;
}

export const PatchRecord = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  backend: z.enum(['api', 'muse-code', 'none']),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  patchCommit: z.string().nullable(),
  selected: z.array(
    z.object({ id: z.string(), file: z.string(), ruleId: z.string(), vulnClass: z.string() }),
  ),
  outcomes: z.array(
    z.object({
      findingIds: z.array(z.string()),
      backend: z.enum(['api', 'muse-code']),
      editsApplied: z.number().int(),
      editsRejected: z.number().int(),
      note: z.string(),
      usd: z.number(),
    }),
  ),
  rescan: z.object({
    before: z.object({ total: z.number().int(), byClass: z.record(z.string(), z.number().int()) }),
    after: z.object({ total: z.number().int(), byClass: z.record(z.string(), z.number().int()) }),
    resolved: z.array(z.string()).describe('selected finding ids that no longer appear'),
    remaining: z.array(z.string()).describe('selected finding ids still reported'),
    introduced: z
      .number()
      .int()
      .describe('findings in the after scan that were not in the before scan'),
  }),
  tests: z.object({
    ran: z.boolean(),
    passed: z.boolean(),
    runner: z.enum(['docker', 'local', 'none']),
    command: z.string(),
    outputTail: z.string(),
    durationMs: z.number(),
  }),
  green: z.boolean(),
  usd: z.number(),
});
export type PatchRecordT = z.infer<typeof PatchRecord>;

export async function runPatchLoop(runDir: string, options: PatchOptions): Promise<PatchRecordT> {
  const startedAt = new Date().toISOString();
  const manifest = RunManifest.parse(
    JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')),
  );
  const findings = z
    .array(Finding)
    .parse(JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')));
  const repoDir = manifest.target.path;

  // Which findings to patch: confirmed or likely verdicts first; without a
  // reasoning stage, the criticals in the top classes.
  const classes = options.classes ?? topClasses(findings);
  const judged = findings.filter((f) => f.reasoning);
  const pool = judged.length
    ? judged.filter(
        (f) =>
          f.reasoning?.exploitability === 'confirmed' || f.reasoning?.exploitability === 'likely',
      )
    : findings.filter((f) => f.severity === 'critical' && classes.includes(f.vulnClass));
  const selected = dedupeByLocation(pool.filter((f) => classes.includes(f.vulnClass))).slice(
    0,
    options.maxFindings,
  );
  info(`patching ${selected.length} findings in classes: ${classes.join(', ')}`);

  const backend = resolveBackend(options);
  const outcomes: PatchOutcome[] = [];
  let branch: string | null = null;
  let baseCommit: string | null = null;
  let patchCommit: string | null = null;
  let tests: TestRunResult = {
    ran: false,
    passed: false,
    runner: 'none',
    command: '',
    outputTail: 'not run',
    durationMs: 0,
  };

  if (!options.dryRun && selected.length > 0 && backend !== 'none') {
    await ensureRepo(repoDir);
    baseCommit = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
    branch = `vibeaudit2/patch-${manifest.runId}`;
    await createBranch(repoDir, branch);

    if (backend === 'api' && options.client) {
      const rate = rateFor(options.client.model);
      for (const finding of selected) {
        try {
          const outcome = await apiPatch(options.client, repoDir, finding, rate); // vibe-audit-ignore perf-no-await-parallel
          outcomes.push(outcome);
          const applied = outcome.edits.filter((e) => e.applied).length;
          info(
            `${finding.file}:${finding.line ?? '?'} ${finding.ruleId}: ${applied}/${outcome.edits.length} edits applied ($${outcome.usd.toFixed(4)})`,
          );
        } catch (error) {
          outcomes.push({
            findingIds: [finding.id],
            backend: 'api',
            plan: null,
            edits: [],
            note: `error: ${(error as Error).message.slice(0, 300)}`,
            usd: 0,
          });
          warn(`patch failed for ${finding.id}: ${(error as Error).message}`);
        }
      }
    } else if (backend === 'muse-code') {
      const outcome = await museCodePatch(repoDir, selected, {
        model: options.museModel,
        maxSteps: 60,
        timeoutMs: 20 * 60_000,
      });
      outcomes.push(outcome);
      info(`muse code: ${outcome.note.slice(0, 200)}`);
    }

    patchCommit = await commitAll(
      repoDir,
      `vibeaudit2: patch ${selected.length} findings (${classes.join(', ')})`,
    );
    const diff = baseCommit ? await diffAgainst(repoDir, baseCommit) : '';
    await writeText(join(runDir, 'patch.diff'), diff);
  }

  // Re-scan the patched tree with the same engine settings as the original run.
  const beforeByClass = countBy(selected, (f) => f.vulnClass);
  let afterFindings: FindingT[] = findings;
  if (!options.dryRun && patchCommit) {
    const engine = await runEngineScan(repoDir, {
      sca: manifest.engine.sca,
      trustTargetConfig: manifest.engine.trustTargetConfig,
    });
    afterFindings = await normalizeFindings(engine.output, repoDir, { contextLines: 6 });
    await writeJson(join(runDir, 'findings.after.json'), afterFindings);
  }
  const afterKeys = new Set(afterFindings.map(locationKey));
  const beforeKeys = new Set(findings.map(locationKey));
  const resolved = selected.filter((f) => !afterKeys.has(locationKey(f))).map((f) => f.id);
  const remaining = selected.filter((f) => afterKeys.has(locationKey(f))).map((f) => f.id);
  const introduced = afterFindings.filter((f) => !beforeKeys.has(locationKey(f))).length;

  if (!options.dryRun && patchCommit && options.runTests) {
    tests = await runProjectTests(repoDir, {
      useDocker: options.useDocker,
      allowLocal: options.allowLocalTests,
    });
    info(
      `project tests: ${tests.ran ? (tests.passed ? 'passed' : 'failed') : 'not run'} (${tests.runner})`,
    );
  }

  const green =
    patchCommit !== null &&
    remaining.length === 0 &&
    introduced === 0 &&
    (!options.runTests || (tests.ran && tests.passed));
  const record: PatchRecordT = {
    runId: manifest.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    backend,
    branch,
    baseCommit,
    patchCommit,
    selected: selected.map((f) => ({
      id: f.id,
      file: f.file,
      ruleId: f.ruleId,
      vulnClass: f.vulnClass,
    })),
    outcomes: outcomes.map((o) => ({
      findingIds: o.findingIds,
      backend: o.backend,
      editsApplied: o.edits.filter((e) => e.applied).length,
      editsRejected: o.edits.filter((e) => !e.applied).length,
      note: o.note,
      usd: o.usd,
    })),
    rescan: {
      before: { total: selected.length, byClass: beforeByClass },
      after: {
        total: remaining.length,
        byClass: countBy(
          selected.filter((f) => afterKeys.has(locationKey(f))),
          (f) => f.vulnClass,
        ),
      },
      resolved,
      remaining,
      introduced,
    },
    tests,
    green,
    usd: Number(outcomes.reduce((n, o) => n + o.usd, 0).toFixed(4)),
  };
  await writeJson(join(runDir, 'patch.json'), record);
  await writeJson(join(runDir, 'manifest.json'), {
    ...manifest,
    stages: {
      ...manifest.stages,
      patch: options.dryRun ? 'pending' : patchCommit ? 'done' : 'failed',
    },
  });
  info(
    options.dryRun
      ? `dry run: ${selected.length} findings would be patched with the ${backend} backend`
      : `patch loop ${green ? 'GREEN' : 'NOT GREEN'}: ${resolved.length} resolved, ${remaining.length} remaining, ${introduced} introduced, tests ${tests.ran ? (tests.passed ? 'passed' : 'failed') : 'not run'}`,
  );
  return record;
}

function resolveBackend(options: PatchOptions): 'api' | 'muse-code' | 'none' {
  if (options.backend === 'muse-code') return museAvailable() ? 'muse-code' : 'none';
  if (options.backend === 'api') return options.client ? 'api' : 'none';
  if (museAvailable()) return 'muse-code';
  return options.client ? 'api' : 'none';
}

/** Several rules often flag one line. One patch per location is enough. */
function dedupeByLocation(findings: readonly FindingT[]): FindingT[] {
  const seen = new Set<string>();
  const out: FindingT[] = [];
  for (const f of findings) {
    const key = `${f.file}:${f.line ?? 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function locationKey(f: FindingT): string {
  return `${f.ruleId}|${f.file}|${f.line ?? 0}`;
}
