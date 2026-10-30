# Build log

One entry per working day inside the hackathon window. Commit times are in `git log`.

## 2026-10-26 (Monday), day 1

- Confirmed the live v1 rule count by running the published CLI: 104 rules, not the 39 in the brief. Every run manifest now records the live count.
- Researched the Meta Model API, Muse Code and Muse Glimmer with a multi-agent sweep and adversarial verification. Notes with sources: `docs/muse-api-notes.md`.
- Decision: Standard mode only for Muse Spark. The Contributor tier is cheaper but Meta states it is used to improve its products, and scanned code may belong to a customer.
- Decision: v1 runs as a child process, never as imported source. The prior-work boundary is visible in the code.
- Scaffolded the repository outside the private vault, installed pinned dependencies with install scripts disabled, inspected lifecycle scripts (none run on install).

## 2026-10-27 (Tuesday), day 2

- Built the 2.0 pipeline: strict target parsing, hardened shallow clone (hooks disabled, no symlinks, no credential prompts, URL after `--`), engine run with JSON capture, normalization with vulnerability classes and masked code context, run manifest and summary.
- Wrote the seeded example app with six planted classes (SSRF is the sixth; the report covers the top five) and the test that proves the pipeline finds all of them and never writes the planted password into any artifact.
- End-to-end on a real repository: `OWASP/NodeGoat`, 91 files, 895 findings, 104 of 104 rules, about 6 seconds including the clone. The severity totals (37 critical, 386 warning, 472 info) and a sample of rows are in `demo/video/nodegoat-rows.txt`; the run folder with the file count and timing was not committed.
- Drafted the reasoning layer: repo map, triage and exploitability prompts, strict-subset structured output schemas, per-file budget, Meta client.
- Wired the reasoning stage into a command: `reason <run>` builds the repo map once, triages each selected finding with the open-weight model (only when `TRIAGE_*` is set), judges exploitability with Muse Spark inside the budget, and writes every decision and dollar to `reasoning.json`. `--dry-run` writes every prompt to disk and estimates the cost with no call.
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
- Built the demo video as a HyperFrames project outside the repo: 150 seconds, 1920x1080, ten scenes, 19 captions, silent in draft 1. Every row, number and sentence on screen is copied from the recorded runs in `demo/video`. A registry terminal component was dropped because its script resolved `#root` to the main composition; the terminals are hand-built, typed text as a pure function of time. `check` passes with zero errors; the remaining craft warnings (silent film, unread scrolling rows, deliberate holds) are listed in the project's `REVIEW.md`. The MP4 stays out of git.

## 2026-10-28 (Wednesday), day 3

- v1 pull request #45 makes the CLI flush its output before it exits. 1.5.0, the release meant to carry it, is not on npm yet, so 2.0 still pins 1.4.0.
- Branch `chore/engine-1.5.0` is pushed, not merged. It is written for engine 1.5.0, which applies a scanned repo's config and inline ignore comments only behind `--trust-target-config`, but its `package.json` still pins 1.4.0. It waits on the 1.5.0 publish.
- Docs pass so every claim matches what ran. Glimmer triage and the Muse Code backend are built, not run live; only Muse Spark 1.3 has run. Green is defined the way the loop computes it, including flags re-judged closed. The demo's tests ran locally with `--allow-local-tests`, and the Docker test runner has not run. The patched user routes refuse every caller, because the demo app has no login. The seeded app plants six classes, not five. The README says which numbers come from run `...-4012` and which from the video run `...-a578`.
- Redacted the Windows account name from the recorded paths in `demo/`, and a vault path and a signed link from the research notes. Older commits still hold them.
- Line 1 of `demo/video/transcript-patch.txt` shows the patch command without `--allow-local-tests`, but the recorded output, "project tests: passed (local)", cannot happen without that flag. The line is left as committed for Desi to confirm what was typed (`docs/demo-script.md`, scene 5).
- Drafted the submission description and an AI-assistance line in the checklist, for review.

## 2026-10-29 (Thursday), day 4

- Report reads in risk order. Kinds with confirmed or likely findings come first, kinds the model checked and cleared sit last under one "Checked and ruled out" heading, and the summary table follows the same order. Before this, the demo report opened on three fake credentials judged not exploitable and said to fix them first. The engine's own order is kept for an unreasoned run.
- A quote the checker cannot match in the file is flagged "not matched word for word against the file" instead of "treat it as a paraphrase".
- `demo/after/report.md` and `demo/video/report.md` regenerated from the local run folders with the current renderer. Every count is unchanged.
- README opens with the pitch, a trimmed transcript of the recorded run, and the demo numbers in one table. The caveats and the security posture are unchanged below it.
