# Reasoning layer design

The v1 engine says "this pattern matched". The reasoning layer says "here is how an attacker uses it, from where, and what they get", or "this one is not reachable, move on". This note records the design so the code in `src/reason` can be read against it.

## Shape

```
findings.json (from the pipeline)
   |
   v
repo map          one Muse Spark call per run. File tree + findings index + key excerpts
   |              -> entry points, auth boundaries, data stores, trust zones, file roles
   v
triage            one Muse Glimmer call per finding (open weights, cheap)
   |              -> keep or drop, with the line that proves a drop
   v
exploitability    one Muse Spark call per kept finding, grouped by file, inside the budget
   |              -> verdict, attacker position, attack path with quotes, impact, fix, plain language
   v
findings.json (updated in place, triage and reasoning slots filled)
```

## Why open weights go first

Most findings in a real repository are noise for a frontier model: test fixtures, vendored code, a guard three lines up. Glimmer 30B costs about a quarter of Spark per input token and runs on any OpenAI-compatible host. It answers one narrow question and must quote the line that proves a drop. Keeping is free, dropping needs proof, so the triage pass can only remove findings a human would also remove.

Spark then spends its budget on findings that are in real, reachable code.

## Budget

Three caps, in `src/reason/budget.ts`:

| Cap | Default | Why |
|---|---|---|
| Input tokens per file | 24,000 | A file with 40 findings should not cost 40 full contexts |
| Output tokens per finding | 2,000 | A verdict is short; reasoning tokens bill as output |
| Dollars per run | 5 | A hackathon credit is $150; a customer run should be predictable |
| Findings per file | 8 | Past that, the file needs a rewrite, not more verdicts |

A finding that hits a cap keeps its deterministic v1 result and is marked in the report as not reasoned. Nothing is dropped silently.

Rates live in `src/reason/rates.json` with a source URL and an as-of date. Cost is computed from the usage block the API returns, never estimated after the fact.

Back-of-envelope at the Spark Standard rates: a typical exploitability call is about 6,000 input and 800 output tokens, close to one cent. A 60-finding run that keeps 25 findings costs about 30 cents plus one repo-map call.

## Data policy

Muse Spark runs in Standard mode only. Meta prices the Contributor tier at a fraction of Standard but states that Contributor content is used to improve its products. Scanned code may belong to a customer, so the cheaper tier is never an option in this product.

## Prompt injection

Scanned code is attacker-controlled text that ends up inside a prompt. Three layers:

1. Every piece of repository text is wrapped in `<repo-data>` tags, and any closing tag inside the data is neutralized, so the data cannot end its own block.
2. The system prompt states that repository data is untrusted and that instructions inside it are to be ignored.
3. The answer is constrained by a JSON schema on the server (`response_format`, strict subset) and validated again with Zod on the client. Free text cannot leak into the pipeline, and a field the schema does not know cannot appear.

## Schemas

`src/reason/schemas.ts` holds the Zod schemas for the repo map, the triage verdict and the exploitability verdict. One function converts a schema into Meta's strict-subset `response_format`. A test checks every generated schema against the subset rules: root is an object, every object sets `additionalProperties: false`, every object lists every key as required, no `allOf` or `oneOf`, depth at most 10.

## Evidence rule

Every claim in an exploitability verdict must trace to a quoted line. The plain-language report quotes the same lines. A founder reads "anyone on the internet can delete any account" next to the two lines of code that make it true.

## What is not decided yet

- The exact list of related snippets pulled in per finding (mounting file, middleware, data layer). First version: the file that imports the flagged file, plus any file the repo map lists as an auth boundary.
- Whether Muse Wonder earns its five-times price on the hardest verdicts. Spark 1.3 first, measure, then decide.
- Reasoning effort per stage. Starting point: Glimmer low, repo map medium, exploitability high.
