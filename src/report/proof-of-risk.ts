import { lstat, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { VULN_CLASS_IDS, vulnClass } from '../model/classes.ts';
import { Finding, type FindingT, RunManifest, type RunManifestT } from '../model/finding.ts';
import { isSecretFile, safeResolve } from '../normalize/context.ts';
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

/** The founder-facing name for each class, said before the technical one. */
const PLAIN_LABELS: Record<string, string> = {
  secrets: 'Passwords and keys sitting in the code',
  'sql-injection': 'Someone can rewrite your database commands',
  'command-injection': 'Someone can run commands on your server',
  'missing-auth': 'Anyone can reach things that should need a login',
  'path-traversal': 'Someone can read files they should not see',
  ssrf: 'Your server can be made to call other systems',
  xss: 'Someone can run their own script in your users’ browsers',
  'input-handling': 'Visitor input is trusted when it should not be',
  'auth-sessions-crypto': 'Logins and sessions are easier to break than they should be',
  'webhooks-payments': 'Payment and webhook messages are trusted without proof',
  'data-exposure': 'Private data leaks through logs, errors or responses',
  'hardening-config': 'Protective settings are missing',
  'supply-chain': 'A dependency is risky',
  'ai-safety': 'The AI feature can be hijacked or run up a bill',
};

const POSITION_WORDS: Record<string, string> = {
  'anonymous-internet': 'anyone on the internet, no account needed',
  'authenticated-user': 'any signed-in user',
  'insider-or-admin': 'someone who already has admin or staff access',
  'local-only': 'someone with access to the server itself',
  none: 'no one, based on what the code shows',
};

/** True when the quote is in the file, false when it is not, null when the file was not checked. */
export type QuoteChecker = (file: string, quote: string) => boolean | null;

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
  const quoted = findings.flatMap((f) => f.reasoning?.evidence.map((e) => e.file) ?? []);
  const checker = await quoteChecker(manifest.target.path, quoted);
  const text = render(manifest, findings, reasoning, patch, checker);
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
  quoteFound: QuoteChecker | null = null,
): string {
  // A typo in --classes is recorded as asked. Unknown ids are dropped so the run still renders.
  const known: readonly string[] = VULN_CLASS_IDS;
  const asked = (reasoning?.classes ?? []).filter((id) => known.includes(id));
  const classes = asked.length ? asked : topClasses(findings);
  const reasoned = findings.filter((f) => f.reasoning);
  const confirmed = reasoned.filter(isHot);
  const lines: string[] = [];

  lines.push(`# Proof of risk: ${manifest.target.label}`);
  lines.push('');
  lines.push(
    `Scanned ${manifest.target.url ?? manifest.target.path} on ${manifest.createdAt.slice(0, 10)}${manifest.commit ? ` (version ${manifest.commit.slice(0, 7)})` : ''}.`,
  );
  lines.push('');
  lines.push('## The short version');
  lines.push('');
  if (reasoning && !reasoning.dryRun && reasoned.length > 0) {
    lines.push(
      `The scanner flagged ${findings.length} places. A reasoning model looked closely at ${reasoned.length} of them in the ${classes.length} kinds of problem that matter most. ${confirmed.length} ${confirmed.length === 1 ? 'is' : 'are'} confirmed or likely exploitable. Each one below comes with the lines of code that prove it and the smallest fix.`,
    );
  } else {
    lines.push(
      `This is a first pass. The scanner flagged ${findings.length} places across ${Object.keys(manifest.counts.byClass).length} kinds of problem. The ${classes.length} kinds below matter most. Nothing here has been checked yet for whether an attacker can really use it. To get a risk rating and proof for each item, run: \`node src/cli.ts reason runs/${manifest.runId}\`.`,
    );
  }
  lines.push('');
  fixFirst(lines, classes, findings);
  lines.push('| Problem | Places | How sure we are | What it means |');
  lines.push('|---|---|---|---|');
  for (const id of classes) {
    const cls = vulnClass(id as never);
    const inClass = findings.filter((f) => f.vulnClass === id);
    lines.push(
      `| ${PLAIN_LABELS[id] ?? cls.name} | ${inClass.length} | ${howSure(inClass)} | ${cls.plain} |`,
    );
  }
  lines.push('');

  for (const id of classes) {
    const cls = vulnClass(id as never);
    const inClass = findings.filter((f) => f.vulnClass === id).sort((a, b) => rank(a) - rank(b));
    if (inClass.length === 0) continue;
    lines.push(`## ${PLAIN_LABELS[id] ?? cls.name}`);
    lines.push('');
    lines.push(`${cls.plain} (${cls.name})`);
    lines.push('');
    const unique = dedupeLocations(inClass);
    const shown = unique.slice(0, 5);
    for (const f of shown) renderFinding(lines, f, quoteFound);
    if (unique.length > shown.length) {
      lines.push(`${unique.length - shown.length} more of this kind are listed in findings.json.`);
      lines.push('');
    }
  }

  if (patch?.patchCommit) {
    lines.push('## After the patch');
    lines.push('');
    const who = patch.backend === 'muse-code' ? 'Muse Code' : 'Muse Spark';
    const testsWord = patch.tests.ran ? (patch.tests.passed ? 'passed' : 'failed') : 'not run';
    const closedOnReview = patch.verification.filter(
      (v) => v.exploitability === 'not-exploitable' || v.exploitability === 'unlikely',
    ).length;
    const result = patch.green
      ? 'green'
      : patch.rescanClean || patch.verifiedClean
        ? 'closed, but not green because the tests did not run or did not pass'
        : 'not green';
    lines.push(
      `${who} patched ${patch.selected.length} findings on branch \`${patch.branch}\`. The scan ran again on the patched code: ${patch.rescan.resolved.length} fixed, ${patch.rescan.remaining.length} still flagged by a rule, ${patch.rescan.introduced} new. Project tests: ${testsWord}${patch.tests.ran ? ` (${patch.tests.runner})` : ''}. Result: ${result}.`,
    );
    lines.push('');
    if (patch.verification.length) {
      lines.push(
        `The rules are pattern checks, so a fix they do not recognize keeps a flag. A reasoning model reviewed each still-flagged spot on the patched code: ${closedOnReview} of ${patch.verification.length} judged closed.`,
      );
      lines.push('');
      for (const v of patch.verification) {
        lines.push(`- ${VERDICT_WORDS[v.exploitability] ?? v.exploitability} ${v.plainLanguage}`);
      }
      lines.push('');
    }
    lines.push('| Problem | Patched | Still reported |');
    lines.push('|---|---|---|');
    for (const [cls, before] of Object.entries(patch.rescan.before.byClass)) {
      lines.push(
        `| ${PLAIN_LABELS[cls] ?? vulnClass(cls as never).name} | ${before} | ${patch.rescan.after.byClass[cls] ?? 0} |`,
      );
    }
    lines.push('');
    lines.push('The full diff is in `patch.diff` next to this report.');
    lines.push('');
  }

  lines.push('## How this report was made');
  lines.push('');
  lines.push(
    `- An automated scan with ${manifest.engine.rulesRun} checks over ${manifest.filesScanned} files (${manifest.engine.name} ${manifest.engine.version}).`,
  );
  if (reasoning && !reasoning.dryRun) {
    lines.push(
      `- Reasoning: ${reasoning.models.reason ?? 'none'} judged ${reasoned.length} findings${reasoning.models.triage ? ` after ${reasoning.models.triage} triage` : ''}. ${reasoning.calls} model calls, $${reasoning.usd.toFixed(2)}.`,
    );
    const capped = reasoning.decisions.filter((d) => d.outcome === 'budget-exhausted').length;
    if (capped) {
      lines.push(`- ${capped} findings hit the reasoning budget and keep their first-pass result.`);
    }
  }
  lines.push(
    '- Secrets in the scanned code were masked before any of it was read by a model or written here.',
  );
  lines.push('');
  return lines.join('\n');
}

