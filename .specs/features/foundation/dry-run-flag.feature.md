---
feature: Dry-Run Flag
domain: foundation
source: src/cli/scroll.ts
tests:
  - tests/foundation/scroll-handler.test.ts
  - tests/foundation/cli-entry.test.ts
  - tests/foundation/replay.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# Dry-Run Flag

**Source File**: `src/cli/scroll.ts` (formalize the `--dry-run` contract), `src/cli/replay.ts` (already honors per feature 14)
**Design System**: N/A (CLI tool — no UI tokens; the "mockup" is terminal output)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: `--dry-run` runs the scroll + extract pipeline without touching disk, the Anthropic API, or cumulative state

The operator's daily ritual is `pnpm scroll` → `open summary.md`. But there are three moments when running the full pipeline is the wrong move and the operator wants to "do everything except the side effects":

1. **They just edited `config.yaml`** (new interests, new `scroll.minutes`, swapped `claude.model`) and want to confirm the scroller still launches, the extractor still pulls posts, and nothing throws — without burning a billed Claude call or writing a real `raw.json` to `~/scrollproxy/runs/`.
2. **They tweaked a Playwright selector** in the extractor (X changed its DOM again — feature 6's recurring tax) and want to verify the selectors still match against a live feed, see the post count and ad-skip count, and back out if the numbers look wrong.
3. **They're testing `--minutes` bounds or `--config <path>`** and want to confirm the CLI plumbing reaches the scroll handler without committing to a 10-minute scroll → API call → markdown write cycle.

In all three cases the operator wants the same contract: scroll the feed, extract the posts, print the count, exit 0 — and **leave the filesystem and the Anthropic account exactly as they found them**. No `raw.json`, no `summary.json`, no `summary.md`, no dedup cache mutation, no rolling themes append, no Claude call, no charge.

This feature is what feature 3 (CLI entry) was holding a seat for: the `--dry-run` flag already parses, the scroll handler already reads `flags.dryRun ?? false`, and the scroller already accepts a `dryRun` parameter. This feature replaces the partial wiring with the full contract: every side effect on the scroll path is gated by `isDryRun`, every dry-run termination prints a single line that names what was extracted and what was skipped, and the contract is restated everywhere a future contributor might forget it.

Vision principle 8 — **"Personal tool simplicity"** — shapes the scope. `--dry-run` is NOT a "preview the markdown" feature, NOT a "summarize against a stub LLM" feature, NOT a "save raw.json but skip Claude" feature. It is exactly: scroll, extract, count, print, exit. Anything that writes to disk or hits the network beyond x.com itself is skipped.

Vision principle 3 — **"Never lose scroll effort"** — has a deliberate exception here. Normal `pnpm scroll` always writes `raw.json` even when downstream fails. `pnpm scroll --dry-run` does NOT write `raw.json` even on success. The operator opts out of preservation explicitly by passing the flag. If they wanted the scroll preserved, they would not have passed `--dry-run`.

This feature ships the `--dry-run` contract for both verbs that accept it:

### `pnpm scroll --dry-run` contract

The handler in `src/cli/scroll.ts` already reads `flags.dryRun ?? false` into `isDryRun` and threads it into `runScroll`. This feature locks in the following side-effect gates:

1. **Scroller still runs end-to-end.** Browser launches against the persistent context (`config.browser.userDataDir`), navigates to `x.com/home`, scrolls for `effectiveMinutes`, and the `extractor.onTick` callback fires on every tick. The scroller's own `dryRun: true` path (per feature 5) governs whether the browser is launched headless or visible — that is a scroller-internal concern, not a CLI concern, and is left as-is.
2. **Extractor still parses every tick.** `extractor.getPosts()` and `extractor.getStats()` return real numbers. Selector failures still skip the offending post (per feature 6). Ad detection still runs.
3. **No `raw.json` is written.** No `runId` directory is created under `config.output.dir`. No `.tmp` file is left behind. The atomic-write helper in `src/writer/raw-json.ts` is not called.
4. **No dedup cache mutation.** `loadDedupCache` is not called, `partitionPosts` is not called, `saveDedupCache` is not called. The dedup cache file's mtime and content are unchanged after a dry-run scroll.
5. **No summarizer call.** `summarizeRun` is not invoked. No HTTP request is made to `api.anthropic.com`. The `ANTHROPIC_API_KEY` is not read or required for a dry-run scroll to succeed (a missing key must not fail dry-run).
6. **No themes store mutation.** `loadThemesStore` is not called, `appendRun` is not called, `saveThemesStore` is not called. The rolling themes file's mtime and content are unchanged.
7. **No `summary.json`, no `summary.md`, no `summary.error.json`.** None of the writers in `src/writer/` are called.
8. **One stdout line on success**, exact format:
   `dry-run complete: <ticks> ticks over <elapsedSec>s — <postsExtracted> posts extracted (<adsSkipped> ads skipped), writer skipped`
   followed by exit `0`.
9. **`browser_closed` during dry-run prints early-termination line and exits `1`.** Format:
   `scroll ended early after <tickCount> ticks (browser closed)`
   No `raw.json` write attempt is made (the existing handler already gates the write block on `!isDryRun` for this branch — that gate is part of this feature's contract). Exit `1`.
10. **`session_expired` and scroller `error` paths are unchanged.** They print their existing messages and exit `1`. They are not dry-run-specific failures.

### `pnpm replay <run-id> --dry-run` contract

The replay handler (per feature 14) already honors `--dry-run`. Restated here for completeness so this feature owns the cross-verb contract:

1. **Reads and parses `<runDir>/raw.json`** (validates `schemaVersion === 1`).
2. **No Claude call.** `summarizeRun` is not invoked.
3. **No write to `summary.json`, `summary.md`, or `summary.error.json`.** No `.tmp` file left behind.
4. **No themes store mutation.** Replays never mutate themes (per feature 14); dry-run reaffirms the no-op.
5. **No dedup cache touch** (replay never touches dedup; dry-run is a no-op on top of that).
6. **One stdout line on success**, exact format:
   `dry-run: replay <runId> — would re-summarize <N> posts, writer skipped`
   followed by exit `0`.
7. **The same fail-fast errors apply as non-dry-run replay** (missing run dir, missing `raw.json`, unsupported `schemaVersion`, malformed JSON, leading path separator). Dry-run does not suppress these — the operator wants to know `raw.json` is parseable as part of the dry-run check.

### `pnpm login --dry-run` contract

`--dry-run` is **rejected** for the `login` verb. The CLI dispatcher (per feature 3) restricts each verb's allowed flags. `login` accepts only `--config <path>`. Passing `--dry-run` to `login` produces:
`unknown flag: --dry-run (run \`pnpm login --help\` for usage)`
and exits `2`. There is no "dry login" semantically — the whole point of login is the side effect of authenticating the persistent context.

### Module boundaries

This feature owns **the contract**. The flag itself is parsed by `src/cli/args.ts` (feature 3). The scroller's internal handling of `dryRun: true` is owned by feature 5. The replay handler's dry-run branch is owned by feature 14. This feature's source is `src/cli/scroll.ts` because that's where the scroll-side gates live; the spec is the system-level contract that all three modules conform to.

### Scenario: Happy-path dry-run scroll — extract 47 posts, no writes, no API call

Given a valid `~/scrollproxy/config.yaml` with `scroll.minutes: 3`
And the operator is logged in (persistent context exists)
And `~/scrollproxy/runs/` is empty before the run
And `~/scrollproxy/state/dedup-cache.json` exists with mtime `T0` and contains 1,234 hashes
And `~/scrollproxy/state/themes.json` exists with mtime `T0` and contains 5 prior runs
When the operator runs `pnpm scroll --dry-run`
Then the browser launches against the persistent context
And the scroller scrolls for 3 minutes with the configured jitter and pauses
And the extractor parses every tick, returning 47 posts and 6 ads skipped
And no `runId` directory is created under `~/scrollproxy/runs/`
And no HTTP request is made to `api.anthropic.com`
And `~/scrollproxy/state/dedup-cache.json`'s mtime is still `T0` and content is unchanged
And `~/scrollproxy/state/themes.json`'s mtime is still `T0` and content is unchanged
And stdout reads `dry-run complete: 92 ticks over 184s — 47 posts extracted (6 ads skipped), writer skipped`
And `pnpm scroll --dry-run` exits `0`
(This is the operator's "I just changed config, does it still work?" run. They get the count, they nod, they get on with their day.)

### Scenario: Dry-run with `ANTHROPIC_API_KEY` unset — succeeds without complaining

Given `config.claude.apiKey` is unset and `process.env.ANTHROPIC_API_KEY` is unset
And a valid config and login context are otherwise in place
When the operator runs `pnpm scroll --dry-run`
Then the scroll proceeds, posts are extracted, and the dry-run line is printed
And no error is raised about the missing API key
And `pnpm scroll --dry-run` exits `0`
(Dry-run must not require credentials it will not use. The operator's first-run experience and CI smoke tests both depend on this.)

### Scenario: Dry-run with `--minutes` override — bound is enforced, scroll runs for the override

Given a valid config with `scroll.minutes: 10`
When the operator runs `pnpm scroll --dry-run --minutes 1`
Then the effective minutes passed to the scroller is `1`
And the scroller runs for ~60 seconds (subject to the existing jitter/long-pause envelope)
And stdout reads `dry-run complete: <ticks> ticks over <~60>s — <N> posts extracted (<M> ads skipped), writer skipped`
And `pnpm scroll --dry-run` exits `0`
(Dry-run composes with `--minutes` — the operator commonly pairs them: "do a fast smoke test of my new selectors.")

### Scenario: Dry-run with `--config <path>` override — config is loaded from the override path

Given `/tmp/scratch-config.yaml` exists with valid config setting `scroll.minutes: 1`
When the operator runs `pnpm scroll --dry-run --config /tmp/scratch-config.yaml`
Then `loadConfig({ path: '/tmp/scratch-config.yaml' })` is called
And the scroll runs against the config from `/tmp/scratch-config.yaml`
And no `~/scrollproxy/runs/` directory is created (regardless of where the override points its `output.dir`)
And `pnpm scroll --dry-run` exits `0`
(The operator's prompt-tuning workflow: keep a scratch config that points `output.dir` at `/tmp/`, then dry-run against it. Nothing should be written anywhere.)

### Scenario: Dry-run when browser closes mid-scroll — early-termination line, no write attempt, exit 1

Given the scroll begins normally
And after 22 ticks the operator closes the browser window
When the scroller returns `status: 'browser_closed'`
Then no `raw.json` write is attempted (no `.tmp` file appears, no `runId` directory is created)
And no dedup cache update is attempted
And stdout reads `scroll ended early after 22 ticks (browser closed)`
And `pnpm scroll --dry-run` exits `1`
(Normal scroll preserves what was collected on `browser_closed`. Dry-run does not — the operator opted out of preservation by passing `--dry-run`. Exit `1` because the run did not complete the budget.)

### Scenario: Dry-run when session has expired — same message and exit code as normal scroll

Given the persistent context's X session has expired
When the operator runs `pnpm scroll --dry-run`
Then stdout reads `session expired — run pnpm login to refresh, then pnpm scroll`
And `pnpm scroll --dry-run` exits `1`
(Session expiry is independent of dry-run. The message guides the operator to `login` even in dry-run mode — they need a session to dry-run anything.)

### Scenario: Dry-run when scroller throws an unexpected error — error surfaces, exit 1

Given the scroller returns `status: 'error'` (e.g. Playwright launch failure)
When the operator runs `pnpm scroll --dry-run`
Then stderr prints the underlying error message (unchanged from the non-dry-run path)
And `pnpm scroll --dry-run` exits `1`
(Dry-run does not swallow errors. "Broken automation that fails silently" is the operator's frustration — surfacing the real error is the contract.)

### Scenario: Dry-run replay — no Claude call, no writes, post count reported

Given `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json` exists with `schemaVersion: 1` and 84 posts
And `summary.json` and `summary.md` do NOT exist for that run
When the operator runs `pnpm replay 2026-04-17T09-02-14Z --dry-run`
Then `raw.json` is read and parsed
And `summarizeRun` is NOT called
And no `summary.json` or `summary.md` is written
And no `.tmp` file is left in the run directory
And the rolling themes store is NOT touched
And stdout reads `dry-run: replay 2026-04-17T09-02-14Z — would re-summarize 84 posts, writer skipped`
And `pnpm replay --dry-run` exits `0`
(Operator's most common dry-run replay: "is yesterday's `raw.json` still parseable before I commit to a billed re-summarize?")

### Scenario: Dry-run replay against a missing run — fails fast even with `--dry-run`

Given `~/scrollproxy/runs/nonesuch` does not exist
When the operator runs `pnpm replay nonesuch --dry-run`
Then stdout reads `no run found: ~/scrollproxy/runs/nonesuch`
And `pnpm replay --dry-run` exits `1`
(Dry-run does not suppress fail-fast errors. The operator wants to know the run id is bad before they think it succeeded silently.)

### Scenario: Dry-run replay against malformed `raw.json` — fails loudly even with `--dry-run`

Given `<runDir>/raw.json` exists but contains `{{{invalid`
When the operator runs `pnpm replay <runId> --dry-run`
Then stdout reads `replay: failed to parse <runDir>/raw.json: <reason>`
And `pnpm replay --dry-run` exits `1`
(Validating that `raw.json` parses is part of what dry-run is FOR. Suppressing parse errors would defeat the smoke-test purpose.)

### Scenario: `--dry-run` is rejected on `pnpm login` (anti-persona guardrail)

Given the dispatcher restricts `login` to `--config <path>` only
When the operator runs `pnpm login --dry-run`
Then stderr reads `unknown flag: --dry-run (run \`pnpm login --help\` for usage)`
And `pnpm login --dry-run` exits `2`
(There is no "dry authentication" semantically. Login is a side-effect-only command. Allowing the flag would silently no-op, which is the anti-persona's preferred ambiguity.)

### Scenario: Dry-run does not write a `runId` directory (filesystem invariant)

Given `~/scrollproxy/runs/` is empty
When the operator runs `pnpm scroll --dry-run` and the scroll completes successfully
Then `~/scrollproxy/runs/` is still empty (no new directories, no `.tmp` files anywhere under it)
And no error message references a write attempt
(The single most-checked invariant. The operator runs dry-run dozens of times during selector tuning; the runs directory must never accumulate noise from those runs.)

### Scenario: `--dry-run` on its own (no other flags) is the documented daily smoke test

Given a valid config and an active login session
When the operator runs `pnpm scroll --dry-run`
Then the run uses `config.scroll.minutes` (no override)
And the dry-run line is printed and exit is `0`
And no side effects occur per the contract above
(The terse form. `--dry-run` is the operator's go-to verb when they want to know "does the whole pipeline still work?" without committing.)

## User Journey

1. Operator just edited `~/scrollproxy/config.yaml` (added an interest, swapped the Claude model, bumped `scroll.minutes`).
2. **Operator runs `pnpm scroll --dry-run --minutes 1`** — a one-minute smoke test against the live feed.
3. The browser launches, scrolls for 60s, extractor parses, dry-run line prints with the post count and ad-skip count.
4. If the count looks normal (≥10 posts, few ads), they're confident the new config is sound and run `pnpm scroll` for real.
5. If the count looks broken (zero posts, all ads, or the line never prints), they back out — edit the selector or revert the config — and dry-run again.
6. Their `~/scrollproxy/runs/` directory looks the same as it did before they started tuning. Their dedup cache is unchanged. Their Anthropic bill is unchanged.

The replay-side journey is similar but smaller: before iterating on a Claude prompt, the operator confirms `raw.json` parses with `pnpm replay <runId> --dry-run`, then commits to the billed `pnpm replay <runId>`.

## CLI Mockup

Happy-path dry-run scroll:

```
$ pnpm scroll --dry-run
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
dry-run complete: 184 ticks over 603s — 47 posts extracted (6 ads skipped), writer skipped
$ echo $?
0
```

Quick smoke test with `--minutes 1`:

```
$ pnpm scroll --dry-run --minutes 1
scrolling x.com for 1m (persistent context: ~/scrollproxy/chrome)
dry-run complete: 18 ticks over 61s — 8 posts extracted (1 ads skipped), writer skipped
$ echo $?
0
$ ls ~/scrollproxy/runs/
$
```

Dry-run with no API key set (must succeed):

```
$ unset ANTHROPIC_API_KEY
$ pnpm scroll --dry-run --minutes 1
scrolling x.com for 1m (persistent context: ~/scrollproxy/chrome)
dry-run complete: 18 ticks over 61s — 8 posts extracted (1 ads skipped), writer skipped
$ echo $?
0
```

Browser closed mid-dry-run (no write, exit 1):

```
$ pnpm scroll --dry-run --minutes 5
scrolling x.com for 5m (persistent context: ~/scrollproxy/chrome)
scroll ended early after 22 ticks (browser closed)
$ echo $?
1
$ ls ~/scrollproxy/runs/
$
```

Session expired during dry-run:

```
$ pnpm scroll --dry-run
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
session expired — run pnpm login to refresh, then pnpm scroll
$ echo $?
1
```

Dry-run replay:

```
$ pnpm replay 2026-04-17T09-02-14Z --dry-run
dry-run: replay 2026-04-17T09-02-14Z — would re-summarize 84 posts, writer skipped
$ echo $?
0
```

`--dry-run` rejected on `login`:

```
$ pnpm login --dry-run
unknown flag: --dry-run (run `pnpm login --help` for usage)
$ echo $?
2
```

## Component References

N/A — CLI tool, no UI components.

## Out of Scope for This Feature

- **Writing a "preview" `raw.json` to `/tmp/`** — adds a write the operator did not ask for; the contract is "no writes".
- **Stub-summarizer mode** (use a fake `summarizeRun` that returns canned themes) — different feature, would belong under testing infrastructure, not the user-facing CLI.
- **`--dry-run` on `pnpm login`** — explicitly rejected; covered by the dispatcher.
- **A `--no-write` synonym** — one flag, one name, one mental model. Adding aliases is anti-persona territory.
- **A "what would have been written?" preview** (e.g. print the `summary.md` to stdout without writing it) — the operator can run real `pnpm scroll` and `cat summary.md`; dry-run is for the "did the pipeline work?" question, not the "what would the output look like?" question.
- **Dry-run for future verbs** (e.g. a hypothetical `pnpm export`) — those will define their own contracts when they exist.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **scroll**, **dry-run**, **feed**, **posts**, **ads skipped**, **writer**, **run**, **operator**. The output line "dry-run complete: ... writer skipped" matches the cadence of the real scroll line ("scroll complete: ... — saved to ...") so the operator's eye lands on the same information columns whether they're reading a real or dry-run output.

Patience-level alignment: the operator is **Very Low** patience for daily use. `--dry-run` is one flag, no positional, one line of output, exit 0 on success. No interactive prompts ("are you sure you want to skip writes?"), no progress bar, no confirmation. The flag's whole purpose is to skip noise; adding ceremony to the flag itself would defeat it.

Anti-persona check: no telemetry of the dry-run, no "share dry-run results" feature, no `--dry-run-output <path>`. The operator's frustration "Setup wizards, onboarding flows" extends to flags that try to do too much; dry-run does one thing.

Frustrations addressed:
- "Tools that hide what they're doing" → the dry-run line names exactly what was extracted and that the writer was skipped. The operator never has to wonder "did it actually scroll, or did it short-circuit?"
- "Broken automation that fails silently" → `browser_closed` and `session_expired` exit `1` even in dry-run; only the writer is suppressed, not the failure surface.
- "Tools that summarize by averaging everything into mush" → the dry-run line is two integers and one stable phrase. No prose, no commentary, no "looks like a great scroll!" affordance.
- "Opening X for one thing" → dry-run lets the operator validate config and selector changes without committing to a real billed run, which is a write-amplifier of the same frustration (one config change → one real run → one wasted Claude call).

Cumulative-intelligence integrity:
- Dedup cache and rolling themes store are NEVER touched by dry-run. If they were, repeated dry-run smoke tests during selector tuning would either pollute dedup with hashes the operator never "really" saw, or pollute themes with averaged smoke-test signal. Both would corrupt the "what's new this week?" loop. The contract is strict for this reason.
- Anthropic spend is bounded by real `pnpm scroll`/`pnpm replay`. A dry-run that secretly hit the API would be a budget surprise — exactly the surprise the operator chose dry-run to avoid.

## Learnings

<!-- Updated via /compound -->
