import { VULN_CLASSES, vulnClass } from '../model/classes.ts';
import type { FindingT, RunManifestT } from '../model/finding.ts';

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Pick the classes that matter most in this run: most criticals first, then
 * most findings, then the fixed demo order. The plain-language report and
 * the patch loop both work from this list.
 */
export function topClasses(findings: readonly FindingT[], limit = 5): string[] {
  const score = new Map<string, { critical: number; total: number }>();
  for (const f of findings) {
    const entry = score.get(f.vulnClass) ?? { critical: 0, total: 0 };
    entry.total += 1;
    if (f.severity === 'critical') entry.critical += 1;
    score.set(f.vulnClass, entry);
  }
  return [...score.entries()]
    .filter(([id]) => id !== 'accessibility' && id !== 'performance')
    .sort((a, b) => {
      if (b[1].critical !== a[1].critical) return b[1].critical - a[1].critical;
      if (b[1].total !== a[1].total) return b[1].total - a[1].total;
      return vulnClass(a[0] as never).demoRank - vulnClass(b[0] as never).demoRank;
    })
    .slice(0, limit)
    .map(([id]) => id);
}

export function renderSummary(manifest: RunManifestT, findings: readonly FindingT[]): string {
  const top = topClasses(findings);
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );
  const lines: string[] = [];
  lines.push('# Vibe Audit 2.0 run summary');
  lines.push('');
  lines.push(`Target: ${manifest.target.url ?? manifest.target.path}`);
  if (manifest.commit) lines.push(`Commit: ${manifest.commit}`);
  lines.push(`Run: ${manifest.runId} (${manifest.createdAt})`);
  lines.push(
    `Engine: ${manifest.engine.name} ${manifest.engine.version}, ${manifest.engine.rulesRun} of ${manifest.engine.rulesAvailable} rules run, ${manifest.filesScanned} files scanned`,
  );
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|---|---|');
  for (const sev of ['critical', 'warning', 'info']) {
    lines.push(`| ${sev} | ${manifest.counts.bySeverity[sev] ?? 0} |`);
  }
  lines.push('');
  lines.push('## Vulnerability classes');
  lines.push('');
  lines.push('| Class | Findings | Critical | In top 5 |');
  lines.push('|---|---|---|---|');
  for (const cls of VULN_CLASSES) {
    const inClass = findings.filter((f) => f.vulnClass === cls.id);
    if (inClass.length === 0) continue;
    const critical = inClass.filter((f) => f.severity === 'critical').length;
    lines.push(
      `| ${cls.name} | ${inClass.length} | ${critical} | ${top.includes(cls.id) ? 'yes' : ''} |`,
    );
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  lines.push('| Severity | Class | Location | Rule |');
  lines.push('|---|---|---|---|');
  for (const f of sorted.slice(0, 60)) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    lines.push(`| ${f.severity} | ${f.vulnClass} | ${escapeCell(where)} | ${f.ruleId} |`);
  }
  if (sorted.length > 60) lines.push(`| ... | | ${sorted.length - 60} more in findings.json | |`);
  lines.push('');
  lines.push(
    'Stages: ' +
      Object.entries(manifest.stages)
        .map(([k, v]) => `${k}=${v}`)
        .join(', '),
  );
  lines.push('');
  return lines.join('\n');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
