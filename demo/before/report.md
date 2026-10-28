# Proof of risk: buildwithdesi/vibeaudit-2-demo-app

Scanned https://github.com/buildwithdesi/vibeaudit-2-demo-app on 2026-10-27 (version 90357d5).

## The short version

This is a first pass. The scanner flagged 16 places across 9 kinds of problem. The 5 kinds below matter most. Nothing here has been checked yet for whether an attacker can really use it. To get a risk rating and proof for each item, run: `node src/cli.ts reason runs/20261027T231844Z-buildwithdesi-vibeaudit-2-demo-app-4012`.

**Fix first:** passwords and keys sitting in the code, then someone can rewrite your database commands.

| Problem | Places | How sure we are | What it means |
|---|---|---|---|
| Passwords and keys sitting in the code | 3 | not checked yet | A password or API key is written into the code, so anyone who can read the code can use it. |
| Someone can rewrite your database commands | 2 | not checked yet | User input is pasted into a database query, so a visitor can rewrite the query and read or delete data. |
| Anyone can reach things that should need a login | 2 | not checked yet | An endpoint does not check who is asking, so anyone can read or change data that should be private. |
| Someone can run commands on your server | 1 | not checked yet | User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server. |
| Someone can read files they should not see | 1 | not checked yet | User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder. |

## Passwords and keys sitting in the code

A password or API key is written into the code, so anyone who can read the code can use it. (Secrets in code)

### server/config.js, line 8

**What the rule found:** Database URL with credentials found in source code.

(The secret itself is hidden in this report for safety.)

**Standard fix:** Move this Database URL with credentials to an environment variable. Add the variable to .env (git-ignored) and reference it via process.env.YOUR_KEY_NAME. Never commit secrets to source control.

_Not checked for exploitability on this scan._

### server/config.js, line 7

**What the rule found:** Hardcoded password detected.

(The secret itself is hidden in this report for safety.)

**Standard fix:** Move credentials to environment variables. Use process.env or a secrets manager. Never store passwords or connection strings in source code.

_Not checked for exploitability on this scan._

## Someone can rewrite your database commands

User input is pasted into a database query, so a visitor can rewrite the query and read or delete data. (Database injection)

### routes/users.js, line 9

**What the rule found:** SQL query built with template-literal interpolation — user input can rewrite the query.

```
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
```

**Standard fix:** Use parameterized queries / prepared statements. Pass values as a separate argument, never build the SQL string with `+` or `${}`. Examples: pg — client.query("SELECT * FROM users WHERE id = $1", [id]); mysql2 — conn.execute("SELECT * FROM users WHERE id = ?", [id]); Prisma/Drizzle — use the query builder or sql`...${id}` tagged templates that bind safely.

_Not checked for exploitability on this scan._

### routes/users.js, line 15

**What the rule found:** SQL query built with string concatenation — user input can rewrite the query.

```
await db.query('DELETE FROM users WHERE id = ' + req.params.id);
```

**Standard fix:** Use parameterized queries / prepared statements. Pass values as a separate argument, never build the SQL string with `+` or `${}`. Examples: pg — client.query("SELECT * FROM users WHERE id = $1", [id]); mysql2 — conn.execute("SELECT * FROM users WHERE id = ?", [id]); Prisma/Drizzle — use the query builder or sql`...${id}` tagged templates that bind safely.

_Not checked for exploitability on this scan._

## Anyone can reach things that should need a login

An endpoint does not check who is asking, so anyone can read or change data that should be private. (Missing authorization)

### routes/users.js, line 9

**What the rule found:** Function "<anonymous>" uses a user-supplied ID without verifying ownership in the same function scope.

```
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.params.id}`);
```

**Standard fix:** After extracting the ID, verify ownership within the same function: "if (resource.userId !== session.user.id) return 403".

_Not checked for exploitability on this scan._

### routes/users.js, line 15

**What the rule found:** Function "<anonymous>" uses a user-supplied ID without verifying ownership in the same function scope.

```
await db.query('DELETE FROM users WHERE id = ' + req.params.id);
```

**Standard fix:** After extracting the ID, verify ownership within the same function: "if (resource.userId !== session.user.id) return 403".

_Not checked for exploitability on this scan._

## Someone can run commands on your server

User input reaches a shell command or a code evaluator, so a visitor can run their own commands on the server. (Command and code injection)

### routes/network.js, line 9

**What the rule found:** exec() runs a shell command built from interpolated input — if any of it is user-controlled, that's remote code execution (a "; rm -rf" away).

```
exec(`ping -c 1 ${req.query.host}`, (error, stdout) => {
```

**Standard fix:** Never build a shell command from input. Use execFile()/spawn() with the program and an ARGUMENT ARRAY (no `shell: true`) so args can't break out: `execFile("convert", [userFile, out])`. If a value must reach a shell, strictly allowlist it.

_Not checked for exploitability on this scan._

## Someone can read files they should not see

User input picks which file the server opens, so a visitor can read or overwrite files outside the intended folder. (File path traversal)

### routes/files.js, line 10

**What the rule found:** Function "<anonymous>" uses user input in a file system operation without path sanitization.

```
res.sendFile(path.join(UPLOADS, req.query.file));
```

**Standard fix:** Use path.basename() to strip directory components, then verify: "if (!resolved.startsWith(ALLOWED_DIR)) return 403".

_Not checked for exploitability on this scan._

## How this report was made

- An automated scan with 104 checks over 9 files (@jackdog668/vibeaudit 1.4.0).
- Secrets in the scanned code were masked before any of it was read by a model or written here.
