import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { vulnClass } from '../model/classes.ts';
import { Finding, type FindingT, RunManifest, type RunManifestT } from '../model/finding.ts';
import { PatchRecord, type PatchRecordT } from '../patch/loop.ts';
import { ReasoningRecord, type ReasoningRecordT } from '../reason/orchestrate.ts';
import { writeJson, writeText } from '../util/fs.ts';
import { topClasses } from './summary.ts';

/**
 * The proof-of-risk report: one section per vulnerability class, written for
 * a founder who has never read a CVE. Each section says what could happen,
 * shows the two lines of code that make it true, and names the smallest fix.
 * Where the reasoning stage ran, its verdicts lead. Where it did not, the
 * deterministic result stands and the report says so.
 */
const VERDICT_WORDS: Record<string, string> = {
  confirmed: 'Confirmed. The full path is visible in the code.',
  likely: 'Likely. One step is unverified, and nothing guards the path.',
  unlikely: 'Unlikely. A guard probably covers this path.',
  'not-exploitable': 'Not exploitable. The code closes the path.',
  'needs-runtime-check': 'Undecided. A runtime setting decides this one.',
};

const POSITION_WORDS: Record<string, string> = {
  'anonymous-internet': 'anyone on the internet, no account needed',
  'authenticated-user': 'any signed-in user',
  'insider-or-admin': 'someone who already has admin or staff access',
  'local-only': 'someone with access to the server itself',
  none: 'no one, based on what the code shows',
};

export async function renderProofOfRisk(runDir: string): Promise<string> {
  const manifest = RunManifest.parse(
    JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')),
  );
  const findings = z
    .array(Finding)
    .parse(JSON.parse(await readFile(join(runDir, 'findings.json'), 'utf8')));
  let reasoning: ReasoningRecordT | null = null;
  try {
    reasoning = ReasoningRecord.parse(
      JSON.parse(await readFile(join(runDir, 'reasoning.json'), 'utf8')),
    );
  } catch {
    reasoning = null;
  }
  let patch: PatchRecordT | null = null;
  try {
    patch = PatchRecord.parse(JSON.parse(await readFile(join(runDir, 'patch.json'), 'utf8')));
  } catch {
    patch = null;
  }
  const text = render(manifest, findings, reasoning, patch);
  await writeText(join(runDir, 'report.md'), text);
  await writeJson(join(runDir, 'manifest.json'), {
    ...manifest,
    stages: { ...manifest.stages, report: 'done' },
  });
  return text;
}

