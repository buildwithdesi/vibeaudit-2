import { z } from 'zod';
import { ExploitVerdict, TriageVerdict } from '../reason/schemas.ts';
import { VULN_CLASS_IDS } from './classes.ts';

/** Exactly what the v1 engine prints with `--format json`. Unknown keys are kept, never trusted. */
export const Severity = z.enum(['critical', 'warning', 'info']);
export type SeverityT = z.infer<typeof Severity>;

export const V1Finding = z.looseObject({
  ruleId: z.string(),
  ruleName: z.string(),
  severity: Severity,
  message: z.string(),
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  evidence: z.string().optional(),
  fix: z.string().optional(),
  cweId: z.string().optional(),
  cvssScore: z.number().optional(),
  owaspCategory: z.string().optional(),
  wcag: z.string().optional(),
  source: z.string().optional(),
  osvId: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  prompt: z.string().optional(),
});
export type V1FindingT = z.infer<typeof V1Finding>;

export const V1Summary = z.object({
  total: z.number().int(),
  critical: z.number().int(),
  warning: z.number().int(),
  info: z.number().int(),
  filesScanned: z.number().int(),
  rulesRun: z.number().int(),
  durationMs: z.number(),
});

export const V1Output = z.looseObject({
  summary: V1Summary,
  findings: z.array(V1Finding),
});
export type V1OutputT = z.infer<typeof V1Output>;

/** Lines around the flagged line. Secrets are masked before this is written anywhere. */
export const CodeContext = z.object({
  startLine: z.number().int(),
  endLine: z.number().int(),
  code: z.string(),
  redacted: z.boolean(),
});
export type CodeContextT = z.infer<typeof CodeContext>;

export const VulnClassIdSchema = z.enum(VULN_CLASS_IDS);

/** The 2.0 finding. Everything later stages add is nullable and starts as null. */
export const Finding = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  severity: Severity,
  vulnClass: VulnClassIdSchema,
  message: z.string(),
  file: z.string(),
  line: z.number().int().nullable(),
  evidence: z.string().nullable(),
  fix: z.string(),
  cweId: z.string().nullable(),
  cvssScore: z.number().nullable(),
  owaspCategory: z.string().nullable(),
  source: z.string().nullable(),
  context: CodeContext.nullable(),
  triage: TriageVerdict.nullable(),
  reasoning: ExploitVerdict.nullable(),
});
export type FindingT = z.infer<typeof Finding>;

export const StageStatus = z.enum(['done', 'skipped', 'pending', 'failed']);

export const RunManifest = z.object({
  runId: z.string(),
  createdAt: z.string(),
  tool: z.object({ name: z.string(), version: z.string() }),
  target: z.object({
    kind: z.enum(['github', 'local']),
    label: z.string(),
    url: z.string().nullable(),
    ref: z.string().nullable(),
    path: z.string(),
  }),
  commit: z.string().nullable(),
  engine: z.object({
    name: z.string(),
    version: z.string(),
    rulesAvailable: z.number().int(),
    rulesRun: z.number().int(),
    sca: z.boolean(),
    trustTargetConfig: z.boolean(),
  }),
  filesScanned: z.number().int(),
  durationMs: z.object({ clone: z.number(), engine: z.number(), total: z.number() }),
  counts: z.object({
    total: z.number().int(),
    bySeverity: z.record(z.string(), z.number().int()),
    byClass: z.record(z.string(), z.number().int()),
  }),
  stages: z.object({
    intake: StageStatus,
    engine: StageStatus,
    normalize: StageStatus,
    triage: StageStatus,
    reasoning: StageStatus,
    report: StageStatus,
    patch: StageStatus,
  }),
});
export type RunManifestT = z.infer<typeof RunManifest>;
