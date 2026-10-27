import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Finding, type FindingT, RunManifest, type RunManifestT } from '../model/finding.ts';
import { topClasses } from '../report/summary.ts';
import { writeJson, writeText } from '../util/fs.ts';
import { debug, info, warn } from '../util/log.ts';
import {
  type BudgetConfig,
  costUsd,
  estimateTokens,
  ReasoningBudget,
  rateFor,
  type Usage,
} from './budget.ts';
import {
  keyFileExcerpts,
  listFiles,
  readPackageJson,
  relatedSnippets,
  renderFindingsIndex,
  renderTree,
} from './context.ts';
import {
  type ChatMessage,
  type ClientConfig,
  completeStructured,
  type ReasoningEffort,
} from './meta-client.ts';
import { buildExploitabilityMessages } from './prompts/exploitability.ts';
import { buildRepoMapMessages } from './prompts/repo-map.ts';
import { buildTriageMessages } from './prompts/triage.ts';
import { ExploitVerdict, RepoMap, type RepoMapT, TriageVerdict } from './schemas.ts';

/**
 * Stage 4 and 5: triage then exploitability, on top of a finished run folder.
 * The orchestrator reads findings.json, fills the triage and reasoning slots
 * in place, and writes reasoning.json with every decision and every dollar.
 */
export interface ReasonOptions {
  reason: ClientConfig | null;
  triage: ClientConfig | null;
  /** No API calls. Prompts and the cost estimate are written to runDir/prompts. */
  dryRun: boolean;
  classes: string[] | null;
  maxFindings: number;
  effort: { map: ReasoningEffort; triage: ReasoningEffort; exploit: ReasoningEffort };
  budget: Partial<BudgetConfig>;
}

export const DEFAULT_EFFORT: ReasonOptions['effort'] = {
  map: 'medium',
  triage: 'low',
  exploit: 'high',
};

export const Decision = z.object({
  findingId: z.string(),
  file: z.string(),
  outcome: z.enum(['reasoned', 'triage-dropped', 'budget-exhausted', 'not-selected', 'error']),
  note: z.string(),
  usd: z.number(),
});

export const ReasoningRecord = z.object({
  runId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  dryRun: z.boolean(),
  models: z.object({ reason: z.string().nullable(), triage: z.string().nullable() }),
  classes: z.array(z.string()),
  repoMap: RepoMap.nullable(),
  decisions: z.array(Decision),
  calls: z.number().int(),
  usage: z.object({
    promptTokens: z.number().int(),
    cachedTokens: z.number().int(),
    completionTokens: z.number().int(),
    reasoningTokens: z.number().int(),
  }),
  usd: z.number(),
  estimatedUsd: z.number(),
});
export type ReasoningRecordT = z.infer<typeof ReasoningRecord>;

