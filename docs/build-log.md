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
