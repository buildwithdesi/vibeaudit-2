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
  4. triage     Muse Glimmer 30B (open weights) drops test fixtures, dead code, mitigated paths. Optional: needs TRIAGE_* set
  5. reason     Muse Spark 1.3 judges exploitability per finding, inside a per-file budget
  6. report     proof-of-risk report for the top five classes, written for founders
  7. patch      Muse Spark edits (default) or Muse Code (--backend muse-code) on a sandbox branch, re-scan, project tests
```

| Stage | Status |
|---|---|
| 1 to 3 | Built. Tested on the seeded app and on OWASP NodeGoat. |
| 4 to 5 | Built and run live. Muse Spark judged the demo app: 9 verdicts, 10 calls, $0.17. See `demo/after/report.md`. |
| 6 | Built. `report <run>` writes `report.md`. |
| 7 | Built and green live with the Muse Spark backend on the demo repo: 4 patched, tests passed, $0.07. Muse Code backend wired, not yet run here. |

## Meta tooling in this repo

| Model | Role | Where | On by default | Data tier |
|---|---|---|---|---|
| Muse Spark 1.3 (Model API) | Repository map and exploitability verdicts | `src/reason/orchestrate.ts`, prompts in `src/reason/prompts/` | Yes, with `META_API_KEY` | Standard only. Contributor-tier model ids are refused in `src/reason/meta-client.ts` |
| Muse Spark 1.3 (Model API) | Patch edits (`--backend api`, the default) | `src/patch/backends.ts`, `apiPatch` | Yes, with `META_API_KEY` | Standard only |
| Muse Glimmer 30B (open weights, hosted) | Triage before Spark | `src/reason/prompts/triage.ts`, client in `src/reason/meta-client.ts` | No. Set `TRIAGE_BASE_URL`, `TRIAGE_API_KEY`, `TRIAGE_MODEL` (OpenRouter `meta/muse-glimmer-30b` works) | Provider's terms |
| Muse Code (agent CLI) | Patch backend `--backend muse-code` | `src/patch/backends.ts`, `museCodePatch` | No. Must be asked for, because it runs an agent inside the repository | Forced to `--contributor-mode off` |

The v1 engine is prior work. `scan` wraps it unchanged; the new work starts at `normalize`.

## Quick start

Needs Node 24 (22.18 or newer works) and git. Docker is optional and only used to run a patched project's tests.

```bash
npm ci --ignore-scripts
npm run scan -- https://github.com/OWASP/NodeGoat
npm run scan -- examples/seeded-app
node src/cli.ts reason runs/<run id> --dry-run   # writes every prompt, no API call
node src/cli.ts reason runs/<run id>             # needs META_API_KEY in .env
node src/cli.ts report runs/<run id>
node src/cli.ts patch runs/<run id> --run-tests   # sandbox branch, re-scan, project tests
node src/cli.ts audit https://github.com/OWASP/NodeGoat   # scan, reason, report in one go (patch is separate)
node src/cli.ts rules
```

Demo target: https://github.com/buildwithdesi/vibeaudit-2-demo-app. Recorded before and after runs live in `demo/`.

One live verdict from `demo/after/report.md`, unedited:

> **Verdict:** Confirmed. The full path is visible in the code. Confidence 95%.
> **Who can do this:** anyone on the internet, no account needed.
> **What could happen:** Anyone on the internet can ask for one user account and trick the system into showing private details for many other accounts. Losing control of customer details like this can break trust and create legal and money problems for the business.

And the patch loop on the same repo: 4 findings patched by Muse Spark, re-scan clean except 2 rule flags the model re-judged closed on the patched code, project tests passed, green, 7 cents.

Each scan writes `runs/<run id>/` with the clone, `engine-output.json`, `findings.json`, `manifest.json` and `summary.md`. The `runs/` folder is never committed.

Copy `.env.example` to `.env` for the reasoning stages. The Meta Model API key comes from https://dev.meta.ai.

## Security posture

- A cloned repository is hostile input. Git hooks point at an empty folder, symlinks are off, credential prompts are off, and the URL always follows `--`. The scan stage only reads files.
- A scanned repository cannot hide its findings. Its own `.vibe-audit.json` and its inline `vibe-audit-ignore` comments apply only when you pass `--trust-target-config`; engine 1.5.0 enforces this and `tests/engine.test.ts` checks both. This repository's self-scan trusts its own comments, because they are ours. The manifest records which mode ran.
- Credential-shaped values are masked before any code context is written to disk or sent to a model.
- Code sent to a model is wrapped as untrusted data. Prompts state that instructions inside the code are to be ignored, and every model answer is constrained by a JSON schema and validated again with Zod.
- The patch loop never lets a model write files directly through the API path: every edit is an exact search-and-replace that must match once, only the finding's own file may change, `.git`, `.github`, package manifests, lockfiles and env files are off limits, a plan that adds dependencies is rejected, and the patch lands on a sandbox branch in the pipeline's own copy. A local folder is copied first and never patched in place.
- The project's tests run on a copy without `.git`, in a Docker container with no network, no root and no capabilities. Running them on this machine needs `--allow-local-tests`.
- Child processes that touch a scanned repository (engine, git, npm, Docker, Muse Code) get a scrubbed environment: no API keys, an empty npm config, install scripts off.
- "Green" requires the re-scan to be clean and the project's tests to have run and passed. Without `--run-tests` the best result is "re-scan clean".
- Muse Spark runs in Standard mode only. The cheaper Contributor tier is never used because scanned code may belong to a customer.

## Develop

```bash
npm run verify      # typecheck, lint, tests
npm run build       # dist/
npm run audit:self  # the v1 engine scans this repository
```

## License

MIT. See `LICENSE`.
