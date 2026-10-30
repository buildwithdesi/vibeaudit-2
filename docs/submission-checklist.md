# Submission checklist

Deadline: Wednesday November 4, 2026, 9:00 PM ET (EST by then; 02:00 UTC on November 5). Portal: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit. Re-read the Official Rules on the waiver page before submitting; the organizers may change them.

## Before the deadline

- [ ] Claim the $150 Model API credit through the claim form (closes at the same moment as submissions). Needs name, application email, Model API Team ID.
- [ ] Add a payment method on the Model API account; the credit does not apply without one.
- [x] `META_API_KEY` in `.env`, never committed. On the tip, `git ls-files | grep -E '(^|/)\.env'` must print only `.env.example`, and `git grep -lE 'LLM_[0-9]{6,}_' -- . ':!tests'` must print nothing (the fake key in `tests/context.test.ts` is left out on purpose). Both held on October 28 and again on October 29. They print file names, never a key.
- [ ] Revoke the Meta key that landed in `.env.example` on October 27 at dev.meta.ai (revoke it, do not only add a new one), and check the dashboard no longer lists it as active. Then write "revoked on <date>" here and in the build log. Rewriting history to drop it is optional and changes every later commit SHA.
- [x] Live reasoning run on the demo repo completed; `report.md` reads well to a non-security reader. Done October 27: `demo/after/reasoning.json`, `demo/after/report.md`.
- [x] Patch loop green on the demo repo. Done October 27: `demo/after/patch.json`. The October 31 scope cut is not needed.
- [x] Before and after artifacts copied into `demo/` and committed (summary, report, patch diff, manifests).
- [x] Open the demo repo in a private window and confirm branch `vibeaudit2/patch-20261027T231844Z-buildwithdesi-vibeaudit-2-demo-app-4012` exists with head `766db6a` (the branch CONTRIBUTIONS names). Then check `vibeaudit2/patch-20261028T011454Z-buildwithdesi-vibeaudit-2-demo-app-a578`, the branch the video run prints: push it, or keep its name off screen. Checked October 29 through the GitHub API: main `90357d5`, 4012 at `766db6a`, a578 at `18ae293`. The a578 branch is pushed, so the video run can show its name.
- [ ] Optional: copy the a578 run's `manifest.json`, `reasoning.json` and `patch.json` into `demo/video` (Windows paths scrubbed), so the video's numbers trace to records the way `demo/after` does.
- [x] CONTRIBUTIONS.md status table matches reality. Every row says built, cut, or not started. Checked October 29: rows 2 and 4 say built, with what ran live and what did not.
- [x] `npm run verify` and `npm run audit:self` pass on a fresh clone (`git clone`, `npm ci --ignore-scripts`). Held October 29 on a fresh clone of `976c90a`: 174 tests, 164 pass, 0 fail, 10 skipped; build clean; self-audit clean, 33 files, 104 rules.
- [x] CI green on the last commit. Green on `976c90a` (merge of PR 2), both Node 22 and Node 24.
- [ ] README quick start works on a machine that is not this one (fresh clone on the laptop, or a Docker `node:24` container).
- [ ] Demo video recorded, under 3 minutes, captions on, uploaded (unlisted YouTube or Vimeo), link opens in a private window.
- [ ] Video shows only work from the window. v1 named as prior work once. Watch the cut against "Check the cut before Nov 2" in `docs/demo-script.md`: the cut lives outside the repo, so nobody else can check it.
- [ ] Decide whether `package.json` should carry your email as author. Your commits use the GitHub noreply address, so this is the only place it appears in the repo. The Windows account name, the vault folder path and the signed Credit Terms link were redacted from the current files on October 28, but older commits still hold them; leave history alone unless you want them gone badly enough to rewrite it.

## Submission form

- [ ] Track: Startup.
- [ ] Theme: Push the Frontier.
- [ ] Project name: Vibe Audit 2.0.
- [ ] Public repo: https://github.com/buildwithdesi/vibeaudit-2
- [ ] Demo repo: https://github.com/buildwithdesi/vibeaudit-2-demo-app
- [ ] Demo video link.
- [ ] Solo submitter: Desmond Baker, listed as the Representative. Startup: DB Creations LLC / Digital Alchemy.
- [ ] AI assistance, if the form or the Official Rules ask (re-read their wording on AI-assisted development first). Draft for you to review: "Built solo with Claude Code (Anthropic) as my coding assistant; every commit carries a Co-Authored-By: Claude trailer. The product itself calls only Meta models." CONTRIBUTIONS and the README say the same.
- [ ] Meta tools used, stated plainly. Paste: "Muse Spark 1.3 (Model API, Standard mode) ran live for exploitability reasoning and for patching. Muse Glimmer 30B triage and the Muse Code patch backend are built but were not run live." If Glimmer or Muse Code runs live before Nov 4, commit the run record to `demo/` first, then change this line, the README and CONTRIBUTIONS together.
- [ ] One-paragraph description. Draft description below, for you to review; every number in it is from `demo/after`. If a number is regenerated, or Glimmer or Muse Code runs live first, change it here before pasting.

  > Vibe Audit 2.0 is a security audit for AI-generated code that explains the risk in plain language and proves it. Vibe Audit v1, my open-source scanner from earlier this year (prior work, used unchanged as a pinned dependency), finds the patterns. 2.0, built inside the hackathon window, adds the judgment. It takes a GitHub URL, clones it into a hardened sandbox, and has Muse Spark 1.3 (Meta Model API, Standard mode) decide which findings an attacker can actually use, quoting the lines of code that prove it. It writes a proof-of-risk report for a founder, not a security team, then patches the confirmed findings on a sandbox branch, scans again and re-runs the project's own tests. On the seeded demo app, Muse Spark judged 9 findings in 10 calls for $0.17: 6 confirmed, and 3 fake credentials correctly ruled not exploitable. The patch run cost $0.07. Of the 6 confirmed findings, 4 are gone on the re-scan and 2 are still flagged by a rule but re-judged closed by Muse Spark on the patched code, and the project's tests still pass. A Muse Glimmer 30B triage stage and a Muse Code patch backend are built but were not run live.

## After submitting

- [ ] Save a screenshot of the confirmation page.
- [ ] Tag the submitted commit: `git tag -a hackathon-submission -m "submitted Nov 4 2026" && git push --tags`.
- [ ] Do not push to `main` after the deadline until judging ends on November 8. Work on a branch.
