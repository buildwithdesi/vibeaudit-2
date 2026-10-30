# Proof of risk: buildwithdesi/vibeaudit-2-demo-app

Scanned https://github.com/buildwithdesi/vibeaudit-2-demo-app on 2026-10-28 (commit 90357d5).

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

**What could happen:** Anyone on the internet can type a trick address into the user lookup and see private details for every customer. If that leaks, customers lose trust and the business can face legal and reputation damage.

**How it happens (for your developer):**

1. An unauthenticated visitor sends GET /users/<payload> which Express forwards to usersRouter.
2. The handler takes req.params.id and pastes it straight into SQL text with template-literal interpolation.
3. The built string is passed to db.query and executed, so crafted input rewrites the WHERE clause to return other users' rows.

**The proof, in the code:**

- `server/index.js`

  ```
  app.use('/users', usersRouter);
  ```
- `routes/users.js:8`

  ```
  usersRouter.get('/:id', async (req, res) => {
  ```
- `routes/users.js:9`

  ```
  const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
  ```
- `server/index.js`

  ```
  app.use(express.json());
  ```

**How far it reaches:** many users.

**Smallest fix (for your developer):** Replace string interpolation with a parameterized query like db.query('SELECT * FROM users WHERE id = $1', [req.params.id]) and validate that id is the expected format.

### routes/users.js, line 15

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can delete one account or every account at once with a crafted web address. Losing all user accounts at once would shut down your service and destroy customer trust.

**How it happens (for your developer):**

1. Attacker sends DELETE request to /users/<payload> with SQL syntax in the id path segment.
2. Express forwards request to usersRouter DELETE /:id handler with attacker value in req.params.id.
3. Handler concatenates req.params.id directly into DELETE statement string.
4. Database executes modified DELETE, deleting rows beyond the single targeted id.

**The proof, in the code:**

- `server/index.js`

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

**Smallest fix (for your developer):** Use a parameterized query such as db.query('DELETE FROM users WHERE id = $1', [req.params.id]) and reject non-numeric ids.

## Anyone can reach things that should need a login

An endpoint does not check who is asking, so anyone can read or change data that should be private. (Missing authorization)

### routes/users.js, line 9

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can view any customer's account information just by changing the number at the end of the address, with no password needed. That can expose your customers' private information and destroy trust in your business.

**How it happens (for your developer):**

1. Attacker sends GET request to /users/123 and substitutes any victim ID to request that account.
2. Server reads req.params.id and uses it directly in the SELECT query with no ownership check in the handler.
3. Server returns the matching user row as JSON directly to the attacker.

**The proof, in the code:**

