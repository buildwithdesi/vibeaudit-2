# Proof of risk: buildwithdesi/vibeaudit-2-demo-app

Scanned https://github.com/buildwithdesi/vibeaudit-2-demo-app on 2026-10-27 (commit 90357d5).

## The short version

The scanner raised 16 flags on 11 lines. A reasoning model looked closely at 9 of them, in the 5 kinds of problem that matter most. 6 are confirmed or likely exploitable, on 4 lines in 3 files. Each one below comes with the lines of code that prove it and the smallest fix.

**Fix first:** Someone can rewrite your database commands. **Next:** Anyone can reach things that should need a login.

| Problem | Flags | How sure we are | What it means |
|---|---|---|---|
| Someone can rewrite your database commands | 2 | 2 of 2 checked are confirmed or likely | User input is pasted into a database query, so a visitor can rewrite the query and read or delete data. |
| Anyone can reach things that should need a login | 2 | 2 of 2 checked are confirmed or likely | An endpoint does not check who is asking, so anyone can read or change data that should be private. |
| Someone can run commands on your server | 1 | 1 of 1 checked is confirmed or likely | User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server. |
| Someone can read files they should not see | 1 | 1 of 1 checked is confirmed or likely | User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder. |
| Passwords and keys sitting in the code | 3 | 0 of 3 checked are confirmed or likely | A password or API key is written into the code, so anyone who can read the code can use it. |

**Also serious, not covered below:** Your server can be made to call other systems (routes/preview.js, line 8). Details are in findings.json.

## Someone can rewrite your database commands

User input is pasted into a database query, so a visitor can rewrite the query and read or delete data. (Database injection)

### routes/users.js, line 9

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can ask for one user account and trick the system into showing private details for many other accounts. Losing control of customer details like this can break trust and create legal and money problems for the business.

**How it happens (for your developer):**

1. Attacker sends unauthenticated GET request to /users/:id with SQL payload in the id segment.
2. Express forwards the request to the usersRouter handler mounted at /users with no auth check.
3. Handler pastes req.params.id directly into SQL text and executes it via db.query then returns the result.

**The proof, in the code:**

- `server/index.js:12`

  ```
  app.use('/users', usersRouter);
  ```
- `routes/users.js:7`

  ```
  // Anyone can call this, and the id is pasted straight into the SQL text.
  ```
- `routes/users.js:8`

  ```
  usersRouter.get('/:id', async (req, res) => {
  ```
- `routes/users.js:9`

  ```
  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  ```

**How far it reaches:** many users.

**Smallest fix (for your developer):** Use a parameterized query such as db.query('SELECT * FROM users WHERE id = $1', [req.params.id]) and validate id is numeric.

### routes/users.js, line 15

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can delete any customer account by sending a specially shaped web address, and can even wipe out every account at once. Losing all user accounts would break trust with customers and shut down the business.

**How it happens (for your developer):**

1. Attacker sends an unauthenticated DELETE request to /users/:id with a crafted id value.
2. The delete handler concatenates req.params.id directly into the DELETE statement with no parameterization.
3. The database executes the rewritten query, allowing deletion of arbitrary or all users.

**The proof, in the code:**

- `server/index.js:12`

  ```
  app.use('/users', usersRouter);
  ```
- `routes/users.js:14`

  ```
  usersRouter.delete('/:id', async (req, res) => {
  ```
- `routes/users.js:15`

  ```
  await db.query('DELETE FROM users WHERE id = ' + req.params.id);
  ```
- `routes/users.js:13`

  ```
  // Anyone can delete any account. No check on who is asking.
  ```

**How far it reaches:** many users.

**Smallest fix (for your developer):** Use a parameterized query such as db.query('DELETE FROM users WHERE id = $1', [req.params.id]) and require authorization for deletes.

## Anyone can reach things that should need a login

An endpoint does not check who is asking, so anyone can read or change data that should be private. (Missing authorization)

