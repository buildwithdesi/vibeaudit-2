# Contributions: what is prior work and what is new

Entry for the Meta Global AI Developer Hackathon 2026, Startup track, theme "Push the Frontier".
Window: October 26, 2026 12:00 PM ET to November 4, 2026 9:00 PM ET.
Builder: Desmond Baker, solo. Digital Alchemy / DB Creations LLC, Maywood, Illinois.

## The rule this repository follows

Everything in this repository was written inside the hackathon window, which opened October 26, 2026 at 12:00 PM ET. The files were drafted on October 26 and committed on October 27; the build log records both days. Prior work is consumed as a pinned npm dependency and is never copied in. If a judge cannot tell whether something is new, it does not go in the demo.

## Prior work (not part of this submission)

| Item | Where it lives | Proof of date |
|---|---|---|
| Vibe Audit v1, the deterministic scanner CLI, `@jackdog668/vibeaudit` | npm, version 1.5.0 (see the note below). Source: https://github.com/buildwithdesi/vibeaudit | `npm view @jackdog668/vibeaudit time` and that repository's git history |
| The AI Tinkerers Chicago talk about v1 | Given before the window | Event listing |

What v1 already does, so this submission does not claim it:

- AST and pattern rules over a local folder. The live count comes from the engine, never from a document: `npx vibeaudit --list-rules` printed 104 rules on 2026-10-26 with 1.4.0 and prints 107 with 1.5.0. The brief for this build said 39; that number was stale, so the pipeline records the live count in every run manifest instead.
- A GitHub target mode (`github://owner/repo`) that reads files through the GitHub API, plus a shallow-clone helper.
- Terminal, JSON, Markdown and HTML reports.
- Static, per-rule fix prompts (`--fix`).
- Dependency checks (npm audit, OSV), a package pre-install check, and the VibeGuard hook.

v1 bugs found during the window get fixed upstream in the v1 repository. They are not part of this submission and are not demoed.

The pinned engine moved from 1.4.0 (published 2026-08-24) to 1.5.0 (released 2026-10-28, inside the window). 1.5.0 is v1 work, not 2.0 work. Its features were written before the window: the `--trust-target-config` switch, the OSV and Gitleaks adapters, Agent Shield, VibeGuard, protected npm install, and the `known-vulnerable-versions` rule. Inside the window it gained two VibeGuard fixes on October 27 and, with the release itself, one bug fix found while building 2.0: the CLI called `process.exit()` before piped output was written, so a caller reading through a pipe could get a cut-off rule list or JSON report (v1 pull request #45). The recorded runs in `demo/` used 1.4.0; their manifests say so.

## New work (built October 26 to November 4, 2026)

| # | Deliverable | Status | Where |
|---|---|---|---|
| 1 | 2.0 run pipeline: GitHub URL intake into a hardened sandbox clone, the v1 engine run as a black box, findings normalized into a 2.0 schema with vulnerability classes and masked code context, a run manifest with the live rule count, and a run summary | Built, tested end to end on `examples/seeded-app` and on `OWASP/NodeGoat` | `src/intake`, `src/engine`, `src/model`, `src/normalize`, `src/pipeline`, `src/report`, `src/cli.ts` |
| 2 | Reasoning layer: open-weight triage (Muse Glimmer) in front of Muse Spark exploitability judgments, structured output schemas, per-file reasoning budget, cost accounting from a rates table | Built and run live on October 27: `vibeaudit2 reason <run>` judged the demo app with Muse Spark 1.3, 10 calls, $0.17, verdicts recorded in `demo/after/reasoning.json`. Dry-run mode writes every prompt and estimates cost without a call | `src/reason` |
| 3 | Plain-language proof-of-risk reports for the top five vulnerability classes in a run | Built: `vibeaudit2 report <run>` writes `report.md`; verdicts lead when the reasoning stage ran, deterministic results stand otherwise and the report says so | `src/report/proof-of-risk.ts` |
| 4 | Patch loop: patches land on a sandbox branch, the audit and the project tests run again, nothing may break. Scope cut on October 31 if not green: two classes patched, the rest findings only | Built and green live on October 27 with the Muse Spark backend: 4 findings patched on the demo repo, re-scan clean except 2 rule flags that the model re-judged closed on the patched code, project tests passed, $0.07. Diff and record in `demo/after`. The Muse Code backend is wired (`--backend muse-code`) but has not run on this machine yet | `src/patch` |
| 5 | Seeded demo repository with five vulnerability classes, before and after runs recorded | Public repo live: https://github.com/buildwithdesi/vibeaudit-2-demo-app. Before run in `demo/before`, after run in `demo/after`, patched branch pushed to the demo repo as `vibeaudit2/patch-*` | `examples/seeded-app`, `demo/` |

Status lines are updated as work lands. The build log in `docs/build-log.md` records each day.

## How a judge can verify what is new

- `git log --format='%ad  %s' --date=iso` shows every commit inside the window. The first commit is the scaffold on October 27, 2026; October 26 was research, recon and drafting, logged in `docs/build-log.md`. One commit is titled "correct the first-commit date" because an earlier draft of this file said October 26.
- `npm ls @jackdog668/vibeaudit` shows the only prior-work code path. It is a pinned dependency, called as a child process from `src/engine/v1.ts`, never imported as source.
- Every run writes `manifest.json` with the engine name, version and live rule count, so the boundary is visible in the output too.
- `npx vibeaudit --list-rules` prints the engine's live rule list on your machine.

## Third-party components

| Component | License | Use |
|---|---|---|
| `@jackdog668/vibeaudit` (own prior work) | MIT | Deterministic scanning engine |
| `zod` | MIT | Schema validation and JSON schema generation |
| `typescript`, `@biomejs/biome`, `@types/node` | Apache-2.0 / MIT | Development only |
| Meta Model API (Muse Spark 1.3, Standard mode) | Meta API terms | Exploitability reasoning. Standard mode only, which Meta states is not used to improve its products. The Contributor tier is never used, because scanned code may belong to a customer. |
| Muse Glimmer 30B | Apache-2.0 | Open-weight triage through a hosted OpenAI-compatible endpoint |
| Muse Code | Meta terms | Patch generation in the patch loop |
| OWASP NodeGoat | Apache-2.0 | Scan target for the end-to-end check only. Not included in this repository. |

No code, data or assets without rights are included. The seeded app's credentials are fake and the app never connects anywhere.
