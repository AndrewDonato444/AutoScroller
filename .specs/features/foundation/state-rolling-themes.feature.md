---
feature: State Module (Rolling Themes Store)
domain: foundation
source: src/state/rolling-themes.ts
tests:
  - tests/foundation/state-rolling-themes.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# State Module (Rolling Themes Store)

**Source File**: `src/state/rolling-themes.ts` (new). Not wired into `src/cli/scroll.ts` in this feature — the summarizer (feature 12) will wire it when it lands.
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Remember the last 10 runs' themes so tomorrow's summarizer can say "still talking about X, newly talking about Y"

The dedup cache (feature 10) lets a run say "38 new, 22 already seen" at the post level. But the operator's actual question on day five is not "which posts are new?" — it is "what is the feed *about* right now, and what is *different* about it since last week?" That question is answered at the **theme** level, not the post level, and it requires the tool to remember the themes from prior runs.

This feature is the second half of the cumulative-intelligence substrate — a tiny state file under `~/scrollproxy/state/` that remembers the themes the summarizer (feature 12) extracted on each of the last 10 runs, plus the helper functions feature 12 will use to ask "what were the rolling themes going into this run?" and "record the themes I just extracted for next time."

Vision principle 6 — **"Cumulative intelligence. Each run builds on prior runs via dedup and rolling themes. The tool should get better at separating signal from noise over time."** — is the same load-bearing principle that drove feature 10. The dedup cache handles the post-level half; this feature handles the theme-level half. Together they are what feature 12 reads to produce a summary that says "the feed's been on agent orchestration all week; today it tilted toward indie-dev distribution for the first time."

This feature ships the **store only** — not the summarizer, not the markdown writer, not any CLI output. The module is library-grade plumbing that feature 12 will import. No CLI wiring, no summary-line fragment, no new flags. This matches the dedup-cache philosophy: keep the two state files' shapes and lifetimes independent so feature 12 can bolt them together without touching their invariants.

This feature ships a `src/state/rolling-themes.ts` module that:

