# Submission checklist

Deadline: Wednesday November 4, 2026, 9:00 PM ET (EST by then; 02:00 UTC on November 5). Portal: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit. Re-read the Official Rules on the waiver page before submitting; the organizers may change them.

## Before the deadline

- [ ] Claim the $150 Model API credit through the claim form (closes at the same moment as submissions). Needs name, application email, Model API Team ID.
- [ ] Add a payment method on the Model API account; the credit does not apply without one.
- [ ] `META_API_KEY` in `.env`, never committed. `git ls-files | grep .env` must print only `.env.example`, and `git grep -n "LLM_" $(git rev-list --all)` must print nothing. A key did land in `.env.example` on October 27; it was removed from the tip and rotated. Decide whether to rewrite history before submitting.
- [ ] Live reasoning run on the demo repo completed; `report.md` reads well to a non-security reader.
- [ ] Patch loop green on the demo repo. If not by October 31, cut to two classes and say so in the README and the video.
- [ ] Before and after artifacts copied into `demo/` and committed (summary, report, patch diff, manifests).
- [ ] CONTRIBUTIONS.md status table matches reality. Every row says built, cut, or not started.
- [ ] `npm run verify` and `npm run audit:self` pass on a fresh clone (`git clone`, `npm ci --ignore-scripts`).
- [ ] CI green on the last commit.
- [ ] README quick start works on a machine that is not this one (fresh clone on the laptop, or a Docker `node:24` container).
- [ ] Demo video recorded, under 3 minutes, captions on, uploaded (unlisted YouTube or Vimeo), link opens in a private window.
- [ ] Video shows only work from the window. v1 named as prior work once.

## Submission form

- [ ] Track: Startup.
- [ ] Theme: Push the Frontier.
- [ ] Project name: Vibe Audit 2.0.
- [ ] Public repo: https://github.com/buildwithdesi/vibeaudit-2
- [ ] Demo repo: https://github.com/buildwithdesi/vibeaudit-2-demo-app
- [ ] Demo video link.
- [ ] Solo submitter: Desmond Baker, listed as the Representative. Startup: DB Creations LLC / Digital Alchemy.
- [ ] Meta tools used, stated plainly: Muse Spark 1.3 (Model API, Standard mode), Muse Glimmer 30B (open weights, hosted), Muse Code (patch backend).
- [ ] One-paragraph description that matches the README's first two paragraphs.

## After submitting

- [ ] Save a screenshot of the confirmation page.
- [ ] Tag the submitted commit: `git tag -a hackathon-submission -m "submitted Nov 4 2026" && git push --tags`.
- [ ] Do not push to `main` after the deadline until judging ends on November 8. Work on a branch.