function renderFinding(lines: string[], f: FindingT, quoteFound: QuoteChecker | null): void {
  lines.push(`### ${f.file}${f.line ? `, line ${f.line}` : ''}`);
  lines.push('');
  const r = f.reasoning;
  if (!r) {
    lines.push(`**What the rule found:** ${f.message}`);
    lines.push('');
    if (f.vulnClass === 'secrets') {
      lines.push('(The secret itself is hidden in this report for safety.)');
      lines.push('');
    } else if (f.evidence) {
      lines.push('```');
      lines.push(f.evidence.split('\n')[0] ?? '');
      lines.push('```');
      lines.push('');
    }
    if (f.triage && !f.triage.keep) {
      lines.push(`**Set aside:** ${f.triage.category}. ${f.triage.reason}`);
    } else {
      lines.push(`**Standard fix:** ${f.fix || 'See the rule documentation.'}`);
      lines.push('');
      lines.push('_Not checked for exploitability on this scan._');
    }
    lines.push('');
    return;
  }
  lines.push(
    `**Verdict:** ${VERDICT_WORDS[r.exploitability] ?? r.exploitability} Confidence ${Math.round(r.confidence * 100)}%.`,
  );
  lines.push('');
  lines.push(`**Who can do this:** ${POSITION_WORDS[r.attackerPosition] ?? r.attackerPosition}.`);
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
      const verified = quoteFound ? quoteFound(e.file, e.quote) : null;
      const flag =
        verified === false
          ? ' (this quote was not found in the file; treat it as a paraphrase)'
          : '';
      lines.push(`- \`${e.file}${e.line ? `:${e.line}` : ''}\`${flag}`);
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
}

