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
  /whsec_[A-Za-z0-9]{24,}/g,
  /sk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /ASIA[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /npm_[A-Za-z0-9]{20,}/g,
  /hf_[A-Za-z0-9]{30,}/g,
  /shp(?:at|ss|ca|pa)_[A-Fa-f0-9]{32}/g,
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /LLM_\d{6,}_[A-Za-z0-9_-]{12,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
  // Basic and Token need a digit or base64 padding, so prose like "Token signature" is kept.
  /(\b(?:Basic|Token)\s+)(?=[A-Za-z0-9._~+/=-]*[\d+/=])[A-Za-z0-9._~+/=-]{12,}/g,
  // Any URL with a password in it: scheme://user:password@host. The user may be empty.
  // Neither part crosses a quote or a backslash, so it never joins two separate strings.
  /([a-z][a-z0-9+.-]*:\/\/[^:/@\s"'`\\]*:)([^@/\s"'`\\]+)(@)/gi,
];

/**
 * Names that mark a credential. `auth` counts only as a whole word (Node's
 * `auth: 'user:pass'`, Docker's `"auth": "<base64>"`), so author, authenticate
 * and authRoutes stay readable; isAuthSetting keeps its settings readable too.
 * Key names are listed one by one, because a generic `_key` also matches
 * primary_key and cache_key.
 */
const SECRET_NAME = String.raw`(?:password|passwd|passphrase|pwd|pass\b|auth\b|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|(?:signing|encryption|session|jwt|hmac|master|app|client)[_-]?key|authorization|auth[_-]?(?:token|key|secret|pass)|credential)`;

/**
 * Values assigned to anything named like a credential: `password = "x"`,
 * `"api_key": "x"`, `API_KEY=x` in .env style, `secret: x` in YAML. A quoted
 * value is masked up to its closing quote, spaces and commas included, and
 * escape pairs such as \\ or \$ count as part of it. A value whose quote is
 * itself escaped (\" inside serialized text) takes no backslash at all, so
 * that text keeps its escapes and stays valid. A quoted value with no closing
 * quote (evidence cut short) is masked up to the next space, quote or
 * backslash; it cannot start with a space, comma or `+`, because that quote
 * is the end of a string (`"token=" + t`), not the start of a value.
 */
const ASSIGNED_SECRET = new RegExp(
  String.raw`(${SECRET_NAME}s?\w*\\?["']?\s*[:=]\s*)(?:(\\["'\x60])((?:(?!\2)[^\n\\]){4,})\2|(["'\x60])((?:\\.|(?!\4)[^\n\\]){4,})\4|(["'\x60])([^\s"'\x60\\,;)}\]+][^\s"'\x60\\,;)}\]]{3,})|([^"'\x60\s,;)}\]\\]{4,}))`,
  'gi',
);

/** A literal fallback after an env lookup for a credential: `process.env.JWT_SECRET || 'x'`. */
const ENV_FALLBACK = new RegExp(
  String.raw`((?:process\.env|import\.meta\.env)(?:\.\w*${SECRET_NAME}\w*|\[["']\w*${SECRET_NAME}\w*["']\])\s*(?:\|\||\?\?)\s*|os\.(?:environ\.get|getenv)\(\s*["']\w*${SECRET_NAME}\w*["']\s*,\s*)(["'\x60])((?:(?!\2)[^\n\\]){4,})\2`,
  'gi',
);

/** Lines in .env, shell, Dockerfile or compose style, where a bare value is always data. */
const ENV_LINE = /^\s*(?:\d+\s+)?(?:-\s*)?(?:export\s+|ENV\s+|ARG\s+)?[A-Z0-9_]+=/;
/** The start of a `key: value` (YAML, compose) or `key=value` (.properties) line, up to the name. */
const CONFIG_KEY = /^\s*(?:\d+\s+)?(?:-\s*)?["']?[\w.-]*$/;
/** Their separator: `=` with no space before it, or `:` with a space after it. */
const CONFIG_SEP = /(?:[\w"']=|:\s+)$/;
/** What may follow a value that ends its line: nothing, or a `#` comment. */
const LINE_END = /^\s*(?:#.*)?$/;
/** Bare values that read a secret from somewhere else rather than hold one. */
const LOOKUP =
  /^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env\.|ENV\[|\$\{|\$[A-Z_][A-Z0-9_]*$)/;
const LITERAL_WORD = /^(?:null|undefined|true|false|none|nil)$/i;
/** Bare values that are code wherever they appear: keywords, type names, calls, index reads. */
const CODE_EXPR =
  /^(?:await|new|require|this|function|async|typeof|yield|string|number|boolean|unknown|any|object)$|^[A-Za-z_$][\w$.?]*[([]/;
/** A member chain such as `req.session.user`. */
const MEMBER_CHAIN = /^[A-Za-z_$][\w$?.]*\.[A-Za-z_$][\w$]*$/;
/** Numbers of up to five digits, such as `max_tokens: 1024`. */
const SMALL_NUMBER = /^\d{1,2}_?\d{3}$|^\d{2,5}$/;
/** The open part of an assignment whose name ends in a password word: `pin_password: `. */
const PASSWORD_OPEN = /(?:pass(?:word|wd|phrase)?|pwd|secret)\\?["']?\s*[:=]\s*$/i;
/** The open part of an assignment to the word `auth` alone: `auth: `, `basic_auth=`. */
const AUTH_OPEN = /(?:^|[^a-z])auth\\?["']?\s*[:=]\s*$/i;

/**
 * Whether a bare value on a line that is not .env style is code rather than
 * data. Member chains are code (`req.session.user`) unless their first part
 * has a digit (`Winter2024.Secure`) or they end a `key: value` or `key=value`
 * config line. Small numbers are code unless the name ends in a password word.
 */
function isCodeValue(
  value: string,
  open: string,
  line: string,
  start: number,
  end: number,
): boolean {
  if (CODE_EXPR.test(value)) return true;
  if (MEMBER_CHAIN.test(value)) {
    if (/^[^.?]*\d/.test(value)) return false;
    const configLine =
      CONFIG_KEY.test(line.slice(0, start)) &&
      CONFIG_SEP.test(open) &&
      LINE_END.test(line.slice(end));
    return !configLine;
  }
  if (SMALL_NUMBER.test(value)) return !PASSWORD_OPEN.test(open);
  return false;
}

/**
 * After the word `auth` alone, values that are settings or code rather than
 * credentials: identifiers, tuples and regexes (`auth: requireAuth`,
 * `auth=(user, pw)`), and quoted plain words or prose (`auth: 'session'`).
 * A credential there is `user:pass` or base64, which neither shape fits.
 */
function isAuthSetting(value: string, quoted: boolean): boolean {
  if (!quoted) return /^[A-Za-z_$]+$|^[({[/]/.test(value);
  if (/\s/.test(value)) return true;
  // A word or camelCase: letters only, each capital followed by a lowercase letter.
  return /^[A-Za-z][a-z][A-Za-z]*$/.test(value) && !/[A-Z](?![a-z])/.test(value);
}

/** Quoted values that are references, versions or fetch's credentials modes, not secrets. */
const QUOTED_REFERENCE =
  /^\$\{[^}]*\}$|^\$[A-Z_][A-Z0-9_]*$|^[\^~]?\d+\.\d+\.\d+(?:[-+][\w.]+)?$|^(?:include|omit|same-origin)$/;

/**
 * Files that are secrets by nature. Their content is never read into context
 * at all. Credential and secrets files count only with a data extension (or
 * none), so source such as credentials.ts or lib/secrets.ts stays readable.
 */
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|.+\.env|\.envrc|\.dev\.vars|env\.local|\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|jks|keystore)|.*credentials?(?:\.(?:json|ya?ml|toml|ini|txt|xml))?|.*service[-_]?account.*\.json|.*secrets?\.(?:json|ya?ml|toml|ini|txt|env))$/i;

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
      // Auth header schemes: keep the word, mask the token.
      if (typeof groups[0] === 'string' && /^(?:[Bb]earer|Basic|Token)\s+$/.test(groups[0])) {
        return `${groups[0]}[REDACTED]`;
      }
      return `[REDACTED:${match.length}]`;
    });
  }
  out = out.replace(ENV_FALLBACK, (_match, open: string, quote: string, value: string) => {
    redacted = true;
    return `${open}${quote}[REDACTED:${value.length}]${quote}`;
  });
  // Line by line, because whether a bare value is data or code depends on the line's style.
  out = out
    .split('\n')
    .map((line) =>
      line.replace(
        ASSIGNED_SECRET,
        (
          match: string,
          open: string,
          escapedQuote: string | undefined,
          escapedValue: string | undefined,
          plainQuote: string | undefined,
          plainValue: string | undefined,
          unclosedQuote: string | undefined,
          unclosedValue: string | undefined,
          bare: string | undefined,
          offset: number,
        ) => {
          const quote = escapedQuote ?? plainQuote ?? unclosedQuote;
          const quoted = escapedValue ?? plainValue ?? unclosedValue;
          const auth = AUTH_OPEN.test(open);
          // `auth` inside a lowercase word, as in `oauth:` or a URN, is not a name.
          if (auth && open.startsWith('auth') && /[a-z]$/.test(line.slice(0, offset))) return match;
          if (quote !== undefined && quoted !== undefined) {
            if (quoted.includes('[REDACTED') || QUOTED_REFERENCE.test(quoted)) return match;
            // A template literal that interpolates is code that builds a value.
            if (quote === '`' && quoted.includes('${')) return match;
            if (auth && isAuthSetting(quoted, true)) return match;
            redacted = true;
            const close = unclosedValue === undefined ? quote : '';
            return `${open}${quote}[REDACTED:${quoted.length}]${close}`;
          }
          const value = bare ?? '';
          if (value.includes('[REDACTED') || LOOKUP.test(value) || LITERAL_WORD.test(value)) {
            return match;
          }
          if (!ENV_LINE.test(line)) {
            if (auth && isAuthSetting(value, false)) return match;
            if (isCodeValue(value, open, line, offset, offset + match.length)) return match;
          }
          redacted = true;
          return `${open}[REDACTED:${value.length}]`;
        },
      ),
    )
    .join('\n');
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
