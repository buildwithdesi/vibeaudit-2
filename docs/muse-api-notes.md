400. (https://dev.meta.ai/docs/protocols/chat-completions)

- Structured output combines with `reasoning_effort`. The Reasoning page points to structured output as the way to constrain a reasoned answer. (https://dev.meta.ai/docs/structured-output)
- The models page lists structured output for `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor`, `muse-spark-1.1` and `muse-wonder-1.0`. (https://dev.meta.ai/docs/models) [medium]
- Guard in code. Require `finish_reason === "stop"` and non-null content. Wrap `JSON.parse` in try/catch. Leave token headroom. (https://dev.meta.ai/docs/structured-output) [inference]

### Schema limits

- Model API validates schemas before decoding starts. Exceeding a limit returns HTTP 400. (https://dev.meta.ai/docs/structured-output)
- Limits: nesting depth 10, 5,000 total properties, 120,000 total string characters, 1,000 enum values (raisable per app) and 200,000 expanded nodes. (https://dev.meta.ai/docs/structured-output)
- A single string enum over 250 values is capped at 15,000 combined characters. (https://dev.meta.ai/docs/structured-output)
- The same limits apply to function-tool parameters. (https://dev.meta.ai/docs/structured-output)

### Tool calling

- Tools on Chat Completions use the nested format `{type: "function", function: {name, description, parameters, strict}}`. Names allow letters, digits, underscore, dash and at most one dot. (https://dev.meta.ai/docs/tool-calling)
- The model replies with `message.tool_calls[]`. Each has `id`, `type: "function"`, and `function.name`. `function.arguments` is a JSON string. `finish_reason` is `tool_calls` and `content` is typically null. (https://dev.meta.ai/docs/tool-calling)
- Send one `role: "tool"` message per call, with `tool_call_id`. Replay the full assistant message with its `tool_calls`, or the API returns 400. (https://dev.meta.ai/docs/tool-calling)
- `type: "custom"` tools are Responses-only and return 400 here. `parallel_tool_calls` defaults to true. (https://dev.meta.ai/docs/tool-calling)
- Tool-call arguments are not guaranteed to match your schema, even with `strict: true`. Strict only validates the schema itself. Always parse and validate arguments in your own code. (https://dev.meta.ai/docs/tool-calling)
- Only `response_format` `json_schema` is documented as always schema-constrained. That makes it the safer path for structured verdicts than a tool call. (https://dev.meta.ai/docs/tool-calling) [inference]
- `tool_choice` supports only `"auto"`, the default when tools are supplied. `"none"`, `"required"` and named-function choices return HTTP 400. The app must handle both a tool call and plain text. (https://dev.meta.ai/docs/tool-calling)

## Pricing and rate limits

### Token prices (per 1M tokens)

- `muse-spark-1.3`, `muse-spark-1.2` and `muse-spark-1.1` in Standard mode: cached input $0.15, input $1.25, output $4.25. Version 1.1 is Standard only. (https://dev.meta.ai/docs/pricing-rate-limits)
- `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` in Contributor mode: cached input $0.002, input $0.10, output $0.20. (https://dev.meta.ai/docs/pricing-rate-limits)
- `muse-wonder-1.0`, Standard only: cached input $0.20, input $4.00, output $20.00. Contributor mode is "Not available" for Muse Wonder. (https://dev.meta.ai/docs/pricing-rate-limits)
- `muse-wonder-full-1.0` has no per-token price. It is available only by subscription in Muse Code, not on Model API. (https://dev.meta.ai/docs/pricing-rate-limits)
- No per-token price is listed for Muse Code. (https://dev.meta.ai/docs/pricing-rate-limits)
- There is no long-context premium. You pay the same rate whether the context window is mostly empty or almost full. (https://dev.meta.ai/docs/pricing-rate-limits)
- The product page repeats the prices. It labels `muse-spark-1.3-contributor` "Used to improve our products." and `muse-spark-1.3` "Not used to improve our products." (https://dev.meta.ai/products/meta-model-api)
- Wonder is labeled Preview. No stability or SLA is stated for its price or limits. (https://dev.meta.ai/docs/models)
- The `web_search` tool adds $2.50 per 1,000 search queries on top of token cost. It is unavailable under ZDR. (https://dev.meta.ai/docs/pricing-rate-limits)
- Search grounding is Responses-only, so it is not on Chat Completions. (https://dev.meta.ai/docs/protocols/chat-completions)
- The Jul 2026 launch post says pay-as-you-go pricing "starts at $1.25 input/$4.25 output per million tokens". (https://dev.meta.ai/resources/blog/build-with-muse-spark)
- An older Muse Spark 1.2 and Muse Code post confirms the same Standard Spark prices. So they have been stable since the 1.2 launch. (https://dev.meta.ai/resources/blog/build-with-muse-code) [medium]
- Derived arithmetic, assuming the $150 hackathon credit applies at list price: about 120M uncached input tokens or about 35.3M output tokens on `muse-spark-1.3` Standard. On `muse-wonder-1.0`, 37.5M input or 7.5M output. On `muse-spark-1.3-contributor`, 1.5B input or 750M output. At the Spark cached rate, 1B cached input tokens. This is arithmetic, not an official figure. (https://dev.meta.ai/docs/pricing-rate-limits) [medium, inference]

### Billing

- Usage accrues as a balance. The payment method is charged when the balance reaches a payment threshold, which can rise after successful payments. Any remaining balance is charged on the 1st of each month. (https://dev.meta.ai/help/billing/api-bill)
- Meta Model API is pay-as-you-go with no minimums or upfront commitment. No free credits or free tier appear on the billing, sign-up or pricing pages. (https://dev.meta.ai/help/billing/api-bill)
- Billing failures return HTTP 402 with type `billing_error` and code `billing_not_configured`. Causes: insufficient balance, a lapsed payment method or a billing account issue. Do not retry 402. (https://dev.meta.ai/docs/error-handling)
- Meta Model API offers no hard spending cap. It sends only a monthly spend-limit email alert. (https://dev.meta.ai/help/billing/spend-limit-alert)

### Rate limits

- Limits apply per team, not per API key. Requests, tokens and streams from every key in a team count toward the same limits. Each model has its own limits. (https://dev.meta.ai/docs/pricing-rate-limits)
- `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1` and `muse-wonder-1.0`: 3,000 requests per minute and 4,000,000 tokens per minute each. (https://dev.meta.ai/docs/pricing-rate-limits)
- `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor`: 150 requests per minute and 3,000,000 tokens per minute. That is 20x lower RPM than Standard. (https://dev.meta.ai/docs/pricing-rate-limits)
- Other limits: `sam-3.1` 3,000 RPM. `muse-image-1.0` 150 RPM. `muse-voice-transcribe-1.0` has 256 concurrent streams and 16,000 streams per hour. (https://dev.meta.ai/docs/pricing-rate-limits)
- Starting new background responses is capped at 600 submissions per minute per team. Over the cap returns HTTP 429 with `Retry-After`. (https://dev.meta.ai/docs/pricing-rate-limits)
- No tokens-per-day cap or tier system is stated. (https://dev.meta.ai/docs/pricing-rate-limits)
- The Help Center defines TPM as input plus output tokens per minute. It says limits apply per team. (https://dev.meta.ai/help/usage-and-limits/rate-limits)
- The Help Center says per-model limits are on the dashboard Limits page. It describes no process to request higher limits. Otherwise contact support. (https://dev.meta.ai/help/usage-and-limits/rate-limits)
- Every successful token-based response carries `x-ratelimit-limit-requests`, `x-ratelimit-remaining-requests`, `x-ratelimit-limit-tokens` and `x-ratelimit-remaining-tokens`. No window length or reset header is documented. Transcription responses omit them. (https://dev.meta.ai/docs/pricing-rate-limits)
- A 429 has type `rate_limit_error` and code `rate_limit_exceeded`. The example message is "Rate limit exceeded. Please retry after 15 seconds." It includes a `Retry-After` header. (https://dev.meta.ai/docs/error-handling)
- On 429, back off with jitter. Start around 500 ms and double after each consecutive 429. Wait at least `Retry-After` when present. (https://dev.meta.ai/docs/pricing-rate-limits)

## Contributor tier and data terms

### The two modes

- Standard mode charges standard prices. Your content is not used to train Meta models. (https://dev.meta.ai/docs/pricing-rate-limits)
- Contributor mode gives heavily discounted prices. In exchange, Meta may use your prompts, code, files, context and the model responses to train future Meta models. (https://dev.meta.ai/docs/pricing-rate-limits)
- On Model API you select Contributor mode only by calling a `-contributor` model ID. Muse Wonder has no Contributor variant. (https://dev.meta.ai/docs/pricing-rate-limits)
- Contributor variants are unavailable to teams with Zero Data Retention. (https://dev.meta.ai/help/policies-and-privacy/contributor-tier)
- ToS section 6.1 (page dated October 9, 2026): by using Contributor Services you agree Meta may use your Content (Inputs and Outputs) to train, develop, evaluate and improve its AI models, products and services. (https://dev.meta.ai/legal/terms-of-service)
- The Data Commitments page calls the same tier "Discounted Services". It says you may upgrade to Standard Services if you do not want Content used for training. (https://dev.meta.ai/legal/commitments)
- Meta says it takes steps designed to disassociate Contributor Content from your Accounts and API key before training. It may use Content for evaluation, safety, abuse, quality and policy review without first applying those steps. The clause does not say whether humans do that review. (https://dev.meta.ai/legal/terms-of-service)
- Models trained on your Contributor Content may output similar or identical content to third parties. So code sent to a contributor model can resurface for others. (https://dev.meta.ai/legal/terms-of-service)
- Contributor Services offer no way to exclude specific traffic from training. Enforce tier separation by which model ID you call. (https://dev.meta.ai/legal/terms-of-service)
- Do not mix tiers in a pipeline. Content first sent to a Standard model becomes Contributor Content if it appears in any request to a Contributor model, directly or as context. Never pass customer code, or Standard-tier output derived from it, into a `-contributor` request. (https://dev.meta.ai/legal/terms-of-service)
- Contributor Models are Muse Spark 1.2 Contributor and Muse Spark 1.3 Contributor. Standard Models are Muse Image, Muse Spark 1.1, 1.2 and 1.3, Muse Voice Transcribe, SAM 3.1, Muse Wonder and Muse Wonder Full (policy page dated October 12, 2026). (https://dev.meta.ai/legal/terms-of-service)
- The ToS warns that the system may route you to a Contributor Model, and you are responsible for what you use. Pin an explicit model ID on every call and check the model echoed in the response. (https://dev.meta.ai/legal/terms-of-service) [inference]

### Rules for sending code

- VERDICT: sending a customer's code to a Contributor variant is not allowed. ToS 6.2 forbids submitting sensitive, confidential or personal information. It also forbids submitting software code you must keep confidential, including by contract. (https://dev.meta.ai/legal/terms-of-service)
- Use `muse-spark-1.3` or `muse-wonder-1.0` (Standard) for any repo that is not your own synthetic demo code. Reserve `-contributor` variants for the seeded demo repo and public test fixtures you own. (https://dev.meta.ai/legal/terms-of-service) [inference]
- The Help Center repeats the rule under the term Discounted Services. It says to use Standard Services for personal information. (https://dev.meta.ai/help/policies-and-privacy/contributor-tier)
- The Help Center says there are no Discounted-tier-specific geographic restrictions. The Restricted Territories list applies to all Services. (https://dev.meta.ai/help/policies-and-privacy/contributor-tier)

### Retention, review and processing

- Standard mode only promises no training. Meta still retains and processes Standard Content as needed, including when systems flag a possible policy violation. (https://dev.meta.ai/legal/terms-of-service)
- Meta reserves monitoring "including through automated or manual (human) review" for all Services. No retention period in days is stated for Standard or Contributor content. (https://dev.meta.ai/legal/terms-of-service)
- ToS 4.4: Meta retains Content and Usage Data as needed to provide the Services, for legal compliance, to exercise its rights to use Content under the Terms, when systems flag data, and for security, safety, abuse and policy review. (https://dev.meta.ai/legal/terms-of-service)
- Data Commitments for Standard Services: Meta does not train on Standard Content. It may process Content to detect and respond to AUP or Terms violations. Content sits under strict access controls. You can view and delete it in your Account. Traffic uses TLS 1.2 or later. (https://dev.meta.ai/legal/commitments)
- Standard Services come with processor terms. Meta acts as Service Provider or Processor under the Meta Global Processor Terms (MGPT), with a subprocessor list. (https://dev.meta.ai/legal/terms-of-service)
- You own your Inputs and Outputs. Meta claims no ownership of your Content. You warrant you have the rights, including data-protection rights, to submit the Inputs. So third-party customer code needs the customer's permission even on Standard. (https://dev.meta.ai/legal/terms-of-service) [inference]
- Zero Data Retention (ZDR) is for qualified accounts only. Meta enables it at the organization level after a contact-sales request. It cannot be turned on from the web UI. (https://dev.meta.ai/help/policies-and-privacy/zero-data-retention)
- ZDR disables stateful requests, background requests, file uploads, web search and Contributor mode. Flagged requests may still be retained for up to 2 years. Assume a hackathon account does not have ZDR. (https://dev.meta.ai/help/policies-and-privacy/zero-data-retention) [inference]
- On Responses, requests are stored server-side by default (`store: true`), including streamed ones. For customer code send `store: false` and replay context yourself. (https://dev.meta.ai/docs/protocols/responses)
- The Chat Completions guide says the API does not retain conversation state between requests. It does not state Meta's backend logging or retention for that endpoint. (https://dev.meta.ai/docs/protocols/chat-completions)

### Muse Code subscription default

- ToS 3.3: access through a Coding Harness Subscription counts as Contributor Services by default, regardless of the model you select. (https://dev.meta.ai/legal/terms-of-service)
- For subscription logins, headless runs follow the saved Contributor setting, which can be on. Set `--contributor-mode off` or `MUSE_CONTRIBUTOR_MODE=0` on every scripted run. (https://dev.meta.ai/docs/muse-code/subscriptions)
- The Contributor mode setting does not appear under pay-as-you-go billing or ZDR. Do not point a default-configured Muse Code subscription at customer code. (https://dev.meta.ai/docs/muse-code/subscriptions)

### Acceptable use

- The AUP prohibits identifying, scanning for or exploiting vulnerabilities in any system, network or application without authorization from its owner. (https://dev.meta.ai/legal/acceptable-use-policy)
- The AUP bans tools designed primarily for offensive cyber operations. A defensive scanner is not designed primarily for offense, but keep exploitability reasoning defensive. (https://dev.meta.ai/legal/acceptable-use-policy) [inference]
- The AUP bans creating or generating malicious code, malware or cyberattack tooling. Keep proof-of-risk reports and patches free of weaponized exploit code. (https://dev.meta.ai/legal/acceptable-use-policy) [inference]
- Meta may grant AUP exceptions for legitimate cybersecurity research at its sole discretion. Contact `aup_exceptions@meta.com`. (https://dev.meta.ai/legal/acceptable-use-policy)

### Promotional credits and indemnity

- ToS 13.3 defines promotional credits as non-cash, and they may expire. ToS 17.2 limits Meta's IP indemnity to Standard Services used "not through promotional credits". So usage paid from hackathon credits is outside that indemnity. (https://dev.meta.ai/legal/terms-of-service)

## Muse Code headless

### Install

- Windows (PowerShell, native, no WSL): `irm https://dev.meta.ai/install.ps1 | iex`. Confirm with `muse --version`. (https://dev.meta.ai/docs/muse-code)
- macOS and Linux per the overview: `curl -fsSL https://dev.meta.ai/install.sh | sh`. (https://dev.meta.ai/docs/muse-code)
- The SDK docs use `curl https://dev.meta.ai/install.sh | bash`. It puts a checksum-verified launcher in `~/.local/bin` and keeps it up to date. (https://meta-models.github.io/muse-code-sdk/1.4/guides/quickstart/)
- The `| sh` form breaks under dash, the `/bin/sh` of Debian and Ubuntu images. Use `| bash` in Dockerfiles. A local test with a stubbed curl showed dash print `[[: not found` and exit 1. (https://dev.meta.ai/install.sh)
- `install.sh` needs `curl` and `mktemp`. It installs a launcher named `muse` in `${MUSE_INSTALL_DIR:-$HOME/.local/bin}`. It edits shell profiles unless `MUSE_NO_MODIFY_PATH` is set. The launcher then downloads the real binary beside itself. (https://dev.meta.ai/install.sh)
- `install.ps1` needs PowerShell 5.1 or newer. It installs to `%LOCALAPPDATA%\Programs\muse` (override with `MUSE_INSTALL_DIR`). It writes a `muse.cmd` shim plus `.muse-launcher.ps1` and edits the user PATH unless `MUSE_NO_MODIFY_PATH` is set. (https://dev.meta.ai/install.ps1)
- The live `install.ps1` returned HTTP 200 `text/plain` with Last-Modified 2026-10-26. (https://dev.meta.ai/install.ps1)
- On Windows the `muse` on PATH is a cmd shim that runs `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .muse-launcher.ps1 %*`. The real executable is `muse-bin-<version>.exe` in the same folder. The active version is in `.muse-version`. (https://api.meta.ai/muse-launcher.ps1)
- Known bug: the installer run from PowerShell 7 failed in 1.4.2, because the shim launched Windows PowerShell 5.1 with pwsh's `PSModulePath`. Issue 68 is still open. The launcher served on 2026-10-26 computes SHA256 with .NET, so it is probably fixed. Run the installer from `powershell.exe` to avoid it. (https://github.com/meta-models/muse-code-sdk)
- Downloads need no login. On 2026-10-26 the `muse-stable` manifest returned HTTP 200 with no auth (version 1.4.13-R6996.1, state public). Range requests on the x86_linux and x86_windows artifacts returned 200 and 206 without an Authorization header. (https://api.meta.ai/muse-code/channels/muse-stable)
- Artifacts: x86_macos, aarch64_macos, x86_linux (400,902,488 bytes), aarch64_linux, universal_macos_pkg, x86_windows (`muse-x86-windows.exe`, 419,535,608 bytes) and aarch64_windows. (https://api.meta.ai/muse-code/channels/muse-stable)
- The Linux release binaries are statically linked ELF executables (ET_EXEC, no PT_INTERP, no PT_DYNAMIC). They need no dynamic loader or glibc to start. (https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.13-R6996.1&file=muse-x86-linux)
- Windows x64 and ARM64 binaries exist, so native Windows is supported. (https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=1.4.13-R6996.1&file=manifest.json)
- Muse Code runs on macOS, Linux and Windows from one codebase. On Windows the agent shell is PowerShell, not Bash. Voice input and session messaging are unavailable on Windows. (https://dev.meta.ai/docs/muse-code)
- The first Windows sandbox initialization can show a UAC prompt. Normal use does not need an administrator terminal. Run `muse` once interactively before unattended use. (https://dev.meta.ai/docs/muse-code) [inference]

### Updates and versions

- The launcher auto-updates from `muse-stable` (interval `MUSE_UPDATE_INTERVAL_SECONDS`, default 3600). `MUSE_CHANNEL` can pick `muse-canary`. `MUSE_NO_AUTO_UPDATE=1` stops updates. `MUSE_SYNC_UPDATE=1` forces a synchronous update. (https://api.meta.ai/muse-launcher.sh)
- For a frozen hackathon environment, set `MUSE_NO_AUTO_UPDATE=1` after installing. (https://api.meta.ai/muse-launcher.sh) [inference]
- New CLI releases arrive every few days: 1.4.8 on 2026-10-14, 1.4.11 on 10-19, 1.4.12 on 10-22 and 1.4.13 on 10-24. Flags and the `--json` stream can change inside the hackathon window. The official changelog carries no dates. (https://docs.rs/crate/muse-codes/latest/source/CHANGELOG.md) [medium]
- Launcher prerequisites: `curl`, `date`, `mktemp`, `uname`, `wc`, and `sha256sum` or `shasum`. Linux x86_64 and arm64 only. (https://api.meta.ai/muse-launcher.sh)
- Hosts used: `api.meta.ai` (launcher and channel manifest), `lookaside.facebook.com` (release manifest and binaries) and `auth.meta.com` (device login only). The model-call endpoint is not stated in the Muse docs. (https://api.meta.ai/muse-launcher.sh)

### Auth

- Non-interactive auth is the `META_API_KEY` environment variable. (https://dev.meta.ai/docs/muse-code)
- Precedence: `META_API_KEY`, then a stored key, then a stored browser session. (https://dev.meta.ai/docs/muse-code/auth)
- Official CI example: `META_API_KEY="$MUSE_KEY" muse exec "Run the test suite and summarize failures."` (https://dev.meta.ai/docs/muse-code/auth)
- `muse logout` clears stored credentials. It does not unset an exported `META_API_KEY`. (https://dev.meta.ai/docs/muse-code/auth)
- Muse Code does not read `MODEL_API_KEY`. The OpenClaw plugin passes the key to Muse as `META_API_KEY`. (https://docs.openclaw.ai/plugins/muse.md) [medium]
- A key from the Model API dashboard is the key to export as `META_API_KEY`. (https://docs.e2b.dev/agents/muse) [medium]
- From 1.4.0, `muse auth set` writes to the OS keychain by default and fails where none exists. `TBH_CREDENTIAL_BACKEND=file` keeps the plain `auth.json` store. In CI, skip `muse auth set` and use `META_API_KEY`. (https://docs.rs/crate/muse-codes/latest/source/CHANGELOG.md) [medium]
- A third-party post says `muse auth set --api-key-stdin` reads the key from stdin. It is not on any official page. (https://qainsights.com/getting-started-with-muse-code-cli-commands-syntax-and-purpose/) [medium]
- Saved credentials live in `~/.config/muse/auth.json`. `XDG_CONFIG_HOME` is honored. `MUSE_AUTH_PATH` overrides it in the launcher. On Windows the path is `%USERPROFILE%\.config\muse\auth.json`. (https://api.meta.ai/muse-launcher.ps1)
- A Muse Code subscription credential works with the Muse Code CLI only. Any other API key is billed pay-as-you-go. (https://dev.meta.ai/docs/muse-code/subscriptions)

### Running headless

- `muse exec "<prompt>"` runs one prompt to completion and exits. Agent output goes to stdout. (https://dev.meta.ai/docs/muse-code)
- Documented forms: a positional prompt, `--prompt-file <path>`, and `--json` for JSONL events on stdout. (https://dev.meta.ai/docs/muse-code/extending)
- Headless-only flags: `--json`, `--prompt-file <path>` and `--max-model-steps <n>`. `--model <id>` works on the TUI and on `muse exec`. (https://dev.meta.ai/docs/muse-code/configuration)
- `--reasoning-effort` (alias `--effort`) takes none, minimal, low, medium, high (default), xhigh, max or ultra. The Meta provider does not accept none. (https://dev.meta.ai/docs/muse-code/configuration)
- No `cd` flag is documented. `--workspace <path>` roots the policy-gated workspace tools. The default is probably the process current directory, so set cwd to the checkout. (https://dev.meta.ai/docs/muse-code/configuration) [medium, inference]
- `--max-model-steps <n>` stops a stuck task from looping. `--max-tool-output-bytes <n>` caps tool output (0 disables the cap). No token or dollar budget flag is documented. (https://dev.meta.ai/docs/muse-code/extending)
- `--output-schema <FILE>` makes the final answer schema-shaped JSON. It works with the Meta provider only. (https://dev.meta.ai/docs/muse-code/changelog)
- `-c key=value` is repeatable. It sets any existing setting for that run only, including MCP servers. (https://dev.meta.ai/docs/muse-code/changelog)
- `--disable-write` and `--disable-shell` stop the model being offered those tools. `--disable-reminders` runs without reminder agents. (https://dev.meta.ai/docs/muse-code/changelog)
- `--disable-request-user-input` keeps an unattended run from stopping to ask. As of 1.4.13, `--yolo` no longer withholds the question tool, so add this flag too. (https://dev.meta.ai/docs/muse-code/changelog)
- With no interactive terminal, a first run on a new workspace stops and names `--trust-workspace`. Fresh checkouts need `--trust-workspace` or `--yolo`. (https://dev.meta.ai/docs/muse-code/changelog)
- `muse exec --session-id <uuid> "<prompt>"` continues a session. A workspace mismatch is refused unless `--allow-workspace-switch` is passed. `muse resume` is interactive only. (https://dev.meta.ai/docs/muse-code/extending)
- Session logs go to `<data dir>/sessions/YYYY/MM/DD/<session id>/session.jsonl`. The data dir is `~/.local/share/muse`. `--no-session-log` disables retention and resume. (https://meta-models.github.io/muse-code-sdk/1.4/guides/host-operations/)
- `--allow-workspace-switch` requires `--session-id`. `--no-session-log` conflicts with `--session-id`. (https://docs.rs/crate/muse-codes/latest/source/CHANGELOG.md) [medium]

### Output and usage

- `--json` emits an event-sourced JSONL journal on stdout, one envelope per line. Meta publishes no official schema for it. (https://docs.rs/crate/muse-codes/latest/source/README.md) [medium]
- The final answer is the text of the `run.terminal.*` record. With `--output-schema` the conforming JSON arrives there. (https://docs.rs/muse-codes/latest/muse_codes/io/struct.RunTerminal.html) [medium]
- `muse exec --json` prints a `run.usage` line before each run ends, with token usage per model. (https://dev.meta.ai/docs/muse-code/changelog)
- The `tool.result` record has an `edit_facts` field with an undocumented shape. It is not a confirmed source of diffs. (https://docs.rs/muse-codes/latest/muse_codes/io/struct.ToolResult.html) [medium]
- `muse serve` is the official structured interface (Muse Session Protocol over stdio). `muse schema` prints its JSON schema. The TypeScript SDK is `npm install @muse-code/sdk`. (https://dev.meta.ai/docs/muse-code)
- A wire-level guide covers building a client without the SDK. The SDK needs Node 20 or newer. (https://meta-models.github.io/muse-code-sdk/1.4/guides/quickstart/)
- The SDK uses plain `child_process.spawn` with no shell. So `museBin` must be a real executable. On Windows that is `muse-bin-<version>.exe`, not the `muse.cmd` shim. (https://raw.githubusercontent.com/meta-models/muse-code-sdk/main/clients/sdk-ts/src/connection/spawn.ts)
- Only the session protocol gives structured edits. Edit `toolCall` items carry `patchRef` and a `PatchSummary`. The patch body comes from `item/readOutput`. This is not documented for `muse exec --json`. (https://meta-models.github.io/muse-code-sdk/1.4/generated/msp/types/patchsummary/)
- `muse serve` has no approval flag. Approval mode is chosen per session over the wire. (https://meta-models.github.io/muse-code-sdk/1.4/guides/host-operations/)

### Approvals, sandbox and trust

- A headless run cannot answer approval prompts. Choose a policy up front. `muse exec` accepts `--approval-mode`, `--approval-judge`, `--disable-approval` and `--yolo`. (https://dev.meta.ai/docs/muse-code/configuration)
- `--disable-approval` skips approval prompts and keeps the sandbox on. (https://dev.meta.ai/docs/muse-code/extending)
- `--yolo` disables approval and the sandbox, and trusts the workspace. Use it only on trusted code in a disposable, isolated container. (https://dev.meta.ai/docs/muse-code/extending)
- `--approval-mode` takes `on-request` (default), `untrusted` or `never`. With `never`, the sandbox alone contains what runs. (https://dev.meta.ai/docs/muse-code/permissions)
- New sessions default to the Auto-review profile. Its reviewer falls back to asking a human when unavailable, and a human cannot answer in `muse exec`. Pass explicit approval flags. (https://dev.meta.ai/docs/muse-code/permissions)
- `--disable-sandbox` keeps approval but removes the sandbox. File tools can write anywhere, and the network goes to full egress. (https://dev.meta.ai/docs/muse-code/permissions)
- `--sandbox-network` takes `proxy-only` (default), `restricted` (no network) or `unrestricted`. (https://dev.meta.ai/docs/muse-code/permissions)
- A command that needs the network can fail with a proxy 502 when nothing can approve the destination. Official recovery is `--disable-sandbox` or `--yolo`. (https://dev.meta.ai/docs/cookbook/contained-execution)
- With approvals off, `unrestricted` or `restricted` network makes behavior explicit without dropping the filesystem sandbox. How `proxy-only` behaves with approvals off is not documented. (https://dev.meta.ai/docs/muse-code/permissions) [low, inference]
- Official recipe for an approval-free run that keeps the sandbox: `--disable-approval --trust-workspace`. (https://dev.meta.ai/docs/cookbook/contained-execution)
- The sandbox keeps `.git`, `.muse` and `.agents` read-only inside the writable workspace. (https://dev.meta.ai/docs/muse-code/permissions)
- On Linux CI and containers the sandbox needs a working bubblewrap and a non-musl build. Without it, every sandboxed shell command aborts. (https://dev.meta.ai/docs/muse-code/extending)
- If the sandbox cannot be enforced, shell commands fail rather than run unsandboxed. Running without it is the explicit `--disable-sandbox` choice. (https://meta-models.github.io/muse-code-sdk/1.4/guides/host-operations/)
- Trusting a workspace loads the repo's own skills, rules and hooks. Hooks run outside the sandbox and approval system. (https://dev.meta.ai/docs/muse-code/permissions)
- On a pull-request or fork checkout, the checkout's `AGENTS.md`, rules and skills are attacker-controlled instructions. (https://dev.meta.ai/docs/muse-code/permissions)
- Never use `--yolo` on a workstation with access to real credentials or infrastructure. (https://dev.meta.ai/docs/muse-code/permissions)
- Committed project memory is read into context even in an untrusted workspace. Treat a repo's `MEMORY.md` as a prompt-injection surface. (https://dev.meta.ai/docs/muse-code/configuration)
- For GitHub-URL intake, delete or exclude `.muse/`, `.agents/`, `.claude/`, `.codex/`, `AGENTS.md` and `CLAUDE.md` before a trusted run. Run inside a throwaway container or VM with network limits. This is not an official procedure. (https://dev.meta.ai/docs/muse-code/permissions) [medium, inference]
- E2B's prebuilt template runs `muse exec --yolo` and relies on the outer sandbox. Restrict outbound traffic yourself. (https://docs.e2b.dev/agents/muse) [medium]
- OpenClaw's live test lane runs the real `muse` binary in disposable Docker containers. (https://docs.openclaw.ai/plugins/muse.md) [medium]
- No official Muse Code Docker image, Dockerfile or GitHub Action was found in the `meta-models` org. (https://api.github.com/orgs/meta-models/repos)
- The official CI template only runs `muse --version`. You supply the install step. (https://dev.meta.ai/docs/cookbook/deterministic-replay)

### Branches, worktrees and diffs

- Edits happen in place by default. Sessions in one directory share a working copy. (https://dev.meta.ai/docs/muse-code/session-messaging)
- Bare `-w` creates a managed worktree from HEAD for the session. (https://dev.meta.ai/docs/muse-code/session-messaging)
- Subagent worktrees sit under `<repo>/.muse/worktrees/` in detached-HEAD state, so no branch name is created. (https://dev.meta.ai/docs/cookbook/subagent-fanout)
- Muse Code does not commit, amend or push unless asked in the session. The end of a task is not a request to commit. (https://dev.meta.ai/docs/muse-code/configuration)
- No flag to commit to a named branch was found. Create and check out the branch before `muse exec`, and commit afterward from your own script. The sandbox keeps `.git` read-only. (https://dev.meta.ai/docs/muse-code/extending) [medium, inference]
- Rewind changes conversation history only. It does not restore workspace files. Use source control. (https://dev.meta.ai/docs/muse-code/rewind)
- Practical diff capture: run `muse exec` in the repo, then `git diff`. (https://docs.e2b.dev/agents/muse) [medium]

### Settings, models and cost

- User settings live at `~/.config/muse/settings.json`. `XDG_CONFIG_HOME` moves it. Trust decisions are in `trust.json` beside it. (https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/)
- `settings.json` must contain `"schema_version": 1`. A missing file is fine. (https://dev.meta.ai/docs/muse-code/configuration)
- No project-level settings file is documented. Project instructions travel with the repo (`AGENTS.md`, `.agents/memory/`, `.muse/hooks.json`, `.agents/skills`). (https://dev.meta.ai/docs/muse-code/configuration)
- MCP servers go under `mcp_servers` in settings. A server's mode defaults to required, so a failed required server aborts the run. (https://dev.meta.ai/docs/muse-code/extending)
- Exit codes: 0 turn completed, 1 failed or cancelled (including `--max-model-steps`), 2 usage error, 130 or 143 on SIGINT or SIGTERM. (https://dev.meta.ai/docs/muse-code/extending)
- Exit 0 does not mean the work is correct. Gate on your own test command. (https://dev.meta.ai/docs/muse-code/extending)
- A failed run prints the recorded failure reason on its final stderr line. (https://dev.meta.ai/docs/muse-code/changelog)
- The docs state the Muse Code default model is `muse-spark-1.2`. (https://dev.meta.ai/docs/muse-code/configuration)
- Usable in Muse Code on pay-as-you-go: `muse-spark-1.3`, `muse-spark-1.3-contributor`, `muse-spark-1.2`, `muse-spark-1.2-contributor` and `muse-wonder-1.0`. Spark 1.1 is not available. (https://dev.meta.ai/docs/models)
- Four observer agents (memory recall, skill recall, goal tracking, verification) are on by default. Each makes its own model calls. (https://dev.meta.ai/docs/muse-code/extending) [medium]
- `MUSE_TRANSPORT_TRACE=1` prints raw provider request and response lines to stderr with credentials scrubbed. (https://dev.meta.ai/docs/muse-code/configuration)
- `--provider echo` runs without credentials, for smoke-testing a harness. (https://docs.rs/crate/muse-codes/latest/source/README.md) [medium]

### Node on Windows

- Node cannot launch a `.cmd` shim without a shell. On Node v24.22.1 with a stand-in `.cmd`, `spawnSync('name')` gave ENOENT, `spawnSync('x.cmd')` gave EINVAL, and `shell: true` worked. An argument with `&` and quotes was split by cmd.exe. (https://nodejs.org/api/child_process.html)
- Spawn the real `muse-bin-<version>.exe` with an args array. Pass long or special prompts with `--prompt-file`. (https://api.meta.ai/muse-launcher.ps1) [medium, inference]

### Untested compositions

- Linux or Docker: set `META_API_KEY` and `MUSE_NO_AUTO_UPDATE=1`, set cwd to the checkout, then run the command below. Use `--yolo` instead of `--disable-approval` only in a disposable container. Create the branch first and run `git diff` and `git commit` outside Muse. The trust fact above still applies. (https://dev.meta.ai/docs/muse-code/extending) [low, untested]

```
muse exec --prompt-file task.txt --json --model muse-spark-1.3 --disable-request-user-input --max-model-steps 40 --disable-approval
```

- Windows 11: spawn `muse-bin-<version>.exe` from `%LOCALAPPDATA%\Programs\muse` with cwd set to the checkout. Set `META_API_KEY` and `MUSE_NO_AUTO_UPDATE=1`. Pass `exec --prompt-file task.txt --json --model muse-spark-1.3 --disable-approval --trust-workspace --disable-request-user-input --max-model-steps 40` and an explicit `--sandbox-network` value. (https://dev.meta.ai/docs/muse-code/extending) [low, untested]

## Open-weight triage options

### Where open weights run

- Muse Spark Open is 816B total and 42B active parameters. It is about 537 GB in NVFP4 and about 1.65 TB in BF16. It cannot run on a laptop. (https://dev.meta.ai/docs/muse-spark-open)
- Muse Glimmer is the 30B open-weight model for local and edge use. (https://dev.meta.ai/docs/muse-spark-open)
- Spark Open takes text, image, audio and video in, and text out. Context is up to 1M tokens. (https://huggingface.co/blog/meta-muse-spark-open)
- Meta lists these Spark Open hosts: Together AI and Baseten (`meta-models/muse-spark-open`), Fireworks (`accounts/fireworks/models/muse-spark-open`), Groq (needs organization approval) and Nebius Token Factory. It mentions Modal and OpenRouter in one sentence. (https://dev.meta.ai/docs/muse-spark-open/deploy)
- Meta's Glimmer page lists exactly one hosted provider: Together AI, model string `meta-models/Muse-Glimmer-30B`. (https://dev.meta.ai/docs/muse-glimmer/deploy)

### Research pick

- The simplest provider for a plain Node `fetch()` is OpenRouter. It has one URL (`POST https://openrouter.ai/api/v1/chat/completions`), one bearer key and the model string `meta/muse-glimmer-30b`. The same key also reaches `meta/muse-spark-open` and the closed Muse Spark models. (https://openrouter.ai/docs/quickstart) [medium]
- Pin DeepInfra, because OpenRouter's Together endpoint for Glimmer showed 0% uptime at research time. The runner-up is DeepInfra direct. The free prototyping option is NVIDIA. (https://openrouter.ai/docs/quickstart) [medium]
- Suggested body, never run. A top-level `reasoning_effort` is also listed as supported. The `deepinfra` slug is assumed from the tag `deepinfra/bf16`. (https://openrouter.ai/docs/quickstart) [medium, untested]

```json
{
  "model": "meta/muse-glimmer-30b",
  "messages": [],
  "temperature": 1,
  "top_p": 0.95,
  "top_k": 64,
  "reasoning": {"effort": "low"},
  "max_tokens": "<generous cap>",
  "response_format": {"type": "json_schema", "json_schema": {"name": "<name>", "strict": true, "schema": {}}},
  "provider": {"order": ["deepinfra"], "allow_fallbacks": false, "require_parameters": true}
}
```

### OpenRouter

- Glimmer ID is `meta/muse-glimmer-30b` (canonical slug `meta/muse-glimmer-30b-20260810`). Price is $0.30 input, $1.20 output and $0.04 cache read per 1M. Context is 131072. (https://openrouter.ai/api/v1/models)
- Two endpoints serve it. DeepInfra (`deepinfra/bf16`, $0.30/$1.20, max completion 16384) and Together ($0.35/$1.50, max completion 117964). Both list `response_format`, `structured_outputs`, `tools`, `reasoning` and `reasoning_effort`. (https://openrouter.ai/api/v1/models/meta/muse-glimmer-30b-20260810/endpoints)
- Defaults are temperature 1, top_p 0.95 and top_k 64. Reasoning is mandatory, with efforts xhigh, high, medium and low. The default effort is medium. (https://openrouter.ai/api/v1/models)
- `json_schema` shape is `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`. Set `provider.require_parameters` true to avoid an endpoint that ignores it. (https://openrouter.ai/docs/guides/features/structured-outputs)
- Provider routing fields: `order`, `allow_fallbacks` (default true) and `require_parameters` (default false). (https://openrouter.ai/docs/guides/routing/provider-selection)
- Reasoning tokens are billed as output tokens. On most providers they count against `max_tokens`. (https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- Spark Open on OpenRouter: ID `meta/muse-spark-open`, $1.25 input, $4.25 output and $0.15 cache read per 1M, 1,048,576 context. (https://openrouter.ai/api/v1/models/meta/muse-spark-open-20261015/endpoints)
- OpenRouter lists the closed `meta/muse-spark-1.3-contributor` at $0.10 input and $0.20 output. That is cheaper than hosted Glimmer, but it trains on content. See the Contributor section. (https://openrouter.ai/api/v1/models) [medium]

### Other providers

- Together catalog row for Glimmer: $0.35 input, $0.04 cached, $1.50 output, FP8, context 131072, function calling and structured outputs yes. (https://docs.together.ai/docs/serverless-models)
- Together's own base URL is `https://api.together.ai/v1`. It also documents `us-api.together.ai` and `ca-api.together.ai` at 1.25x serverless rates. (https://docs.together.ai/docs/openai-api-compatibility)
- Meta's docs use the older host `https://api.together.xyz/v1/chat/completions`. (https://dev.meta.ai/docs/muse-glimmer/deploy)
- Together's JSON schema shape is `response_format {type: "json_schema", json_schema: {name, schema}}`. (https://docs.together.ai/docs/json-mode) [medium]
- On 2026-10-26, OpenRouter showed Together unhealthy for Glimmer (status -5, 0 percent uptime in the last 30 and 5 minutes). DeepInfra showed 100 percent. (https://openrouter.ai/api/v1/models/meta/muse-glimmer-30b-20260810/endpoints) [medium]
- Hugging Face's router lists only featherless-ai and deepinfra for Glimmer. DeepInfra shows $0.3 in, $1.2 out, first token 2648 ms and about 21.6 tokens per second. (https://router.huggingface.co/v1/models) [medium]
- DeepInfra direct: `https://api.deepinfra.com/v1/openai/chat/completions`, model `meta-models/Muse-Glimmer-30B`, bearer key. (https://deepinfra.com/meta-models/Muse-Glimmer-30B/api)
- DeepInfra's own sampling defaults (temperature 0.7, top_p 0.9) differ from Meta's. Send all three Meta values explicitly. (https://deepinfra.com/meta-models/Muse-Glimmer-30B) [medium]
- Fireworks: Glimmer serverless was deprecated from September 25, 2026. Only on-demand deployment remains. (https://fireworks.ai/models/fireworks/muse-glimmer-30b)
- Fireworks serves Spark Open serverless at $1.25 input, $0.15 cached and $4.25 output per 1M. (https://fireworks.ai/models/fireworks/muse-spark-open)
- Baseten lists no Glimmer. Its Spark Open does not support structured outputs or JSON mode. Base URL is `https://inference.baseten.co/v1`. (https://docs.baseten.co/development/model-apis/overview)
- Groq serves Spark Open only, as a limited preview that needs organization approval. (https://console.groq.com/docs/model/meta-models/muse-spark-open)
- Nebius serves Spark Open at $1.25 input and $4.25 output per 1M. (https://nebius.com/blog/posts/three-new-open-weight-models-from-us-companies-give-builders-more-choice)
- Modal offers Glimmer only as a Dedicated Endpoint, billed by the second of compute. (https://modal.com/library/meta/muse-glimmer-30b-bf16)
- Modal offers Spark Open on a pay-per-token Shared Endpoint. (https://modal.com/library/meta/muse-spark-open)
- NVIDIA hosts Glimmer on a free prototyping API at `https://integrate.api.nvidia.com/v1`, model `meta/muse-glimmer-30b`. (https://build.nvidia.com/meta/muse-glimmer-30b) [medium]

### Local Ollama

- `ollama run muse-glimmer` pulls the 18GB `latest` tag. It is the same image as `30b` and `30b-q4_K_M`. Context is 128K. (https://ollama.com/library/muse-glimmer)
- Other tags run from 17GB (`30b-nvfp4`) to 65GB (`30b-mlx-bf16-dflash`). The `dflash` tags bundle a speculative-decoding drafter. (https://ollama.com/library/muse-glimmer/tags)
- Glimmer needs Ollama 0.32.7 or later. Local API: `http://localhost:11434/v1/chat/completions` with a placeholder key. (https://dev.meta.ai/docs/muse-glimmer/deploy)
- Ollama's `/v1` lists `response_format` and JSON mode, but `tool_choice` is unsupported. (https://docs.ollama.com/api/openai-compatibility)
- For schema-constrained output, use the native `/api/chat` endpoint and put the JSON Schema in `format`. (https://docs.ollama.com/capabilities/structured-outputs)

### Glimmer behavior and license

- Model card sampling: temperature 1.0, top_p 0.95, top_k 64. (https://huggingface.co/meta-models/Muse-Glimmer-30B)
- Do not run Glimmer greedy. `temperature: 0` overrides the published settings. If you set sampling, send all three values. (https://dev.meta.ai/docs/muse-glimmer/deploy)
- Reasoning strength levels are low, medium, high and xhigh. The model card sets them with a `Reasoning strength: <value>` system prompt line. Hosted APIs use `reasoning_effort`. (https://huggingface.co/meta-models/Muse-Glimmer-30B)
- Meta's guide says the default strength is high. OpenRouter's catalog says medium. (https://dev.meta.ai/docs/muse-glimmer/prompting) [medium]
- Too small a `max_tokens` clips the model mid-reasoning before the final answer. Glimmer supports one tool call per turn. (https://dev.meta.ai/docs/muse-glimmer/prompting)
- Never stop on `<|eom|>` (200007). Hosted providers set stop tokens themselves. (https://dev.meta.ai/docs/muse-glimmer/deploy)
- Glimmer is Apache 2.0, for all released artifacts. Release was August 2026. (https://huggingface.co/meta-models/Muse-Glimmer-30B)
- The repo `LICENSE` is byte-identical to the official Apache 2.0 text (11,358 bytes). (https://huggingface.co/meta-models/Muse-Glimmer-30B/raw/main/LICENSE)
- The repo also ships `USAGE_POLICY.md`. Item 1.7 bars creating malicious code or malware. It is not stated to be a license term. (https://huggingface.co/meta-models/Muse-Glimmer-30B/raw/main/USAGE_POLICY.md) [medium]
- NVIDIA's hosted trial is governed by the NVIDIA Open Model Agreement. The base model is Apache 2.0. (https://build.nvidia.com/meta/muse-glimmer-30b)

### Spark Open license and settings

- Spark Open recommended settings: temperature 1.0, top_p 1.0, top_k disabled. Default reasoning effort is xhigh. Reasoning cannot be turned off. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- Meta's prompting guide maps effort to strengths: low 8, medium 32, high 256 and xhigh 512. Other values such as `none` or `max` are rejected. (https://dev.meta.ai/docs/muse-spark-open/prompting) [medium]
- The Muse Model License grants broad rights, including fine-tune and distill. It is not Apache 2.0. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- Condition 2: show "Built with Muse Spark Open" in the product UI, docs, website or settings. Adding it to the README and demo UI is cheap insurance. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B) [inference]
- Condition 3: a Model-as-a-Service business above US$20 million gross revenue in any 12 months needs a separate agreement. It does not apply to internal use, research, non-MaaS commercial activity, or using the model inside your own product. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- "Derivatives" include any model trained or improved using the Software or its outputs. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- The Usage Policy is incorporated into the license as Exhibit A. It prohibits creating malicious code or malware. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- Downloading Spark Open weights from Hugging Face is gated behind a legal-identity form. Hosted API use does not need it. Glimmer weights are not gated. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)

## Hackathon rules and submission

### Dates and submission

- Project submissions are due Wed Nov 4, 2026 at 9:00 PM ET. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
- US daylight time ended Sun Nov 1, so that moment is EST, or Thu Nov 5 02:00 UTC. The conversion was computed in the research. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon) [inference]
- The Cerebral Valley (CV) markdown view says "submissions due Nov 5, 2026 UTC". (https://cerebralvalley.ai/e/meta-ai-developer-hackathon.md)
- The CV page data carries a 6-hour grace-period setting. No public rule explains it. Treat 9:00 PM ET Nov 4 as the hard deadline. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [low]
- Judging runs Nov 4 to Nov 8. The closing ceremony and winners are Nov 9. Workshops and Discord office hours run Oct 27 to Nov 4. Dates can change at Meta's discretion. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
- Submit through the CV portal at `https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit`. Logged out, it redirects to login, so the form fields were not seen. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The rules score the demo video within the 25% Demo criterion. They give no maximum length, host or "required" wording. The 3-minute cap in the brief is not on any public official page. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)

### Eligibility, tracks and originality

- Open to individual builders, students and teams of up to four. The Representative lists other team members. No team-size cap is stated for the Startup track. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- A participant may apply for one track only, and a submission may enter one track only. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The Startup track is "Open to technical founders building a product". The Representative must be an active employee of the startup. "Startup" is not defined. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [medium]
- Meta's Connect recap calls it a track for "startup teams". No page bars a one-person startup, and none confirms it. (https://developers.meta.com/blog/meta-connect-recap/) [medium]
- Meta describes the Startup track as for teams and founders building a real product, judged on technical execution and production readiness. (https://dev.meta.ai/events/global-hackathon)
- No "built during the hackathon window" rule and no prior-work disclosure mechanism appears in the published rules. A new-work-only rule is not confirmed. The CONTRIBUTIONS.md split is a safe superset. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [medium]
- A Submission must be original work, solely owned, and must not violate third-party IP or privacy rights. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Open source may be included if its licenses are followed and the Submission builds upon it. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)

### Judging, prizes and Meta tooling

- Judging weights: Impact 30%, Use of Meta AI Tooling 25%, Demo 25%, Technical Depth and Execution 20%. No separate Startup weights are published. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Startup prizes (track total $550,000): 1st $250,000, 2nd $150,000, 3rd $75,000, 4th $50,000, 5th $25,000. They are awarded only after eligibility verification. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Up to $50,000 in bonus prizes may be added. The anticipated pool is $1,000,000. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Payout needs verified eligibility, the signed waiver and rules, and a W-9 (US resident) or W-8BEN. Payment follows within 30 days of verification and documents. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Participants build with Meta AI products: Muse Spark, Glimmer, SAM 3 and others named on the Event page. No minimum Meta-model usage was found as an eligibility condition. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The Event page names the Muse Spark series, Muse Wonder, Muse Image and SAM 3.1 via Model API, Meta open-weights models, and Muse Code. The dev.meta.ai copy omits Muse Wonder from its body text. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
- Muse Code is listed as a build tool. No text says that using it only as a dev tool earns Meta-tooling credit. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon) [medium]
- Glimmer, named in the rules, is a 30B open-weight model per Meta's blog. (https://dev.meta.ai/resources/blog/build-with-muse-glimmer/)

### Credits

- Selected participants get $150 in Meta Model API credits. The $150 is in the Official Rules and Credit Terms, not on the CV event page body or the dev.meta.ai event page. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Meta's Connect recap says only "free Model API credits", with no amount. (https://developers.meta.com/blog/meta-connect-recap/)
- Credit Terms 3.1: Meta applies USD $150 in promotional credits. They have no cash value and are not transferable. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The Claim Form runs from the "know before you go" email until Nov 4, 2026 at 9:00 PM ET, the same moment submissions are due. It needs your name, application email and Model API Team ID. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- One claim per participant and one grant per Account. A solo builder gets one $150 grant. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Credits arrive within two business days of a valid claim, in batches. A claim on Monday Oct 26 lands by about Wednesday Oct 28. Do not schedule real-model tests before then. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [inference]
- A valid payment method is required before any Model API use. This is not a condition of entering. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Credits apply to any use permitted under the API Terms and AUP. No model restriction is stated. They are used before any other payment method. After they run out, usage bills the card at standard pricing. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Participation is free and credits are optional. You may build with Meta's open-weight models without a Model API account. Spending beyond credits never affects judging. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The Credit Terms supplement the Model API Terms and AUP, so AUP limits apply to any project calling the Model API. (https://scontent-lax3-2.xx.fbcdn.net/v/t39.8562-6/863382756_2547674092403265_4283663620107745955_n.pdf?_nc_cat=100&ccb=1-7&_nc_sid=e280be&_nc_ohc=EFQ5LeXZ-MUQ7kNvwHvDcx5&_nc_oc=AdoeGNY4W4j-EwTQuNla2mB6lsljXHjwGGXr5Sl9p-70H_2Zix2h-rRI806kbycsKf8AulDaNOnoXY4eA3am6iVp&_nc_zt=14&_nc_ht=scontent-lax3-2.xx&_nc_gid=Y7-1cX56vp36VWqQJwJLXg&_nc_ss=7b289&oh=00_AQNeUJ9hA6Oq7nguNZ2gEnMvXWJ22tvRUkRdV0U258IXOA&oe=6AE17F14)
- Implication for GitHub-URL intake: demo scans should target repos the builder owns or has permission to scan. (https://dev.meta.ai/legal/acceptable-use-policy) [inference]
- The PDF link on the waiver page is signed and expires. A local text copy was saved at `C:/Users/ulilj/AppData/Local/Temp/claude/C--Users-ulilj-Digital-Alchemy-Vault-active-projects-vibeaudit-vibeaudit/36d60ac0-9564-490f-870a-cf3a94b99216/scratchpad/credit-terms/credit-terms.txt`. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Partner credits are separate from the $150. They are for open-weights models on the partners' own platforms, for select participants. Baseten offers $100 plus 2M TPM. Modal offers $100. Fireworks offers $25 plus a workshop. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)

### IP, publicity and conduct

- The entrant keeps ownership. The Organizers get a perpetual, irrevocable, worldwide, royalty-free, non-exclusive license to use the Submission for any purpose, including marketing. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Materials shared in connection with the event are not confidential. Organizers get a broader transferable, sub-licensable license. Put nothing confidential in the submission or demo. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Participants consent to recording and perpetual promotional use of name, likeness, voice, screen shares and submissions, without compensation. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The readable rules list no prohibited project content. Constraints are the IP representation, sanctions and eligibility limits, and a conduct clause allowing disqualification. The Model API AUP governs API use. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [medium]
- The Official Rules sit on the CV waiver page, dated October 25, 2026. The Organizers can modify terms at any time. Re-read before submitting. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The dev.meta.ai event page still uses future tense: "Official Rules will be published before the Hackathon begins on October 26, 2026". (https://dev.meta.ai/events/global-hackathon)
- Other CV hackathons show GitHub and demo-video links on project records. That hints the Meta form collects them. (https://cerebralvalley.ai/llms.txt) [low]

## Unverified or unknown

### Unknowns: Chat Completions, reasoning and caching

- Minimum cacheable prefix length and any block size are not stated. The 128-token hint is unverified. (https://dev.meta.ai/docs/prompt-caching) [low]
- In-memory cache lifetime is unpublished. It is unconfirmed whether Chat Completions honors `prompt_cache_retention: "24h"`. (https://dev.meta.ai/docs/prompt-caching)
- Whether any cache-write or storage fee exists. Only cached input, input and output rates are listed. (https://dev.meta.ai/docs/pricing-rate-limits)
- The default reasoning level when `reasoning_effort` is omitted. The Reasoning page says model-determined. The cookbook says it is still being finalized. (https://dev.meta.ai/docs/reasoning)
- Whether `xhigh` is stronger than `high`. Whether `max` is accepted on Chat Completions in practice. (https://dev.meta.ai/docs/api-reference/chat-completions/schemas)
- Reasoning-token counts and latency per effort level. None are published, and none were measured. (https://dev.meta.ai/docs/reasoning)
- The value of the non-streaming time limit behind HTTP 504. (https://dev.meta.ai/docs/error-handling)
- The maximum accepted `max_completion_tokens` per model. Only `muse-spark-1.3` output 131072 appears. `muse-wonder-1.0` is unstated. (https://dev.meta.ai/docs/quickstart)
- The format of the `Retry-After` value, and the rate-limit window or reset header. (https://dev.meta.ai/docs/error-handling)
- How mid-stream failures surface on Chat Completions SSE. Terminal error events are documented only for Responses. (https://dev.meta.ai/docs/protocols/chat-completions)
- Free credits or raised limits in the Model API docs: none found. The Official Rules describe the $150 credit. (https://dev.meta.ai/help/accounts-and-login/sign-up)
- Whether `muse-wonder-1.0` (preview) is enabled for a new team. The check is `GET /v1/models`. (https://dev.meta.ai/docs/models)
- US availability beyond the Jul 2026 launch post. The Geographic Use Policy was not read. (https://dev.meta.ai/help/accounts-and-login/supported-countries)
- The Chat Completions research did not read the ToS or AUP. The pricing research did. Whether sending third-party repo code for security analysis is permitted is unconfirmed. (https://dev.meta.ai/legal/acceptable-use-policy)
- Behavior of `service_tier`, and any `stream_options` field beyond `include_usage`. (https://dev.meta.ai/docs/api-reference/chat-completions/schemas)
- Whether `top_k` is ignored or rejected on Chat Completions. (https://dev.meta.ai/docs/protocols/chat-completions)
- Whether `x-request-id` appears on every response. It was seen on a live 401 only. (https://api.meta.ai/v1/chat/completions)
- All 200-response details (real usage numbers, headers, `reasoning_tokens`, `cached_tokens`) come from docs only. (https://api.meta.ai/v1/chat/completions)
- What a token-capped structured-output call returns. The page never mentions `finish_reason`, refusal or null content. (https://dev.meta.ai/docs/structured-output) [low]
- What happens when `json_schema.schema` is omitted. (https://dev.meta.ai/docs/api-reference/chat-completions/schemas) [low]
- The error status and message for a `strict: true` schema that breaks the strict subset. Only recursive schemas are documented as 400. (https://dev.meta.ai/docs/structured-output) [medium]
- Streaming combined with structured output is not covered. (https://dev.meta.ai/docs/structured-output) [low]
- `reasoning_effort: "max"` on `muse-spark-1.3` is docs-confirmed, not run-confirmed. The "Recommended for new work" label may move to `muse-wonder-1.0` once it leaves Preview. (https://dev.meta.ai/docs/models)
- Whether `muse-spark-1.3` stays the docs default through Nov 4. Older third-party snippets show 1.1 and 1.2. (https://dev.meta.ai/docs/api-reference)

### Unknowns: pricing, limits, credits and terms

- Rate-limit tiers and hackathon account tiering are described nowhere. The real limits are on the dashboard Limits page, which needs sign-in. Verify after the account exists. (https://dev.meta.ai/help/usage-and-limits/rate-limits)
- Which credit-validity statement governs. See the conflicts below. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Whether the $150 works on `-contributor` variants and Muse Code pay-as-you-go. The text says "any use of the Services". It is likely yes, not confirmed. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The Claim Form and "know before you go" email were not viewable. The Credit Terms "Effective Date" is undefined. Meta may change the terms prospectively. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- No retention period in days is given for Standard or Contributor content. The Meta Privacy Policy, MGPT, Supplemental Managed Accounts Terms and subprocessor list were not read. (https://dev.meta.ai/legal/terms-of-service)
- Whether humans review Contributor content is undisclosed. (https://dev.meta.ai/legal/terms-of-service)
- Partner-credit eligibility, selection, expiry and whether they can still be claimed after Oct 26. Only Baseten states a rate limit (2M TPM). (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
- The credits research did not capture partner per-token prices for Spark Open. The open-weights research captured several. Groq's price was not shown. (https://console.groq.com/docs/model/meta-models/muse-spark-open)
- Whether Contributor variants cache identically to Standard. (https://dev.meta.ai/docs/prompt-caching)
- Whether GitHub-URL intake of third-party repos counts as unauthorized scanning under the AUP. The exception route is `aup_exceptions@meta.com`. (https://dev.meta.ai/legal/acceptable-use-policy)
- Messages API (Anthropic-compatible): the reasoning parameter and reasoning-token usage fields are not stated. (https://dev.meta.ai/docs/token-counting)
- Whether Chat Completions requests are logged or persisted on Meta's side. (https://dev.meta.ai/docs/protocols/chat-completions)
- The derived budget arithmetic assumes list price and no expiry. Neither is confirmed. (https://dev.meta.ai/docs/pricing-rate-limits) [medium]
- No official statement on batch discounts. (https://dev.meta.ai/docs/pricing-rate-limits)

### Unknowns: Muse Code

- The complete official `muse exec --help` is not published. Confirm `--worktree`, `--worktree-base`, `--worktree-existing`, `--image`, `--base-url`, `--agents`, `--api-key-stdin`, `--provider`, `--preset` and `--context-compaction-*` after install. (https://dev.meta.ai/docs/muse-code/configuration)
- Whether `muse exec` reads the prompt from stdin. (https://dev.meta.ai/docs/muse-code/extending)
- No flag to create or commit to a named branch was found. Whether `--worktree create` makes a branch or detached HEAD is unknown. Whether an agent-run `git commit` works headless with `.git` read-only is unknown. (https://dev.meta.ai/docs/muse-code/extending)
- No official unified-diff output exists for `muse exec`. Whether `edit_facts` carries diff text is unknown. (https://docs.rs/muse-codes/latest/muse_codes/io/struct.ToolResult.html)
- The `--json` record schema is unpublished and drifts between releases. `run.usage` in 1.4.11 broke older versions of the third-party crate. (https://docs.rs/crate/muse-codes/latest/source/CHANGELOG.md)
- Windows config, trust and session paths are undocumented. The `muse sandbox windows check|setup` subcommand appears only in a v0.1.0 blog. Whether the first-run UAC step can be done ahead of time is unknown. (https://qainsights.com/getting-started-with-muse-code-cli-commands-syntax-and-purpose/) [low]
- How `proxy-only` network mode behaves with approvals disabled. No per-host allowlist is documented. (https://dev.meta.ai/docs/muse-code/permissions)
- No official statement of container settings (seccomp, AppArmor, user namespaces, capabilities) that bubblewrap needs, including on GitHub-hosted ubuntu runners. The `muse` binary was not executed, so "works unattended in Docker" rests on docs, E2B and OpenClaw. (https://dev.meta.ai/docs/muse-code/extending)
- Whether Muse scrubs `META_API_KEY` from the environment of agent-run shells, hooks and MCP servers. (https://dev.meta.ai/docs/muse-code/auth)
- Whether `--contributor-mode off` is accepted or ignored under pay-as-you-go API-key auth. (https://dev.meta.ai/docs/muse-code/subscriptions)
- Whether the Auto-review reviewer works with a plain `META_API_KEY` headless, and its token cost. (https://dev.meta.ai/docs/muse-code/permissions)
- How to run unattended on an untrusted checkout without `--trust-workspace`. The `trust.json` format and pre-seeding are undocumented. (https://dev.meta.ai/docs/muse-code/changelog)
- No token or dollar budget flag exists. The default `--max-model-steps` is not stated. (https://dev.meta.ai/docs/muse-code/extending)
- The installer always installs the current `muse-stable` build. Retention of older versions is unknown. Release dates come only from a third-party changelog. (https://api.meta.ai/muse-code/channels/muse-stable)
- Which hosts the `muse` process must reach for model calls. This matters for egress allowlists. (https://api.meta.ai/muse-launcher.sh)
- Exit codes for auth failure, rate limit and sandbox-unavailable. The 0 to 5 table in the SDK docs is for `muse serve`. (https://dev.meta.ai/docs/muse-code/extending)
- Exact `exec` spelling and behavior of session worktrees, and how `--allow-workspace-switch` interacts with them. (https://dev.meta.ai/docs/muse-code/changelog)

### Unknowns: open-weight triage

- No live call was made to any provider. Every request shape, `response_format` behavior, reasoning parameter and price comes from docs and catalogs. (https://openrouter.ai/docs/quickstart)
- Together's Glimmer serverless health is unresolved. It needs one real call with a Together key. (https://openrouter.ai/api/v1/models/meta/muse-glimmer-30b-20260810/endpoints)
- Which Together hostname is canonical: `api.together.xyz` or `api.together.ai`. Whether one key works on both. (https://docs.together.ai/docs/openai-api-compatibility)
- Whether both Spark Open aliases work on Together: `meta-models/muse-spark-open` and `meta-models/Muse-Spark-Open-816B-A42B`. (https://docs.together.ai/docs/serverless-models)
- Fireworks Glimmer on-demand pricing, cold start and `response_format` support were not retrieved. (https://fireworks.ai/models/fireworks/muse-glimmer-30b)
- Baseten's Glimmer absence is inferred from its Model APIs table. Dedicated deployments were not checked. (https://docs.baseten.co/development/model-apis/overview)
- Groq's Glimmer absence is inferred from a 404 and a search. Its model list returned 403 to scripted fetch. (https://console.groq.com/docs/model/meta-models/muse-glimmer-30b)
- Nebius: no evidence for or against Glimmer. Its API returns 401 unauthenticated. The canonical hostname is unclear. (https://nebius.com/blog/posts/three-new-open-weight-models-from-us-companies-give-builders-more-choice)
- Modal: no shared pay-per-token Glimmer endpoint found. Per-second GPU prices were not retrieved. (https://modal.com/library/meta/muse-glimmer-30b-bf16)
- `json_object` vs `json_schema` per provider was verified only for `json_schema` on Together and OpenRouter. DeepInfra's own docs page was not found. (https://docs.together.ai/docs/json-mode)
- OpenRouter: the `deepinfra` provider slug is assumed. Any markup over provider prices is unknown. The exact `reasoning` shape is unverified. DeepInfra's OpenRouter endpoint caps completions at 16,384 tokens, while DeepInfra's own catalog says 131072. (https://openrouter.ai/docs/quickstart)
- What default reasoning each Glimmer host applies when no effort is sent. Whether reasoning can be disabled on Together. (https://dev.meta.ai/docs/muse-glimmer/prompting)
- Whether the Glimmer `USAGE_POLICY.md` binds beyond Apache 2.0. Only the start of the policy was read. (https://huggingface.co/meta-models/Muse-Glimmer-30B/raw/main/USAGE_POLICY.md)
- Whether the "Built with Muse Spark Open" clause and Usage Policy bind a developer who only calls a hosted API. No legal review was done. (https://huggingface.co/meta-models/Muse-Spark-Open-816B-A42B)
- NVIDIA's free Glimmer endpoint: rate limits, terms, data handling and JSON support were not checked. (https://build.nvidia.com/meta/muse-glimmer-30b)
- Other Glimmer hosts seen only in search snippets: Featherless AI, Doubleword, Vultr (reported $0.25/$1.00), FlexAI (`https://api.flex.ai/v1`), Azure AI Foundry, LLM Gateway and Requesty. No source URLs were recorded for most. (https://api.flex.ai/v1) [low]
- Speed figures are snapshots from Hugging Face, not benchmarks. (https://huggingface.co/inference/models?model=meta-models%2FMuse-Glimmer-30B) [medium]
- Eligibility, rate limits and terms for the closed `muse-spark-1.3-contributor` tier on OpenRouter were not checked. (https://openrouter.ai/api/v1/models)
- dev.meta.ai pages were read with WebFetch and raw HTTP text. They are JavaScript-rendered and could differ in the live UI. (https://dev.meta.ai/llms.txt)

### Unknowns: hackathon rules

- Whether a public GitHub repo is required. No clause was found, and the submit form is login-gated. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Whether a demo video is formally required, its maximum length and its host. The 3-minute cap is unconfirmed. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The exact submission form fields and which are mandatory. (https://cerebralvalley.ai/llms.txt) [low]
- Whether pre-Oct 26 work is allowed or must be disclosed. The "know before you go" email, Discord and kickoff livestream may carry extra rules. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Which track was chosen on the application, and whether it can change. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The definition of "startup" and "real product". Whether a sole founder counts as an active employee for the Representative role. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Whether Muse Code as a dev tool or inside the pipeline counts toward Meta tooling. Whether any minimum Meta-model usage is required. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
- Whether non-Meta AI coding tools are restricted. No clause was found either way. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- Whether the Startup track uses different weights than the single published set. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- What the 6-hour grace-period setting does. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [low]
- Whether a separate or updated Official Rules document will appear. (https://dev.meta.ai/events/global-hackathon)
- Whether the rules contain an explicit prohibited-content list. None was found. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
- The kickoff livestream time and any rule clarifications from Discord office hours. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)

### Refuted, corrected, qualified or conflicting claims

- Base URL and auth claim. Not refuted. Tightened: the base URL already ends in `/v1`. The key name `META_API_KEY` is only a placeholder. The HTTP docs say `MODEL_API_KEY`. The Muse Code CLI reads `META_API_KEY`. No SDK reads either one. (https://dev.meta.ai/docs/api-reference)
- Corrected: the earlier statement that the live 401 "confirms the route exists" is too strong. The 401 fires on every `/v1` path. The OPTIONS `allow: POST` result is the route evidence. (https://api.meta.ai/v1/chat/completions)
- Stale link: `ai.developer.meta.com/docs/features/chat-completion` now ends in a 404. (https://dev.meta.ai/docs/api-reference)
- Model and effort claim. Not refuted. Qualified: `none` returns 400, `max` is unavailable on contributor IDs, and Wonder costs more and is Preview. (https://dev.meta.ai/docs/models)
- Older official pages list only `none` through `xhigh`, omit `max`, and say `xhigh` equals `high`. The research ranked the Reasoning page, schemas and models page higher, because they are per-model, explicit and newer. (https://dev.meta.ai/docs/reasoning)
- Third-party reports conflict on `max`. Some say it was partner-only at the Sep 2 launch. One says it opened to all on Sep 4. LiteLLM and promptfoo docs list only `minimal` through `xhigh`. No URLs were recorded. (https://dev.meta.ai/docs/models) [medium]
- Docs also disagree on `none`. The Reasoning page says HTTP 400. The cookbook says it is not reliably available. (https://dev.meta.ai/docs/cookbook/reasoning-thinking-tokens)
- Structured output claim. Not refuted. Qualified: `strict` defaults to false and every example omits it. `message.parsed` is SDK-only. (https://dev.meta.ai/docs/structured-output)
- Muse Code headless claim. Not refuted. Addition: headless runs need `--disable-approval` or `--yolo`. Third-party guides saying Windows is unsupported or WSL-only contradict the official docs and are stale. `--api-key-stdin` and `--provider meta` are third-party only. (https://dev.meta.ai/docs/muse-code)
- Muse Code is a CLI agent, not a model ID. Open-weight models are not served at api.meta.ai. (https://dev.meta.ai/docs/overview)
- Glimmer Apache 2.0 claim. Not refuted. The verification named Together AI the primary pick. The open-weights research favored OpenRouter with DeepInfra pinned, because Together looked unhealthy. The meaning of status -5 is unconfirmed. (https://research.meta.ai/blog/introducing-muse-glimmer-open-agentic-model)
- The models page calls Glimmer self-hosted only. Third parties host it. Meta's Model API does not list it. (https://dev.meta.ai/models/muse-glimmer)
- Pricing claim. Not refuted. Prices are Standard-mode only. Contributor is $0.10 input and $0.20 output, with lower limits and no `max`. (https://dev.meta.ai/docs/pricing-rate-limits)
- Pricing URLs in the task, `/docs/pricing` and `/docs/rate-limits`, return 404. (https://dev.meta.ai/docs/pricing-rate-limits)
- Contributor rate-limit conflict. An older launch blog described a rolling 5-hour token window and "select countries". The current page lists 150 RPM and 3,000,000 TPM. The Help Center says no Discounted-tier geographic limits. Treat the docs page as authoritative. (https://dev.meta.ai/resources/blog/build-with-muse-code) [medium]
- Credit validity conflict. The Official Rules say "valid for a 10-day development window". The Credit Terms say applied credits do not expire. ToS 13.3 says unused promotional credits may expire as stated in the Account. Assume the 10-day window and check the Account. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver) [medium]
- The $150 is not on the CV event page body, which lists only partner credits. It is in the Official Rules and Credit Terms. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
- Muse Code default model conflict. Docs say `muse-spark-1.2`. A third-party crate says the catalog default moved to `muse-spark-1.3-contributor` in 1.4.11. Always pass `--model`. (https://docs.rs/crate/muse-codes/latest/source/CHANGELOG.md) [medium]
- Glimmer default reasoning conflict. Meta says high. OpenRouter says medium. (https://dev.meta.ai/docs/muse-glimmer/prompting) [medium]
- Spark Open effort mapping conflict. Meta says 8, 32, 256, 512. The Hugging Face blog says 16, 64, 256, 512. Use symbolic names. (https://huggingface.co/blog/meta-muse-spark-open) [medium]
- Fireworks conflict. Aggregators still show Glimmer serverless at $0.35/$1.50. Fireworks' own page says serverless was deprecated September 25, 2026. No aggregator URLs were recorded. (https://fireworks.ai/models/fireworks/muse-glimmer-30b)
- Baseten conflict. Hugging Face's router marks Baseten Spark Open as structured-output capable. Baseten's docs say it is not. (https://docs.baseten.co/development/model-apis/overview)
- Together conflict. The Hugging Face listing for the NVFP4 Spark Open repo showed Structured: No. Together's catalog says Yes. (https://docs.together.ai/docs/serverless-models) [medium]
- The OpenClaw page says Muse ignores `MODEL_API_KEY`. Meta's docs name only `META_API_KEY`. (https://docs.openclaw.ai/plugins/muse.md) [medium]
- The Chat Completions guide says it serves the Muse Spark text models. The models page lists Chat Completions for both Spark and Wonder. (https://dev.meta.ai/docs/models)
- The 3-minute demo cap in the brief and a new-work-only rule have no public official text. No public text requires a public repo or a demo video. (https://cerebralvalley.ai/e/meta-ai-developer-hackathon/waiver)
