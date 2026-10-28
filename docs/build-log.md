# Build log

One entry per working day inside the hackathon window. Times are Central.

## 2026-10-26 (Monday), day 1

- Confirmed the live v1 rule count by running the published CLI: 104 rules, not the 39 in the brief. Every run manifest now records the live count.
- Researched the Meta Model API, Muse Code and Muse Glimmer with a multi-agent sweep and adversarial verification. Notes with sources: `docs/muse-api-notes.md`.
- Decision: Standard mode only for Muse Spark. The Contributor tier is cheaper but Meta states it is used to improve its products, and scanned code may belong to a customer.
- Decision: v1 runs as a child process, never as imported source. The prior-work boundary is visible in the code.
- Scaffolded the repository outside the private vault, installed pinned dependencies with install scripts disabled, inspected lifecycle scripts (none run on install).

## 2026-10-27 (Tuesday), day 2

- Built the 2.0 pipeline: strict target parsing, hardened shallow clone (hooks disabled, no symlinks, no credential prompts, URL after `--`), engine run with JSON capture, normalization with vulnerability classes and masked code context, run manifest and summary.
- Wrote the seeded example app with five planted classes and the test that proves the pipeline finds all of them and never writes the planted password into any artifact.
- End-to-end on a real repository: `OWASP/NodeGoat`, 91 files, 895 findings, 104 of 104 rules, about 6 seconds including the clone.
- Drafted the reasoning layer: repo map, triage and exploitability prompts, strict-subset structured output schemas, per-file budget, Meta client.
- Wired the reasoning stage into a command: `reason <run>` builds the repo map once, triages each selected finding with the open-weight model, judges exploitability with Muse Spark inside the budget, and writes every decision and dollar to `reasoning.json`. `--dry-run` writes every prompt to disk and estimates the cost with no call.
- Wrote the proof-of-risk report command. One section per class, founder language, verdict, who can do it, how it happens, the lines that prove it, the smallest fix.
- `audit <target>` runs scan, reason and report in one go.
- Dry run on the NodeGoat scan: prompts written for the top five classes, estimated under one dollar.
- Built the patch loop: sandbox branch, two backends (Muse Code headless, Muse Spark exact edits), commit, re-scan with the same engine settings, before and after per class, optional project tests in Docker or locally by explicit flag, `patch.json` and `patch.diff` in the run folder. Report gained an "After the patch" section.
- Gave the seeded app its own tests so "tests still pass" means something.
- Published the demo app as its own public repo and scanned it from the GitHub URL. Before artifacts recorded in `demo/before`.
- Wrote the demo video script with a recording plan (2:45 target, 3:00 cap) and the submission checklist.
- Three parallel reviews (security, correctness, judge view) came back. A key had landed in `.env.example` and been committed; removed from the tip, rotation requested. Hardening sweep from the reviews: edit allowlist (finding's own file only, no `.git`, `.github`, manifests, lockfiles, env files), atomic per-file edits that honor CRLF, local folders copied before patching instead of patched in place, before/after comparison through the diff's line map instead of line numbers, green requires tests that ran and passed, scrubbed environment for every child process, Docker test runner with no network, no root, no capabilities, on a copy without `.git`, wider secret masking (JSON keys, env lines, bearer tokens, URL passwords, vendor key formats), secret-bearing files never read, every repo- or model-derived string wrapped before it reaches a prompt, billed-but-failed calls counted, fatal API statuses abort the run, output caps raised so reasoning tokens do not truncate answers, Contributor-tier models refused, Muse Code forced to contributor mode off and never auto-selected.
- Report rewritten for a founder: plain labels first, a "fix first" line, one entry per location, secrets hidden by wording, quotes checked against the file.
- First live Meta API calls. Reasoning on the demo app: 10 calls, 9 verdicts, $0.17; the three fake credentials came back not exploitable because the app never connects, which is the honest answer. Reasoning tokens were 32k of 36k completion tokens, so the earlier 2k output cap would have truncated every answer; the reviewer caught that before it cost anything.
- Live patch loop with the Muse Spark backend: path containment, execFile with a hostname allowlist, parameterized SQL, login and ownership checks. Re-scan clean except the IDOR rule still firing on the new ownership check; added a verification step where the model re-judges any still-flagged spot on the patched code, recorded separately from the scanner's result. Green, $0.07. Patched branch pushed to the demo repo.
