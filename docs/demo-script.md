# Demo video: script and recording plan

Target length in the original plan: 2 minutes 45 seconds. Hard cap: 3 minutes. The scene timings below are from that original plan; the built cut runs 150 seconds and sets its own. Only work built inside the hackathon window appears on screen. The v1 engine is named once as prior work, in Scene 2, and never demoed on its own.

## The cut that exists

Draft 1 is built as a HyperFrames project outside the repo: 150 seconds, 1920x1080, ten scenes, 19 captions, silent. Its terminals are typed text copied from the recorded run in `demo/video` (run `20261028T011454Z-buildwithdesi-vibeaudit-2-demo-app-a578`), not a screen capture. That run is one `audit` command (scan, reason and report) and one `patch` command: `demo/video/transcript-audit.txt` and `demo/video/transcript-patch.txt`.

The six scenes below are the voice-over plan for that cut. Each names the recorded lines it sits on. Draft 1 has no voice yet.

## Recording plan

- Voice recorded separately and laid over the cut. If the terminal is ever re-recorded instead of typed: screen only, 1920x1080, terminal font at 18pt, dark theme.
- Terminal: a fresh shell at the repo root with `.env` loaded. Clear the `runs/` folder first so the run id on screen is the one in the video.
- Pre-run every command once before recording so caches are warm and the clone is fast. Record the real run; no fake output.
- Scenes 4 and 5 show `demo/video/report.md` and `demo/video/patch.diff`.
- Cut in HyperFrames. Captions on, because judges may watch muted.
- Record before Nov 2 so a late bug cannot leave the submission without a video.

## Scenes

### Scene 1, the problem (0:00 to 0:20)

On screen: the demo app's `routes/users.js`, cursor on the SQL line.

Voice: "This is what AI-generated code looks like when a non-developer ships it. The scanner I built earlier this year finds this pattern. But it found eight hundred ninety-five things in one real repo. A founder cannot act on a list of eight hundred ninety-five. They need to know which ones are real, how bad, and how to fix them."

### Scene 2, intake and the deterministic scan (0:20 to 0:50)

On screen: terminal, `demo/video/transcript-audit.txt` lines 1 to 10.

```
node src/cli.ts audit https://github.com/buildwithdesi/vibeaudit-2-demo-app --budget-usd 1
```

Voice: "Vibe Audit 2.0 takes a GitHub URL. It clones into a sandbox where nothing from the repo can run, then runs the v1 engine, which is prior work, as a black box. Every finding gets a vulnerability class and masked code context. Secrets are masked before anything is written to disk."

Show: the run summary with the top five classes, then one finding in `findings.json` with its class and masked context. The rule id and message come from v1; the class, the masked context and the manifest are new. A caption can mark that. The voice does not name v1 again.

### Scene 3, reasoning with Muse Spark (0:50 to 1:35)

On screen: the same `audit` run carrying on, `demo/video/transcript-audit.txt` lines 11 to 22. There is no separate `reason` command in the recorded run.

Voice: "Now the new part. Muse Spark, Meta's model, builds one map of the repo, then judges each finding: who can exploit it, from where, through which lines. Every answer is constrained by a JSON schema. The scanned code is wrapped as untrusted data so it cannot talk the model into a verdict. And there is a budget per file and per run, in dollars, printed when it finishes."

Show: verdict lines scrolling, then the final cost line: "spent $0.1597 over 10 calls". The same line says "triage dropped 0" because triage was off in this run. Do not narrate it as a triage step.

### Scene 4, proof of risk for a founder (1:35 to 2:05)

On screen: `demo/video/report.md` rendered.

Voice: "The report is written for the person who owns the app, not for a security team. Each class says what could happen in plain words, who can do it, the steps, and the two lines of code that prove it. Then the smallest fix."

Show: the database injection section, scrolling slowly through verdict, attack path, proof, fix.

### Scene 5, the patch loop (2:05 to 2:40)

On screen: terminal, `demo/video/transcript-patch.txt`.

```
node src/cli.ts patch runs/<id> --run-tests --allow-local-tests
```

The recorded run printed "project tests: passed (local)", and the code only runs tests locally when `--allow-local-tests` is given (`src/patch/project-tests.ts`). Without that flag, and without Docker, the tests are skipped and the run is not green. With Docker running, the flag alone still sends the tests to a container; add `--no-docker` to repeat the recorded local run. Line 1 of `demo/video/transcript-patch.txt` shows the command without `--allow-local-tests`, but its output cannot happen without that flag. Only Desi knows what was typed: confirm it, then fix line 1 (and add `--no-docker` if that was typed too) so the transcript matches the run.

(Muse Spark backend, the one recorded in `demo/after` and `demo/video`. The Muse Code backend is built but not run live, so it stays off screen.)

Voice: "Then it fixes them. Muse Spark proposes exact edits on a sandbox branch, never on main. The scan runs again on the patched code, and the app's own tests run again. Green means nothing new was flagged, every patched spot is either gone from the re-scan or re-judged closed by Muse Spark on the patched code, and the tests pass. Here: four gone, two still flagged by a rule and re-judged closed."

Show: the GREEN line ("4 resolved, 2 still flagged (2 judged closed on review) ... $0.0880"), then `patch.diff` with the parameterized query and the execFile change side by side.

If the line `routes/users.js:15 idor-vulnerability: 0/0 edits applied ($0.0180)` is on screen, it is a paid call that found nothing left to change: the two edits for line 9 had already fixed the DELETE route (`demo/video/patch.diff`). A caption can say so.

The patch makes both user routes require a login. The demo app has no login yet, so those routes now answer 401 to everyone, and the app's two tests do not touch the routes. Say "the project's tests still pass", not "the app still works".

### Scene 6, close (2:40 to 2:55)

On screen: the GitHub repo with CONTRIBUTIONS.md open.

Voice: "Everything you saw was built inside the hackathon window. The split from prior work is in CONTRIBUTIONS.md. Vibe Audit 2.0: find it, prove it, fix it, and the project's tests still pass."

## What must be true before recording

- A live reasoning run on the demo repo has completed and the verdicts read well. Done: `demo/after` and `demo/video`.
- The patch loop is green on the demo repo with the Muse Spark backend. Done: `demo/after/patch.json`. The October 31 scope cut is not needed.
- Muse Code and Glimmer triage are built but not run live. Nothing on screen or in the voice may suggest they ran.
- `META_API_KEY` in `.env` with credit on the account, only if a run is recorded again.

## Check the cut before Nov 2

The cut lives outside the repo, so nobody can check it from here. Watch it once, muted and then with the voice, and tick each line:

- [ ] No caption or voice says Glimmer triaged anything or Muse Code patched anything.
- [ ] No caption or voice says the tests ran in a container, or that the re-scan came back clean.
- [ ] The patch command on screen includes `--allow-local-tests`.
- [ ] v1 is named once, as prior work.
- [ ] No `C:\Users\...` path on screen. The run transcripts printed a full Windows path, with the account name, on four lines (`transcript-audit.txt` lines 6, 10, 23, `transcript-patch.txt` line 11). The repo copies show it as `<user>`; the typed terminals in the cut may still carry the real one.
- [ ] Costs on screen are the video run's: $0.16 for reasoning, $0.09 for the patch. The README's $0.17 and $0.07 are run `...-4012` in `demo/after`. Both are real runs on the same demo commit.
