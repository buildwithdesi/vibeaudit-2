import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { CodeContextT } from '../model/finding.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Patterns that look like live credentials. Matched values are masked before
 * any context leaves this process, so run artifacts and model prompts never
 * carry a real secret even when the scanned repo does.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?:(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^:\s/]+:)([^@\s/]+)(@)/g,
];

/** Quoted values assigned to anything named like a credential. */
const ASSIGNED_SECRET =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth)\w*\s*[:=]\s*['"`])([^'"`\n]{4,})(['"`])/gi;

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups: unknown[]) => {
      redacted = true;
      // Connection strings: keep user and host, mask only the password.
      if (typeof groups[0] === 'string' && typeof groups[1] === 'string' && groups[1] === '@') {
        const prefixLength = match.length - groups[0].length - 1;
        return `${match.slice(0, prefixLength)}[REDACTED]@`;
      }
      return `[REDACTED:${match.length}]`;
    });
  }
  out = out.replace(ASSIGNED_SECRET, (_match, open: string, value: string, close: string) => {
    redacted = true;
    return `${open}[REDACTED:${value.length}]${close}`;
  });
  return { text: out, redacted };
}

/**
 * Read the lines around a finding. Returns null when the file is missing,
 * binary-sized, or resolves outside the repository root.
 */
export async function readContext(
  repoDir: string,
  relativeFile: string,
  line: number | null,
  radius: number,
): Promise<CodeContextT | null> {
  if (line === null || line <= 0) return null;
  const root = resolve(repoDir);
  const abs = resolve(root, relativeFile);
  if (abs !== root && !abs.startsWith(root + sep)) return null;

  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    return null;
  }
  if (size > MAX_FILE_BYTES) return null;

  const content = await readFile(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, line - radius);
  const endLine = Math.min(lines.length, line + radius);
  const slice = lines.slice(startLine - 1, endLine);
  const numbered = slice.map((text, index) => `${String(startLine + index).padStart(5)}  ${text}`);
  const { text, redacted } = redactSecrets(numbered.join('\n'));
  return { startLine, endLine, code: text, redacted };
}
