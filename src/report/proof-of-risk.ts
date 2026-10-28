import { existsSync } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { VULN_CLASS_IDS, VULN_CLASSES, vulnClass } from '../model/classes.ts';
import { Finding, type FindingT, RunManifest, type RunManifestT } from '../model/finding.ts';
import { isSecretFile, redactSecrets, safeResolve } from '../normalize/context.ts';
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
  'not-exploitable': 'Not exploitable as the code stands.',
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

/** How far an attack reaches, said instead of "blast radius". */
const REACH_WORDS: Record<string, string> = {
  'single-user': 'one user',
  'many-users': 'many users',
  'whole-system': 'the whole app and everyone who uses it',
  infrastructure: 'the servers and systems the app runs on',
};

const RUNNER_WORDS: Record<string, string> = {
  local: 'run on this computer, not in a sealed container',
  docker: 'run in a sealed container',
};

/** Shown per kind of problem; the rest are counted and left to findings.json. */
const MAX_SHOWN = 5;

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
  // A GitHub run keeps its clone in repo/. If the run folder moved since, look there.
  const repoDir =
    manifest.target.kind === 'github' && !existsSync(manifest.target.path)
      ? join(runDir, 'repo')
      : manifest.target.path;
  const checker = await quoteChecker(repoDir, quoted);
  const text = render(manifest, findings, reasoning, patch, checker, runDir);
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
  runDir: string | null = null,
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
    `Scanned ${manifest.target.url ?? manifest.target.path} on ${manifest.createdAt.slice(0, 10)}${manifest.commit ? ` (commit ${manifest.commit.slice(0, 7)})` : ''}.`,
  );
  lines.push('');
  lines.push('## The short version');
  lines.push('');
  if (findings.length === 0) {
    lines.push(
      manifest.filesScanned === 0
        ? 'The scanner found no files to check here.'
        : `The scanner checked ${plural(manifest.filesScanned, 'file')} and found nothing to report. It only knows the patterns it checks for, so this is good news, not a guarantee.`,
    );
    lines.push('');
  } else {
    // Several rules often flag one line, so flags and lines are counted apart.
    const flagged = `The scanner raised ${plural(findings.length, 'flag')} on ${plural(spots(findings), 'line')}`;
    if (reasoning && !reasoning.dryRun && reasoned.length > 0) {
      const kinds =
        classes.length === 1
          ? 'the kind of problem that matters most'
          : `the ${classes.length} kinds of problem that matter most`;
      const where = confirmed.length
        ? `, on ${plural(spots(confirmed), 'line')} in ${plural(new Set(confirmed.map((f) => f.file)).size, 'file')}`
        : '';
      lines.push(
        `${flagged}. A reasoning model looked closely at ${reasoned.length} of them, in ${kinds}. ${confirmed.length} ${confirmed.length === 1 ? 'is' : 'are'} confirmed or likely exploitable${where}. Each one below comes with the lines of code that prove it and the smallest fix.`,
      );
    } else {
      lines.push(
        `This is a first pass. ${flagged}, across ${plural(Object.keys(manifest.counts.byClass).length, 'kind')} of problem. ${classes.length === 1 ? 'The kind below matters most.' : `The ${classes.length} kinds below matter most.`} Nothing here has been checked yet for whether an attacker can really use it. To get a risk rating and proof for each item, run: \`node src/cli.ts reason ${runDir ? runPath(runDir) : `runs/${manifest.runId}`}\`.`,
      );
    }
    lines.push('');
    fixFirst(lines, classes, findings);
    lines.push('| Problem | Flags | How sure we are | What it means |');
    lines.push('|---|---|---|---|');
    for (const id of classes) {
      const cls = vulnClass(id as never);
      const inClass = findings.filter((f) => f.vulnClass === id);
      lines.push(
        `| ${PLAIN_LABELS[id] ?? cls.name} | ${inClass.length} | ${howSure(inClass)} | ${cls.plain} |`,
      );
    }
    lines.push('');
    notCovered(lines, classes, findings);
  }

  for (const id of classes) {
    const cls = vulnClass(id as never);
    const unique = locationsOf(findings, id);
    if (unique.length === 0) continue;
    lines.push(`## ${PLAIN_LABELS[id] ?? cls.name}`);
    lines.push('');
    lines.push(`${cls.plain} (${cls.name})`);
    lines.push('');
    const shown = unique.slice(0, MAX_SHOWN);
    for (const f of shown) renderFinding(lines, f, quoteFound);
    if (unique.length > shown.length) {
      lines.push(`${unique.length - shown.length} more of this kind are listed in findings.json.`);
      lines.push('');
    }
  }

  if (patch?.patchCommit) afterPatch(lines, patch, findings, classes);

  lines.push('## How this report was made');
  lines.push('');
  lines.push(
    `- An automated scan with ${manifest.engine.rulesRun} checks over ${plural(manifest.filesScanned, 'file')} (${manifest.engine.name} ${manifest.engine.version}).`,
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

/**
 * The patch section. Counts come from finding ids: a patch fixes the lead
 * finding and any other finding on the same line, so "patched" means both,
 * and every patched finding is either fixed or still flagged.
 */
function afterPatch(
  lines: string[],
  patch: PatchRecordT,
  findings: readonly FindingT[],
  classes: readonly string[],
): void {
  lines.push('## After the patch');
  lines.push('');
  const who = patch.backend === 'muse-code' ? 'Muse Code' : 'Muse Spark';
  const testsWord = patch.tests.ran ? (patch.tests.passed ? 'passed' : 'failed') : 'not run';
  const closed = new Set(
    patch.verification
      .filter((v) => v.exploitability === 'not-exploitable' || v.exploitability === 'unlikely')
      .map((v) => v.findingId),
  );
  const fixed = new Set(patch.rescan.resolved);
  const patched = [...new Set([...patch.rescan.resolved, ...patch.rescan.remaining])];
  const places = patch.selected.length;
  // Closed as the loop counts it: a new flag reopens the work even when the old ones were judged closed.
  const closedUp = patch.rescanClean || (patch.verifiedClean && patch.rescan.introduced === 0);
  const blockers = [
    ...(patch.tests.ran && patch.tests.passed ? [] : ['the tests did not run or did not pass']),
    ...(patch.error ? ['the patch loop stopped early (see below)'] : []),
  ];
  const result = patch.green
    ? "green, meaning every patched problem is gone or was judged closed, and the app's own tests pass"
    : closedUp && blockers.length
      ? `closed, but not green because ${blockers.join(' and ')}`
      : 'not green';
  const rescan = patch.rescan.ran
    ? `The scan ran again on the patched code: ${fixed.size} fixed, ${patch.rescan.remaining.length} still flagged by a rule, ${patch.rescan.introduced} new.`
    : 'The scan could not run again on the patched code, so none of these fixes is confirmed yet.';
  lines.push(
    `${who} patched ${plural(patched.length, 'finding')}${places !== patched.length ? ` in ${plural(places, 'place')}` : ''} on branch \`${patch.branch}\`. ${rescan} The app's own tests: ${testsWord}${patch.tests.ran ? ` (${RUNNER_WORDS[patch.tests.runner] ?? patch.tests.runner})` : ''}. Result: ${result}.`,
  );
  lines.push('');
  if (patch.error) {
    // The message can quote engine output, so it is masked like everything else here.
    const why = redactSecrets(patch.error).text.replace(/\s+/g, ' ').trim();
    lines.push(`**The patch loop stopped early:** ${why}`);
    lines.push('');
  }
  if (patch.verification.length) {
    lines.push(
      `The rules are pattern checks, so a fix they do not recognize keeps a flag. A reasoning model reviewed each still-flagged spot on the patched code: ${closed.size} of ${patch.verification.length} judged closed.`,
    );
    lines.push('');
    for (const v of patch.verification) {
      lines.push(`- ${VERDICT_WORDS[v.exploitability] ?? v.exploitability} ${v.plainLanguage}`);
    }
    lines.push('');
  }
  if (!patch.rescan.ran) {
    lines.push('The full diff is in `patch.diff` next to this report.');
    lines.push('');
    return;
  }
  const classOf = new Map<string, string>([
    ...patch.selected.map((s) => [s.id, s.vulnClass] as const),
    ...findings.map((f) => [f.id, f.vulnClass] as const),
  ]);
  const rows = new Map<
    string,
    { patched: number; fixed: number; flagged: number; closed: number }
  >();
  for (const id of patched) {
    const cls = classOf.get(id) ?? 'other';
    const row = rows.get(cls) ?? { patched: 0, fixed: 0, flagged: 0, closed: 0 };
    row.patched += 1;
    if (fixed.has(id)) row.fixed += 1;
    else row.flagged += 1;
    if (!fixed.has(id) && closed.has(id)) row.closed += 1;
    rows.set(cls, row);
  }
  const order = (cls: string) => (classes.includes(cls) ? classes.indexOf(cls) : classes.length);
  const reviewed = patch.verification.length > 0;
  lines.push(
    `| Problem | Patched | Fixed | Still flagged |${reviewed ? ' Judged closed on review |' : ''}`,
  );
  lines.push(`|---|---|---|---|${reviewed ? '---|' : ''}`);
  for (const [cls, row] of [...rows].sort((a, b) => order(a[0]) - order(b[0]))) {
    lines.push(
      `| ${label(cls)} | ${row.patched} | ${row.fixed} | ${row.flagged} |${reviewed ? ` ${row.closed} |` : ''}`,
    );
  }
  lines.push('');
  lines.push('The full diff is in `patch.diff` next to this report.');
  lines.push('');
}

/** The plain label, for any id a record may hold, including one this version does not know. */
function label(id: string): string {
  return PLAIN_LABELS[id] ?? VULN_CLASSES.find((c) => c.id === id)?.name ?? id;
}

/** The run folder as the user would type it: relative when it sits under the current folder. */
function runPath(runDir: string): string {
  const rel = relative(process.cwd(), runDir);
  const path = rel === '' ? '.' : rel.startsWith('..') || isAbsolute(rel) ? runDir : rel;
  return /\s/.test(path) ? `"${path}"` : path;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
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
  // A path the model judged closed keeps its proof and fix, not the steps of an attack that fails.
  const closed = r.exploitability === 'not-exploitable' || r.exploitability === 'unlikely';
  lines.push(
    `**Verdict:** ${VERDICT_WORDS[r.exploitability] ?? r.exploitability} Confidence: ${confidenceWord(r.confidence)}.`,
  );
  lines.push('');
  lines.push(`**Who can do this:** ${POSITION_WORDS[r.attackerPosition] ?? r.attackerPosition}.`);
  lines.push('');
  lines.push(`**What could happen:** ${r.plainLanguage}`);
  lines.push('');
  if (r.attackPath.length && !closed) {
    lines.push('**How it happens (for your developer):**');
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
  if (!closed) {
    lines.push(
      `**How far it reaches:** ${REACH_WORDS[r.blastRadius] ?? r.blastRadius.replace(/-/g, ' ')}.`,
    );
    lines.push('');
  }
  lines.push(`**Smallest fix (for your developer):** ${r.fixSummary}`);
  lines.push('');
}

/** A model's confidence in words: a percentage reads as a promise, and 100% overclaims. */
function confidenceWord(confidence: number): string {
  return confidence >= 0.85 ? 'high' : confidence >= 0.6 ? 'medium' : 'low';
}

/**
 * Criticals the sections below never show: in a kind outside the top few,
 * and on a line no shown finding covers. Named so a short report does not
 * read as the whole story.
 */
function notCovered(
  lines: string[],
  classes: readonly string[],
  findings: readonly FindingT[],
): void {
  const shown = new Set(
    classes.flatMap((id) => locationsOf(findings, id).slice(0, MAX_SHOWN).map(locationKey)),
  );
  const missed = dedupeLocations(
    findings.filter(
      (f) =>
        f.severity === 'critical' && !classes.includes(f.vulnClass) && !shown.has(locationKey(f)),
    ),
  );
  if (missed.length === 0) return;
  const named = missed
    .slice(0, MAX_SHOWN)
    .map((f) => `${label(f.vulnClass)} (${f.file}${f.line ? `, line ${f.line}` : ''})`);
  const more = missed.length - named.length;
  lines.push(
    `**Also serious, not covered below:** ${named.join('; ')}${more ? `; and ${more} more` : ''}. Details are in findings.json.`,
  );
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
  const [first, next] = ranked.map((c) => label(c.id));
  if (!first) return;
  lines.push(`**Fix first:** ${first}.${next ? ` **Next:** ${next}.` : ''}`);
  lines.push('');
}

/** A class's locations in report order: verdicts first, each line once. */
function locationsOf(findings: readonly FindingT[], id: string): FindingT[] {
  return dedupeLocations(
    findings.filter((f) => f.vulnClass === id).sort((a, b) => rank(a) - rank(b)),
  );
}

function locationKey(f: FindingT): string {
  return `${f.file}:${f.line ?? 0}`;
}

/** Distinct lines among these findings. */
function spots(findings: readonly FindingT[]): number {
  return new Set(findings.map(locationKey)).size;
}

/** Several rules often flag one line. Show the location once, led by the finding with a verdict. */
function dedupeLocations(findings: readonly FindingT[]): FindingT[] {
  const seen = new Map<string, FindingT>();
  for (const f of findings) {
    const key = locationKey(f);
    const existing = seen.get(key);
    if (!existing || (!existing.reasoning && f.reasoning)) seen.set(key, f);
  }
  return [...seen.values()];
}

/**
 * Checks a quoted line against the real file, whitespace-insensitive, so a
 * made-up quote is flagged. The model only ever saw masked code, so a quote
 * matches the file as written or as masked. The paths come from the model, so
 * files are read through the same guard as the code context: a path outside
 * the repo cannot hold the quote, and a symlink, an oversized file or a
 * secret-bearing file is never read, so its quotes are not checked. Neither
 * is anything when the repo is not on this machine. The repo folder itself may
 * be a symlink: containment is checked per file, against its real path.
 */
export async function quoteChecker(
  repoDir: string,
  files: Iterable<string>,
): Promise<QuoteChecker> {
  const root = resolve(repoDir);
  const present = await stat(root).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!present) return () => null;
  const keys = [...new Set([...files].map(repoKey))];
  const texts = await Promise.all(keys.map((key) => readForQuotes(root, key)));
  const cache = new Map(keys.map((key, i) => [key, texts[i] ?? null]));
  return (file, quote) => {
    const versions = cache.get(repoKey(file));
    if (!versions) return null;
    const needle = squash(quote);
    return needle.length > 0 && versions.some((v) => v.includes(needle));
  };
}

/** A quoted path as a repo key: forward slashes, and a leading slash means the repo root. */
function repoKey(file: string): string {
  return file.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** The file as written and as masked; [] when it cannot hold the quote; null when it is not checked. */
async function readForQuotes(root: string, key: string): Promise<string[] | null> {
  const lexical = resolve(root, key);
  if (lexical !== root && !lexical.startsWith(root + sep)) return [];
  if (isSecretFile(key)) return null;
  const abs = await safeResolve(root, key);
  if (abs) {
    return readFile(abs, 'utf8').then(
      (text) => [squash(text), squash(redactSecrets(text).text)],
      () => null,
    );
  }
  // Missing: the quote cannot be there. Present but refused: not checked.
  return lstat(lexical).then(
    () => null,
    () => [],
  );
}

/** Whitespace-free, with every mask alike: a mask that shows a length still matches one that does not. */
function squash(text: string): string {
  return text.replace(/\[REDACTED(?::\d+)?\]/g, '[REDACTED]').replace(/\s+/g, '');
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
