# Proof of risk: buildwithdesi/vibeaudit-2-demo-app

Scanned https://github.com/buildwithdesi/vibeaudit-2-demo-app at commit 90357d5dbb on 2026-10-27.

## The short version

The scanner flagged 16 places across 9 classes. The 5 classes below matter most. The reasoning stage has not run on this scan yet, so each item shows what the rule found and the standard fix. Run the reasoning stage to get exploitability verdicts with proof.

| Class | Findings | Confirmed or likely | What it means |
|---|---|---|---|
| Secrets in code | 3 | not judged | A password or API key is written into the code, so anyone who can read the code can use it. |
| Database injection | 2 | not judged | User input is pasted into a database query, so a visitor can rewrite the query and read or delete data. |
| Missing authorization | 2 | not judged | An endpoint does not check who is asking, so anyone can read or change data that should be private. |
| Command and code injection | 1 | not judged | User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server. |
| File path traversal | 1 | not judged | User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder. |

## Secrets in code

A password or API key is written into the code, so anyone who can read the code can use it.

### server/config.js, line 8

**What the rule found:** Database URL with credentials found in source code.

```
post...(redacted)...5432
```

**Standard fix:** Move this Database URL with credentials to an environment variable. Add the variable to .env (git-ignored) and reference it via process.env.YOUR_KEY_NAME. Never commit secrets to source control.

_Not judged by the reasoning stage on this scan._

### server/config.js, line 7

**What the rule found:** Hardcoded password detected.

```
***REDACTED***
```

**Standard fix:** Move credentials to environment variables. Use process.env or a secrets manager. Never store passwords or connection strings in source code.

_Not judged by the reasoning stage on this scan._

### server/config.js, line 8

**What the rule found:** Database connection string with credentials detected.

```
postgres://app:[REDACTED]@db.internal:5432
```

**Standard fix:** Move credentials to environment variables. Use process.env or a secrets manager. Never store passwords or connection strings in source code.

_Not judged by the reasoning stage on this scan._

## Database injection

User input is pasted into a database query, so a visitor can rewrite the query and read or delete data.

### routes/users.js, line 9

**What the rule found:** SQL query built with template-literal interpolation — user input can rewrite the query.

```
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
```

**Standard fix:** Use parameterized queries / prepared statements. Pass values as a separate argument, never build the SQL string with `+` or `${}`. Examples: pg — client.query("SELECT * FROM users WHERE id = $1", [id]); mysql2 — conn.execute("SELECT * FROM users WHERE id = ?", [id]); Prisma/Drizzle — use the query builder or sql`...${id}` tagged templates that bind safely.

_Not judged by the reasoning stage on this scan._

### routes/users.js, line 15

**What the rule found:** SQL query built with string concatenation — user input can rewrite the query.

```
await db.query('DELETE FROM users WHERE id = ' + req.params.id);
```

**Standard fix:** Use parameterized queries / prepared statements. Pass values as a separate argument, never build the SQL string with `+` or `${}`. Examples: pg — client.query("SELECT * FROM users WHERE id = $1", [id]); mysql2 — conn.execute("SELECT * FROM users WHERE id = ?", [id]); Prisma/Drizzle — use the query builder or sql`...${id}` tagged templates that bind safely.

_Not judged by the reasoning stage on this scan._

## Missing authorization

An endpoint does not check who is asking, so anyone can read or change data that should be private.

### routes/users.js, line 9

**What the rule found:** Function "<anonymous>" uses a user-supplied ID without verifying ownership in the same function scope.

```
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
```

**Standard fix:** After extracting the ID, verify ownership within the same function: "if (resource.userId !== session.user.id) return 403".

_Not judged by the reasoning stage on this scan._

### routes/users.js, line 15

**What the rule found:** Function "<anonymous>" uses a user-supplied ID without verifying ownership in the same function scope.

```
await db.query('DELETE FROM users WHERE id = ' + req.params.id);
```

**Standard fix:** After extracting the ID, verify ownership within the same function: "if (resource.userId !== session.user.id) return 403".

_Not judged by the reasoning stage on this scan._

## Command and code injection

User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server.

### routes/network.js, line 9

**What the rule found:** exec() runs a shell command built from interpolated input — if any of it is user-controlled, that's remote code execution (a "; rm -rf" away).

```
exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {
```

**Standard fix:** Never build a shell command from input. Use execFile()/spawn() with the program and an ARGUMENT ARRAY (no `shell: true`) so args can't break out: `execFile("convert", [userFile, out])`. If a value must reach a shell, strictly allowlist it.

_Not judged by the reasoning stage on this scan._

## File path traversal

User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder.

### routes/files.js, line 10

**What the rule found:** Function "<anonymous>" uses user input in a file system operation without path sanitization.

```
res.sendFile(path.join(UPLOADS, req.query.file));
```

**Standard fix:** Use path.basename() to strip directory components, then verify: "if (!resolved.startsWith(ALLOWED_DIR)) return 403".

_Not judged by the reasoning stage on this scan._

## How this report was made

- Deterministic scan: @jackdog668/vibeaudit 1.4.0, 104 rules, 9 files.
- Secrets in the scanned code were masked before any of it was read by a model or written here.