### routes/users.js, line 9

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone can change the number in the profile address to see another person's private account information. This loss of privacy can drive customers away and create legal costs for the business.

**How it happens (for your developer):**

1. Attacker sends an unauthenticated GET request to /users/2 to request another user's record.
2. Server uses the request id value directly in the database lookup without checking who owns it.
3. Server returns the other user's database row as JSON to the attacker.

**The proof, in the code:**

- `routes/users.js:7`

  ```
  // Anyone can call this, and the id is pasted straight into the SQL text.
  ```
- `routes/users.js:8`

  ```
  usersRouter.get('/:id', async (req, res) => {
  ```
- `routes/users.js:9`

  ```
  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  ```
- `routes/users.js:10`

  ```
  res.json(rows[0] ?? null);
  ```

**How far it reaches:** many users.

**Smallest fix (for your developer):** Require login and verify the requested id belongs to the logged-in user before querying, rejecting other ids with forbidden.

### routes/users.js, line 15

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can delete any customer account just by guessing its number, with no password needed. This would lock real users out and quickly destroy trust in your business.

**How it happens (for your developer):**

1. Attacker sends an anonymous DELETE request to /users/<victim-id>.
2. Express delivers it to the users router mounted at /users with only JSON parsing and no login check.
3. Handler deletes the database row for the attacker-supplied ID without verifying ownership.

**The proof, in the code:**

- `routes/users.js:14`

  ```
  usersRouter.delete('/:id', async (req, res) => {
  ```
- `routes/users.js:15`

  ```
  await db.query('DELETE FROM users WHERE id = ' + req.params.id);
  ```
- `routes/users.js:13`

  ```
  // Anyone can delete any account. No check on who is asking.
  ```
- `server/index.js:12`

  ```
  app.use('/users', usersRouter);
  ```

**How far it reaches:** many users.

**Smallest fix (for your developer):** Require authentication on DELETE /users/:id and verify the caller owns the ID or has an admin role, returning 403 otherwise.

## Someone can run commands on your server

User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server. (Command and code injection)

### routes/network.js, line 9

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can send a crafted web address to this ping feature and make the server run their own commands. That matters because they could steal information, break the service, or take over the computer running your app.

**How it happens (for your developer):**

1. Attacker sends unauthenticated GET request to /network/ping with a hostile host query value containing shell metacharacters.
2. Server handler interpolates req.query.host directly into a shell command string with no validation or escaping.
3. exec() runs the combined string in a system shell, executing the attacker's injected commands with server privileges.

**The proof, in the code:**

- `server/index.js:13`

  ```
  app.use('/network', networkRouter);
  ```
- `routes/network.js:8`

  ```
  networkRouter.get('/ping', (req, res) => {
  ```
- `routes/network.js:9`

  ```
  exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {
  ```

**How far it reaches:** the whole app and everyone who uses it.

**Smallest fix (for your developer):** Replace exec() with execFile('ping', ['-c','1', host]) so host is passed as an argument without a shell, and validate host as IP or hostname.

## Someone can read files they should not see

User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder. (File path traversal)

### routes/files.js, line 10

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can trick the download link to read private files from your server. This matters because leaked secrets and user files could be used to break in further and harm your users.

**How it happens (for your developer):**

1. Attacker sends GET /files/download with file set to a traversal payload such as ../../etc/passwd.
2. Handler joins attacker-controlled req.query.file onto UPLOADS with no sanitization or allowlist.
3. Express returns the file at the escaped path via res.sendFile.

**The proof, in the code:**

- `server/index.js:14`

  ```
  app.use('/files', filesRouter);
  ```
- `routes/files.js:9`

  ```
  filesRouter.get('/download', (req, res) => {
  ```
- `routes/files.js:6`

  ```
  const UPLOADS = path.join(process.cwd(), 'uploads');
  ```