- `server/index.js`

  ```
  app.use('/users', usersRouter);
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

**Smallest fix (for your developer):** Add authentication to the /users routes and verify req.params.id matches the authenticated user (or admin role) before querying, using a parameterized query.

### routes/users.js, line 15

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can delete any customer account just by guessing its number, with no login needed. If abused, customers would be locked out and lose trust, leaving you with recovery work and lost business.

**How it happens (for your developer):**

1. An anonymous client sends DELETE /users/<any-id> with an attacker-chosen id.
2. Express forwards it via app.use('/users', usersRouter) to the delete handler with only express.json() and no auth check.
3. The handler runs DELETE FROM users with req.params.id directly and returns 204 without verifying ownership.

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
- `server/index.js:9`

  ```
  app.use('/users', usersRouter);
  ```

**How far it reaches:** many users.

**Smallest fix (for your developer):** Require login on DELETE /users/:id and only allow it when the caller owns that id or has an admin role, rejecting others with 403.

## Someone can run commands on your server

User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server. (Command and code injection)

### routes/network.js, line 9

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can trick this check-up tool into running any computer command they choose on your server. That means they could steal information, delete things, or take over the machine that runs your business.

**How it happens (for your developer):**

1. Attacker issues GET /network/ping with a malicious host query value.
2. Server interpolates req.query.host directly into a shell string passed to exec.
3. Exec runs the attacker-influenced string in a shell and returns command output in the response.

**The proof, in the code:**

- `routes/network.js:8`

  ```
  networkRouter.get('/ping', (req, res) => {
  ```
- `routes/network.js:9`

  ```
  exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {
  ```
- `server/index.js`

  ```
  app.use('/network', networkRouter);
  ```
- `routes/network.js:11`

  ```
  res.type('text').send(stdout);
  ```

**How far it reaches:** the whole app and everyone who uses it.

**Smallest fix (for your developer):** Replace exec with execFile without a shell and pass host as a separate argument after validating it as an IP or hostname.

## Someone can read files they should not see

User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder. (File path traversal)

### routes/files.js, line 10

**Verdict:** Confirmed. The full path is visible in the code. Confidence: high.

**Who can do this:** anyone on the internet, no account needed.

**What could happen:** Anyone on the internet can trick the download link into giving them private files from the server without needing a password. This matters because stolen private files can be used to break in further or expose your customers.

**How it happens (for your developer):**

1. Attacker sends anonymous GET to /files/download with file set to a traversal sequence like ../../etc/passwd.
2. Server joins that attacker-controlled query value directly onto the uploads folder with path.join.
3. Server returns the contents of the resulting out-of-bounds file with res.sendFile.

**The proof, in the code:**

- `routes/files.js:9`

  ```
  filesRouter.get('/download', (req, res) => {
  ```
- `server/index.js:14`

  ```
  app.use('/files', filesRouter);
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

**Smallest fix (for your developer):** Resolve the requested path and reject it unless it stays inside UPLOADS, e.g. allow only a basename or check resolved path starts with UPLOADS.

## Checked and ruled out

The scanner flagged these too. A reasoning model read the code around each one and found no way in. They are kept here so you can see the reasoning, not because they need fixing today.

### Passwords and keys sitting in the code

A password or API key is written into the code, so anyone who can read the code can use it. (Secrets in code)

#### server/config.js, line 8

**Verdict:** Not exploitable as the code stands. Confidence: high.

**Who can do this:** no one, based on what the code shows.

**What could happen:** This file holds a pretend password for a pretend database that cannot be reached from the internet, so no one can use it to steal anything. You should still move passwords out of code so a real password never gets copied into the same place later.

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
  // repos: credentials typed straight into a config module.
  ```

**Smallest fix (for your developer):** Remove the hardcoded password and connectionString from server/config.js and load them from environment variables instead.

#### server/config.js, line 7

**Verdict:** Not exploitable as the code stands. Confidence: high.

**Who can do this:** no one, based on what the code shows.

**What could happen:** This password written in the code is pretend and does not protect anything real, so an outsider cannot use it to get in. You still want to keep real passwords out of shared code so a future real password is never leaked by accident.

**The proof, in the code:**

- `server/config.js:7`

  ```
    password: '[REDACTED:15]',
  ```
- `server/config.js:1`

  ```
  // Planted class: secrets in code. These values are fake and the app never
  // connects anywhere, but the pattern is exactly what shows up in vibe-coded
  ```
- `server/config.js:5`

  ```
    host: 'db.internal',
  ```

**Smallest fix (for your developer):** Remove the hard-coded password and connection string from source and load them from environment variables.

## After the patch

Muse Spark patched 6 findings in 4 places on branch `vibeaudit2/patch-20261028T011454Z-buildwithdesi-vibeaudit-2-demo-app-a578`. The scan ran again on the patched code: 4 fixed, 2 still flagged by a rule, 0 new. The app's own tests: passed (run on this computer, not in a sealed container). Result: green, meaning every patched problem is gone or was judged closed, and the app's own tests pass.

The rules are pattern checks, so a fix they do not recognize keeps a flag. A reasoning model reviewed each still-flagged spot on the patched code: 2 of 2 judged closed.

- Not exploitable as the code stands. This profile page now blocks anyone trying to view another person's account unless they are that person or an approved manager. Your users' private information stays private, which protects trust in your business.
- Not exploitable as the code stands. This alarm is now a false alarm because the app checks that you can only delete your own account unless you are an admin. Your customers accounts are safe from being deleted by strangers, so no urgent action is needed.

| Problem | Patched | Fixed | Still flagged | Judged closed on review |
|---|---|---|---|---|
| Someone can rewrite your database commands | 2 | 2 | 0 | 0 |
| Anyone can reach things that should need a login | 2 | 0 | 2 | 2 |
| Someone can run commands on your server | 1 | 1 | 0 | 0 |
| Someone can read files they should not see | 1 | 1 | 0 | 0 |

The full diff is in `patch.diff` next to this report.

## How this report was made

- An automated scan with 104 checks over 9 files (@jackdog668/vibeaudit 1.4.0).
- Reasoning: muse-spark-1.3 judged 9 findings. 10 model calls, $0.16.
- Secrets in the scanned code were masked before any of it was read by a model or written here.
