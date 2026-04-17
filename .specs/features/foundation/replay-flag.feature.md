---
feature: Replay Flag
domain: foundation
source: src/cli/replay.ts
tests:
  - tests/foundation/replay.test.ts
  - tests/foundation/cli-entry.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# Replay Flag

**Source File**: `src/cli/replay.ts` (replaces stub), wired into `src/cli/index.ts` via the existing `replay` verb
**Design System**: N/A (CLI tool — no UI tokens; the "mockup" is terminal output)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: `pnpm replay <run-id>` re-summarizes a saved `raw.json` without re-scrolling

The operator's daily loop is `pnpm scroll` → `open summary.md` → click 0–3 links → close. But two things break that loop today. First: the Anthropic API occasionally rate-limits or 5xxs, and when it does, `pnpm scroll` leaves `raw.json` on disk but writes `summary.error.json` instead of `summary.json`/`summary.md`. The posts are collected, the scroll effort is not lost, but the operator has no summary to read. Re-running `pnpm scroll` would burn another 10 minutes of real scrolling and probably hit the same posts again. Second: the operator is iterating on the summarizer prompt, the interest list in `config.yaml`, or the Claude model — they want to re-render yesterday's run with a new prompt without kicking off a fresh scroll. Both cases want the same thing: take an existing `~/scrollproxy/runs/<run-id>/raw.json`, hand it back to the summarizer with today's config, and produce a fresh `summary.json` and `summary.md` in the same run directory.

This feature is what the CLI skeleton from feature 3 was holding a seat for: the `replay` verb already routes, the `handleReplay` stub already prints `scrollproxy replay <run-id> — not yet wired (feature 14)`. This feature replaces that stub with the real implementation. No new CLI plumbing — just the handler body.

