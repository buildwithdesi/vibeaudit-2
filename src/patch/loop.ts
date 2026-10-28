import { cpSync, existsSync, rmSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { runEngineScan } from '../engine/v1.ts';
import { Finding, type FindingT, RunManifest } from '../model/finding.ts';
import { countBy, normalizeFindings } from '../normalize/index.ts';
import { ReasoningBudget, rateFor } from '../reason/budget.ts';
import { listFiles, relatedSnippets } from '../reason/context.ts';
import type { ClientConfig } from '../reason/meta-client.ts';
import { completeStructured, isFatalStatus, ModelApiError } from '../reason/meta-client.ts';
import { buildExploitabilityMessages } from '../reason/prompts/exploitability.ts';
import { ExploitVerdict } from '../reason/schemas.ts';
import { topClasses } from '../report/summary.ts';
import { writeJson, writeText } from '../util/fs.ts';
import { info, warn } from '../util/log.ts';
import { apiPatch, museAvailable, museCodePatch, type PatchOutcome } from './backends.ts';
import { compareScans, parseUnifiedDiff } from './compare.ts';
import { countSuppressions, forbiddenPathReason } from './edits.ts';
import {
  changedFiles,
  checkout,
  commitAll,
  createBranch,
  diffAgainst,
  ensureRepo,
  git,
  untrackedFiles,
} from './git.ts';
import { runProjectTests, type TestRunResult } from './project-tests.ts';

/**
 * Stage 7: the patch loop.
 *
 *   select findings -> pipeline's own copy -> sandbox branch -> patch ->
 *   commit -> re-scan -> project tests
 *
 * The user's checkout is never touched: a GitHub target is already the
 * pipeline's clone, and a local folder is copied into the run folder first.
 * "Green" means the re-scan no longer reports the patched findings, nothing
 * new appeared, and the project's own tests ran and passed. Without tests
 * the result is at best "re-scan clean", never green.
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
  budgetUsd: number;
  /** Plan only: no edits, no branch, no tests. */
  dryRun: boolean;
}

export const PatchRecord = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  backend: z.enum(['api', 'muse-code', 'none']),
  workDir: z.string().nullable(),
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
  rejectedFiles: z
    .array(z.string())
    .describe(
      'files a backend changed or created outside the allowlist, or where it added a scanner suppression; all were undone',
    ),
  rescan: z.object({
    ran: z.boolean(),
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
  /** Findings the scanner still flags after the patch, re-judged on the patched code. */
  verification: z.array(
    z.object({
      findingId: z.string(),
      exploitability: z.string(),
      confidence: z.number(),
      plainLanguage: z.string(),
      usd: z.number(),
    }),
  ),
  rescanClean: z.boolean(),
  /** Every remaining finding was judged closed on the patched code. */
  verifiedClean: z.boolean(),
  green: z.boolean(),
  error: z.string().nullable(),
  usd: z.number(),
});
export type PatchRecordT = z.infer<typeof PatchRecord>;

const COPY_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'runs']);

