import type { FindingT } from '../../model/finding.ts';
import type { ChatMessage } from '../meta-client.ts';
import { clip, inline, repoData, UNTRUSTED_RULE } from './shared.ts';

/**
 * Triage: a cheap open-weight pass (Muse Glimmer) that answers one question
 * per finding: does this sit in real, reachable application code? It never
 * judges exploitability. Its job is to keep test fixtures, dead code, vendored
 * files and already-mitigated paths away from the frontier model.
 */
export const TRIAGE_SYSTEM = `You are a fast first-pass reviewer for a security scanner. A deterministic rule flagged one location. Decide only whether the location deserves a deeper exploitability review.

${UNTRUSTED_RULE}

Keep the finding (keep=true) when the code is real application code that could run in production.
Drop it (keep=false) only when you can point at the code that proves one of these:
- test-or-fixture: the file is a test, a mock, a fixture, or demo data.
- dead-code: the flagged code is unreachable, commented out, or never exported or mounted.
- already-mitigated: a visible guard on the same path neutralizes the issue (parameterized query, allowlist, sanitizer, auth check).
- generated-or-vendored: build output, a dependency copy, or generated code.
When unsure, keep it and say category=unsure. A dropped finding never reaches a human, so dropping must be proven, keeping needs no proof.
Quote the exact line that decided your answer in the reason.`;

export interface TriageInput {
  finding: FindingT;
  fileRole: string | null;
  repoSummary: string | null;
}

export function buildTriageMessages(input: TriageInput): ChatMessage[] {
  const f = input.finding;
  const user = [
    input.repoSummary
      ? `Repository summary:\n${repoData('repo-summary', clip(input.repoSummary, 600))}`
      : '',
    `File:\n${repoData('location', `${inline(f.file)}${f.line ? `:${f.line}` : ''}`)}`,
    input.fileRole
      ? `File role from the repo map:\n${repoData('file-role', inline(input.fileRole, 40))}`
      : '',
    `Rule: ${f.ruleId} (${f.ruleName}), severity ${f.severity}, class ${f.vulnClass}`,
    `What the rule says:\n${repoData('rule-message', inline(f.message, 400))}`,
    f.evidence ? `Flagged evidence:\n${repoData('evidence', clip(f.evidence, 400))}` : '',
    f.context
      ? `Code around the flagged line:\n${repoData(f.file, clip(f.context.code, 3_000))}`
      : 'No code context available.',
    '',
    'Answer as JSON matching the schema.',
  ]
    .filter((line) => line !== '')
    .join('\n');
  return [
    { role: 'system', content: TRIAGE_SYSTEM },
    { role: 'user', content: user },
  ];
}
