# Vibe Audit 2.0

**A security audit for AI-generated code that explains the risk in plain language, proves it with the code, and patches it.**

One command. A GitHub URL goes in. Out comes a proof-of-risk report written for the founder who shipped the app, not for a security team: what could happen, who can do it, the exact lines that make it true, and the smallest fix. Then a second command patches the confirmed findings on a sandbox branch, scans again, and runs the project's own tests.

```
$ node src/cli.ts audit https://github.com/buildwithdesi/vibeaudit-2-demo-app --budget-usd 1
cloning https://github.com/buildwithdesi/vibeaudit-2-demo-app
running @jackdog668/vibeaudit 1.4.0 (104 rules available)
engine: 16 findings in 9 files (264 ms)
reasoning over 9 of 16 findings in classes: secrets, sql-injection, missing-auth, command-injection, path-traversal
repo map: 5 entry points, 0 auth boundaries ($0.0122)
routes/files.js:10 path-traversal -> confirmed ($0.0114)
routes/network.js:9 command-injection -> confirmed ($0.0148)
routes/users.js:9 sql-injection -> confirmed ($0.0162)
server/config.js:7 hardcoded-credentials -> not-exploitable ($0.0200)
reasoned 9, triage dropped 0, budget capped 0, errors 0, spent $0.1597 over 10 calls
report: runs/<run id>/report.md

$ node src/cli.ts patch runs/<run id> --run-tests
patching 4 findings in classes: secrets, sql-injection, missing-auth, command-injection, path-traversal
routes/files.js:10 path-traversal: 1/1 edits applied ($0.0063)
routes/users.js:9 idor-vulnerability: 2/2 edits applied ($0.0126)
project tests: passed (local)
patch loop GREEN: 4 resolved, 2 still flagged (2 judged closed on review), 0 introduced, tests passed, $0.0880
```

Lines from the recorded run, some left out for length. The full transcripts are `demo/video/transcript-audit.txt` and `demo/video/transcript-patch.txt`.

## The demo run, by the numbers

Every number here comes from the committed records in `demo/after`, one live run on the seeded demo app.

| | |
|---|---|
| Flags from the v1 scanner | 16 |
| Findings Muse Spark 1.3 judged | 9, in 10 calls, $0.17 |
| Confirmed exploitable, with the code that proves it | 6 |
| Fake credentials correctly ruled not exploitable | 3 |
| Patched by Muse Spark on a sandbox branch | 6 findings in 4 places, $0.07 |
| Re-scan of the patched code | 4 gone, 2 still flagged by a rule and re-judged closed |
| The app's own tests after the patch | passed |

One verdict from `demo/after/report.md`, unedited:

> **Verdict:** Confirmed. The full path is visible in the code. Confidence: high.
>
> **Who can do this:** anyone on the internet, no account needed.
>
> **What could happen:** Anyone on the internet can ask for one user account and trick the system into showing private details for many other accounts. Losing control of customer details like this can break trust and create legal and money problems for the business.

