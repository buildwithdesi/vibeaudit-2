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

test('masks values with escapes, auth values, config-file values and cut-off quotes', () => {
  const leaks = [
    // A quoted value may carry escape pairs.
    `const DB_PASSWORD = "p@ss\\\\w0rd${M}";`,
    `export DB_PASSWORD="Pa\\$\\$w0rd${M}"`,
    `      POSTGRES_PASSWORD: "Pa\\$\\$${M}word"`,
    `token = "abc\\u0041${M}def"`,
    `const password = "abc\\n${M}def";`,
    `password: "C:\\\\Users\\\\${M}pw"`,
    // `auth` alone names a credential.
    `const options = { hostname: 'api.example.com', auth: 'admin:${M}pw123' };`,
    `http.get({ host, auth: "deploy:${M}abcdef" }, cb)`,
    `"auths": {"https://index.docker.io/v1/": {"auth": "${M}dXNlcjpwYXNz=="}}`,
    `_auth=${M}abcdefgh`,
    `basic_auth: 'admin:${M}pw'`,
    // YAML, compose and .properties values that look like member chains.
    `password: Winter2024.${M}`,
    `  password: secret.${M}`,
    `  password: secret.${M}  # prod`,
    `      POSTGRES_PASSWORD: Winter.${M}x`,
    `   12    password: Winter.${M}x`,
    `- password: Winter.${M}x`,
    `spring.datasource.password=Winter.${M}x`,
    `  client_secret: abc123.${M}xyz`,
    `API_KEY: ${M}abcdef.ghij`,
    `password = Winter2024.${M}`,
    // Evidence cut off before the closing quote.
    `const dbPassword = "Super${M}SecretPasswordThatIsCutOffBy120`,
    `{ password: '${M}abcdefgh`,
  ];
  for (const line of leaks) {
    const { text, redacted } = redactSecrets(line);
    assert.ok(!text.includes(M), `leaked: ${text}`);
    assert.equal(redacted, true, line);
  }
  // Short numbers stay code, except under a password name.
  for (const line of ['password: 12345', '  pin_password: 4821', 'DB_SECRET: 90210']) {
    assert.ok(!/\d{4}/.test(redactSecrets(line).text), line);
  }
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
    // `auth` settings and code, as opposed to `auth` credentials.
    'const options = { hostname, auth: requireAuth };',
    "server.route({ method: 'GET', path: '/me', options: { auth: 'session' } });",
    'auth: authOptions',
    'r = requests.get(url, auth=(user, password))',
    'auth = HTTPBasicAuth(user, password)',
    'auth = "Basic " + credentials',
    "grant_type = 'urn:ietf:params:oauth:grant-type:jwt-bearer'",
    // A quote that ends a string is not the start of a value.
    'print("shlex: token=" + repr(raw))',
    "def unix_getpass(prompt='Password: ', stream=None):",
    // Member chains in code, including at the end of a line.
    'password = settings.DB_PASSWORD',
    'self.secret = config.secret',
    '  password: user.password,',
    'consumer_name="launchpad", access_token=self.token',
    '  max_tokens: 4096',
    'passwordResetExpiry: 3600,',
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
    pair: String.raw`secret = 'ab\cd${M}'`,
    cut: `password = 'abc${M}`,
    a: 'postgres://u:',
    b: 'x@host',
  });
  const { text } = redactSecrets(json);
  assert.ok(!text.includes(M), text);
  const parsed = JSON.parse(text) as Record<string, string>;
  assert.equal(parsed.a, 'postgres://u:', 'a URL pattern never joins two strings');
  assert.equal(parsed.b, 'x@host');
});
