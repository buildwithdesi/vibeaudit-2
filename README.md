# Vibe Audit 2.0

Security audits for AI-generated code that explain the risk in plain language and prove it.

Vibe Audit v1 finds the patterns. 2.0 adds the judgment: a reasoning layer that decides which findings are actually exploitable, writes the proof of risk for a non-security reader, and patches the code on a sandbox branch without breaking the tests.

Built solo by Desmond Baker for the Meta Global AI Developer Hackathon 2026 (Startup track, "Push the Frontier"). Read `CONTRIBUTIONS.md` first: it separates the prior v1 engine from the work built inside the hackathon window.

## Pipeline

```
GitHub URL or folder
  1. intake     strict URL parsing, hardened shallow clone into runs/<id>/repo
  2. engine     @jackdog668/vibeaudit (v1, prior work) runs as a child process, JSON captured
  3. normalize  stable ids, vulnerability classes, masked code context, run manifest
  4. triage     Muse Glimmer 30B (open weights) drops test fixtures, dead code, mitigated paths
  5. reason     Muse Spark 1.3 judges exploitability per finding, inside a per-file budget
  6. report     proof-of-risk report for the top five classes, written for founders
  7. patch      Muse Code patches on a sandbox branch, audit and tests run again
```

| Stage | Status |
|---|---|
| 1 to 3 | Built. Tested on the seeded app and on OWASP NodeGoat. |
| 4 to 5 | Built. `reason <run>` with a dry-run mode; tested against a fake endpoint. First live call waits on API credits. |
| 6 | Built. `report <run>` writes `report.md`. |
| 7 | Planned |

## Quick start

Needs Node 24 and git.

```bash
npm ci --ignore-scripts
npm run scan -- https://github.com/OWASP/NodeGoat
npm run scan -- examples/seeded-app
node src/cli.ts reason runs/<run id> --dry-run   # writes every prompt, no API call
node src/cli.ts reason runs/<run id>             # needs META_API_KEY in .env
node src/cli.ts report runs/<run id>
node src/cli.ts audit https://github.com/OWASP/NodeGoat   # all stages in one go
node src/cli.ts rules
```

Each scan writes `runs/<run id>/` with the clone, `engine-output.json`, `findings.json`, `manifest.json` and `summary.md`. The `runs/` folder is never committed.

Copy `.env.example` to `.env` for the reasoning stages. The Meta Model API key comes from https://dev.meta.ai.

## Security posture

- A cloned repository is hostile input. Git hooks point at an empty folder, symlinks are off, credential prompts are off, and the URL always follows `--`. The scan stage only reads files.
- The scanned repository's own `.vibe-audit.json` is moved aside during the engine run unless you pass `--trust-target-config`, so a repo cannot hide findings through its config. Known gap: engine 1.4.0 still honors inline `vibe-audit-ignore` comments. The manifest records which mode ran.
- Credential-shaped values are masked before any code context is written to disk or sent to a model.
- Code sent to a model is wrapped as untrusted data. Prompts state that instructions inside the code are to be ignored, and every model answer is constrained by a JSON schema and validated again with Zod.
- Muse Spark runs in Standard mode only. The cheaper Contributor tier is never used because scanned code may belong to a customer.

## Develop

```bash
npm run verify      # typecheck, lint, tests
npm run build       # dist/
npm run audit:self  # the v1 engine scans this repository
```

## License

MIT. See `LICENSE`.