function isHot(f: FindingT): boolean {
  return f.reasoning?.exploitability === 'confirmed' || f.reasoning?.exploitability === 'likely';
}

/** Counts only this class's own verdicts, so a class nobody judged never reads as "0 confirmed". */
function howSure(inClass: readonly FindingT[]): string {
  const judged = inClass.filter((f) => f.reasoning).length;
  if (judged === 0) return 'not checked yet';
  const hot = inClass.filter(isHot).length;
  const left = inClass.length - judged;
  return `${hot} of ${judged} checked ${judged === 1 ? 'is' : 'are'} confirmed or likely${left ? `; ${left} not checked yet` : ''}`;
}

/**
 * The two kinds to fix first: most confirmed or likely, then most criticals,
 * then most findings. A kind whose every finding was judged closed is left out.
 */
function fixFirst(
  lines: string[],
  classes: readonly string[],
  findings: readonly FindingT[],
): void {
  const ranked = classes
    .map((id) => {
      const inClass = findings.filter((f) => f.vulnClass === id);
      return {
        id,
        hot: inClass.filter(isHot).length,
        critical: inClass.filter((f) => f.severity === 'critical').length,
        total: inClass.length,
        cleared: inClass.every(
          (f) =>
            f.reasoning?.exploitability === 'not-exploitable' ||
            f.reasoning?.exploitability === 'unlikely',
        ),
      };
    })
    .filter((c) => c.total > 0 && !c.cleared)
    .sort((a, b) => b.hot - a.hot || b.critical - a.critical || b.total - a.total)
    .slice(0, 2);
  // Two separate sentences: the labels are consequences, so "X, then Y" read as cause and effect.
  const [first, next] = ranked.map((c) => PLAIN_LABELS[c.id] ?? vulnClass(c.id as never).name);
  if (!first) return;
  lines.push(`**Fix first:** ${first}.${next ? ` **Next:** ${next}.` : ''}`);
  lines.push('');
}

/** Several rules often flag one line. Show the location once, led by the finding with a verdict. */
function dedupeLocations(findings: readonly FindingT[]): FindingT[] {
  const seen = new Map<string, FindingT>();
  for (const f of findings) {
    const key = `${f.file}:${f.line ?? 0}`;
    const existing = seen.get(key);
    if (!existing || (!existing.reasoning && f.reasoning)) seen.set(key, f);
  }
  return [...seen.values()];
}

/**
 * Checks a quoted line against the real file, whitespace-insensitive, so a
 * made-up quote is flagged. The paths come from the model, so files are read
 * through the same guard as the code context: a path outside the repo cannot
 * hold the quote, and a symlink, an oversized file or a secret-bearing file is
 * never read, so its quotes are not checked.
 */
export async function quoteChecker(
  repoDir: string,
  files: Iterable<string>,
): Promise<QuoteChecker> {
  const root = resolve(repoDir);
  const keys = [...new Set([...files].map((f) => f.replace(/\\/g, '/')))];
  const texts = await Promise.all(keys.map((key) => readForQuotes(root, key)));
  const cache = new Map(keys.map((key, i) => [key, texts[i] ?? null]));
  return (file, quote) => {
    const content = cache.get(file.replace(/\\/g, '/'));
    if (content === null || content === undefined) return null;
    const needle = quote.replace(/\s+/g, '');
    return needle.length > 0 && content.includes(needle);
  };
}

/** The file with whitespace removed; '' when it cannot hold the quote; null when it is not checked. */
async function readForQuotes(root: string, key: string): Promise<string | null> {
  const lexical = resolve(root, key);
  if (lexical !== root && !lexical.startsWith(root + sep)) return '';
  if (isSecretFile(key)) return null;
  const abs = await safeResolve(root, key);
  if (abs) {
    return readFile(abs, 'utf8').then(
      (text) => text.replace(/\s+/g, ''),
      () => null,
    );
  }
  // Missing: the quote cannot be there. Present but refused: not checked.
  return lstat(lexical).then(
    () => null,
    () => '',
  );
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
