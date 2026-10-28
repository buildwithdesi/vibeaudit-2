/**
 * Vulnerability classes group the v1 engine's rule ids into the handful of
 * stories a non-security reader can follow. The reasoning layer, the
 * plain-language report and the patch loop all work per class, not per rule.
 *
 * The map must cover every rule id the pinned v1 engine ships. A test asks the
 * engine for its live rule list and fails if any id is missing here, so a v1
 * upgrade can never silently drop findings into "other".
 */
export const VULN_CLASS_IDS = [
  'secrets',
  'sql-injection',
  'command-injection',
  'missing-auth',
  'path-traversal',
  'ssrf',
  'xss',
  'input-handling',
  'auth-sessions-crypto',
  'webhooks-payments',
  'data-exposure',
  'hardening-config',
  'supply-chain',
  'ai-safety',
  'accessibility',
  'performance',
  'other',
] as const;

export type VulnClassId = (typeof VULN_CLASS_IDS)[number];

export interface VulnClass {
  id: VulnClassId;
  name: string;
  /** One sentence a founder can read without a security background. */
  plain: string;
  /** Lower number = shown first when classes tie on severity. */
  demoRank: number;
  rules: readonly string[];
}

export const VULN_CLASSES: readonly VulnClass[] = [
  {
    id: 'secrets',
    name: 'Secrets in code',
    plain:
      'A password or API key is written into the code, so anyone who can read the code can use it.',
    demoRank: 1,
    rules: [
      'exposed-secrets',
      'hardcoded-credentials',
      'exposed-env-vars',
      'client-bundle-secrets',
      'secrets-in-urls',
      'supabase-service-key-client',
      'firebase-admin-client',
      'vercel-env-leak',
      'high-entropy-strings',
      'git-history-secrets',
    ],
  },
  {
    id: 'sql-injection',
    name: 'Database injection',
    plain:
      'User input is pasted into a database query, so a visitor can rewrite the query and read or delete data.',
    demoRank: 2,
    rules: ['sql-injection', 'nosql-injection'],
  },
  {
    id: 'command-injection',
    name: 'Command and code injection',
    plain:
      'User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server.',
    demoRank: 3,
    rules: [
      'command-injection',
      'eval-usage',
      'template-injection',
      'mdx-untrusted-source',
      'github-actions-injection',
      'unsafe-deserialization',
    ],
  },
  {
    id: 'missing-auth',
    name: 'Missing authorization',
    plain:
      'An endpoint does not check who is asking, so anyone can read or change data that should be private.',
    demoRank: 4,
    rules: [
      'missing-auth',
      'idor-vulnerability',
      'client-only-auth',
      'nextjs-server-action-exposure',
      'nextjs-middleware-bypass',
      'graphql-no-auth',
      'open-database-rules',
      'supabase-missing-rls',
      'supabase-anon-key-abuse',
      'supabase-public-bucket',
      'mfa-bypass',
      'client-side-db-access',
    ],
  },
  {
    id: 'path-traversal',
    name: 'File path traversal',
    plain:
      'User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder.',
    demoRank: 5,
    rules: ['path-traversal', 'unsafe-file-upload', 'serverless-fs-write'],
  },
  {
    id: 'ssrf',
    name: 'Server-side request forgery',
    plain:
      'The server fetches a URL the visitor supplies, so the visitor can make it call internal systems.',
    demoRank: 6,
    rules: ['ssrf-vulnerability'],
  },
  {
    id: 'xss',
    name: 'Cross-site scripting',
    plain:
      'Untrusted text is rendered as live HTML, so an attacker can run script in other users’ browsers.',
    demoRank: 7,
    rules: ['dangerously-set-inner-html', 'clickjacking', 'missing-sri'],
  },
  {
    id: 'input-handling',
    name: 'Unsafe input handling',
    plain:
      'Input is trusted without checks, so a visitor can set fields or trigger behavior they should not control.',
    demoRank: 8,
    rules: [
      'no-input-validation',
      'mass-assignment',
      'prototype-pollution',
      'xml-xxe',
      'ldap-injection',
      'header-injection',
      'regex-dos',
      'unsafe-redirect',
      'netlify-redirect-open',
      'client-side-trust',
      'payment-amount-client',
    ],
  },
  {
    id: 'auth-sessions-crypto',
    name: 'Weak authentication, sessions, or crypto',
    plain:
      'Logins, sessions, or stored passwords are protected with weak methods that an attacker can break or bypass.',
    demoRank: 9,
    rules: [
      'insecure-jwt',
      'plaintext-passwords',
      'insecure-randomness',
      'insecure-cookies',
      'timing-attack',
      'no-account-lockout',
      'session-fixation',
      'oauth-state-missing',
      'password-reset-weak',
      'auth-token-no-expiry',
      'weak-hashing',
      'insecure-cipher',
      'missing-data-encryption',
      'missing-csrf',
      'race-condition',
    ],
  },
  {
    id: 'webhooks-payments',
    name: 'Unverified webhooks and payments',
    plain:
      'The server trusts payment or webhook messages without proof of who sent them, so anyone can fake them.',
    demoRank: 10,
    rules: ['unverified-webhook', 'stripe-webhook-no-verify'],
  },
  {
    id: 'data-exposure',
    name: 'Data exposure',
    plain:
      'Private data leaks through logs, error messages, browser storage, or responses that return too much.',
    demoRank: 11,
    rules: [
      'sensitive-browser-storage',
      'console-data-leak',
      'source-maps-exposed',
      'api-data-overfetch',
      'insecure-error-handling',
      'pii-logging',
      'graphql-introspection',
      'debug-mode-exposed',
      'predictable-ids',
      'hardcoded-ip',
    ],
  },
  {
    id: 'hardening-config',
    name: 'Missing hardening',
    plain:
      'Protective settings such as rate limits, security headers, or safe deploy config are missing.',
    demoRank: 12,
    rules: [
      'missing-security-headers',
      'missing-rate-limiting',
      'insecure-connections',
      'cors-credentials',
      'no-bot-protection',
      'no-pagination',
      'missing-gitignore',
      'graphql-depth-limit',
      'nextjs-api-route-no-method-check',
      'deployment-config-insecure',
      'subdomain-takeover',
      'docker-root-user',
      'exposed-database-port',
      'no-error-monitoring',
    ],
  },
  {
    id: 'supply-chain',
    name: 'Supply chain',
    plain:
      'A dependency or setup step can run code you never reviewed, is unpinned or known to be unsafe, or carries a license that blocks commercial use.',
    demoRank: 13,
    rules: [
      'unpinned-dependencies',
      'install-script-dependency',
      'license-contamination',
      'known-vulnerable-versions',
      'download-execution',
    ],
  },
  {
    id: 'ai-safety',
    name: 'AI integration risks',
    plain:
      'Prompts or model outputs are trusted without checks, so a visitor can hijack the AI feature or run up the bill.',
    demoRank: 14,
    rules: [
      'ai-prompt-injection',
      'ai-response-trusted',
      'ai-cost-exposure',
      'agent-control-injection',
    ],
  },
  {
    id: 'accessibility',
    name: 'Accessibility',
    plain: 'Parts of the interface do not work for people using screen readers or keyboards.',
    demoRank: 15,
    rules: [
      'a11y-img-no-alt',
      'a11y-form-no-label',
      'a11y-no-lang',
      'a11y-button-no-name',
      'a11y-positive-tabindex',
      'a11y-click-no-keyboard',
    ],
  },
  {
    id: 'performance',
    name: 'Performance',
    plain: 'Code patterns that get slow or expensive as the app grows.',
    demoRank: 16,
    rules: ['perf-n-plus-one', 'perf-no-await-parallel', 'perf-db-client-per-request'],
  },
  {
    id: 'other',
    name: 'Other',
    plain: 'Findings the class map does not know yet.',
    demoRank: 99,
    rules: [],
  },
];

const RULE_TO_CLASS: ReadonlyMap<string, VulnClassId> = new Map(
  VULN_CLASSES.flatMap((c) => c.rules.map((rule) => [rule, c.id] as const)),
);

/** Resolve a finding to its class. Dependency findings from the SCA adapters count as supply chain. */
export function classOf(ruleId: string, source?: string | null): VulnClassId {
  const direct = RULE_TO_CLASS.get(ruleId);
  if (direct) return direct;
  if (
    source ||
    ruleId.startsWith('osv') ||
    ruleId.startsWith('npm-audit') ||
    ruleId.startsWith('sca')
  ) {
    return 'supply-chain';
  }
  return 'other';
}

export function vulnClass(id: VulnClassId): VulnClass {
  const found = VULN_CLASSES.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown vulnerability class: ${id}`);
  return found;
}
