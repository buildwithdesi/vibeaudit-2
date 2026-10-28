import { classOf } from '../model/classes.ts';
import type { FindingT, V1OutputT } from '../model/finding.ts';
import { shortId } from '../util/hash.ts';
import { readContext, redactSecrets } from './context.ts';

export interface NormalizeOptions {
  /** Lines of code to keep on each side of the flagged line. */
  contextLines: number;
}

/**
 * Turn the engine's raw findings into 2.0 findings: a stable id, a
 * vulnerability class, masked code context, and empty slots for the
 * reasoning stages to fill.
 */
export async function normalizeFindings(
  raw: V1OutputT,
  repoDir: string,
  options: NormalizeOptions,
): Promise<FindingT[]> {
  const findings: FindingT[] = [];
  for (const f of raw.findings) {
    const line = typeof f.line === 'number' && f.line > 0 ? f.line : null;
    const evidence = f.evidence ? redactSecrets(f.evidence).text : null;
    const context = await readContext(repoDir, f.file, line, options.contextLines); // vibe-audit-ignore perf-no-await-parallel
    findings.push({
      id: shortId(`${f.ruleId}|${f.file}|${line ?? 0}|${evidence ?? f.message}`),
      ruleId: f.ruleId,
      ruleName: f.ruleName,
      severity: f.severity,
      vulnClass: classOf(f.ruleId, f.source ?? null),
      message: redactSecrets(f.message).text,
      file: f.file.replace(/\\/g, '/'),
      line,
      evidence,
      fix: redactSecrets(f.fix ?? '').text,
      cweId: f.cweId ?? null,
      cvssScore: f.cvssScore ?? null,
      owaspCategory: f.owaspCategory ?? null,
      source: f.source ?? null,
      context,
      triage: null,
      reasoning: null,
    });
  }
  return findings;
}

export function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