1. Exports `loadThemesStore(stateDir: string): Promise<ThemesStore>`. Reads `<stateDir>/rolling-themes.json`. If the file does not exist, returns an empty store (first run). If the file is corrupt (invalid JSON, wrong `schemaVersion`), it is renamed to `rolling-themes.json.corrupt-<timestamp>` and an empty store is returned — a corrupt themes file must never kill a scroll, identical to the dedup-cache contract.
2. Exports `saveThemesStore(store: ThemesStore, stateDir: string): Promise<{ statePath: string }>`. Serializes the store to `<stateDir>/rolling-themes.json` atomically (tmpfile → rename, same pattern as features 7 and 10). Creates `<stateDir>/` recursively if missing.
3. Exports `ThemesStore` as a small record, not a class: `{ schemaVersion: 1; runs: RunThemes[] }`. `runs` is a FIFO list — oldest run at index `0`, newest at the end. One ordering invariant, mirroring the dedup cache.
4. Exports `RunThemes` as: `{ runId: string; endedAt: string; themes: string[] }`. `runId` matches the `raw.json` run id (e.g., `2026-04-16T14-32-07Z`). `endedAt` is ISO-8601 UTC. `themes` is a compact array of short labels the summarizer produced (e.g., `["agent orchestration", "indie-dev distribution", "sports-betting odds math"]`) — not prose, not paragraphs.
5. Exports `appendRun(store: ThemesStore, run: RunThemes): ThemesStore`. Returns a new store (does not mutate input) with `run` appended, then truncated from the front so `runs.length <= MAX_RUNS`. Default `MAX_RUNS = 10`. Eviction is FIFO: when the store is full, the oldest run falls off the front. Duplicate `runId` entries replace the prior entry in place (a `--replay <runId>` re-summarize overwrites that run's themes rather than double-counting it).
6. Exports `recentThemes(store: ThemesStore, limit?: number): string[]`. Returns a flat, duplicate-preserving list of themes from the newest `limit` runs (default: all runs in the store), newest run's themes last. This is the helper feature 12 will use to build its "prior themes" prompt context without the summarizer having to iterate `runs` itself.
7. Exports a `THEMES_SCHEMA_VERSION = 1` constant and a `MAX_RUNS = 10` constant, both read-only. A file with `schemaVersion !== 1` triggers the same "rename to .corrupt-<timestamp>, return empty" path as a parse failure — future-you adds a reader branch when bumping to `2`, not a silent migration.
8. Is NOT wired into `src/cli/scroll.ts` in this feature. There is nothing to store yet — themes are produced by feature 12's Claude call. Adding CLI wiring now would either fabricate themes (violates vision principle "no mock data") or write empty `themes: []` arrays on every run (pollutes the store with meaningless entries). Feature 12 will wire this module when it imports it.
9. Adds zero runtime dependencies. `node:fs/promises` and `node:path` are already in use. No hashing is required (themes are stored as plain strings); no LRU library is required (FIFO eviction at 10 entries is a 3-line array slice). Personal-tool simplicity, same as the dedup cache.

The module does not know about Claude, markdown, the dedup cache, or the `--replay` flag. It does not expose the store over any network, nor does it include any data beyond the run id, the end timestamp, and the theme labels the summarizer chose — no post content, no author handles, no metrics, no operator metadata.

### Scenario: First run ever — no state file exists, loading returns an empty store

Given `<stateDir>/rolling-themes.json` does not exist
When `loadThemesStore(stateDir)` runs
Then it returns `{ schemaVersion: 1, runs: [] }`
And no file is created (load is read-only on miss)
And no warning is logged (a missing themes file on day one is the expected shape)
(Day one is the moment the rolling-themes story starts; the first load must return empty so feature 12 can proceed as if there is no prior context to cite.)

### Scenario: Appending the first run's themes — store grows to one entry

Given an empty store `{ schemaVersion: 1, runs: [] }`
And a `RunThemes` entry `{ runId: "2026-04-16T14-32-07Z", endedAt: "2026-04-16T14:35:07.000Z", themes: ["agent orchestration", "indie-dev distribution"] }`
When `appendRun(store, run)` runs
Then the returned store has `runs.length === 1`
And `runs[0]` equals the input run entry (reference-equal fields, deep-equal arrays)
And `saveThemesStore(appendedStore, stateDir)` writes `<stateDir>/rolling-themes.json`
And the saved file contains `{ schemaVersion: 1, runs: [<the one run>] }`
(The first save is what makes day two's load non-empty; there is no other entry point for populating the store.)

### Scenario: Eleventh run — FIFO eviction drops the oldest run

Given a store with exactly `MAX_RUNS === 10` runs, ordered oldest-first at index 0
And an eleventh `RunThemes` entry with a fresh `runId` not present in the store
When `appendRun(store, run)` runs
Then the returned store's `runs.length === 10`
And the run that was previously at index 0 is no longer present
And the run that was previously at index 1 is now at index 0
And the new run is at index 9 (the end of the array)
And the operator does not see any warning — eviction at 10 is routine, not exceptional
(Bounded history matters for a file the operator never prunes. 10 runs is roughly 10 days of daily scrolls; older than that, "what were the themes two weeks ago?" stops being a useful signal and starts being archaeology.)

### Scenario: Re-appending an existing runId — the prior entry is replaced in place

Given a store with 5 runs, the third of which has `runId: "2026-04-15T14-10-00Z"` and `themes: ["agent orchestration"]`
And a `RunThemes` entry with the same `runId: "2026-04-15T14-10-00Z"` and `themes: ["agent orchestration", "newly surfaced theme"]`
When `appendRun(store, run)` runs
Then the returned store's `runs.length === 5` (no growth — a replay replaces, does not duplicate)
And the entry at the prior index (2) now has the new `themes` array
And the FIFO order of the other four runs is preserved
And no duplicate `runId` appears anywhere in the returned store
(Feature 14's `--replay <runId>` will re-run the summarizer against a saved `raw.json`. If that re-summary wrote a second entry with the same runId, the rolling window would be silently shortened by one real run every time a replay happens. In-place replacement keeps the window honest.)

### Scenario: recentThemes flattens newest-last across multiple runs

Given a store with three runs:
  | Index | runId                     | themes                              |
  | 0     | `2026-04-14T...`          | `["A", "B"]`                        |
  | 1     | `2026-04-15T...`          | `["B", "C"]`                        |
  | 2     | `2026-04-16T...`          | `["D"]`                             |
When `recentThemes(store)` is called with no limit
Then it returns `["A", "B", "B", "C", "D"]` (oldest run's themes first, newest run's themes last)
And duplicates are preserved (the helper does not dedup — feature 12 decides whether repetition is signal)
When `recentThemes(store, 2)` is called
Then it returns `["B", "C", "D"]` (themes from the last two runs, in order)
When `recentThemes(store, 0)` is called
Then it returns `[]`
When `recentThemes(store, 99)` is called
Then it returns all five themes from all three runs (limit clamps to `runs.length`)
(Feature 12 will want "the last N runs' themes" as a flat list for prompt injection. Pushing the limit and flatten logic into the store keeps feature 12's call site one line long and gives the store a single place to enforce ordering.)

### Scenario: Corrupt state file is quarantined, not crash

Given `<stateDir>/rolling-themes.json` exists but its contents are `{"not valid json`
When `loadThemesStore(stateDir)` runs
Then the corrupt file is renamed to `<stateDir>/rolling-themes.json.corrupt-<epochMs>`
And `loadThemesStore` returns `{ schemaVersion: 1, runs: [] }`
And a one-line warning is logged: `rolling themes corrupt; quarantined to rolling-themes.json.corrupt-<epochMs>, starting fresh`
(Frustration addressed: "broken automation that fails silently." The operator sees exactly what happened and keeps the old file for forensic review — they can `cat` it, `jq` it, or delete it at their pace. Same quarantine contract as feature 10 so there is one mental model for state corruption.)

### Scenario: Schema mismatch is treated the same as corruption

Given `<stateDir>/rolling-themes.json` parses as valid JSON but contains `{ "schemaVersion": 2, "runs": [...] }`
When `loadThemesStore(stateDir)` runs
Then the file is renamed to `<stateDir>/rolling-themes.json.corrupt-<epochMs>`
And an empty store is returned
And a warning is logged: `rolling themes schema 2 not supported by this build; quarantined and started fresh`
(A future ScrollProxy version may bump the schema. This build must not crash when it sees a forward-version file written by that future build; it must also not silently pretend it understands. Quarantine is the honest middle — same pattern the dedup cache uses.)

### Scenario: Atomic save — a crash mid-write never produces a half-written store

Given a save is running
When the process is killed between the tmpfile write and the rename
Then `<stateDir>/rolling-themes.json.tmp` exists (possibly partial)
And `<stateDir>/rolling-themes.json` is untouched (either the prior version, or absent if this was the first save)
And the next `loadThemesStore` call returns the prior store (or empty on first run) — never a truncated file
(Same atomic-write pattern as features 7 and 10. Losing the mid-write state is acceptable; silently truncating the rolling window would erode the operator's "what were we talking about last week" signal going forward.)

### Scenario: Store file shape is locked at schema version 1

Given an `appendRun` has grown the store to 3 runs
When `saveThemesStore` serializes the payload
Then the top-level keys, in order, are: `schemaVersion`, `runs`
And `schemaVersion` is the literal number `1`
And `runs` is a JSON array of `RunThemes` objects
And each `RunThemes` object's keys, in order, are: `runId`, `endedAt`, `themes`
And no other keys appear in the file — no `createdAt`, no `hostname`, no `operatorId`, no per-run metrics, no post counts, no summarizer model id, no token usage counters
And `JSON.stringify(payload, null, 2)` is used — 2-space indentation, UTF-8
(Locking the shape keeps the file self-describing and grep-friendly. Any additional field is a future-proofing temptation that invites anti-persona features — "track which model wrote which summary with what latency" is the beginning of a SaaS observability product ScrollProxy explicitly rejects.)

### Scenario: Store file contains no post content and no PII

Given a run whose themes are derived from 84 posts with authors, text, URLs, and metrics
When `saveThemesStore` serializes the payload
Then the on-disk file contains only the `runId`, `endedAt`, and the short theme labels — no post text, no author handles, no URLs, no media links, no metrics, no API keys, no model identifiers
And the file is safe to paste into an issue, commit accidentally, or share to debug
(The anti-persona's "give me a dashboard of what I've been reading" feature would need richer state. Labels-only at rest is the firewall — same principle as the dedup cache's hashes-only rule.)

### Scenario: State directory is respected from config and expanded

Given `config.output.state` is `~/scrollproxy/state` (the default)
When `loadThemesStore` and `saveThemesStore` resolve the path
Then `~` is expanded via the same `expandHomeDir` helper the scroller, writer, and dedup cache use
And the store file lives at `<expandedHome>/scrollproxy/state/rolling-themes.json`
And a custom config like `output.state: /tmp/test-state` writes to `/tmp/test-state/rolling-themes.json` without tilde handling
And the state directory is created with `fs.mkdir(..., { recursive: true })` if missing
(One home-dir helper. Same pattern as the raw.json writer and the dedup cache. If three state artifacts end up sharing a directory, three call sites should not each reinvent path expansion.)

### Scenario: Store module never writes outside `output.state`

Given the configured `output.state` is `~/scrollproxy/state`
When any rolling-themes function runs
Then every file it creates is under `<expandedStateDir>/`
And the module does NOT read or write anything under `~/scrollproxy/runs/` (feature 7 owns runs)
And the module does NOT read or write `<stateDir>/seen-posts.json` (feature 10 owns the dedup cache)
And the module does NOT touch any file at the repo root during tests (tests always pass an explicit `stateDir`)
(Boundary enforcement: each state file is owned by exactly one module. `rm ~/scrollproxy/state/rolling-themes.json` does not clobber the dedup cache, and vice versa. The operator can reset one axis of cumulative intelligence without touching the other.)

### Scenario: Module adds no new runtime dependencies

Given a contributor reviews `package.json` after this feature lands
When they inspect new runtime deps
Then no atomic-write library is added (reuses the `writeFile` + `rename` pattern from features 7 and 10)
And no LRU / cache library is added (FIFO eviction is a 3-line array slice)
And no dependency is added at all — the module is pure Node stdlib
(Playwright + Node + Zod + @anthropic-ai/sdk is still the whole toolkit. Personal-tool simplicity — same budget as feature 10.)

### Scenario: Module is library-only — no CLI integration in this feature

Given the operator runs `pnpm scroll` after this feature lands (but before feature 12)
When the scroll completes
Then the summary line is unchanged from what feature 10 produced (`— N new, M already seen — saved to ...`)
And `<stateDir>/rolling-themes.json` is NOT created by this feature
And no new CLI flags exist
And no import of `rolling-themes.ts` appears in `src/cli/scroll.ts`
And the module is exercised only by its unit tests and (in the future) by feature 12's summarizer
(Vision principle: "features either work end-to-end or they aren't done." This feature's end-to-end surface is the module's library API. Feature 12 is the user-facing integration; wiring this module to the CLI with nothing to store would violate the "no mock data" rule.)

### Scenario: Empty-themes run is still a valid run entry

Given a `RunThemes` entry `{ runId: "...", endedAt: "...", themes: [] }` (the summarizer produced no themes — e.g., the feed was all noise today)
When `appendRun(store, run)` runs
Then the returned store contains the empty-themes entry
And it counts as one slot in the 10-run window
And `recentThemes(store)` still returns the flat list without throwing on the empty array
(An all-noise day is still a data point. Refusing to record it would silently extend the rolling window on bad-signal days, which is the opposite of the operator's "ruthless editor" preference — the empty entry is itself the honest answer.)

## User Journey

1. The operator has been running `pnpm scroll` daily since feature 10 shipped. Each run produces a `raw.json` and updates `~/scrollproxy/state/seen-posts.json`. The summary line tells them today's new-vs-seen delta at the post level.
2. **They pull this build. Nothing visible changes in the CLI output.** `pnpm scroll` still prints the same summary line as yesterday; no new file appears under `~/scrollproxy/state/`. This feature is invisible plumbing — the module is now available for feature 12 to import.
3. Under the hood: a new `src/state/rolling-themes.ts` sits next to `src/state/dedup-cache.ts`, exporting `loadThemesStore`, `saveThemesStore`, `appendRun`, `recentThemes`, and the `THEMES_SCHEMA_VERSION` / `MAX_RUNS` constants. Its unit tests cover the same quarantine, schema-mismatch, atomic-save, and FIFO-eviction contracts the dedup cache has. The operator can read the module and recognize the shape immediately.
4. When feature 12 (Claude summarizer) lands, it will import this module and — after every successful run — call `appendRun` with the summarizer's extracted themes, then `saveThemesStore`. The next run's summarizer will start by calling `loadThemesStore` + `recentThemes` to build its "prior themes" context. The rolling-themes file becomes visible on disk at that point, not before.
5. The operator can `cat ~/scrollproxy/state/rolling-themes.json` once feature 12 ships and see an ordered array of up to 10 small objects, each with a runId, endedAt, and a handful of short theme labels. That is all. No post content, no PII, no API keys, nothing platform-identifying beyond the runId-shaped timestamps. The operator's "keeping their own data" principle is honoured at the shape level.
6. If the store ever goes sideways (corrupt, schema mismatch, disk full), the operator will see a one-line warning from the summarizer-phase of a future run, the original file is preserved under a `.corrupt-<timestamp>` suffix, and the next scroll starts fresh on that axis (dedup-cache behaviour is unaffected). The worst case is losing the last 10 runs of theme history — never a crashed scroll.

## CLI Mockup

This feature ships no CLI output of its own. The operator-facing surface is unchanged from feature 10.

However, the on-disk shape this module will maintain (once feature 12 wires it) is a contract this feature locks in now:

```
$ jq '{version: .schemaVersion, run_count: (.runs | length), newest: .runs[-1]}' \
    ~/scrollproxy/state/rolling-themes.json
{
  "version": 1,
  "run_count": 3,
  "newest": {
    "runId": "2026-04-16T14-32-07Z",
    "endedAt": "2026-04-16T14:35:07.000Z",
    "themes": [
      "agent orchestration",
      "indie-dev distribution",
      "sports-betting odds math"
    ]
  }
}
```

Inspecting themes across the window (what feature 12 will do with `recentThemes`):

```
$ jq '[.runs[].themes] | flatten' ~/scrollproxy/state/rolling-themes.json
[
  "agent orchestration",
  "claude code workflows",
  "agent orchestration",
  "indie-dev distribution",
  "agent orchestration",
  "indie-dev distribution",
  "sports-betting odds math"
]
```

Corrupt store is quarantined (once feature 12 is calling this module):

```
$ echo "{broken" > ~/scrollproxy/state/rolling-themes.json
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: ...)
  rolling themes corrupt; quarantined to rolling-themes.json.corrupt-1713280000000, starting fresh
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — 84 new, 0 already seen — saved to ~/scrollproxy/runs/2026-04-16T14-32-07Z/raw.json
$ ls ~/scrollproxy/state/
rolling-themes.json
rolling-themes.json.corrupt-1713280000000
seen-posts.json
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Claude summarizer (feature 12). This feature ships the store the summarizer will write to; it does not produce themes itself.
- Markdown writer's cross-run rendering (feature 13). The `## Themes` section will read from this store; this feature does not render anything.
- CLI wiring of `appendRun` / `saveThemesStore` in `src/cli/scroll.ts`. With no summarizer, there are no themes to store; wiring now would mean writing `themes: []` on every run, which pollutes the window and violates "no mock data."
- Any "theme extraction" logic — this module is a store, not an NLP component. It accepts whatever string array the caller provides.
- Cross-run trend detection (feature 21, Phase 3). Drift analysis over the last 10 runs is feature 21's job; this feature only provides the substrate.
- Configurable `MAX_RUNS`. The 10-run limit is a constant exported from this module. If 10 proves wrong after real use, the constant changes in one place; no YAML key for it.
- Explicit store-reset / `--clear-themes` CLI flag. The operator can `rm ~/scrollproxy/state/rolling-themes.json` and the next feature-12 run starts with empty prior context — no dedicated UX for an operation done once a year.
- Encryption / at-rest protection. Theme labels are already low-sensitivity by design; encryption would add a key-management problem for a personal tool.
- Multi-machine sync. Each machine keeps its own rolling window. Two Macs would produce different "prior themes" context — and that is the right behaviour for a single-user local tool. Hosted sync is anti-persona territory.
- Schema migration tooling. When `schemaVersion` bumps to 2, the loader adds a read branch; quarantine-and-reset is the default for any unrecognized version — same contract as the dedup cache.
- Per-run metrics in the store (token usage, model id, latency). That would be the start of an observability product; the store tracks themes, not operator-side telemetry.
- Post-level attribution ("which posts produced theme X"). That would be richer state the anti-persona wants for analytics; this module stores labels only.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **run** (the scroll artifact), **themes** (what the feed is about, matching the persona's "themes" word), **rolling** (the adjective the roadmap uses for the bounded window), **store** (the file's role — not "database", not "service"), **already seen** language is deliberately *not* borrowed here because this module is not about posts. No "theme extraction pipeline", no "cross-run analytics layer", no "rolling aggregate service" — every one of those would smuggle SaaS architecture vocabulary the operator rejects.

Patience-level alignment:
- **Daily patience: Very Low.** This feature ships no new CLI output. The module is invisible until feature 12 uses it. The operator's daily command produces exactly the same summary line it produced yesterday.
- **Setup patience: High.** The operator is expected to understand that when feature 12 lands, a second state file appears under `~/scrollproxy/state/`, that it grows to at most 10 entries, and that corruption is quarantined. All of that is in the scenarios above; no CLI onboarding wizard is required.
- Error messages — which only surface once feature 12 wires this module — read as the operator would write them: `rolling themes corrupt; quarantined to <path>, starting fresh` mirrors the dedup cache's error line exactly. One mental model covers both state files.
- The on-disk shape (2-space JSON, fixed key order) mirrors `raw.json` and `seen-posts.json`. The operator's `jq` muscle memory transfers one-to-one across the three files.

Anti-persona check: every shape of hosted / multi-user / analytics / surveillance product the anti-persona would expect is blocked at the feature level.
- **No post content in the store** — a scenario forbids text, author, URL, metric, or model-identifying data. The anti-persona's "give me a dashboard of what I've been reading" feature would need richer state; labels-only is the firewall.
- **No user identity in the store** — no hostname, no account, no session cookie derived-value, no device fingerprint. The file is portable and anonymised by its shape.
- **No cloud sync** — a scenario forbids writing anywhere but `output.state`. The anti-persona's "sync my reading history across devices" feature would require a network call this module will never make.
- **No write actions derived from themes** — knowing last week's themes does not, under any branch of this feature, trigger a "follow users who post about theme X" API call. That was never on the table and it remains never on the table.
- **No observability model** — a label array per run is the entire model. Token counts, model ids, latency, and cost per run would be the beginning of a SaaS analytics product; explicitly out of scope.
- **No tagged stores for "work" vs. "personal"** — one operator, one feed, one rolling window per machine. Splitting into multiple windows would invite a config key, a CLI flag, and a UX for choosing between them — all complexity the single-user principle forbids.
- **No retention policy beyond FIFO-at-10** — the operator owns disk space. The store is bounded by count, not by time, so "retain last 30 days" is never a config decision. Ten runs is the window; anything older is archaeology.

Frustrations addressed:
- **"Cumulative intelligence"** (persona "what they care about" item 3) — this feature is the theme-level half of that promise. Once feature 12 lands, `recentThemes(store)` will let the summarizer say "still on X, newly on Y." This feature is the thing that makes that sentence possible.
- **"Keeping their own data"** (persona item 4) — the store is a local file under `~/scrollproxy/state/`, labels-only, no network, no account. The operator can `rm` it, `mv` it, `git`-ignore it, or back it up with their dotfiles. No SaaS dashboard ever reads it.
- **"Broken automation that fails silently"** (frustration) — corrupt files quarantine loudly, schema mismatches trigger the same quarantine path. Identical contract to the dedup cache so the operator has one mental model for state failures.
- **"Tools that hide what they're doing"** (frustration) — the store file is human-readable JSON with two top-level keys. One `jq` pipe shows the whole history. No hidden state, no opaque counters.
- **"Deterministic output"** (persona item 2) — `appendRun` is pure (no mutation), FIFO eviction is deterministic (not LRU or probabilistic), and replay re-uses `runId` to replace in place rather than duplicate. The same inputs always produce the same store.
- **"Tools that summarize by averaging everything into mush"** (frustration) — this feature does not summarize anything. It stores whatever labels the caller provides, in the order the caller provides them, and returns them unchanged when asked. Averaging is explicitly somebody else's job.

## Learnings

<!-- Updated via /compound -->
