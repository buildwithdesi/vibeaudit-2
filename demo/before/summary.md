# Vibe Audit 2.0 run summary

Target: https://github.com/buildwithdesi/vibeaudit-2-demo-app
Commit: 90357d5dbbab056bc5369d011b1ff2b6db66ee47
Run: 20261027T231844Z-buildwithdesi-vibeaudit-2-demo-app-4012 (2026-10-27T23:18:47.724Z)
Engine: @jackdog668/vibeaudit 1.4.0, 104 of 104 rules run, 9 files scanned

| Severity | Count |
|---|---|
| critical | 11 |
| warning | 4 |
| info | 1 |

## Vulnerability classes

| Class | Findings | Critical | In top 5 |
|---|---|---|---|
| Secrets in code | 3 | 3 | yes |
| Database injection | 2 | 2 | yes |
| Command and code injection | 1 | 1 | yes |
| Missing authorization | 2 | 2 | yes |
| File path traversal | 1 | 1 | yes |
| Server-side request forgery | 1 | 1 |  |
| Unsafe input handling | 1 | 1 |  |
| Weak authentication, sessions, or crypto | 2 | 0 |  |
| Missing hardening | 3 | 0 |  |

## Findings

| Severity | Class | Location | Rule |
|---|---|---|---|
| critical | path-traversal | routes/files.js:10 | path-traversal |
| critical | input-handling | routes/network.js:9 | no-input-validation |
| critical | command-injection | routes/network.js:9 | command-injection |
| critical | ssrf | routes/preview.js:8 | ssrf-vulnerability |
| critical | missing-auth | routes/users.js:9 | idor-vulnerability |
| critical | missing-auth | routes/users.js:15 | idor-vulnerability |
| critical | sql-injection | routes/users.js:9 | sql-injection |
| critical | sql-injection | routes/users.js:15 | sql-injection |
| critical | secrets | server/config.js:8 | exposed-secrets |
| critical | secrets | server/config.js:7 | hardcoded-credentials |
| critical | secrets | server/config.js:8 | hardcoded-credentials |
| warning | hardening-config | .gitignore:1 | missing-gitignore |
| warning | auth-sessions-crypto | routes/preview.js:7 | missing-csrf |
| warning | auth-sessions-crypto | routes/users.js:14 | missing-csrf |
| warning | hardening-config | routes/users.js:9 | no-pagination |
| info | hardening-config | package.json:1 | no-error-monitoring |

Stages: intake=done, engine=done, normalize=done, triage=pending, reasoning=pending, report=pending, patch=pending
