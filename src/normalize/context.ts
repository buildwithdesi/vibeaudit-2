import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import type { CodeContextT } from '../model/finding.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Patterns that look like live credentials. Matched values are masked before
 * any context leaves this process, so run artifacts and model prompts never
 * carry a real secret even when the scanned repo does.
 */
const SECRET_PATTERNS: RegExp[] = [
  /(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/g,
  /sk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /LLM_\d{6,}_[A-Za-z0-9_-]{12,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  // Any URL with a password in it: scheme://user:password@host. The user may be empty.
  /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)([^@/\s]+)(@)/gi,
];

/**
 * Values assigned to anything named like a credential: `password = "x"`,
 * `"api_key": "x"`, `API_KEY=x` in .env style, `secret: x` in YAML.
 */
const ASSIGNED_SECRET =
  /((?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth|credential)s?\w*["']?\s*[:=]\s*["'`]?)([^"'`\s,;)}\]]{4,})(["'`]?)/gi;

/** Files that are secrets by nature. Their content is never read into context at all. */
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i;

export function isSecretFile(file: string): boolean {
  return SECRET_FILE.test(basename(file.replace(/\\/g, '/')));
}

export function redactSecrets(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, ...groups: unknown[]) => {
      redacted = true;
      // URL credentials: keep scheme, user and host, mask only the password.
      if (typeof groups[0] === 'string' && typeof groups[2] === 'string' && groups[2] === '@') {
        return `${groups[0]}[REDACTED]@`;
      }
      // Bearer tokens: keep the word, mask the token.
      if (typeof groups[0] === 'string' && /^Bearer\s+$/.test(groups[0])) {
        return `${groups[0]}[REDACTED]`;
      }
      return `[REDACTED:${match.length}]`;
    });
  }
  out = out.replace(ASSIGNED_SECRET, (_match, open: string, value: string, close: string) => {
    if (
      /^(?:process\.env|env\.|os\.environ|\$\{|\$[A-Z_]|null|undefined|true|false|none|\[REDACTED)/i.test(
        value,
      )
    ) {
      return `${open}${value}${close}`;
    }
    redacted = true;
    return `${open}[REDACTED:${value.length}]${close}`;
  });
  return { text: out, redacted };
}

/**
 * Read the lines around a finding. Returns null when the file is missing,
 * oversized, a symlink, a secret-bearing file, or resolves outside the root.
 */
export async function readContext(
  repoDir: string,
  relativeFile: string,
  line: number | null,
  radius: number,
): Promise<CodeContextT | null> {
  if (line === null || line <= 0) return null;
  if (isSecretFile(relativeFile)) {
    return {
      startLine: line,
      endLine: line,
      code: '[secret-bearing file: content not read]',
      redacted: true,
    };
  }
  const abs = await safeResolve(repoDir, relativeFile);
  if (!abs) return null;

  const content = await readFile(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, line - radius);
  const endLine = Math.min(lines.length, line + radius);
  const slice = lines.slice(startLine - 1, endLine);
  const numbered = slice.map((text, index) => `${String(startLine + index).padStart(5)}  ${text}`);
  const { text, redacted } = redactSecrets(numbered.join('\n'));
  return { startLine, endLine, code: text, redacted };
}

/** Lexical check, then a real-path check, then a symlink and size check. */
export async function safeResolve(repoDir: string, relativeFile: string): Promise<string | null> {
  const root = resolve(repoDir);
  const abs = resolve(root, relativeFile);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const realRoot = await realpath(root);
    const real = await realpath(abs);
    if (!real.startsWith(realRoot + sep)) return null;
    return abs;
  } catch {
    return null;
  }
}