- `routes/files.js:10`

  ```
  res.sendFile(path.join(UPLOADS, req.query.file));
  ```

**How far it reaches:** the whole app and everyone who uses it.

**Smallest fix (for your developer):** Resolve the joined path and reject unless it stays inside UPLOADS, or only allow known filenames via path.basename allowlist.

## Checked and ruled out

The scanner flagged these too. A reasoning model read the code around each one and found no way in. They are kept here so you can see the reasoning, not because they need fixing today.

### Passwords and keys sitting in the code

A password or API key is written into the code, so anyone who can read the code can use it. (Secrets in code)

#### server/config.js, line 8

**Verdict:** Not exploitable as the code stands. Confidence: high.

**Who can do this:** no one, based on what the code shows.

**What could happen:** The password written in this file is fake and cannot be used to open anything, so your users and business are not at risk from it. It is still worth cleaning up because leaving pretend secrets in code teaches a habit that could one day expose a real password and customer information.

**The proof, in the code:**

- `server/config.js:8`

  ```
  connectionString: 'postgres://app:[REDACTED]@db.internal:5432/app',
  ```
- `server/config.js:5`

  ```
  host: 'db.internal',
  ```
- `server/config.js:2`

  ```
  // connects anywhere, but the pattern is exactly what shows up in vibe-coded
  ```

**Smallest fix (for your developer):** Remove the hard-coded password and connection string and load database credentials from environment variables, even in demo code.

#### server/config.js, line 7

**Verdict:** Not exploitable as the code stands. Confidence: high.

**Who can do this:** no one, based on what the code shows.

**What could happen:** No one can use this password to break in because it is a fake placeholder with no real database behind it. You should still keep passwords out of code because copying this habit into a real product would give strangers full access to your business data.

**The proof, in the code:**

- `server/config.js:7`

  ```
      password: '[REDACTED:15]',
  ```
- `server/config.js:1`

  ```
  // Planted class: secrets in code. These values are fake and the app never
  ```
- `server/config.js:2`

  ```
  // connects anywhere, but the pattern is exactly what shows up in vibe-coded
  ```
- `server/config.js:5`

  ```
      host: 'db.internal',
  ```

**Smallest fix (for your developer):** Remove the hardcoded password and connection string from server/config.js and load them from environment variables at startup.

## After the patch

Muse Spark patched 6 findings in 4 places on branch `vibeaudit2/patch-20261027T231844Z-buildwithdesi-vibeaudit-2-demo-app-4012`. The scan ran again on the patched code: 4 fixed, 2 still flagged by a rule, 0 new. The app's own tests: passed (run on this computer, not in a sealed container). Result: green, meaning every patched problem is gone or was judged closed, and the app's own tests pass.

The rules are pattern checks, so a fix they do not recognize keeps a flag. A reasoning model reviewed each still-flagged spot on the patched code: 2 of 2 judged closed.

- Not exploitable as the code stands. Someone who is logged in can now only see their own profile, and any request for someone else's details is blocked. Your users' private information stays private, so there is no extra risk from this page.
- Not exploitable as the code stands. An outsider cannot delete another person's account because the system checks ownership before deleting. This means your customers are protected from having their accounts removed by someone else.

| Problem | Patched | Fixed | Still flagged | Judged closed on review |
|---|---|---|---|---|
| Someone can rewrite your database commands | 2 | 2 | 0 | 0 |
| Anyone can reach things that should need a login | 2 | 0 | 2 | 2 |
| Someone can run commands on your server | 1 | 1 | 0 | 0 |
| Someone can read files they should not see | 1 | 1 | 0 | 0 |

The full diff is in `patch.diff` next to this report.

## How this report was made

- An automated scan with 104 checks over 9 files (@jackdog668/vibeaudit 1.4.0).
- Reasoning: muse-spark-1.3 judged 9 findings. 10 model calls, $0.17.
- Secrets in the scanned code were masked before any of it was read by a model or written here.
