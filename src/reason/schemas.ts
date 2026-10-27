import { z } from 'zod';

/**
 * Output schemas for the reasoning layer. Zod is the single source of truth:
 * the same schema validates the model's JSON and is converted into the
 * `response_format` the Meta Model API constrains generation with.
 *
 * Meta's strict subset (dev.meta.ai/docs/structured-output): root is a plain
 * object, every object sets additionalProperties false, every object lists
 * every key in `required`, no allOf or oneOf anywhere. So these schemas use
 * nullable instead of optional, and never use unions at the root.
 */

/** Cheap first pass from an open-weight model. Decides whether a finding deserves frontier reasoning. */
export const TriageVerdict = z.object({
  keep: z.boolean().describe('true when the finding sits in real, reachable application code'),
  category: z
    .enum([
      'real-code',
      'test-or-fixture',
      'dead-code',
      'already-mitigated',
      'generated-or-vendored',
      'unsure',
    ])
    .describe('why the finding was kept or dropped'),
  reason: z.string().describe('one or two sentences, quote the code that decided it'),
  confidence: z.number().min(0).max(1),
});
export type TriageVerdictT = z.infer<typeof TriageVerdict>;

export const Exploitability = z.enum([
  'confirmed',
  'likely',
  'unlikely',
  'not-exploitable',
  'needs-runtime-check',
]);
export type ExploitabilityT = z.infer<typeof Exploitability>;

/** Frontier-model judgment on one finding, with the evidence that supports it. */
export const ExploitVerdict = z.object({
  exploitability: Exploitability,
  confidence: z.number().min(0).max(1),
  attackerPosition: z
    .enum(['anonymous-internet', 'authenticated-user', 'insider-or-admin', 'local-only', 'none'])
    .describe('the weakest position from which the attack works'),
  preconditions: z
    .array(z.string())
    .describe('what must be true for the attack to work; empty when none'),
  attackPath: z.array(z.string()).describe('ordered steps an attacker takes, each one sentence'),
  impact: z.string().describe('what the attacker gets, in one or two sentences'),
  blastRadius: z.enum(['single-user', 'many-users', 'whole-system', 'infrastructure']),
  evidence: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().nullable(),
        quote: z.string().describe('verbatim code, at most two lines'),
      }),
    )
    .describe('code that proves the path exists; every claim above must trace to one of these'),
  severityAdjustment: z.enum(['raise', 'keep', 'lower']),
  fixSummary: z.string().describe('the smallest change that closes the path, one or two sentences'),
  plainLanguage: z
    .string()
    .describe(
      'two sentences for a founder with no security background: what could happen and why it matters',
    ),
});
export type ExploitVerdictT = z.infer<typeof ExploitVerdict>;

/** One map of the repository, built once per run and shared by every exploitability call. */
export const RepoMap = z.object({
  summary: z.string().describe('what the application does, two or three sentences'),
  stack: z.array(z.string()).describe('frameworks, runtimes, databases, hosting hints'),
  entryPoints: z.array(
    z.object({
      file: z.string(),
      kind: z.enum(['http-route', 'server-action', 'cli', 'job', 'webhook', 'other']),
      note: z.string(),
    }),
  ),
  authBoundaries: z.array(
    z.object({
      file: z.string(),
      mechanism: z.string().describe('middleware name, session check, API key check, and so on'),
      coversRoutes: z
        .array(z.string())
        .describe('route paths or file globs this boundary protects'),
    }),
  ),
  dataStores: z.array(
    z.object({
      name: z.string(),
      accessedFrom: z.array(z.string()).describe('files that talk to this store'),
    }),
  ),
  trustZones: z.array(
    z.object({
      zone: z.enum(['public', 'authenticated', 'admin', 'internal']),
      files: z.array(z.string()),
    }),
  ),
  fileRoles: z.array(
    z.object({
      file: z.string(),
      role: z.enum([
        'route',
        'middleware',
        'model',
        'config',
        'test',
        'fixture',
        'generated',
        'vendored',
        'ui',
        'util',
        'infra',
        'unknown',
      ]),
    }),
  ),
  notes: z
    .array(z.string())
    .describe('anything a security reviewer should know before judging findings'),
});
export type RepoMapT = z.infer<typeof RepoMap>;

/**
 * Convert a Zod schema into the `response_format` block the Meta Model API
 * expects, tightened to the strict subset so the server validates it too.
 */
export function toResponseFormat(
  schema: z.ZodType,
  name: string,
): {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: Record<string, unknown> };
} {
  const raw = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete raw.$schema;
  return { type: 'json_schema', json_schema: { name, strict: true, schema: strictify(raw) } };
}

/** Walk a JSON schema and apply Meta's strict-subset rules to every object node. */
export function strictify(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== 'object' || Array.isArray(node))
    return node as Record<string, unknown>;
  const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, unknown>;
    for (const key of Object.keys(props)) props[key] = strictify(props[key]);
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictify(out.items);
  if (Array.isArray(out.anyOf)) out.anyOf = out.anyOf.map(strictify);
  return out;
}