export async function runPatchLoop(runDir: string, options: PatchOptions): Promise<PatchRecordT> {
  const startedAt = new Date().toISOString();
  const manifest = RunManifest.parse(
    JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')),
  );
  const findings = z
    .array(Finding)
    .parse(JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')));

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
  const rate = backend === 'api' && options.client ? rateFor(options.client.model) : null;
  const budget = new ReasoningBudget({
    perRunUsd: options.budgetUsd,
    maxFindingsPerFile: 50,
    perFileInputTokens: 400_000,
  });
  const outcomes: PatchOutcome[] = [];
  const rejectedFiles: string[] = [];
  let workDir: string | null = null;
  let branch: string | null = null;
  let baseCommit: string | null = null;
  let patchCommit: string | null = null;
  let error: string | null = null;
  let afterFindings: FindingT[] | null = null;
  let lineMap = parseUnifiedDiff('');
  let tests: TestRunResult = {
    ran: false,
    passed: false,
    runner: 'none',
    command: '',
    outputTail: 'not run',
    durationMs: 0,
  };

  try {
    if (!options.dryRun && selected.length > 0 && backend !== 'none') {
      workDir = await workingCopy(runDir, manifest.target.kind, manifest.target.path);
      await ensureRepo(workDir);
      baseCommit = (await git(workDir, ['rev-parse', 'HEAD'])).trim();
      branch = `vibeaudit2/patch-${manifest.runId}`;
      await createBranch(workDir, branch);

      if (backend === 'api' && options.client && rate) {
        for (const finding of selected) {
          const decision = budget.canSpend(finding.file, 6_000, rate);
          if (!decision.ok) {
            outcomes.push({
              findingIds: [finding.id],
              backend: 'api',
              plan: null,
              edits: [],
              note: `skipped: ${decision.reason}`,
              usd: 0,
              usage: null,
            });
            continue;
          }
          const siblings = siblingsOf(finding, pool);
          const outcome = await apiPatch(options.client, workDir, finding, rate, siblings); // vibe-audit-ignore perf-no-await-parallel
          if (outcome.usage) budget.record(finding.file, outcome.usage, rate);
          outcomes.push(outcome);
          const applied = outcome.edits.filter((e) => e.applied).length;
          info(
            `${finding.file}:${finding.line ?? '?'} ${finding.ruleId}: ${applied}/${outcome.edits.length} edits applied ($${outcome.usd.toFixed(4)})`,
          );
          if (outcome.fatal) {
            // Every later call would fail the same way. Keep what was applied, stop spending.
            error = `stopped before spending more: ${outcome.note}`;
            warn(error);
            break;
          }
        }
      } else if (backend === 'muse-code') {
        // Untracked files already in the copy (gitignored ones) are not the agent's.
        const before = new Set(await untrackedFiles(workDir));
        const outcome = await museCodePatch(workDir, selected, {
          model: options.museModel,
          maxSteps: 60,
          timeoutMs: 20 * 60_000,
          apiKey: options.client?.apiKey ?? null,
        });
        outcomes.push(outcome);
        info(`muse code: ${outcome.note.slice(0, 200)}`);
        // The agent edits the tree itself, so the allowlist is enforced afterwards.
        const allowed = new Set(selected.map((f) => f.file.replace(/\\/g, '/')));
        rejectedFiles.push(
          ...(await revertOutsideAllowlist(workDir, branch, baseCommit, allowed, before)),
        );
        if (rejectedFiles.length)
          warn(
            `reverted ${rejectedFiles.length} file(s) outside the allowlist: ${rejectedFiles.join(', ')}`,
          );
      }

      // Neither backend may close a finding by hiding it from the scanner.
      const suppressing = await revertAddedSuppressions(workDir, baseCommit);
      if (suppressing.length) {
        rejectedFiles.push(...suppressing);
        warn(
          `reverted ${suppressing.length} file(s) that add a scanner suppression: ${suppressing.join(', ')}`,
        );
      }

      patchCommit = await commitAll(
        workDir,
        `vibeaudit2: patch ${selected.length} findings (${classes.join(', ')})`,
      );
      if (patchCommit) {
        lineMap = parseUnifiedDiff(
          await git(workDir, ['diff', '--no-ext-diff', '-U0', baseCommit]),
        );
      }
      await writeText(
        join(runDir, 'patch.diff'),
        patchCommit ? await diffAgainst(workDir, baseCommit) : '',
      );

      if (patchCommit) {
        const engine = await runEngineScan(workDir, {
          sca: manifest.engine.sca,
          trustTargetConfig: manifest.engine.trustTargetConfig,
        });
        afterFindings = await normalizeFindings(engine.output, workDir, { contextLines: 6 });
        await writeJson(join(runDir, 'findings.after.json'), afterFindings);
        if (options.runTests) {
          tests = await runProjectTests(workDir, {
            useDocker: options.useDocker,
            allowLocal: options.allowLocalTests,
          });
          info(
            `project tests: ${tests.ran ? (tests.passed ? 'passed' : 'failed') : 'not run'} (${tests.runner})`,
          );
        }
      }
    }
  } catch (caught) {
    error = (caught as Error).message.slice(0, 500);
    warn(`patch loop stopped: ${error}`);
  } finally {
    if (workDir && baseCommit) {
      // Leave the copy on its original commit so a later stage, or a second
      // patch run, sees the before state. The patch stays on its branch.
      await checkout(workDir, baseCommit).catch(() => undefined);
    }
  }

  // Compare through the diff's line map, never by raw line number.
  const selectedIds = new Set(
    selected.flatMap((f) => [f, ...siblingsOf(f, pool)]).map((f) => f.id),
  );
  const comparison = afterFindings
    ? compareScans(findings, afterFindings, selectedIds, lineMap)
    : { resolved: [], remaining: selected.map((f) => f.id), remainingPairs: [], introduced: 0 };
  const { resolved, remaining, introduced } = comparison;

  // A rule is a heuristic. When it still fires on patched code, the reasoning
  // model re-judges that exact spot with the patch in view. The scanner's
  // verdict and the model's verdict are both recorded, never merged.
  const verification: PatchRecordT['verification'] = [];
  if (
    !options.dryRun &&
    error === null &&
    workDir &&
    options.client &&
    rate &&
    comparison.remainingPairs.length
  ) {
    const files = await listFiles(workDir);
    for (const { beforeId, after } of comparison.remainingPairs) {
      const decision = budget.canSpend(after.file, 6_000, rate);
      if (!decision.ok) break;
      try {
        const related = await relatedSnippets(workDir, after, files, null); // vibe-audit-ignore perf-no-await-parallel
        const messages = buildExploitabilityMessages({
          finding: after,
          repoMap: null,
          relatedSnippets: related,
          triageNote: 'This code was just patched. Judge the patched version only.',
        });
        const request = {
          messages,
          schema: ExploitVerdict,
          schemaName: 'ExploitVerdict',
          reasoningEffort: 'high' as const,
          maxOutputTokens: 16_000,
        };
        const result = await completeStructured(options.client, request); // vibe-audit-ignore perf-no-await-parallel
        const usd = budget.record(after.file, result.usage, rate);
        after.reasoning = result.data;
        verification.push({
          findingId: beforeId,
          exploitability: result.data.exploitability,
          confidence: result.data.confidence,
          plainLanguage: result.data.plainLanguage,
          usd,
        });
        info(
          `verify ${after.file}:${after.line ?? '?'} ${after.ruleId} -> ${result.data.exploitability} ($${usd.toFixed(4)})`,
        );
      } catch (caught) {
        if (caught instanceof ModelApiError && isFatalStatus(caught.status)) {
          error = `verification stopped before spending more: ${caught.message.slice(0, 300)}`;
          warn(error);
          break;
        }
        warn(`verification failed for ${beforeId}: ${(caught as Error).message}`);
      }
    }
    if (afterFindings) await writeJson(join(runDir, 'findings.after.json'), afterFindings);
  }
  const verifiedClean =
    remaining.length > 0 &&
    verification.length === remaining.length &&
    verification.every(
      (v) => v.exploitability === 'not-exploitable' || v.exploitability === 'unlikely',
    );
  const rescanClean = afterFindings !== null && remaining.length === 0 && introduced === 0;
  const closed =
    afterFindings !== null && introduced === 0 && (remaining.length === 0 || verifiedClean);
  const green = closed && tests.ran && tests.passed && error === null;

  const record: PatchRecordT = {
    runId: manifest.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    backend,
    workDir,
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
    rejectedFiles,
    rescan: {
      ran: afterFindings !== null,
      before: { total: selected.length, byClass: countBy(selected, (f) => f.vulnClass) },
      after: {
        total: remaining.length,
        byClass: countBy(
          selected.filter((f) => remaining.includes(f.id)),
          (f) => f.vulnClass,
        ),
      },
      resolved,
      remaining,
      introduced,
    },
    tests,
    verification,
    rescanClean,
    verifiedClean,
    green,
    error,
    usd: Number(
      (
        outcomes.reduce((n, o) => n + o.usd, 0) + verification.reduce((n, v) => n + v.usd, 0)
      ).toFixed(4),
    ),
  };
  // A dry run never overwrites a live record, and never moves the stage.
  await writeJson(join(runDir, options.dryRun ? 'patch.dry-run.json' : 'patch.json'), record);
  if (!options.dryRun) {
    await writeJson(join(runDir, 'manifest.json'), {
      ...manifest,
      stages: { ...manifest.stages, patch: error ? 'failed' : patchCommit ? 'done' : 'failed' },
    });
  }
  info(
    options.dryRun
      ? `dry run: ${selected.length} findings would be patched with the ${backend} backend`
      : `patch loop ${green ? 'GREEN' : closed ? 'CLOSED, tests not run or failed' : 'NOT GREEN'}: ${resolved.length} resolved, ${remaining.length} still flagged${verification.length ? ` (${verification.filter((v) => v.exploitability === 'not-exploitable' || v.exploitability === 'unlikely').length} judged closed on review)` : ''}, ${introduced} introduced, tests ${tests.ran ? (tests.passed ? 'passed' : 'failed') : 'not run'}, $${record.usd.toFixed(4)}`,
  );
  return record;
}

/** GitHub targets are already the pipeline's clone. Local folders are copied in, never patched in place. */
async function workingCopy(
  runDir: string,
  kind: 'github' | 'local',
  targetPath: string,
): Promise<string> {
  if (kind === 'github') return targetPath;
  const dest = resolve(runDir, 'repo');
  if (!existsSync(dest)) {
    cpSync(targetPath, dest, {
      recursive: true,
      filter: (src) => !COPY_SKIP.has(src.split(/[\\/]/).pop() ?? ''),
    });
  }
  return dest;
}

function resolveBackend(options: PatchOptions): 'api' | 'muse-code' | 'none' {
  // Muse Code runs an agent inside the repository, so it is never picked by default.
  if (options.backend === 'muse-code') return museAvailable() ? 'muse-code' : 'none';
  return options.client ? 'api' : 'none';
}

/**
 * Several rules often flag one line. One patch per location is enough, but
 * the patcher must know every rule that fired there so one edit closes all
 * of them. The first finding leads; the rest ride along as siblings.
 */
function dedupeByLocation(findings: readonly FindingT[]): FindingT[] {
  const byKey = new Map<string, FindingT>();
  for (const f of findings) {
    const key = `${f.file}:${f.line ?? 0}`;
    if (!byKey.has(key)) byKey.set(key, f);
  }
  return [...byKey.values()];
}

function siblingsOf(lead: FindingT, pool: readonly FindingT[]): FindingT[] {
  return pool.filter(
    (f) => f !== lead && f.file === lead.file && (f.line ?? 0) === (lead.line ?? 0),
  );
}

/**
 * Undo every change an agent made outside the allowlist and return those
 * paths. Anything the agent staged, committed or switched to is undone
 * first, keeping its edits in the working tree, so the index is the base
 * again. New files are deleted before tracked files are restored, so a
 * folder planted where a tracked file was cannot block the restore.
 */
async function revertOutsideAllowlist(
  repoDir: string,
  branch: string,
  baseCommit: string,
  allowed: ReadonlySet<string>,
  untrackedBefore: ReadonlySet<string>,
): Promise<string[]> {
  await git(repoDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  await git(repoDir, ['reset', '-q', baseCommit]);
  const outside = (file: string): boolean =>
    Boolean(forbiddenPathReason(file)) || !allowed.has(file);
  const changed = await changedFiles(repoDir, baseCommit);
  const planted = changed.untracked.filter((file) => !untrackedBefore.has(file) && outside(file));
  for (const file of planted) rmSync(resolve(repoDir, file), { recursive: true, force: true });
  const restored = changed.tracked.filter(outside);
  if (restored.length) {
    await git(repoDir, ['--literal-pathspecs', 'checkout', '-q', '--', ...restored]);
  }
  return [...planted, ...restored];
}

/**
 * Put back every changed file whose patch adds vibe-audit-ignore comments and
 * return those paths. The engine honours the comments, so the re-scan would
 * read a hidden finding as fixed. Runs for both backends, on the tree itself.
 */
async function revertAddedSuppressions(repoDir: string, baseCommit: string): Promise<string[]> {
  const { tracked } = await changedFiles(repoDir, baseCommit);
  const checked = await Promise.all(
    tracked.map(async (file) => {
      const abs = resolve(repoDir, file);
      const stat = await lstat(abs).catch(() => null);
      const after = stat?.isFile() ? await readFile(abs, 'utf8') : '';
      const before = await git(repoDir, ['cat-file', 'blob', `${baseCommit}:${file}`]).catch(
        () => '',
      );
      return countSuppressions(after) > countSuppressions(before) ? file : null;
    }),
  );
  const suppressing = checked.filter((file) => file !== null);
  if (suppressing.length) {
    await git(repoDir, ['--literal-pathspecs', 'checkout', '-q', baseCommit, '--', ...suppressing]);
  }
  return suppressing;
}