Read the whole report: [`demo/after/report.md`](demo/after/report.md). The patch it produced: [`demo/after/patch.diff`](demo/after/patch.diff). The app it ran on: [vibeaudit-2-demo-app](https://github.com/buildwithdesi/vibeaudit-2-demo-app).

## What is new here

Vibe Audit v1 is my open-source scanner from earlier this year. It finds the patterns and is used here unchanged, as a pinned dependency. Everything after the scan is 2.0, built inside the hackathon window: the hardened intake, the reasoning layer that decides which findings an attacker can actually use, the founder-facing report, and the patch loop that has to prove its own work.

Built solo by Desmond Baker for the Meta Global AI Developer Hackathon 2026 (Startup track, "Push the Frontier"), with Claude Code as the coding assistant. `CONTRIBUTIONS.md` separates the prior v1 engine from the hackathon work, line by line.

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
| 4 | Built, not run live. No recorded run had `TRIAGE_*` set: `demo/after/reasoning.json` has `triage: null`. Tested against a stub endpoint only. |
| 5 | Built and run live. Muse Spark judged the demo app: 9 verdicts, 10 calls, $0.17. See `demo/after/report.md`. |
| 6 | Built. `report <run>` writes `report.md`. |
| 7 | Built and green live with the Muse Spark backend on the demo repo: 4 places patched covering 6 findings (4 gone on the re-scan, 2 re-judged closed), tests passed (run locally), $0.07. Muse Code backend built, not run live. |

## Meta tooling in this repo

Only Muse Spark 1.3 has run live. Glimmer triage and the Muse Code backend are built but not run live.

| Model | Role | Where | On by default | Run live | Data tier |
|---|---|---|---|---|---|
| Muse Spark 1.3 (Model API) | Repository map and exploitability verdicts | `src/reason/orchestrate.ts`, prompts in `src/reason/prompts/` | Yes, with `META_API_KEY` | Yes. `demo/after/reasoning.json` | Standard only. Contributor-tier model ids are refused in `src/reason/meta-client.ts` |
| Muse Spark 1.3 (Model API) | Patch edits (`--backend api`, or `auto`, the default, when `META_API_KEY` is set) | `src/patch/backends.ts`, `apiPatch` | Yes, with `META_API_KEY` | Yes. `demo/after/patch.json` | Standard only |
| Muse Glimmer 30B (open weights, hosted) | Triage before Spark | `src/reason/prompts/triage.ts`, client in `src/reason/meta-client.ts` | No. Set `TRIAGE_BASE_URL`, `TRIAGE_API_KEY`, `TRIAGE_MODEL`, for example OpenRouter `meta/muse-glimmer-30b` (untested) | Built, not run live | Provider's terms |
| Muse Code (agent CLI) | Patch backend `--backend muse-code` | `src/patch/backends.ts`, `museCodePatch` | No. Must be asked for, because it runs an agent inside the repository | Built, not run live | Passes `--contributor-mode off`. Whether Muse Code honors it under API-key auth is not confirmed |

The v1 engine is prior work. `scan` wraps it unchanged; the new work starts at `normalize`.

## Quick start

Needs Node 24 (22.18 or newer works) and git. Docker is optional and only used to run a patched project's tests. With Docker running, `--run-tests` runs them in a container, even when `--allow-local-tests` is also given; no recorded run has used that path yet. Without Docker, `--run-tests` skips them and the run cannot go green unless you add `--allow-local-tests`. `--no-docker --allow-local-tests` runs them on this machine either way, which is how the recorded demo ran them.

```bash
npm ci --ignore-scripts
npm run scan -- https://github.com/OWASP/NodeGoat
npm run scan -- examples/seeded-app
node src/cli.ts reason runs/<run id> --dry-run   # writes every prompt, no API call
node src/cli.ts reason runs/<run id>             # needs META_API_KEY in .env
node src/cli.ts report runs/<run id>
node src/cli.ts patch runs/<run id> --run-tests --no-docker --allow-local-tests   # needs META_API_KEY; sandbox branch, re-scan, project tests on this machine (how the demo ran)
node src/cli.ts audit https://github.com/OWASP/NodeGoat   # scan, reason, report in one go (patch is separate); reasoning needs META_API_KEY
node src/cli.ts audit https://github.com/OWASP/NodeGoat --dry-run   # the same with no key: prompts and a cost estimate, no API call
node src/cli.ts rules
```

Demo target: https://github.com/buildwithdesi/vibeaudit-2-demo-app. Recorded runs live in `demo/`, both on demo commit `90357d5`:

- `demo/before` and `demo/after`: run `20261027T231844Z-...-4012`. The headline numbers in this README come from it. `runs/` is never committed, so the `reason runs/...` hint at the top of `demo/before/report.md` points at a folder that is not here; the reasoned report for that run is `demo/after/report.md`.
- `demo/video`: a second full run, `20261028T011454Z-...-a578`, which the video is built from. Reasoning $0.16 over 10 calls, patch $0.09. Only its transcripts, report and diff are committed. Its line `routes/users.js:15 idor-vulnerability: 0/0 edits applied ($0.0180)` is a paid call that found nothing left to change: the edits for line 9 had already fixed the DELETE route.

The patch loop on the same repo: Muse Spark patched 4 places covering 6 findings (each selected lead plus any finding on the same line): 4 gone on the re-scan, 2 still flagged by a rule and re-judged closed on the patched code. Project tests passed (run locally with `--allow-local-tests`), green, 7 cents.

One caveat on that patch: the demo app has no login, so the patched user routes now answer 401 to every caller until one is added. The app's two tests do not touch the routes, so "tests passed" says nothing about them. The model raised this itself in its patch notes (`outcomes[].note` in `demo/after/patch.json`), but the report does not show those notes yet.

Each scan writes `runs/<run id>/` with the clone, `engine-output.json`, `findings.json`, `manifest.json` and `summary.md`. The `runs/` folder is never committed.

Copy `.env.example` to `.env` for the reasoning stages. The Meta Model API key comes from https://dev.meta.ai.

## Security posture

- A cloned repository is hostile input. Git hooks are off (the clone points them at an empty folder, the patch loop at a path that cannot hold hooks), symlinks are off, credential prompts are off, and the URL always follows `--`. The scan stage only reads files.
- The scanned repository's own `.vibe-audit.json` is moved aside during the engine run unless you pass `--trust-target-config`, so a repo cannot hide findings through its config. Known gap: engine 1.4.0 still honors inline `vibe-audit-ignore` comments in the scanned code (this repo uses them on its own source for the self-scan only). The manifest records which mode ran.
- Second known gap: engine 1.4.0 skips every folder named `reports`, `tests`, `fixtures`, `__tests__`, `__fixtures__`, `.claude`, `node_modules`, `.git`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.output`, `.vercel`, `.netlify`, `.svelte-kit`, `__pycache__`, `venv` or `.venv`, at any depth, and every file over 2 MB. There is no flag to turn that off, so code a repo puts under, say, `src/reports/` is never scanned, and the manifest and report do not list what was skipped yet.
- Credential-shaped values are masked before any code context is written to disk or sent to a model.
- Code sent to a model is wrapped as untrusted data. Prompts state that instructions inside the code are to be ignored, and every model answer is constrained by a JSON schema and validated again with Zod.
- The patch loop never lets a model write files directly through the API path: every edit is an exact search-and-replace that must match once, only the finding's own file may change, `.git`, `.github`, package manifests, lockfiles and env files are off limits, a plan that adds dependencies is rejected, and the patch lands on a sandbox branch in the pipeline's own copy. A local folder is copied first and never patched in place.
- The project's tests run on a copy without `.git`. With Docker running and no `--no-docker`, dependencies install in one container with no capabilities, then the tests run in a second with no network, as the non-root `node` user, with no capabilities. The Docker path has not run in a recorded run or in a test yet. Otherwise the tests run on this machine only with `--allow-local-tests`, which is how the recorded demo ran them (`tests.runner: "local"` in `demo/after/patch.json`).
- Child processes that touch a scanned repository (engine, git, npm, Docker, Muse Code) get a scrubbed environment: no API keys (except the Meta key Muse Code itself needs), empty user and global npm configs, install scripts off.
- "Green" means three things: the re-scan shows nothing new, every patched finding is either gone from the re-scan or re-judged `not-exploitable` or `unlikely` by Muse Spark on the patched code, and the project's tests ran and passed. `patch.json` records the two routes apart: `rescanClean` for the scanner, `verifiedClean` for the model's re-judgement. The recorded demo went green the second way: 4 gone, 2 still flagged by a rule and re-judged not exploitable. Without `--run-tests` the best result is "closed", never green.
- Muse Spark runs in Standard mode only. The cheaper Contributor tier is never used because scanned code may belong to a customer.

## Develop

```bash
npm run verify      # typecheck, lint, tests
npm run build       # dist/
npm run audit:self  # the v1 engine scans this repository
```

## License

MIT. See `LICENSE`.
