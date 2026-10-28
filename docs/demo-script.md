# Demo video: script and recording plan

Target length: 2 minutes 45 seconds. Hard cap: 3 minutes. Only work built inside the hackathon window appears on screen. The v1 engine is named once as prior work and never demoed on its own.

## Recording plan

- Two takes of each scene, screen only, 1920x1080, terminal font at 18pt, dark theme. Voice recorded separately and laid over the cut.
- Terminal: a fresh shell in `C:\Users\ulilj\repos\vibeaudit-2` with `.env` loaded. Clear the `runs/` folder first so the run id on screen is the one in the video.
- Pre-run every command once before recording so caches are warm and the clone is fast. Record the real run; no fake output.
- Keep `report.md` and `patch.diff` open in a second window for scenes 4 and 5.
- Cut in HyperFrames or Descript. Captions on, because judges may watch muted.
- Record before Nov 2 so a late bug cannot leave the submission without a video.

## Scenes

### Scene 1, the problem (0:00 to 0:20)

On screen: the demo app's `routes/users.js`, cursor on the SQL line.

Voice: "This is what AI-generated code looks like when a non-developer ships it. The scanner I built last year, Vibe Audit, finds this pattern. But it found eight hundred ninety-five things in one real repo. A founder cannot act on a list of eight hundred ninety-five. They need to know which ones are real, how bad, and how to fix them."

### Scene 2, intake and the deterministic scan (0:20 to 0:50)

On screen: terminal.

```
node src/cli.ts scan https://github.com/buildwithdesi/vibeaudit-2-demo-app
```

Voice: "Vibe Audit 2.0 takes a GitHub URL. It clones into a sandbox where nothing from the repo can run, then runs the v1 engine, which is prior work, as a black box. Every finding gets a vulnerability class and masked code context. Secrets are masked before anything is written to disk."

Show: the run summary with the top five classes, then one finding in `findings.json` with its class and masked context. The raw rule output is v1; the class, the masked context and the manifest are new. Say so.

### Scene 3, reasoning with Muse Spark (0:50 to 1:35)

On screen: terminal.

```
node src/cli.ts reason runs/<id>
```

Voice: "Now the new part. Muse Glimmer, Meta's open-weight model, triages each finding: real code or a test fixture. Only the keepers go to Muse Spark. Spark builds one map of the repo, then judges each finding: who can exploit it, from where, through which lines. Every answer is constrained by a JSON schema. The scanned code is wrapped as untrusted data so it cannot talk the model into a verdict. And there is a budget per file and per run, in dollars, printed when it finishes."

Show: verdict lines scrolling, then the final cost line.

### Scene 4, proof of risk for a founder (1:35 to 2:05)

On screen: `report.md` rendered.

Voice: "The report is written for the person who owns the app, not for a security team. Each class says what could happen in plain words, who can do it, the steps, and the two lines of code that prove it. Then the smallest fix."

Show: the database injection section, scrolling slowly through verdict, attack path, proof, fix.

### Scene 5, the patch loop (2:05 to 2:40)

On screen: terminal.

```
node src/cli.ts patch runs/<id> --run-tests
```

(Muse Spark backend, the one recorded in `demo/after`. Add `--backend muse-code` only if the agent CLI has been installed and run green before recording.)

Voice: "Then it fixes them. Muse Spark proposes exact edits, or Muse Code does it as an agent, on a sandbox branch, never on main. The scan runs again on the patched code, and the app's own tests run in a container. Green means two things: the findings are gone, and the tests still pass."

Show: the GREEN line, then `patch.diff` with the parameterized query and the execFile change side by side.

### Scene 6, close (2:40 to 2:55)

On screen: the GitHub repo with CONTRIBUTIONS.md open.

Voice: "Everything you saw was built inside the hackathon window. The split from prior work is in CONTRIBUTIONS.md. Vibe Audit 2.0: find it, prove it, fix it, without breaking the app."

## What must be true before recording

- `META_API_KEY` in `.env` with credit on the account.
- A live reasoning run on the demo repo has completed at least once and the verdicts read well.
- The patch loop is green on the demo repo with the Muse Code backend, or with the API backend if Muse Code misbehaves. Say which one on screen; both are Meta models.
- If the patch loop is not green by October 31: record scene 5 with the two classes that are green and say "two classes patched, the rest reported".