Vision principle 3 — **"Never lose scroll effort"** — is the load-bearing principle here. `raw.json` already preserves the scroll; this feature makes it useful a second time. If today's scroll produced `summary.error.json` because Claude rate-limited, `pnpm replay <today's run-id>` five minutes later finishes the job without re-scrolling.

Vision principle 8 — **"Personal tool simplicity"** — shapes the scope. Replay is NOT a "rehydrate dedup cache from raw.json" feature, NOT a "replay against a different model config" feature with its own flags, NOT a "replay multiple runs in a batch" feature. It is exactly this: given a run-id on disk with a valid `raw.json`, call the summarizer and write `summary.json` + `summary.md` using the current config. Everything else is a future feature or out of scope.

This feature ships replay behavior in `src/cli/replay.ts` that:

1. Resolves the run directory: `<config.output.dir>/<runId>/` with `~` expansion. The `runId` is taken verbatim from the positional arg parsed by the existing CLI dispatcher (feature 3). Whitespace is not trimmed — the operator will type or paste the id exactly as it appears in the directory name (e.g. `2026-04-17T09-02-14Z`). A leading `./` or absolute path in the positional is rejected with a clear error; `runId` is always a directory name, never a path.

2. Fails fast with a clear error if the run directory does not exist: `no run found: <runDir>` and exit `1`. The operator's frustration "Broken automation that fails silently" drives this — the message must name the directory path so the operator can `ls ~/scrollproxy/runs` and see what's actually there. No suggestion engine, no "did you mean...?" — the operator reads the error, runs `ls`, types the right id, moves on.

3. Fails fast with a clear error if `<runDir>/raw.json` does not exist: `no raw.json in <runDir>` and exit `1`. This matches the guidance in feature 7's atomic-write scenario: an interrupted write leaves `raw.json.tmp`, not `raw.json`, and replay must not parse the `.tmp`. If only `raw.json.tmp` is present, the error is still `no raw.json in <runDir>` — do not auto-promote, do not patch, do not rename; a half-written file is the caller's problem (re-scroll).

4. Reads and parses `raw.json` as JSON. Validates `schemaVersion === 1`; any other value produces `replay: unsupported raw.json schemaVersion <n>, expected 1` and exit `1`. This matches feature 13's schema-version discipline and prevents rendering a v1 summary against v2 raw data or vice versa. If the JSON is malformed (not JSON at all, or missing `posts`), the error message is `replay: failed to parse <rawJsonPath>: <reason>` and exit `1`.

5. Reconstructs the summarizer inputs from `raw.json` and current state:
   - `posts`: `payload.posts` verbatim (already `ExtractedPost[]`).
   - `newPostIds`: empty `[]`. Replay does NOT re-partition against the dedup cache — that cache has already absorbed this run's hashes, and re-partitioning would either return zero new (misleading) or pollute the cache (wrong). Explicit `[]` tells the summarizer "we don't know new vs. seen for a replay" and the prompt (feature 12) handles the empty list cleanly.
   - `priorThemes`: `recentThemes(await loadThemesStore(config.output.state))` — the CURRENT state of the rolling themes store, not a frozen snapshot. Replaying with today's prompt uses today's accumulated context, by design. The operator iterating on the prompt wants to see how the new prompt performs against the current themes window.
   - `interests`: `config.interests` — today's config, not yesterday's. Same rationale.
   - `runId`: the `runId` positional (matches the directory name).
   - `model`: `config.claude.model` — today's config.
   - `apiKey`: `config.claude.apiKey ?? process.env.ANTHROPIC_API_KEY ?? ''` — same resolution as `handleScroll`.

6. Calls `summarizeRun(input)` exactly like the scroll path (feature 12). On `status: 'ok'`:
   - Writes `<runDir>/summary.json` atomically via the same tmpfile → rename pattern the scroll path uses (same `writeSummaryJson` helper or equivalent).
   - Writes `<runDir>/summary.md` via `writeSummaryMarkdown` from feature 13 with the same `MarkdownContext` shape the scroll path uses (both absolute and `~`-compressed paths for `raw.json` and `summary.json`).
   - **Does NOT update the rolling themes store.** A replay is not a new run — it is a re-rendering. Appending this run's themes a second time would double-count it in the rolling window and corrupt "what changed this week?" signal. If `summary.json` already existed for this run (because it was replayed before, or it was a successful run being re-rendered), overwriting it is intentional; the themes store was already updated by the original scroll and must not be touched.
   - Prints: `replayed <runId>: summarized (N themes, M worth clicking) — rendered to <displaySummaryMdPath>` on stdout.
   - Exits `0`.

7. On summarizer `status: 'error'`:
   - Writes `<runDir>/summary.error.json` via the same helper the scroll path uses. If a `summary.error.json` from a previous run exists, it is overwritten (this replay is the authoritative error record now). If a `summary.json` from a prior successful run exists, it is NOT deleted — the operator's most-recent successful render stays on disk as a fallback. The operator can `ls` and see both files and decide what to do.
   - Prints: `replayed <runId>: summarizer failed: <reason>` on stdout.
   - Exits `1`.
   - **Does NOT touch the rolling themes store.** Same reason as the success case — replays do not mutate cumulative state.

8. On unexpected errors (file permissions, disk full, unknown filesystem errors thrown from `writeSummaryJson`/`writeSummaryMarkdown`):
   - Prints: `replay failed: <reason>` on stdout and exits `1`.
   - Atomic-write contracts from features 7, 12, and 13 mean a crash mid-write never leaves a corrupt `summary.json` or `summary.md` — only `.tmp` files, which the operator can safely `rm` and replay again.

9. Does NOT re-run the extractor, the scroller, the dedup cache, the themes store writer, or the login flow. This is a read-raw + call-Claude + write-outputs feature, nothing else. If any of those modules throw on import time, that is a pre-existing bug, not this feature's concern.

10. Honors the `--dry-run` flag when passed (`pnpm replay <runId> --dry-run`). Dry-run promise per feature 15 is "no API calls, no writes". Replay with dry-run prints `dry-run: replay <runId> — would re-summarize <N> posts, writer skipped` (where `N` is `payload.posts.length`) and exits `0`. No Claude call, no `summary.json` write, no `summary.md` write. This mirrors the scroll path's dry-run contract and keeps the operator's mental model stable across verbs.

11. Honors the `--config <path>` flag per feature 3's dispatcher — `config` is already loaded by `handleReplayCommand` before `handleReplay` is invoked, so this feature does not parse flags directly. Unknown flags are rejected by the dispatcher (feature 3, anti-persona guardrail).

12. Adds zero runtime dependencies. `fs/promises`, `path`, and the existing summarizer/writer/state modules are enough. No new module under `src/` other than the replaced `src/cli/replay.ts` body — the handler is short enough to live in one file alongside a small `loadRawJson` helper. If the helper grows past ~30 lines, it extracts to `src/replay/load-raw.ts`; otherwise it stays inline.

The module does not know about `--replay`'s entry shim in `src/replay.ts` (that is feature 3's concern), does not re-validate `config.yaml` (the loader already did), and does not care whether the original run used a different model — today's config wins.

### Scenario: Happy-path replay — `raw.json` on disk, Claude succeeds, `summary.md` is re-rendered

Given `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json` exists with `schemaVersion: 1` and 84 posts
And the operator's `config.claude.apiKey` is set and `config.claude.model` is `"claude-sonnet-4-6"`
And the rolling themes store exists and contains 3 prior runs of themes (from real scrolls earlier this week)
When the operator runs `pnpm replay 2026-04-17T09-02-14Z`
Then `raw.json` is read and parsed
And `summarizeRun` is called with `posts: <84 posts>`, `newPostIds: []`, `priorThemes: <current recentThemes>`, `interests: <config.interests>`, `runId: "2026-04-17T09-02-14Z"`, `model: "claude-sonnet-4-6"`
And on Claude success, `<runDir>/summary.json` is written atomically (tmpfile → rename)
And `<runDir>/summary.md` is rendered via `writeSummaryMarkdown` and written atomically
And the rolling themes store is NOT updated (theme file's mtime and content are unchanged vs. before the replay)
And stdout reads `replayed 2026-04-17T09-02-14Z: summarized (5 themes, 3 worth clicking) — rendered to ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md`
And `pnpm replay` exits `0`
(This is the "I fixed the prompt, show me yesterday again" path. The operator gets a fresh `summary.md` without re-scrolling.)

### Scenario: Recovery replay — original scroll hit rate-limit, replay finishes the job

Given yesterday's `pnpm scroll` wrote `raw.json` and then `summary.error.json` with `reason: "rate_limited"`
And `<runDir>/summary.json` does NOT exist, `<runDir>/summary.md` does NOT exist
And 10 minutes have passed and the API is available again
When the operator runs `pnpm replay <yesterdays-run-id>`
Then `summarizeRun` succeeds
And `<runDir>/summary.json` is created
And `<runDir>/summary.md` is created
And `<runDir>/summary.error.json` from the original run remains on disk (the replay does NOT delete it; the operator's `ls` shows the full forensic history)
And the rolling themes store is NOT updated — it was already skipped on the original run per feature 12, and the replay does not append either (replays never touch cumulative state)
And stdout reads `replayed <runId>: summarized (...) — rendered to ...`
And `pnpm replay` exits `0`
(The vision's "never lose scroll effort" payoff. The scroll from yesterday is still useful today. This is the primary persona's most common replay trigger.)

### Scenario: Run id does not exist — fails fast with the path

Given `~/scrollproxy/runs/` exists but has no directory named `nonesuch`
When the operator runs `pnpm replay nonesuch`
Then stdout reads `no run found: ~/scrollproxy/runs/nonesuch`
And no Claude call is made, no files are written, no state is read beyond the run directory check
And `pnpm replay` exits `1`
(Operator frustration: "Broken automation that fails silently." A named path tells the operator exactly where to `ls` to see what run ids actually exist.)

### Scenario: Run directory exists but `raw.json` does not — fails fast

Given `~/scrollproxy/runs/2026-04-17T09-02-14Z/` exists
And the directory contains `raw.json.tmp` (from an interrupted scroll) but no `raw.json`
When the operator runs `pnpm replay 2026-04-17T09-02-14Z`
Then stdout reads `no raw.json in ~/scrollproxy/runs/2026-04-17T09-02-14Z`
And no Claude call is made, no files are written
And `raw.json.tmp` is NOT auto-promoted, renamed, or deleted — the half-written file stays where it is for forensic inspection
And `pnpm replay` exits `1`
(The operator's recovery path here is to re-scroll, not to replay. Auto-promoting `.tmp` → `raw.json` would break the atomicity contract from feature 7.)

### Scenario: `raw.json` has unknown `schemaVersion` — fails loudly, no partial output

Given `<runDir>/raw.json` exists with `schemaVersion: 2` (from a future version of the tool)
When the operator runs `pnpm replay <runId>`
Then stdout reads `replay: unsupported raw.json schemaVersion 2, expected 1`
And no Claude call is made, no summary files are written
And `pnpm replay` exits `1`
(Mirrors feature 13's schema-version discipline. Replaying a v2 raw file through a v1 summarizer would silently mis-render; failing loudly preserves trust.)

### Scenario: `raw.json` is malformed JSON — fails loudly with the file path

Given `<runDir>/raw.json` exists but contains `{{{invalid` (not parseable as JSON)
When the operator runs `pnpm replay <runId>`
Then stdout reads `replay: failed to parse ~/scrollproxy/runs/<runId>/raw.json: Unexpected token` (the exact tail is the JSON parser's message; the prefix and file path are stable)
And no Claude call is made, no summary files are written
And `pnpm replay` exits `1`
(The operator can open the file and see what's wrong. Reproducibility principle: the tool names the file it failed on, never "something went wrong".)

### Scenario: Summarizer returns a rate-limit error on replay — `summary.error.json` is written, `summary.json` from a prior successful render is NOT deleted

Given `<runDir>/raw.json` exists and is valid
And `<runDir>/summary.json` already exists from a previous successful replay (e.g. an earlier iteration of prompt tuning)
And `<runDir>/summary.md` already exists from that prior replay
When the operator runs `pnpm replay <runId>` and the summarizer returns `{ status: 'error', reason: 'rate_limited' }`
Then `<runDir>/summary.error.json` is written with `{ schemaVersion: 1, runId, at: <ISO now>, reason: 'rate_limited' }` (overwrites any prior error file)
And `<runDir>/summary.json` from the prior replay is NOT deleted or modified
And `<runDir>/summary.md` from the prior replay is NOT deleted or modified
And stdout reads `replayed <runId>: summarizer failed: rate_limited`
And `pnpm replay` exits `1`
And the operator can still `open <runDir>/summary.md` to read their last successful render
(Failure mode preserves optionality. The operator keeps their most recent good summary visible while the error file records what happened on the latest attempt.)

### Scenario: `--dry-run` replay — no Claude call, no writes, post count reported

Given `<runDir>/raw.json` exists with 84 posts
When the operator runs `pnpm replay <runId> --dry-run`
Then `summarizeRun` is NOT called
And no `summary.json` or `summary.md` is written (nor is any `.tmp` file left behind)
And no existing files in `<runDir>` are modified
And stdout reads `dry-run: replay <runId> — would re-summarize 84 posts, writer skipped`
And `pnpm replay` exits `0`
(Dry-run promise from feature 15: "no API calls, no writes". Replay honors it. Useful for the operator to confirm `raw.json` is parseable before committing to a billed Claude call.)

### Scenario: `pnpm replay` with no run-id is rejected by the dispatcher (feature 3 contract, reaffirmed)

Given the operator forgets the positional
When they run `pnpm replay`
Then stderr reads `replay requires a run-id: pnpm replay <run-id>` (from feature 3's dispatcher)
And `handleReplay` is NOT invoked
And the process exits `2`
(This scenario already exists in feature 3's spec; it is restated here so a future refactor of `src/cli/index.ts` does not break the contract. No new code in this feature — the dispatcher's guardrail is the contract.)

### Scenario: Rolling themes store is not appended on replay — the window stays honest

Given the rolling themes store contains exactly 3 entries (runs R1, R2, R3) and the latest-entry mtime is `T0`
And `<runDir>/raw.json` for run R2 exists
When the operator runs `pnpm replay R2` and the summarizer succeeds
Then after replay, the themes store still contains exactly 3 entries (R1, R2, R3) in the same order with the same themes as before
And the themes store file's mtime is NOT advanced past `T0` by this feature
(Replays are not new runs. If `--replay` appended to the themes store, R2 would appear twice in the rolling window; "what changed this week?" would lie. The cumulative-intelligence story depends on the rolling window matching the count of real scrolls.)

### Scenario: `config.output.dir` override via `--config` — replay resolves the run against the overridden path

Given `/tmp/alt-config.yaml` sets `output.dir: /tmp/alt-runs`
And `/tmp/alt-runs/2026-04-17T09-02-14Z/raw.json` exists with `schemaVersion: 1`
And the default `~/scrollproxy/runs/2026-04-17T09-02-14Z/` does NOT exist
When the operator runs `pnpm replay 2026-04-17T09-02-14Z --config /tmp/alt-config.yaml`
Then replay resolves the run directory as `/tmp/alt-runs/2026-04-17T09-02-14Z/`
And `summary.json` and `summary.md` are written under `/tmp/alt-runs/2026-04-17T09-02-14Z/`
And `pnpm replay` exits `0`
(The operator's testing workflow: keep a "scratch" config pointing at a throwaway runs directory so replays during prompt tuning don't pollute the real runs directory.)

### Scenario: Run-id with a leading path separator is rejected

Given the operator copy-pastes `./2026-04-17T09-02-14Z` or `/abs/path` as the run-id by accident
When they run `pnpm replay ./2026-04-17T09-02-14Z`
Then stdout reads `replay: run-id must be a directory name, not a path: ./2026-04-17T09-02-14Z`
And no filesystem read is attempted
And `pnpm replay` exits `1`
(Defensive input handling matching the operator's mental model: the run-id is what `ls ~/scrollproxy/runs` prints, not a path. Accepting paths would permit directory traversal in a multi-user context — not a real threat for a personal tool, but reinforcing "run-id is a name" keeps the contract small.)

## User Journey

1. Operator's morning scroll ran overnight via cron or they ran `pnpm scroll` at 9am.
2. Either: (a) Claude rate-limited and `summary.error.json` was written, or (b) the operator has since tweaked `config.yaml` (new interests, new model, new prompt).
3. **Operator runs `pnpm replay <run-id>`** — the last scroll's id is visible in the previous terminal line, or they `ls ~/scrollproxy/runs | tail -1`.
4. Replay reads `raw.json`, calls Claude with today's config, writes `summary.json` + `summary.md`, exits 0.
5. Operator runs `open ~/scrollproxy/runs/<run-id>/summary.md` and reads the new summary.
6. If the new summary is better, they're done. If worse, they iterate on `config.yaml` and run `pnpm replay <run-id>` again. `raw.json` is the cached input; the feedback loop is bounded by Claude's latency, not by scrolling x.com.

The operator's daily ritual does not change. `pnpm replay` is the safety valve for the two failure modes (API flake, prompt iteration) that would otherwise force a re-scroll.

## CLI Mockup

Happy-path replay:

```
$ pnpm replay 2026-04-17T09-02-14Z
replayed 2026-04-17T09-02-14Z: summarized (5 themes, 3 worth clicking) — rendered to ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md
$
```

Recovery from rate-limit:

```
$ pnpm scroll --minutes 10
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
scroll complete: 184 ticks over 603s — 84 posts extracted (6 ads skipped) — 38 new, 46 already seen — summarizer failed: rate_limited — saved to ~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json
$ pnpm replay 2026-04-17T09-02-14Z
replayed 2026-04-17T09-02-14Z: summarized (5 themes, 3 worth clicking) — rendered to ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md
$ open ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md
```

Missing run:

```
$ pnpm replay nonesuch
no run found: ~/scrollproxy/runs/nonesuch
$ echo $?
1
```

Missing `raw.json`:

```
$ pnpm replay 2026-04-17T09-02-14Z
no raw.json in ~/scrollproxy/runs/2026-04-17T09-02-14Z
$ echo $?
1
```

Unsupported schema:

```
$ pnpm replay 2026-04-17T09-02-14Z
replay: unsupported raw.json schemaVersion 2, expected 1
$ echo $?
1
```

Summarizer failure on replay:

```
$ pnpm replay 2026-04-17T09-02-14Z
replayed 2026-04-17T09-02-14Z: summarizer failed: rate_limited
$ echo $?
1
```

Dry-run:

```
$ pnpm replay 2026-04-17T09-02-14Z --dry-run
dry-run: replay 2026-04-17T09-02-14Z — would re-summarize 84 posts, writer skipped
$ echo $?
0
```

## Component References

N/A — CLI tool, no UI components.

## Out of Scope for This Feature

- Re-hydrating the dedup cache from historical `raw.json` files (not a real operator need; would risk double-counting)
- Replaying multiple runs in a batch (`pnpm replay <id1> <id2>` — not a daily pain point; add if ever requested)
- Per-replay overrides for `model`, `interests`, or prompt (the operator uses `--config` or edits `config.yaml` — one knob, not two)
- Listing available run ids (`pnpm replay --list` — the operator uses `ls ~/scrollproxy/runs`)
- Deleting stale `summary.error.json` files after a successful replay (operator's disk, operator's problem — consistent with feature 7's "no retention policy" stance)
- `--dry-run` end-to-end contract plumbing (that is feature 15's concern; this feature honors it locally)
- Notion writer replay path (feature 20 territory)

## Persona Revision Notes

Drafted in operator vocabulary throughout: **scroll**, **replay**, **run**, **run id**, **summary**, **worth clicking**. Terminal output lines match the exact cadence of the scroll path's output ("replayed X: summarized (N themes, M worth clicking) — rendered to ...") so the operator's eye tracks the same columns whether they're reading a scroll line or a replay line.

Patience-level alignment: the operator is **Very Low** patience for daily use. Replay is one command, one positional, one line of output, exit 0 on success. No interactive prompts, no "are you sure you want to overwrite summary.json?" confirmation, no progress bar. The only friction is typing the run id, which the operator copy-pastes from the previous terminal line or `ls`.

Anti-persona check: no hosted-product features leaked in (no `--notify`, no `--webhook`, no "replay all runs in the last 7 days"). Replay is not a batch tool, not a service, not a dashboard. It is one command that re-renders one run. Unknown flags are rejected by feature 3's dispatcher, consistent with the config loader's strict-mode stance.

Frustrations addressed:
- "Tools that hide what they're doing" → every error names the file or directory it failed on (`no run found: <path>`, `no raw.json in <runDir>`, `replay: failed to parse <path>: <reason>`).
- "Broken automation that fails silently" → every failure exits non-zero; no silent no-ops.
- "Opening X for one thing" → recovery from rate-limit errors no longer requires re-scrolling, which would mean either re-opening the browser or waiting another cycle; replay closes that loop.
- "Tools that summarize by averaging everything into mush" → no change to the summarizer's ruthlessness contract from feature 12; replay is a loyal re-render.

Cumulative-intelligence integrity:
- Rolling themes store is NOT appended on replay. This is the non-obvious correctness decision of the feature. Appending would double-count any replayed run and corrupt the rolling window's meaning. The operator's "what changed this week?" habit depends on the window counting real scrolls, not re-renders.
- Dedup cache is NOT touched on replay. The posts in `raw.json` were already recorded; re-recording them would be a no-op at best (same hashes) or a correctness bug at worst if the cache's LRU window drifts.

## Learnings

### CLI Test Fixtures Must Match Runtime Dependencies

**Problem:** CLI entry tests for replay were failing with exit 1 because tests invoked the real replay handler but didn't set up the fixtures it needs (run directory with `raw.json`, state directory for themes store).

**Solution:** Created `setupTestRunDirectory` helper that creates both the run directory with a minimal valid `raw.json` AND the state directory before invoking CLI commands. Used `--dry-run` flag to test CLI routing without making actual Claude API calls.

**Why:** The replay handler loads the themes store on startup, which requires the state directory to exist. Tests that verify CLI routing (not just argument parsing) need to provide all dependencies the handler expects, even if they're not the focus of the test.

**Pattern:** For CLI routing tests that invoke real handlers:
1. Use `--dry-run` flag to skip expensive operations (API calls, writes)
2. Create minimal fixtures for all runtime dependencies (directories, config files, data files)
3. Extract fixture creation to helpers when duplication appears (~40 lines → `createMinimalRawJson`, `setupTestRunDirectory`)

### Stale Test Expectations from Stub Implementations

**Gotcha:** Test expectations at line 301 still referenced "not yet wired feature 14" from when replay was a stub. When the feature was implemented, the test expectation became stale and caused failures.

**Solution:** Removed the stub message expectation and replaced with the actual handler's behavior (routing to replay with `--dry-run`).

**When to apply:** When implementing a feature that replaces a stub, search test files for stub message strings and update expectations to match the real implementation's behavior.

<!-- Updated via /compound -->
