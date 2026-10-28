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
  type Rate,
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
  isFatalStatus,
  ModelApiError,
  type ReasoningEffort,
} from './meta-client.ts';
import { buildExploitabilityMessages } from './prompts/exploitability.ts';
import { buildRepoMapMessages } from './prompts/repo-map.ts';
import { buildTriageMessages } from './prompts/triage.ts';
import { ExploitVerdict, RepoMap, type RepoMapT, TriageVerdict } from './schemas.ts';

/**
 * Stage 4 and 5: triage then exploitability, on top of a finished run folder.
 * The orchestrator reads findings.json, fills the triage and reasoning slots
 * in place after every call (so a crash loses nothing that was paid for),
 * and writes reasoning.json with every decision and every dollar.
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
  /** Judge findings again even when they already carry a verdict. */
  force: boolean;
}

export const DEFAULT_EFFORT: ReasonOptions['effort'] = {
  map: 'medium',
  triage: 'low',
  exploit: 'high',
};

/** Completion caps. Reasoning tokens count against them, so they sit well above the answer size. */
const OUTPUT_CAP = { map: 16_000, triage: 4_000, exploit: 16_000 };

/**
 * Completion tokens a dry run expects per call, reasoning included. The map
 * billed about 2,450 on the live seeded-app run (demo/after/reasoning.json).
 * Triage has no live sample yet. A verdict uses the budget's
 * perFindingOutputTokens, so the estimate and the run cap agree.
 */
const EXPECTED_OUTPUT = { map: 2_500, triage: 300 };

export const Decision = z.object({
  findingId: z.string(),
  file: z.string(),
  outcome: z.enum([
    'reasoned',
    'triage-dropped',
    'budget-exhausted',
    'not-selected',
    'already-reasoned',
    'error',
  ]),
  note: z.string(),
  usd: z.number(),
});
type DecisionT = z.infer<typeof Decision>;

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
  aborted: z.string().nullable(),
});
export type ReasoningRecordT = z.infer<typeof ReasoningRecord>;

export class ReasoningAborted extends Error {
  override name = 'ReasoningAborted';
}