export function render(
  manifest: RunManifestT,
  findings: readonly FindingT[],
  reasoning: ReasoningRecordT | null,
  patch: PatchRecordT | null = null,
): string {
  const classes = reasoning?.classes ?? topClasses(findings);
  const reasoned = findings.filter((f) => f.reasoning);
  const confirmed = reasoned.filter(
    (f) => f.reasoning?.exploitability === 'confirmed' || f.reasoning?.exploitability === 'likely',
  );
  const lines: string[] = [];

  lines.push(`# Proof of risk: ${manifest.target.label}`);
  lines.push('');
  lines.push(
    `Scanned ${manifest.target.url ?? manifest.target.path}${manifest.commit ? ` at commit ${manifest.commit.slice(0, 10)}` : ''} on ${manifest.createdAt.slice(0, 10)}.`,
  );
  lines.push('');
  lines.push('## The short version');
  lines.push('');
  if (reasoning && !reasoning.dryRun && reasoned.length > 0) {
    lines.push(
      `The scanner flagged ${findings.length} places. A reasoning model looked closely at ${reasoned.length} of them in the ${classes.length} classes that matter most. ${confirmed.length} ${confirmed.length === 1 ? 'is' : 'are'} confirmed or likely exploitable. Each one below comes with the lines of code that prove it and the smallest fix.`,
    );
  } else {
    lines.push(
      `The scanner flagged ${findings.length} places across ${Object.keys(manifest.counts.byClass).length} classes. The ${classes.length} classes below matter most. The reasoning stage has not run on this scan yet, so each item shows what the rule found and the standard fix. Run the reasoning stage to get exploitability verdicts with proof.`,
    );
  }
  lines.push('');
  lines.push('| Class | Findings | Confirmed or likely | What it means |');
  lines.push('|---|---|---|---|');
  for (const id of classes) {
    const cls = vulnClass(id as never);
    const inClass = findings.filter((f) => f.vulnClass === id);
    const hot = inClass.filter(
      (f) =>
        f.reasoning?.exploitability === 'confirmed' || f.reasoning?.exploitability === 'likely',
    ).length;
    lines.push(
      `| ${cls.name} | ${inClass.length} | ${reasoned.length ? hot : 'not judged'} | ${cls.plain} |`,
    );
  }
  lines.push('');

  for (const id of classes) {
    const cls = vulnClass(id as never);
    const inClass = findings.filter((f) => f.vulnClass === id).sort((a, b) => rank(a) - rank(b));
    if (inClass.length === 0) continue;
    lines.push(`## ${cls.name}`);
    lines.push('');
    lines.push(cls.plain);
    lines.push('');
    const shown = inClass.slice(0, 5);
    for (const f of shown) {
      lines.push(`### ${f.file}${f.line ? `, line ${f.line}` : ''}`);
      lines.push('');
      const r = f.reasoning;
      if (r) {
        lines.push(
          `**Verdict:** ${VERDICT_WORDS[r.exploitability] ?? r.exploitability} Confidence ${Math.round(r.confidence * 100)}%.`,
        );
        lines.push('');
        lines.push(
          `**Who can do this:** ${POSITION_WORDS[r.attackerPosition] ?? r.attackerPosition}.`,
        );
        lines.push('');
        lines.push(`**What could happen:** ${r.plainLanguage}`);
        lines.push('');
        if (r.attackPath.length) {
          lines.push('**How it happens:**');
          lines.push('');
          for (const [i, step] of r.attackPath.entries()) lines.push(`${i + 1}. ${step}`);
          lines.push('');
        }
        if (r.preconditions.length) {
          lines.push(`**Only if:** ${r.preconditions.join('; ')}`);
          lines.push('');
        }
        if (r.evidence.length) {
          lines.push('**The proof, in the code:**');
          lines.push('');
          for (const e of r.evidence.slice(0, 4)) {
            lines.push(`- \`${e.file}${e.line ? `:${e.line}` : ''}\``);
            lines.push('');
            lines.push('  ```');
            for (const l of e.quote.split('\n').slice(0, 2)) lines.push(`  ${l}`);
            lines.push('  ```');
          }
          lines.push('');
        }
        lines.push(`**Blast radius:** ${r.blastRadius.replace(/-/g, ' ')}.`);
        lines.push('');
        lines.push(`**Smallest fix:** ${r.fixSummary}`);
        lines.push('');
      } else {
        lines.push(`**What the rule found:** ${f.message}`);
        lines.push('');
        if (f.evidence) {
          lines.push('```');
          lines.push(f.evidence.split('\n')[0] ?? '');
          lines.push('```');
          lines.push('');
        }
        if (f.triage && !f.triage.keep) {
          lines.push(`**Triage:** set aside as ${f.triage.category}. ${f.triage.reason}`);
          lines.push('');
        } else {
          lines.push(`**Standard fix:** ${f.fix || 'See the rule documentation.'}`);
          lines.push('');
          lines.push('_Not judged by the reasoning stage on this scan._');
          lines.push('');
        }
      }
    }
    if (inClass.length > shown.length) {
      lines.push(
        `${inClass.length - shown.length} more in this class are listed in findings.json.`,
      );
      lines.push('');
    }
  }

  if (patch?.patchCommit) {
    lines.push('## After the patch');
    lines.push('');
    const who = patch.backend === 'muse-code' ? 'Muse Code' : 'Muse Spark';
    const testsWord = patch.tests.ran ? (patch.tests.passed ? 'passed' : 'failed') : 'not run';
    lines.push(
      `${who} patched ${patch.selected.length} findings on branch \`${patch.branch}\`. The scan ran again on the patched code: ${patch.rescan.resolved.length} resolved, ${patch.rescan.remaining.length} still reported, ${patch.rescan.introduced} new. Project tests: ${testsWord}${patch.tests.ran ? ` (${patch.tests.runner})` : ''}. Result: ${patch.green ? 'green' : 'not green'}.`,
    );
    lines.push('');
    lines.push('| Class | Before | After |');
    lines.push('|---|---|---|');
    for (const [cls, before] of Object.entries(patch.rescan.before.byClass)) {
      lines.push(
        `| ${vulnClass(cls as never).name} | ${before} | ${patch.rescan.after.byClass[cls] ?? 0} |`,
      );
    }
    lines.push('');
    lines.push('The full diff is in `patch.diff` next to this report.');
    lines.push('');
  }

  lines.push('## How this report was made');
  lines.push('');
  lines.push(
    `- Deterministic scan: ${manifest.engine.name} ${manifest.engine.version}, ${manifest.engine.rulesRun} rules, ${manifest.filesScanned} files.`,
  );
  if (reasoning && !reasoning.dryRun) {
    lines.push(
      `- Reasoning: ${reasoning.models.reason ?? 'none'} judged ${reasoned.length} findings${reasoning.models.triage ? ` after ${reasoning.models.triage} triage` : ''}. ${reasoning.calls} model calls, $${reasoning.usd.toFixed(2)}.`,
    );
    const capped = reasoning.decisions.filter((d) => d.outcome === 'budget-exhausted').length;
    if (capped)
      lines.push(
        `- ${capped} findings hit the reasoning budget and keep their deterministic result.`,
      );
  }
  lines.push(
    '- Secrets in the scanned code were masked before any of it was read by a model or written here.',
  );
  lines.push('');
  return lines.join('\n');
}

function rank(f: FindingT): number {
  const order: Record<string, number> = {
    confirmed: 0,
    likely: 1,
    'needs-runtime-check': 2,
    unlikely: 3,
    'not-exploitable': 4,
  };
  const verdict = f.reasoning ? (order[f.reasoning.exploitability] ?? 5) : 6;
  const severity = f.severity === 'critical' ? 0 : f.severity === 'warning' ? 1 : 2;
  return verdict * 10 + severity;
}