export async function runReasoning(
  runDir: string,
  options: ReasonOptions,
): Promise<ReasoningRecordT> {
  const startedAt = new Date().toISOString();
  const manifest = RunManifest.parse(
    JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')),
  );
  const findings = z
    .array(Finding)
    .parse(JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')));
  const repoDir = manifest.target.path;
  const liveReason = !options.dryRun && options.reason;
  const liveTriage = !options.dryRun && options.triage;
  if (!options.dryRun && !options.reason) {
    throw new Error('No reasoning model configured. Set META_API_KEY in .env or pass --dry-run.');
  }

  const reasonRate = options.reason ? rateFor(options.reason.model) : rateFor('muse-spark-1.3');
  const triageRate = options.triage ? rateFor(options.triage.model) : null;
  const budget = new ReasoningBudget(options.budget);
  const usage: Usage = {
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  };
  let estimatedUsd = 0;
  const decisions: z.infer<typeof Decision>[] = [];
  const promptDir = join(runDir, 'prompts');

  // Which findings get the expensive treatment: the top classes, criticals first.
  const classes = options.classes ?? topClasses(findings);
  const selected = findings
    .filter((f) => classes.includes(f.vulnClass))
    .sort((a, b) => severityRank(a) - severityRank(b))
    .slice(0, options.maxFindings);
  const selectedIds = new Set(selected.map((f) => f.id));
  for (const f of findings) {
    if (!selectedIds.has(f.id)) {
      decisions.push({
        findingId: f.id,
        file: f.file,
        outcome: 'not-selected',
        note: 'outside the selected classes or past --max-findings',
        usd: 0,
      });
    }
  }
  info(
    `reasoning over ${selected.length} of ${findings.length} findings in classes: ${classes.join(', ')}`,
  );

  // Stage 4a: repository map, one call.
  const files = await listFiles(repoDir);
  const mapMessages = buildRepoMapMessages({
    label: manifest.target.label,
    fileTree: renderTree(files),
    packageJson: await readPackageJson(repoDir),
    findingsIndex: renderFindingsIndex(findings),
    keyFileExcerpts: await keyFileExcerpts(repoDir, files, findings),
  });
  let repoMap: RepoMapT | null = null;
  if (liveReason && options.reason) {
    try {
      const result = await completeStructured(options.reason, {
        messages: mapMessages,
        schema: RepoMap,
        schemaName: 'RepoMap',
        reasoningEffort: options.effort.map,
        maxOutputTokens: 6_000,
      });
      repoMap = result.data;
      addUsage(usage, result.usage);
      budget.record('<repo-map>', result.usage, reasonRate);
      info(
        `repo map: ${repoMap.entryPoints.length} entry points, ${repoMap.authBoundaries.length} auth boundaries ($${costUsd(result.usage, reasonRate).toFixed(4)})`,
      );
    } catch (error) {
      warn(`repo map failed, continuing without it: ${(error as Error).message}`);
    }
  } else {
    await writeText(join(promptDir, 'repo-map.md'), renderMessages(mapMessages));
    estimatedUsd += estimateCost(mapMessages, 4_000, reasonRate);
  }

  // Stage 4b and 5: per finding, grouped by file so the budget reads naturally.
  const roleOf = new Map((repoMap?.fileRoles ?? []).map((r) => [r.file, r.role] as const));
  for (const finding of selected) {
    // Triage with the cheap model when one is configured.
    if (options.triage) {
      const triageMessages = buildTriageMessages({
        finding,
        fileRole: roleOf.get(finding.file) ?? null,
        repoSummary: repoMap?.summary ?? null,
      });
      if (liveTriage && triageRate) {
        try {
          const request = {
            messages: triageMessages,
            schema: TriageVerdict,
            schemaName: 'TriageVerdict',
            reasoningEffort: options.effort.triage,
            maxOutputTokens: 800,
          };
          // biome-ignore format: the trailing marker must stay on the await line for the v1 engine
          const result = await completeStructured(options.triage, request); // vibe-audit-ignore perf-no-await-parallel
          addUsage(usage, result.usage);
          budget.record(`<triage>${finding.file}`, result.usage, triageRate);
          finding.triage = result.data;
          if (!result.data.keep) {
            decisions.push({
              findingId: finding.id,
              file: finding.file,
              outcome: 'triage-dropped',
              note: `${result.data.category}: ${result.data.reason}`,
              usd: costUsd(result.usage, triageRate),
            });
            debug(`dropped ${finding.id} (${result.data.category})`);
            continue;
          }
        } catch (error) {
          warn(`triage failed for ${finding.id}, keeping it: ${(error as Error).message}`);
        }
      } else {
        await writeText(join(promptDir, `triage-${finding.id}.md`), renderMessages(triageMessages)); // vibe-audit-ignore perf-no-await-parallel
        if (triageRate) estimatedUsd += estimateCost(triageMessages, 300, triageRate);
      }
    }

    const related = await relatedSnippets(repoDir, finding, files, repoMap); // vibe-audit-ignore perf-no-await-parallel
    const messages = buildExploitabilityMessages({
      finding,
      repoMap,
      relatedSnippets: related,
      triageNote: finding.triage?.reason ?? null,
    });
    const estimatedInput = estimateTokens(messages.map((m) => m.content).join('\n'));
    const decision = budget.canSpend(finding.file, estimatedInput, reasonRate);
    if (!decision.ok) {
      decisions.push({
        findingId: finding.id,
        file: finding.file,
        outcome: 'budget-exhausted',
        note: decision.reason,
        usd: 0,
      });
      continue;
    }

    if (liveReason && options.reason) {
      try {
        const request = {
          messages,
          schema: ExploitVerdict,
          schemaName: 'ExploitVerdict',
          reasoningEffort: options.effort.exploit,
          maxOutputTokens: budget.config.perFindingOutputTokens,
        };
        // biome-ignore format: the trailing marker must stay on the await line for the v1 engine
        const result = await completeStructured(options.reason, request); // vibe-audit-ignore perf-no-await-parallel
        addUsage(usage, result.usage);
        const usd = budget.record(finding.file, result.usage, reasonRate);
        finding.reasoning = result.data;
        decisions.push({
          findingId: finding.id,
          file: finding.file,
          outcome: 'reasoned',
          note: `${result.data.exploitability} (${result.data.confidence})`,
          usd,
        });
        info(
          `${finding.file}:${finding.line ?? '?'} ${finding.ruleId} -> ${result.data.exploitability} ($${usd.toFixed(4)})`,
        );
      } catch (error) {
        decisions.push({
          findingId: finding.id,
          file: finding.file,
          outcome: 'error',
          note: (error as Error).message.slice(0, 300),
          usd: 0,
        });
        warn(`reasoning failed for ${finding.id}: ${(error as Error).message}`);
      }
    } else {
      await writeText(join(promptDir, `exploit-${finding.id}.md`), renderMessages(messages)); // vibe-audit-ignore perf-no-await-parallel
      const est = estimateCost(messages, 1_200, reasonRate);
      estimatedUsd += est;
      // Charge the budget with the estimate so a dry run shows the same caps a live run would hit.
      budget.reserve(finding.file, estimatedInput, 1_200, reasonRate);
      decisions.push({
        findingId: finding.id,
        file: finding.file,
        outcome: 'reasoned',
        note: 'dry run: prompt written, no call made',
        usd: 0,
      });
    }
  }

  const record: ReasoningRecordT = {
    runId: manifest.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    models: { reason: options.reason?.model ?? null, triage: options.triage?.model ?? null },
    classes,
    repoMap,
    decisions,
    calls: budget.callCount,
    usage,
    usd: Number(budget.spentUsd.toFixed(4)),
    estimatedUsd: Number(estimatedUsd.toFixed(4)),
  };
  await writeJson(join(runDir, 'findings.json'), findings);
  await writeJson(join(runDir, 'reasoning.json'), record);
  const stages: RunManifestT['stages'] = {
    ...manifest.stages,
    triage: options.triage ? (options.dryRun ? 'pending' : 'done') : 'skipped',
    reasoning: options.dryRun ? 'pending' : 'done',
  };
  await writeJson(join(runDir, 'manifest.json'), { ...manifest, stages });
  const reasoned = decisions.filter((d) => d.outcome === 'reasoned').length;
  const dropped = decisions.filter((d) => d.outcome === 'triage-dropped').length;
  const capped = decisions.filter((d) => d.outcome === 'budget-exhausted').length;
  info(
    options.dryRun
      ? `dry run: ${reasoned} prompts written to ${promptDir}, estimated $${estimatedUsd.toFixed(2)}`
      : `reasoned ${reasoned}, triage dropped ${dropped}, budget capped ${capped}, spent $${budget.spentUsd.toFixed(4)} over ${budget.callCount} calls`,
  );
  return record;
}

function severityRank(f: FindingT): number {
  return f.severity === 'critical' ? 0 : f.severity === 'warning' ? 1 : 2;
}

function addUsage(total: Usage, add: Usage): void {
  total.promptTokens += add.promptTokens;
  total.cachedTokens += add.cachedTokens;
  total.completionTokens += add.completionTokens;
  total.reasoningTokens += add.reasoningTokens;
}

function estimateCost(
  messages: ChatMessage[],
  outputTokens: number,
  rate: { input: number; output: number },
): number {
  const input = estimateTokens(messages.map((m) => m.content).join('\n'));
  return (input * rate.input + outputTokens * rate.output) / 1_000_000;
}

function renderMessages(messages: ChatMessage[]): string {
  return messages.map((m) => `## ${m.role}\n\n${m.content}\n`).join('\n');
}
