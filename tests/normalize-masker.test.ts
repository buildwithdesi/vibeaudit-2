import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../src/normalize/context.ts';

// Every fake secret below carries this marker, so a leak is a plain substring check.
const M = 'FAKEZ9';
const HEX = '0123456789abcdef'.repeat(2);

test('masks the credential shapes real repos leak', () => {
  const leaks = [
    `const secret = process.env.SESSION_SECRET || 'keyboard ${M} cat';`,
    `const apiKey = process.env.API_KEY ?? '${M}abcdefgh';`,
    `const k = process.env['JWT_SECRET'] ?? "${M}abcdefgh";`,
    `secret = os.environ.get('SECRET_KEY', '${M}abcdefgh')`,
    `jwt.sign(payload, process.env.JWT_SECRET || '${M}abcdefgh');`,
    `auth: { user: 'me@example.com', pass: '${M}abcdefgh' }`,
    `DB_PASS=${M}abcdefgh`,
    `SMTP_PASS=${M}abcdefgh`,
    `ENCRYPTION_KEY=${M}abcdefgh`,
    `JWT_KEY=${M}abcdefgh`,
    `SIGNING_KEY=${M}abcdefgh`,
    `export API_TOKEN=${M}.abc.def`,
    `    9  DB_PASS=${M}.abc.def`,
    `- MYSQL_PASSWORD=${M}.abc.def`,
    `const signingKey = '${M}abcdefgh';`,
    `headers: { authorization: 'bearer ${M}abcdefghijklmnop' }`,
    `headers.set('Authorization', 'Bearer ${M}abcdefghijklmnop');`,
    `fetch(url, { headers: { Authorization: 'Basic ${M}abcdefgh12==' } })`,
    `fetch(url, { headers: { Authorization: 'Token ${M}abcdefgh1234' } })`,
    `password = 'true${M}abcdefgh'`,
    `password = 'none${M}abcdefgh'`,
    `password: 'null${M}abcdefgh'`,
    `password = 'env.${M}abcdefgh'`,
    `password = '$X${M}abcdefgh'`,
    `password = 'ab,${M}abcdefgh'`,
    `password = 'ab;${M}abcdefgh'`,
    `password = 'correct horse ${M} staple'`,
    `const password = "it's ${M} a secret";`,
    `const k = 'ASIA${M}ABCDEFGHIJ';`,
    `const k = 'SG.${M}abcdefghijklmn.${M}abcdefghijklmnopqrstuvwxyz';`,
    `const k = 'glpat-${M}abcdefghijklmn';`,
    `const k = 'hf_${M}abcdefghijklmnopqrstuvwxyz12';`,
    `const k = 'whsec_${M}abcdefghijklmnopqrstuv';`,
    `<connection password="${M}abcdefgh" />`,
    `MYSQL_ROOT_PASSWORD: 123${M}456`,
  ];
  for (const line of leaks) {
    const { text, redacted } = redactSecrets(line);
    assert.ok(!text.includes(M), `leaked: ${text}`);
    assert.equal(redacted, true, line);
  }
  const shopify = redactSecrets(`const k = 'shpat_${HEX}';`).text;
  assert.ok(!shopify.includes(HEX), shopify);
});

test('leaves ordinary auth code, env lookups, versions and small numbers alone', () => {
  const code = [
    'const token = req.headers.authorization;',
    "const token = req.headers['authorization'];",
    'const auth = req.session.user;',
    'const passwordHash = await bcrypt.hash(password, 10);',
    'router.use({ authenticate: requireLogin });',
    '{ author: "Jane" }',
    'const isAuthenticated = req.isAuthenticated();',
    'const tokenExpiry = Date.now() + 3600;',
    "const authRoutes = require('./routes/auth');",
    'const secretName = getSecretName();',
    'const port = process.env.PORT || "3000";',
    'const mode = process.env.NODE_ENV || "development";',
    'const key = process.env.API_KEY;',
    "SECRET_KEY = config('SECRET_KEY')",
    '"jsonwebtoken": "^9.0.2",',
    'apiKey: string | null,',
    'interface Login { email: string; password: string }',
    'password: z.string().min(8),',
    'promptTokens: usage?.prompt_tokens ?? 0,',
    'max_tokens: 1024,',
    'const res = await fetch(url, { credentials: "include" });',
    'headers: { Authorization: `Bearer ${token}` }',
    'token: ${{ secrets.GITHUB_TOKEN }}',
    "password: '${DB_PASSWORD}'",
    '// verify the token signature before trusting claims',
    'const primary_key = "id";',
  ];
  for (const line of code) {
    assert.equal(redactSecrets(line).text, line);
  }
});

test('escaped text keeps its escapes, so masked JSON still parses', () => {
  const json = JSON.stringify({
    evidence: `fetch("https://api.example.com/data?token=${M}abcd1234")`,
    script: `API_KEY="${M}abcd1234" node deploy.js`,
    note: `see token=${M}abcd"`,
    a: 'postgres://u:',
    b: 'x@host',
  });
  const { text } = redactSecrets(json);
  assert.ok(!text.includes(M), text);
  const parsed = JSON.parse(text) as Record<string, string>;
  assert.equal(parsed.a, 'postgres://u:', 'a URL pattern never joins two strings');
  assert.equal(parsed.b, 'x@host');
});