interface Session {
  options: ReasonOptions;
  live: boolean;
  repoDir: string;
  runDir: string;
  promptDir: string;
  files: string[];
  findings: FindingT[];
  repoMap: RepoMapT | null;
  roleOf: Map<string, string>;
  reasonRate: Rate;
  triageRate: Rate | null;
  budget: ReasoningBudget;
  usage: Usage;
  estimatedUsd: number;
  decisions: DecisionT[];
}

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
  const live = !options.dryRun;
  if (live && !options.reason) {
    throw new Error('No reasoning model configured. Set META_API_KEY in .env or pass --dry-run.');
  }

  const session: Session = {
    options,
    live,
    repoDir: manifest.target.path,
    runDir,
    promptDir: join(runDir, 'prompts'),
    files: [],
    findings,
    repoMap: null,
    roleOf: new Map(),
    reasonRate: options.reason ? rateFor(options.reason.model) : rateFor('muse-spark-1.3'),
    triageRate: options.triage ? rateFor(options.triage.model) : null,
    budget: new ReasoningBudget(options.budget),
    usage: { promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0 },
    estimatedUsd: 0,
    decisions: [],
  };

  // Which findings get the expensive treatment: the top classes, criticals first.
  const classes = options.classes ?? topClasses(findings);
  const unknown = classes.filter((c) => !findings.some((f) => f.vulnClass === c));
  if (unknown.length) warn(`no findings in classes: ${unknown.join(', ')}`);
  const selected = findings
    .filter((f) => classes.includes(f.vulnClass))
    .sort((a, b) => severityRank(a) - severityRank(b))
    .slice(0, options.maxFindings);
  const selectedIds = new Set(selected.map((f) => f.id));
  for (const f of findings) {
    if (!selectedIds.has(f.id)) {
      session.decisions.push({
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

  let aborted: string | null = null;
  try {
    // The map only serves new verdicts. When none will be bought, it is not worth a call.
    if (selected.some((f) => !keepsVerdict(session, f))) {
      await buildRepoMap(session, manifest.target.label);
    }
    for (const finding of selected) {
      await judgeFinding(session, finding); // vibe-audit-ignore perf-no-await-parallel
    }
  } catch (caught) {
    if (!(caught instanceof ReasoningAborted)) throw caught;
    aborted = caught.message;
    warn(aborted);
  }

  const reasoned = session.decisions.filter((d) => d.outcome === 'reasoned').length;
  const errors = session.decisions.filter((d) => d.outcome === 'error').length;
  const record: ReasoningRecordT = {
    runId: manifest.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    models: { reason: options.reason?.model ?? null, triage: options.triage?.model ?? null },
    classes,
    repoMap: session.repoMap,
    decisions: session.decisions,
    calls: session.budget.callCount,
    usage: session.usage,
    usd: Number(session.budget.spentUsd.toFixed(4)),
    estimatedUsd: Number(session.estimatedUsd.toFixed(4)),
    aborted,
  };
  if (live) {
    await persist(session);
    await writeJson(join(runDir, 'reasoning.json'), record);
    const failed = aborted !== null || (reasoned === 0 && errors > 0);
    const stages: RunManifestT['stages'] = {
      ...manifest.stages,
      triage: options.triage ? (failed ? 'failed' : 'done') : 'skipped',
      reasoning: failed ? 'failed' : 'done',
    };
    await writeJson(join(runDir, 'manifest.json'), { ...manifest, stages });
  } else {
    // A dry run never overwrites a live record.
    await writeJson(join(runDir, 'reasoning.dry-run.json'), record);
  }
  const dropped = session.decisions.filter((d) => d.outcome === 'triage-dropped').length;
  const capped = session.decisions.filter((d) => d.outcome === 'budget-exhausted').length;
  info(
    options.dryRun
      ? `dry run: ${reasoned} prompts written to ${session.promptDir}, estimated $${session.estimatedUsd.toFixed(2)}`
      : `reasoned ${reasoned}, triage dropped ${dropped}, budget capped ${capped}, errors ${errors}, spent $${session.budget.spentUsd.toFixed(4)} over ${session.budget.callCount} calls${aborted ? ' (aborted)' : ''}`,
  );
  return record;
}

/** Stage 4a: one map of the repository, shared by every later call. */
async function buildRepoMap(session: Session, label: string): Promise<void> {
  const { options, repoDir, findings } = session;
  session.files = await listFiles(repoDir);
  const messages = buildRepoMapMessages({
    label,
    fileTree: renderTree(session.files),
    packageJson: await readPackageJson(repoDir),
    findingsIndex: renderFindingsIndex(findings),
    keyFileExcerpts: await keyFileExcerpts(repoDir, session.files, findings),
  });
  if (!(session.live && options.reason)) {
    await writeText(join(session.promptDir, 'repo-map.md'), renderMessages(messages));
    session.estimatedUsd += estimateCost(messages, EXPECTED_OUTPUT.map, session.reasonRate);
    return;
  }
  try {
    const result = await completeStructured(options.reason, {
      messages,
      schema: RepoMap,
      schemaName: 'RepoMap',
      reasoningEffort: options.effort.map,
      maxOutputTokens: OUTPUT_CAP.map,
    });
    session.repoMap = result.data;
    session.roleOf = new Map(result.data.fileRoles.map((r) => [r.file, r.role] as const));
    addUsage(session.usage, result.usage);
    session.budget.record('<repo-map>', result.usage, session.reasonRate);
    info(
      `repo map: ${result.data.entryPoints.length} entry points, ${result.data.authBoundaries.length} auth boundaries ($${costUsd(result.usage, session.reasonRate).toFixed(4)})`,
    );
  } catch (caught) {
    charge(session, caught, '<repo-map>', session.reasonRate);
    abortIfFatal(caught);
    warn(`repo map failed, continuing without it: ${(caught as Error).message}`);
  }
}

/** Stage 4b and 5 for one finding: triage, then exploitability inside the budget. */
async function judgeFinding(session: Session, finding: FindingT): Promise<void> {
  const { options, live, budget, decisions } = session;
  if (keepsVerdict(session, finding)) {
    decisions.push({
      findingId: finding.id,
      file: finding.file,
      outcome: 'already-reasoned',
      note: 'verdict kept from an earlier run; pass --force to judge again',
      usd: 0,
    });
    return;
  }
  if (live) {
    finding.triage = null;
    finding.reasoning = null;
  }

  if (options.triage && session.triageRate) {
    const kept = await triage(session, finding, session.triageRate);
    if (!kept) return;
  }

  const related = await relatedSnippets(session.repoDir, finding, session.files, session.repoMap);
  const messages = buildExploitabilityMessages({
    finding,
    repoMap: session.repoMap,
    relatedSnippets: related,
    triageNote: finding.triage?.reason ?? null,
  });
  const estimatedInput = estimateTokens(messages.map((m) => m.content).join('\n'));
  const decision = budget.canSpend(finding.file, estimatedInput, session.reasonRate);
  if (!decision.ok) {
    decisions.push({
      findingId: finding.id,
      file: finding.file,
      outcome: 'budget-exhausted',
      note: decision.reason,
      usd: 0,
    });
    return;
  }

  if (!(live && options.reason)) {
    await writeText(join(session.promptDir, `exploit-${finding.id}.md`), renderMessages(messages));
    const expected = budget.config.perFindingOutputTokens;
    session.estimatedUsd += estimateCost(messages, expected, session.reasonRate);
    budget.reserve(finding.file, estimatedInput, expected, session.reasonRate);
    decisions.push({
      findingId: finding.id,
      file: finding.file,
      outcome: 'reasoned',
      note: 'dry run: prompt written, no call made',
      usd: 0,
    });
    return;
  }

  try {
    const result = await completeStructured(options.reason, {
      messages,
      schema: ExploitVerdict,
      schemaName: 'ExploitVerdict',
      reasoningEffort: options.effort.exploit,
      maxOutputTokens: OUTPUT_CAP.exploit,
    });
    addUsage(session.usage, result.usage);
    const usd = budget.record(finding.file, result.usage, session.reasonRate);
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
    await persist(session);
  } catch (caught) {
    const usd = charge(session, caught, finding.file, session.reasonRate);
    decisions.push({
      findingId: finding.id,
      file: finding.file,
      outcome: 'error',
      note: (caught as Error).message.slice(0, 300),
      usd,
    });
    abortIfFatal(caught);
    warn(`reasoning failed for ${finding.id}: ${(caught as Error).message}`);
  }
}

/** Returns false when the finding was dropped (or capped) and needs no exploitability call. */
async function triage(session: Session, finding: FindingT, rate: Rate): Promise<boolean> {
  const { options, live, budget, decisions } = session;
  const messages = buildTriageMessages({
    finding,
    fileRole: session.roleOf.get(finding.file) ?? null,
    repoSummary: session.repoMap?.summary ?? null,
  });
  if (!(live && options.triage)) {
    await writeText(join(session.promptDir, `triage-${finding.id}.md`), renderMessages(messages));
    session.estimatedUsd += estimateCost(messages, EXPECTED_OUTPUT.triage, rate);
    return true;
  }
  if (budget.spentUsd >= budget.config.perRunUsd) {
    decisions.push({
      findingId: finding.id,
      file: finding.file,
      outcome: 'budget-exhausted',
      note: 'run-usd-cap before triage',
      usd: 0,
    });
    return false;
  }
  try {
    const result = await completeStructured(options.triage, {
      messages,
      schema: TriageVerdict,
      schemaName: 'TriageVerdict',
      reasoningEffort: options.effort.triage,
      maxOutputTokens: OUTPUT_CAP.triage,
    });
    addUsage(session.usage, result.usage);
    budget.record(`<triage>${finding.file}`, result.usage, rate);
    finding.triage = result.data;
    if (!result.data.keep) {
      decisions.push({
        findingId: finding.id,
        file: finding.file,
        outcome: 'triage-dropped',
        note: `${result.data.category}: ${result.data.reason}`,
        usd: costUsd(result.usage, rate),
      });
      debug(`dropped ${finding.id} (${result.data.category})`);
      await persist(session);
      return false;
    }
    return true;
  } catch (caught) {
    charge(session, caught, `<triage>${finding.file}`, rate);
    abortIfFatal(caught);
    warn(`triage failed for ${finding.id}, keeping it: ${(caught as Error).message}`);
    return true;
  }
}

/** A live run keeps a verdict an earlier run paid for, unless --force asks for a new one. */
function keepsVerdict(session: Session, finding: FindingT): boolean {
  return session.live && finding.reasoning !== null && !session.options.force;
}

async function persist(session: Session): Promise<void> {
  if (session.live) await writeJson(join(session.runDir, 'findings.json'), session.findings);
}

/** A failed call that reached the model still costs money. Count it. */
function charge(session: Session, caught: unknown, file: string, rate: Rate): number {
  if (caught instanceof ModelApiError && caught.usage) {
    addUsage(session.usage, caught.usage);
    return session.budget.record(file, caught.usage, rate);
  }
  return 0;
}

function abortIfFatal(caught: unknown): void {
  if (caught instanceof ModelApiError && isFatalStatus(caught.status)) {
    throw new ReasoningAborted(`stopped before spending more: ${caught.message}`);
  }
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
