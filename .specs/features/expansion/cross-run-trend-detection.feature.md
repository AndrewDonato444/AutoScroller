---
feature: Cross-Run Trend Detection
domain: expansion
source: src/trends/trend-detector.ts
tests:
  - tests/expansion/trend-detector.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# Cross-Run Trend Detection

**Source File**: `src/trends/trend-detector.ts` (new). Wired into `src/cli/scroll.ts` (after summarizer success) and `src/writer/markdown.ts` (new `## Trends` section).
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Tell the operator which themes are sticking around, which are showing up for the first time, and which have quietly fallen off the feed

The rolling-themes store (feature 11) remembers the last 10 runs' theme labels. The summarizer (feature 12) reads that store via `recentThemes` and asks Claude to make a prose call about drift — "still on agent orchestration, newly on indie-dev distribution." That prose call is fuzzy, model-dependent, and prone to confabulation: Claude has no way to count how many of the last 10 runs a theme actually appeared in, so it guesses based on the flat list it sees in its prompt.

This feature is the deterministic counterpart. Given the rolling-themes store and the run that just finished, it computes — without an API call, without prose — three small lists: themes that have been around for a while (**persistent**), themes that just showed up (**emerging**), and themes that used to be around but aren't anymore (**fading**). Those lists are written to `summary.json` and rendered in `summary.md` as a new `## Trends` section the operator can scan in two seconds.

Vision principle 6 — **"Cumulative intelligence. Each run builds on prior runs via dedup and rolling themes. The tool should get better at separating signal from noise over time."** — is the load-bearing principle here. The dedup cache handles post-level memory; the rolling-themes store handles theme-level memory; this feature is the analytical layer over that memory. Without it, the rolling-themes store is just storage; with it, the store earns its keep by answering the operator's day-five question — "what is *different* about the feed since last week?" — with counts the operator can verify, not vibes a model produced.

Vision principle 2 — **"Signal over completeness."** — shapes the output. The trends section does not list every theme that has ever appeared in the last 10 runs. It lists at most 5 persistent themes, at most 5 emerging themes, and at most 5 fading themes. If a category is empty (legitimately — a brand-new store has nothing persistent yet), it is omitted from the markdown rather than padded with `_(none)_` filler. The operator's "ruthless editor" preference applies to the trends layer the same way it applies to the summarizer.

This feature ships the **trend-detection module + the CLI/markdown wiring** — not a new file under `~/scrollproxy/state/`, not a new CLI flag, not a new `--trends` command. The trend report is computed on every successful scroll from data the rolling-themes store already holds; it lives inside `summary.json` (so feature 13's reader contract grows by one optional field) and inside `summary.md` (so the operator sees it without opening JSON). It is not persisted as a separate state artifact — recomputing from the store is cheap and avoids a third file the operator has to reason about.

This feature ships a `src/trends/trend-detector.ts` module that:

1. Exports `detectTrends(input: TrendInput): TrendReport`. `TrendInput` is `{ store: ThemesStore; currentThemes: string[] }`. The function is **pure** — no I/O, no `Date.now()`, no console output, no mutation of the input store. Same architectural posture as the rolling-themes store's `appendRun` and `recentThemes`: a deterministic transform the caller invokes after gathering inputs.
2. Exports a `TrendReport` type with exactly this shape (schema version 1):
   ```
   {
     schemaVersion: 1;
     persistent: PersistentTheme[];   // 0–5 items, most-frequent first
     emerging: EmergingTheme[];       // 0–5 items, most-recent first
     fading: FadingTheme[];           // 0–5 items, most-recently-faded first
   }
   ```
   Where:
   - `PersistentTheme` is `{ theme: string; runCount: number; firstSeenRunId: string; lastSeenRunId: string }` — `runCount` is how many of the runs in the input store contained this theme (current run included if `currentThemes` is supplied).
   - `EmergingTheme` is `{ theme: string; firstSeenRunId: string }` — themes whose first appearance across the input window is the current run or one of the most recent 2 runs, AND that did not appear in any earlier run in the store.
   - `FadingTheme` is `{ theme: string; lastSeenRunId: string; runsSinceLastSeen: number }` — themes that appeared in earlier runs but have been absent from the most recent 3 runs (current run included).
3. Exports a `TRENDS_SCHEMA_VERSION = 1` constant. The constant lives next to the type so a future bump (e.g., adding a `volatility` category) gets a single source of truth — same pattern as `THEMES_SCHEMA_VERSION` and `SUMMARY_SCHEMA_VERSION`.
4. Exports tunable thresholds as named constants: `PERSISTENT_MIN_RUNS = 4`, `EMERGING_MAX_AGE_RUNS = 2`, `FADING_MIN_AGE_RUNS = 3`, `MAX_PER_CATEGORY = 5`. Constants — not config keys. The 4 / 2 / 3 / 5 values are tuned for a 10-run window; if the operator wanted to tune them, they would also need to tune `MAX_RUNS`, and that argues for a coordinated future change rather than four independent YAML knobs today. Personal-tool simplicity, same constraint that kept `MAX_RUNS` out of config.
5. Treats theme strings as case-sensitive equal — `"AI agents"` and `"ai agents"` are different themes. The summarizer's prompt asks Claude for short, lowercase-style labels; the operator's `jq` muscle memory expects exact matches; any case-folding here would silently merge themes the operator can see are distinct in the store. Same string-equality contract as `recentThemes` returning the array unchanged.
6. Sorts each category by a stable rule:
   - `persistent`: `runCount` descending; ties broken by `lastSeenRunId` descending (more recent first); ties broken by theme string ascending. Same input always yields the same order.
   - `emerging`: `firstSeenRunId` descending (newest emergence first); ties broken by theme string ascending.
   - `fading`: `runsSinceLastSeen` ascending (most-recently-faded first); ties broken by `lastSeenRunId` descending; ties broken by theme string ascending.
   The deterministic-output principle (persona "what they care about" item 2) requires the same store to render the same trends section every time.
7. Treats the `currentThemes` input as the run that just finished — i.e., a run that has not yet been written to the store. The detector logically appends `currentThemes` to the store (under a synthetic runId of the literal string `"current"` for sort purposes) BEFORE computing categories. This means: emerging themes can include themes that just appeared in this run, and fading themes are computed against a window that includes the current run. The caller does NOT pre-append the current run via `appendRun` — that is the summarizer's job, and double-appending would shift the window incorrectly.
8. If `currentThemes` is omitted (the field is optional on `TrendInput`), the detector computes trends purely from the stored runs — useful for `--replay` (feature 14) that re-summarizes a saved run and wants the trend snapshot as-of that run's position in the window. In replay mode, the caller passes only the store and the categories reflect the stored history.
9. Returns empty arrays when the store has fewer than 2 runs total (current run included). With one run there is no "trend" — every theme is by definition both persistent (100% of the window) and emerging (just appeared) and fading (zero runs since last seen), and reporting any of those would be noise dressed as signal. Below the 2-run floor, the report's three arrays are all `[]` and the markdown renderer omits the `## Trends` section entirely.
10. Is wired into `src/cli/scroll.ts` immediately after the summarizer succeeds and BEFORE the markdown writer runs. The CLI:
    - Loads the themes store (already loaded for the summarizer's `priorThemes` — reuse the in-memory copy, don't re-read).
    - Calls `detectTrends({ store, currentThemes: summary.themes })`.
    - Adds the `TrendReport` to the in-memory `RunSummary` as a new optional field `summary.trends`.
    - Writes the augmented `summary.json` (atomic, same path as before — feature 12's contract gains one optional field, no new file).
    - Passes the augmented summary to the markdown writer, which renders the new section.
    The store-update step (`appendRun` + `saveThemesStore`) runs AFTER trend detection so the report reflects "what was true going into this run", and the store update reflects "what we now know about this run" — the same temporal ordering the dedup cache uses.
11. Is wired into `src/writer/markdown.ts` as a new `## Trends` section that renders BETWEEN `## Themes` and `## Worth clicking`. The renderer:
    - Omits the section entirely if `summary.trends` is undefined (older `summary.json` files written before this feature shipped) OR if all three category arrays are empty (early-life store with <2 runs).
    - Renders each non-empty category as a bullet list with subtitles `### Persistent`, `### Emerging`, `### Fading` (h3, not h2 — the trends section is one section, not three).
    - Persistent items render as `- {theme} — {runCount}/{windowSize} runs`, where `windowSize` is the highest `runCount` among persistent themes in this report (a conservative denominator — if a theme appears in every run of the effective window, `windowSize` equals the actual window length; if the top theme does not appear in every run, the denominator is lower than the window length but still never less than any individual `runCount`). Deriving the denominator this way avoids threading the store's window size through the markdown writer and keeps the `TrendReport` shape unchanged.
    - Emerging items render as `- {theme} — first seen {runId-shaped-timestamp}`.
    - Fading items render as `- {theme} — last seen {runId-shaped-timestamp}, {runsSinceLastSeen} runs ago`.
    - Empty individual categories within an otherwise-populated trends section are omitted (no `### Persistent` heading with nothing under it).
12. Adds zero runtime dependencies. `node:fs/promises` is not even needed — the module is pure logic over plain objects. No date library, no statistics library, no LRU. Personal-tool simplicity, same budget as features 10 and 11.
13. Is NOT wired into the summarizer's prompt. Feeding the trend report back into Claude as context would create a circular dependency — Claude produces themes, the detector categorizes them, then we hand the categories back to Claude on the next run, which would bias Claude toward repeating "persistent" themes to keep them persistent. Keeping the layers separate (Claude produces; detector analyses) preserves the deterministic guarantee and the "Claude is a ruthless editor, not a memory" stance.
14. Is NOT a new state file. The trend report is a derived view of the rolling-themes store; persisting it would create a second source of truth (and a third state file under `~/scrollproxy/state/`) that could drift from the store. Recomputing from the store on every run is O(themes × runs) — cheap enough that caching is premature.
15. Does NOT introduce a new CLI flag (`--trends`, `--no-trends`). Trend detection runs unconditionally on every successful scroll; if the operator wants to suppress the section, they can `grep -v "## Trends"`-style it out of their renderer. The summarizer either runs or it doesn't (`--dry-run`); trends inherit that gating without a knob of their own.

The module does not know about Claude, markdown, the dedup cache, the `--replay` flag's CLI surface, or the scroller/extractor. It produces a typed report from a typed input; the CLI decides where to thread the result and the markdown writer decides how to render it.

### Scenario: Mature store — two persistent themes, one emerging, one fading

Given the rolling-themes store contains 8 runs ordered oldest-first:
  | Index | runId                  | themes                                                  |
  | 0     | `2026-04-09T14-00-00Z` | `["agent orchestration", "indie-dev distribution"]`     |
  | 1     | `2026-04-10T14-00-00Z` | `["agent orchestration", "indie-dev distribution"]`     |
  | 2     | `2026-04-11T14-00-00Z` | `["agent orchestration", "indie-dev distribution"]`     |
  | 3     | `2026-04-12T14-00-00Z` | `["agent orchestration", "indie-dev distribution", "sports betting odds"]` |
  | 4     | `2026-04-13T14-00-00Z` | `["agent orchestration", "indie-dev distribution"]`     |
  | 5     | `2026-04-14T14-00-00Z` | `["agent orchestration", "indie-dev distribution"]`     |
  | 6     | `2026-04-15T14-00-00Z` | `["agent orchestration", "claude code workflows"]`      |
  | 7     | `2026-04-16T14-00-00Z` | `["agent orchestration", "claude code workflows"]`      |
And `currentThemes` is `["agent orchestration", "claude code workflows", "sales enablement playbooks"]`
When `detectTrends({ store, currentThemes })` is called
Then `report.persistent` contains `agent orchestration` (runCount: 9 of 9 runs, the entire window)
And `report.persistent` contains `indie-dev distribution` (runCount: 6 of 9, meets the 4-run minimum)
And `report.persistent` is sorted with `agent orchestration` before `indie-dev distribution` (higher runCount first)
And `report.emerging` contains `sales enablement playbooks` (firstSeenRunId is the current run, did not appear in any earlier run)
And `report.fading` contains `sports betting odds` (last seen at index 3 — `2026-04-12T14-00-00Z` — and absent from the most recent 3 runs and the current run, so runsSinceLastSeen is 5)
And `claude code workflows` appears in NEITHER persistent (only 3 of 9 runs, below the 4-run threshold) NOR emerging (first appeared at index 6, which is 3 runs ago including the current — older than the 2-run emerging window) NOR fading (still appears in the current run)
(This is the day-eight-or-later experience the feature exists for: the operator sees at a glance that agent orchestration is the through-line, sports betting was a one-week thing that has cooled off, and a new theme just showed up worth noticing.)

### Scenario: Brand-new store — fewer than 2 runs returns all empty arrays

Given the rolling-themes store contains 0 runs (first scroll ever)
And `currentThemes` is `["agent orchestration", "indie-dev distribution"]`
When `detectTrends({ store, currentThemes })` is called
Then `report.persistent` is `[]`
And `report.emerging` is `[]`
And `report.fading` is `[]`
And the CLI's `summary.json` still includes `summary.trends` (with the empty arrays — the field is present, the analysis is honest)
And the markdown writer omits the `## Trends` section entirely from `summary.md`
(Day one has no trends to detect; rendering "everything is emerging!" would be noise. The operator sees themes in `## Themes` and that is the entire signal of the day.)

### Scenario: Two-run store — the floor where trend detection becomes meaningful

Given the rolling-themes store contains 1 stored run with themes `["agent orchestration", "indie-dev distribution"]`
And `currentThemes` is `["agent orchestration", "claude code workflows"]`
When `detectTrends({ store, currentThemes })` is called
Then `report.persistent` is `[]` (no theme has reached the 4-run minimum yet)
And `report.emerging` contains `claude code workflows` (first appeared in the current run, did not appear in the prior 1 run)
And `report.fading` is `[]` (only 2 total runs in the window — fading requires absence from the most recent 3 runs, and we only have 2)
And the markdown writer renders the `## Trends` section with only `### Emerging` underneath (empty categories are omitted within a populated section)
(The 2-run floor is the moment the section starts appearing in `summary.md`. The operator's first "wait, what's new?" experience happens here, with one bullet that is both honest and minimal.)

### Scenario: Replay mode — current run omitted, trends computed from stored history

Given the rolling-themes store contains 5 runs
And the operator runs `pnpm scroll --replay 2026-04-15T14-00-00Z` (feature 14)
And the replay's summarizer call produces themes that are different from what was stored for that runId
When `detectTrends({ store })` is called WITHOUT `currentThemes`
Then the report is computed against the 5 stored runs as if they were the entire window
And no synthetic `"current"` run participates in the calculation
And the report reflects the trend snapshot as it would have looked at the time the stored run-being-replayed was made
(Replay is an archaeological operation — re-summarize a saved `raw.json` to test a new prompt or model. The trend snapshot in the replay's `summary.md` should reflect the state of the world at the time the original run was made, not a hybrid of stored history plus the replay's freshly-computed themes. The summarizer's `appendRun` will replace the stored entry in place — feature 11's replay contract — and the next non-replay run will see the updated themes; the trend section in the replay's output stays archaeological.)

### Scenario: Persistent category caps at 5 themes even when more qualify

Given the rolling-themes store contains 10 runs
And 7 distinct themes each appear in 4 or more of those 10 runs
And `currentThemes` is `[]` (today the feed was all noise — empty themes is a legitimate run state per feature 11)
When `detectTrends({ store, currentThemes })` is called
Then `report.persistent.length` is exactly 5 (capped at `MAX_PER_CATEGORY`)
And the 5 themes returned are the 5 with the highest `runCount` (ties broken by `lastSeenRunId` descending, then theme string ascending)
And the 2 themes that qualified but were dropped do NOT appear in any other category — they are simply omitted
(Capping is intentional. A `## Trends` section with 12 persistent bullets becomes a wall of text the operator scrolls past; 5 is the ceiling where the section stays scannable in two seconds. The 7th and 8th themes are real, but listing them past the cap would dilute the signal.)

### Scenario: Identical store and currentThemes always produce identical reports

Given the same `ThemesStore` value (deep-equal across two calls)
And the same `currentThemes` array (deep-equal across two calls)
When `detectTrends` is called twice with these inputs
Then the two `TrendReport` results are deep-equal
And the order of themes within each category is identical between the two calls
And the function makes no calls to `Date.now()`, `Math.random()`, `process.hrtime()`, or any other source of nondeterminism
(The persona's "deterministic output" expectation extends to the trends layer. Two `pnpm scroll --replay` invocations on the same saved run, against an unchanged store, must produce byte-identical `summary.md` files in the trends section.)

### Scenario: Empty currentThemes — the run produced no themes, but trend detection still runs

Given a stored window of 5 runs with healthy theme histories
And `currentThemes` is `[]` (today's summarizer returned an empty themes array — feed was all noise)
When `detectTrends({ store, currentThemes: [] })` is called
Then `report.persistent` is computed across the 6-run window (5 stored + the current empty run)
And no theme is added to `emerging` solely because the current run is empty
And `fading` may include themes that were in the most recent stored runs but not in the current empty run, IF they have been absent from the most recent 3 runs (current included) — i.e., a theme last seen at stored-index 2 of 5 IS now fading because positions 3, 4, and "current" are all without it
And the operator sees the `## Trends` section in `summary.md` rendered against the empty-current-run reality: persistent themes still listed, possibly more themes flagged as fading
(An all-noise day is itself a data point. Trend detection should reflect that the feed went quiet on the themes the operator was tracking, not pretend the absence didn't happen.)

### Scenario: Case-sensitive theme equality — distinct casings stay distinct

Given the rolling-themes store contains runs with themes `["AI agents"]`, `["AI agents"]`, `["AI agents"]`, and `["ai agents"]`
And `currentThemes` is `["AI agents"]`
When `detectTrends({ store, currentThemes })` is called
Then `AI agents` has runCount 4 (3 stored runs + current)
And `ai agents` has runCount 1 (one stored run only)
And the two themes are reported as separate entries (or one of them is below the persistent minimum and simply absent — never silently merged)
(The summarizer's prompt asks for short, consistent labels and the operator visually verifies them in `~/scrollproxy/state/rolling-themes.json`. Silently folding `"AI agents"` and `"ai agents"` would hide a quality issue in the prompt that the operator should see and fix at the prompt level.)

### Scenario: Schema version constant is exported and pinned at 1

Given a contributor reads `src/trends/trend-detector.ts`
When they look for the schema version
Then the file exports `TRENDS_SCHEMA_VERSION = 1` as a `const`
And the `TrendReport` type's `schemaVersion` field is the literal type `1`
And the constant is referenced wherever a `schemaVersion` is set (no string literals, no inline `1`s)
And if a future feature adds a `volatility` category, the type AND the constant bump together to `2` — never one without the other
(Same pattern as `THEMES_SCHEMA_VERSION` and the summarizer's `SUMMARY_SCHEMA_VERSION`. One version per derived shape, exported, locked at 1 today, bumped together when the shape changes.)

### Scenario: Trend report is embedded in summary.json under the optional `trends` field

Given a successful scroll completes
And `detectTrends` returns a non-empty `TrendReport`
When the CLI writes `<runDir>/summary.json` (atomic tmpfile → rename)
Then the file contains the existing `RunSummary` fields (`schemaVersion`, `runId`, `summarizedAt`, `model`, `themes`, `worthClicking`, `voices`, `noise`, `newVsSeen`, `feedVerdict`)
And it ALSO contains a `trends` field with shape `{ schemaVersion: 1, persistent: [...], emerging: [...], fading: [...] }`
And `RunSummary.schemaVersion` is still `1` (the field is added as optional — older `summary.json` files without `trends` are still valid schema-1 files; the markdown writer reads `summary.trends ?? undefined` and renders accordingly)
And the on-disk JSON is 2-space indented, UTF-8, with `trends` appearing AFTER `feedVerdict` (key order locked, same convention as `RunSummary`'s existing fields)
(Non-breaking augmentation. Pre-existing replay tests against older `summary.json` files keep passing because `trends` is read as optional. New runs always include the field; replay of a pre-trends run will rewrite `summary.json` with `trends` populated from the current store state.)

### Scenario: Markdown renders `## Trends` between `## Themes` and `## Worth clicking`

Given a successful scroll with `summary.trends` populated (1 persistent, 1 emerging, 0 fading)
When `summary.md` is rendered
Then the section order is: header, verdict line, `## Themes`, `## Trends`, `## Worth clicking`, `## Voices`, `## Noise`, footer
And the `## Trends` section contains `### Persistent` and `### Emerging` subheadings
And it does NOT contain a `### Fading` subheading (empty subcategories are omitted)
And under `### Persistent` there is one bullet: `- agent orchestration — 7/7 runs` (the denominator is the highest `runCount` among persistent themes — with only one persistent theme at `runCount: 7`, the denominator is 7; the CLI mockup below shows a case where the top theme appears in every run and the denominator equals the window size)
And under `### Emerging` there is one bullet: `- sales enablement playbooks — first seen 2026-04-16T14-32-07Z`
(One section, scannable in two seconds. The operator's eye lands on `## Trends` after `## Themes` and before the actionable `## Worth clicking` block — the order matches the operator's reading flow: "what is the feed about" → "how is that changing" → "what should I click".)

### Scenario: Markdown omits the entire `## Trends` section when all three categories are empty

Given a successful scroll on day one (store has 0 stored runs at trend-detection time)
And `summary.trends` is `{ schemaVersion: 1, persistent: [], emerging: [], fading: [] }`
When `summary.md` is rendered
Then the rendered file does NOT contain the string `## Trends`
And it does NOT contain any of `### Persistent`, `### Emerging`, `### Fading`
And the section order is: header, verdict line, `## Themes`, `## Worth clicking`, `## Voices`, `## Noise`, footer (unchanged from the pre-trends layout)
(Frustration addressed: "tools that summarize by averaging everything into mush." A `## Trends` heading with nothing under it is exactly the kind of polite-but-empty section the operator hates. Better to skip it than to fill it with `_(none yet — keep scrolling)_`.)

### Scenario: Markdown gracefully reads older `summary.json` without a `trends` field

Given a `summary.json` written by an earlier ScrollProxy build (before this feature shipped) that has no `trends` field
When the operator runs `pnpm scroll --replay <that-runId>` to re-render markdown
Then the markdown writer reads `summary.trends` as `undefined`
And the rendered `summary.md` omits the `## Trends` section (same as the all-empty case)
And no error is logged, no warning is printed
(The contract change in `RunSummary` is purely additive. Old summaries continue to render; new summaries gain the section. Replay against an old summary uses fresh trends? No — replay re-runs the summarizer entirely and produces a new `summary.json` with current `trends`, so the "old summary read directly" path is rare in practice but still must not crash.)

### Scenario: Module is pure — no I/O, no clocks, no global state

Given a contributor reads `src/trends/trend-detector.ts`
When they inspect imports and function bodies
Then no imports from `node:fs`, `node:fs/promises`, `node:path`, `node:os`, or `node:child_process` appear
And no calls to `Date.now()`, `new Date()`, `Math.random()`, `process.env`, `process.hrtime`, or `console.*` appear
And the module imports only the `ThemesStore` type from `../state/rolling-themes.js` and the `MAX_RUNS` constant if needed for the window-size denominator
And the module exports the `detectTrends` function, the `TrendReport` / `PersistentTheme` / `EmergingTheme` / `FadingTheme` types, the `TRENDS_SCHEMA_VERSION` constant, and the `PERSISTENT_MIN_RUNS` / `EMERGING_MAX_AGE_RUNS` / `FADING_MIN_AGE_RUNS` / `MAX_PER_CATEGORY` threshold constants
(Purity is the testability story. The unit tests construct `ThemesStore` literals in memory and assert on the report — no temp directories, no clock manipulation, no environment isolation. The module is library-grade plumbing the CLI orchestrates.)

### Scenario: Module adds zero runtime dependencies

Given a contributor reviews `package.json` after this feature lands
When they inspect new runtime deps
Then no statistics library is added (counting and sorting are stdlib operations)
And no date library is added (timestamps are passed as strings, never parsed)
And no functional-utility library is added (one `flatMap`, one `Map<string, count>`, native `Array.prototype.sort`)
And the dependency list is unchanged from the prior feature
(Personal-tool simplicity, same budget as features 10, 11, and 12. The Phase 3 expansion is meant to add capability, not weight.)

### Scenario: Trend detection runs after summarizer success and before themes-store update

Given a successful scroll has just produced a `RunSummary`
When the CLI orchestrates the post-summarizer steps
Then the order is:
  1. Summarizer returns `{ status: 'ok', summary }`
  2. `detectTrends({ store: <pre-update store>, currentThemes: summary.themes })` runs
  3. `summary.trends` is set to the trend report
  4. `summary.json` is written atomically (containing the `trends` field)
  5. `appendRun` + `saveThemesStore` updates the rolling-themes store with this run's themes
  6. The markdown writer renders `summary.md` from the augmented summary
  7. The CLI's summary line is printed
And step 2 sees the store as it was when the run started (the `priorThemes` view), NOT after this run has been appended
(Temporal ordering matters. If the store were updated before trend detection, the current run would appear in the store, the synthetic `"current"` injection would double-count it, and emerging/fading boundaries would shift by one. Detect first, then persist.)

### Scenario: Summarizer failure skips trend detection entirely

Given a scroll completes its scroll and extract steps successfully
And the summarizer returns `{ status: 'error', reason: 'rate_limited' }`
When the CLI handles the post-extract steps
Then `detectTrends` is NOT called
And no `summary.json` is written (only `summary.error.json`, per feature 12's contract)
And no markdown file is written (per feature 13's "summary.json missing → skip" contract)
And the rolling-themes store is NOT updated (per feature 12's "errors don't pollute the window" contract)
And the scroll's summary line reads `... — summarizer failed: rate_limited`
(Trend detection is parasitic on summarizer success. If the summarizer didn't produce themes, there is nothing to detect, and the rolling window stays as it was. Same fail-shut posture as feature 12's themes-store update.)

### Scenario: Dry-run skips trend detection entirely

Given the operator runs `pnpm scroll --dry-run --minutes 3`
When the scroll completes its extract step
Then `summarizeRun` is NOT called (per feature 15)
And `detectTrends` is NOT called
And no `summary.json`, `summary.error.json`, or `summary.md` is written
And no trends-related output appears in the CLI summary line
(Dry-run is "no API calls, no destination writes." Trends are derived from the summarizer's output; without summarizer output, there is nothing to derive. The dry-run contract is unchanged from feature 15.)

### Scenario: Replay re-renders summary.md with fresh trends from current store

Given a stored run `2026-04-15T14-00-00Z` exists with a `raw.json` and an old `summary.json`
And the rolling-themes store has evolved since that run was first summarized (5 more runs have been added)
When the operator runs `pnpm scroll --replay 2026-04-15T14-00-00Z`
Then the summarizer re-runs against `raw.json` and produces fresh themes
And `appendRun` replaces the stored entry for `2026-04-15T14-00-00Z` in place (per feature 11)
And `detectTrends` is called WITHOUT `currentThemes` (replay mode — feature 14's signal that this is archaeology, not a fresh run)
And the trend report reflects the store as it stands now (with the replayed entry replaced in place), giving the operator a "what would today's trend section have looked like for this old run, given everything we know now?" view
And the rewritten `summary.json` contains the new `trends` field; the rewritten `summary.md` shows the `## Trends` section as freshly computed
(Replay is for testing the prompt, not for time-travel. The trend section reflects the operator's current understanding of the world; the rest of the summary reflects the saved posts. This is the same hybrid feature 14 already produces for `summarizedAt` and `model` — fresh metadata, saved data.)

### Scenario: Trend report does not contain post content, handles, URLs, metrics, or PII

Given a run whose 84 posts include authors, URLs, and engagement metrics
When `detectTrends` runs
Then the returned `TrendReport` contains only theme strings, run ids, and counts
And the report does NOT contain any post text, author handle, URL, media link, metric value, or per-run summarizer-model identifier
And the on-disk `summary.json`'s `trends` field reflects the same labels-only shape
(Anti-persona firewall: the rolling-themes store already enforces labels-only at rest — this feature inherits that discipline. A trend report that named handles or URLs would invite the "who are my top 5 voices this week?" surveillance feature the anti-persona wants and ScrollProxy refuses.)

### Scenario: Trend categories are computed independently — a theme cannot be in two categories at once

Given any input store and `currentThemes` combination
When `detectTrends` returns
Then no theme string appears in more than one of `persistent`, `emerging`, `fading`
And precedence is enforced in this order: emerging → fading → persistent → none
   (i.e., a theme that just appeared cannot also be persistent; a theme that has faded cannot also be persistent; persistent is the residual category)
And this is asserted by an internal invariant test that walks all three arrays and verifies no string overlap
(One mental model per theme. The operator reading `## Trends` should see each theme exactly once, in the category that best describes its current state. If a theme could appear under both `### Emerging` and `### Persistent`, the section would lose its "what does this label mean?" clarity.)

## User Journey

1. The operator has been running `pnpm scroll` daily for two weeks. The rolling-themes store has 10 entries; the markdown writer's `## Themes` section shows today's labels; the summarizer's prose drift mention ("this week has been heavy on agent orchestration") is fuzzy and they cannot tell whether it is an actual count or Claude's vibe.
2. **They pull this build. The next `pnpm scroll` produces a `summary.md` with a new `## Trends` section between `## Themes` and `## Worth clicking`.** The section has up to three subheadings — `### Persistent`, `### Emerging`, `### Fading` — each with up to 5 bullets. Each bullet is a short, deterministic statement: `agent orchestration — 8/10 runs`, `claude code workflows — first seen 2026-04-16T14-32-07Z`, `sports betting odds — last seen 2026-04-12T14-00-00Z, 5 runs ago`.
3. The operator reads the section in two seconds. It tells them what they suspected (agent orchestration is the through-line) and surfaces what they didn't notice (sports betting fell off five runs ago, which they can either re-engage with or ignore on purpose). The summarizer's prose drift line is still in the prompt, but the operator now uses the `## Trends` section as the trustworthy version — counts they can verify against `~/scrollproxy/state/rolling-themes.json`.
4. Under the hood: `src/trends/trend-detector.ts` is a pure module exporting `detectTrends` plus the four threshold constants. `src/cli/scroll.ts` calls it after the summarizer succeeds and before `saveThemesStore`. `src/writer/markdown.ts` gains a `renderTrends` function and one section between themes and worth-clicking. `summary.json` gains an optional `trends` field; older summary files render fine without it.
5. If the operator runs `pnpm scroll --replay <runId>` against a saved run, the trend section reflects the current store (with the replay's themes spliced in via `appendRun`'s in-place replacement). They can re-run the summarizer with a tweaked prompt and see how the trend categories shift — useful for prompt iteration without a separate analytics tool.
6. If a day is all noise (`themes: []`), the persistent and emerging categories don't grow, and themes that were tracked in the most recent few runs may move into `### Fading`. The section honestly tells the operator the feed went quiet on the things they care about. No filler, no false positives.
7. If the operator wants to reset the trend view, they `rm ~/scrollproxy/state/rolling-themes.json` (or just edit it). The next scroll's `## Trends` section will be empty (then appear again as the store rebuilds). No `--reset-trends` flag exists; the operator's `rm` is the operation.

## CLI Mockup

This feature ships no new CLI commands or flags. The operator's daily command line is unchanged. The visible change is in `summary.md`.

Day-eight `summary.md` excerpt (newly added section in **bold**):

```
# ScrollProxy — 2026-04-17 14:35 UTC

**Verdict**: signal · **New**: 38 · **Seen**: 46 · **Model**: claude-sonnet-4-6

## Themes

- agent orchestration
- claude code workflows
- sales enablement playbooks

**## Trends**

**### Persistent**

**- agent orchestration — 9/9 runs**
**- indie-dev distribution — 6/9 runs**

**### Emerging**

**- sales enablement playbooks — first seen 2026-04-17T14-32-07Z**

**### Fading**

**- sports betting odds — last seen 2026-04-12T14-00-00Z, 5 runs ago**

## Worth clicking

- @someoperator — Notion's new database UI lays bare what the old one was hiding...
  ...

(rest of summary unchanged)
```

Day-one `summary.md` excerpt (no `## Trends` section because the store has <2 runs):

```
# ScrollProxy — 2026-04-09 14:35 UTC

**Verdict**: signal · **New**: 60 · **Seen**: 0 · **Model**: claude-sonnet-4-6

## Themes

- agent orchestration
- indie-dev distribution

## Worth clicking

- ...
```

Inspecting the trend report directly via `jq`:

```
$ jq '.trends' ~/scrollproxy/runs/2026-04-17T14-32-07Z/summary.json
{
  "schemaVersion": 1,
  "persistent": [
    { "theme": "agent orchestration", "runCount": 9, "firstSeenRunId": "2026-04-09T14-00-00Z", "lastSeenRunId": "2026-04-17T14-32-07Z" },
    { "theme": "indie-dev distribution", "runCount": 6, "firstSeenRunId": "2026-04-09T14-00-00Z", "lastSeenRunId": "2026-04-14T14-00-00Z" }
  ],
  "emerging": [
    { "theme": "sales enablement playbooks", "firstSeenRunId": "2026-04-17T14-32-07Z" }
  ],
  "fading": [
    { "theme": "sports betting odds", "lastSeenRunId": "2026-04-12T14-00-00Z", "runsSinceLastSeen": 5 }
  ]
}
```

Verifying counts against the rolling-themes store directly:

```
$ jq '[.runs[].themes] | flatten | group_by(.) | map({theme: .[0], count: length}) | sort_by(-.count)' \
    ~/scrollproxy/state/rolling-themes.json
[
  { "theme": "agent orchestration", "count": 8 },
  { "theme": "indie-dev distribution", "count": 6 },
  { "theme": "claude code workflows", "count": 3 },
  { "theme": "sports betting odds", "count": 1 }
]
```

(The summary's `runCount` of 9 for `agent orchestration` includes the current run; the store's count of 8 reflects pre-update history. The off-by-one is the temporal ordering described in the post-summarizer scenario.)

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- A new state file for trend reports. Trends are recomputed from the rolling-themes store on every run; persisting them would create a second source of truth that could drift. The summary.json's `trends` field is the per-run snapshot.
- A `--trends-only` CLI flag that prints just the trend section. The operator can `awk '/## Trends/,/## Worth clicking/' summary.md` if they want it isolated; a flag for a one-off operation is anti-persona territory.
- A `--reset-trends` flag. The operator `rm`s the rolling-themes store; trends rebuild as the store refills. Same pattern as the dedup cache reset.
- Volatility / variance scoring (e.g., "this theme has the most run-over-run change"). Persistent / emerging / fading are the three categories that answer the operator's "what is different?" question; volatility is a fourth category whose value is unproven. Add when the operator asks for it.
- Theme similarity / clustering ("agent orchestration" and "agent workflows" are probably the same thing). Case-sensitive string equality is the contract; clustering would require an embedding model and a similarity threshold, which is the start of an analytics product. The operator's prompt-tuning at the summarizer layer is the right place to enforce label discipline.
- Per-run trend deltas in the markdown ("themes that moved between categories since the last run"). The categorization is already a delta-versus-history view; tracking deltas-of-deltas is exactly the kind of layered abstraction the operator's "ruthless editor" preference rejects.
- Configurable thresholds via YAML (`config.trends.persistentMinRuns`, etc.). Constants in code, tunable by editing the file. If the operator finds the defaults wrong, a code change is one PR; four YAML keys are forever.
- Trend detection on the dedup cache (post-level trends — "this author has appeared in 5 of the last 10 runs"). The dedup cache stores hashes only by design; reconstructing authors from hashes would require a second store. Per-author trend detection is anti-persona territory (surveillance on people, not themes).
- Email / push notifications when a new "emerging" theme appears. The operator opens `summary.md` daily; pushing trends out-of-band is the opposite of the "run one command, get one file" flow.
- A historical view of trend reports across many runs ("show me the trend report from 5 runs ago"). The operator can `git log` their `~/scrollproxy/runs/` directory if they want history; the tool itself does not maintain a trend-report log.
- A `--explain-trend <theme>` CLI flag that shows which runs a theme appeared in. The operator can `jq '.runs[] | select(.themes | index("agent orchestration")) | .runId' ~/scrollproxy/state/rolling-themes.json` for that. Personal-tool simplicity.
- Auto-detection of the right thresholds based on store size. The 4 / 2 / 3 / 5 values are tuned for a 10-run window; if `MAX_RUNS` changes (it won't — same logic that kept it constant for feature 11), the thresholds may need to shift, but the operator who changes one will think about the other.
- Cross-platform trend detection (LinkedIn themes vs. X themes side-by-side). Phase 3's "second platform" is a separate feature; if it lands, each platform owns its own rolling-themes store, and trend detection runs per-store. No cross-platform aggregation in this feature.
- Trend visualizations (sparklines, ascii heatmaps). The bullet list is the entire UI. The operator runs in a terminal that may or may not render unicode reliably; a textual report works everywhere.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **run** (one scroll's artifact, matches feature 11), **theme** (what the feed is about), **persistent / emerging / fading** (plain-English category names — not "trending up", "high velocity", "engagement decay"; not "secular trend", "anomaly score", "regression slope"). The category names are the same words the operator would use describing the feed at a coffee shop. No "drift detection pipeline", no "theme lifecycle service", no "topical novelty score" — every one of those would import vocabulary the operator rejects when explaining what the tool does to a friend.

Patience-level alignment:
- **Daily patience: Very Low.** The trends section is a self-contained block the operator scans in two seconds. Maximum 15 bullets total (5 per category × 3 categories). No table, no chart, no "click to expand" — bullets, sorted, done. The section is omitted entirely when there is nothing meaningful to report (day one through two), so the operator's daily file does not start padding empty headings before the data is real.
- **Setup patience: High.** No new config keys, no new CLI flags, no migration step. Pulling this build and running `pnpm scroll` produces the new section automatically; if the store has <2 runs the section is omitted; otherwise it appears. The operator's `~/scrollproxy/state/rolling-themes.json` is unchanged in shape — the trends layer reads it without modifying it.
- **Discoverability for the operator's `jq` reflex:** the `summary.json` shape change is additive (one new optional field, `trends`, with a stable schema version inside it). The operator can `jq '.trends'` to inspect the same data the markdown shows. No JSON-to-YAML conversion, no nested object surgery; same flat shape as the rest of `RunSummary`.
- Error messages — not applicable. This feature has no I/O and no external calls; there is nothing that can fail at the trend-detection layer. CLI errors before/after (summarizer failure, store-write failure) are owned by their respective features and fail the same way they did before.
- The on-disk shape additions follow the operator's "fixed key order, 2-space JSON" expectation set by features 7, 10, 11, and 12. The `trends` field appears in a stable position in `RunSummary` (after `feedVerdict`). The internal `TrendReport` keys are always in the order `schemaVersion`, `persistent`, `emerging`, `fading`. The operator's grep / jq expectations transfer.

Anti-persona check: every shape of hosted / multi-user / analytics / surveillance product the anti-persona would expect is blocked at the feature level.
- **No per-author trend detection** — themes only. Reconstructing "which authors are emerging" from the dedup-cache hashes is impossible by design (hashes are one-way), and adding handle storage to the rolling-themes store is forbidden by feature 11. This feature inherits that firewall and does not rebuild a parallel author-tracking store.
- **No engagement-metric trends** — `runCount` is the only metric. The detector does not see (and does not need) likes, replies, reposts, or any other anti-persona analytics. Adding "themes weighted by post engagement" would require pulling metrics into the rolling-themes store, which is explicitly forbidden by feature 11's labels-only rule.
- **No notifications, alerts, or webhooks on trend changes** — the operator opens `summary.md`; that is the entire delivery mechanism. Pushing "🚨 NEW TREND DETECTED: 'agent orchestration'" to Slack would be the start of a SaaS product layer ScrollProxy explicitly rejects.
- **No multi-tenant / per-user trends** — one operator, one rolling-themes store, one trend report per run. No `config.trends.userId`, no `config.trends.team`. Same single-user constraint as the rest of the tool.
- **No cloud computation** — `detectTrends` is a pure function in the CLI's process. No "send the store to a server for richer trend analysis" path. The operator's data never leaves their machine for trend purposes (it leaves once per run for the Claude summarizer call, and only the post payload — feature 12).
- **No long-term trend archive** — the report covers the rolling 10-run window only. The operator can `git log` their `~/scrollproxy/runs/` if they want historical trend reports; the tool itself does not maintain a trend-history database.
- **No trend-driven write actions** — knowing a theme is emerging does not, under any branch of this feature, trigger a "follow users posting about emerging themes" or "auto-RT trending content" path. Read-only on principle (vision principle 1) extends to derived analytics; write actions are out of scope permanently.

Frustrations addressed:
- **"Cumulative intelligence"** (persona "what they care about" item 3) — feature 11 made the rolling-themes store; this feature makes the store *useful*. The persistent / emerging / fading split is the explicit answer to "is the tool getting smarter run over run?" — yes, it is, and here are the three lists that prove it.
- **"Tools that summarize by averaging everything into mush"** (frustration) — this feature does the opposite of averaging. It surfaces the extremes (the most-recurring, the just-appeared, the just-departed) and silently drops the middle. Persistent caps at 5, emerging caps at 5, fading caps at 5 — total ceiling of 15 bullets.
- **"Deterministic output"** (persona item 2) — `detectTrends` is pure. Same store + same currentThemes → same `TrendReport`, byte-identical. No clock, no random, no environment. Replay against a saved run produces a stable output every time.
- **"Tools that hide what they're doing"** (frustration) — the trend report is in `summary.json` (raw, greppable, jq-friendly) and `summary.md` (formatted). The counts in the markdown match the counts in the JSON, which match what `jq` over `~/scrollproxy/state/rolling-themes.json` produces. Three layers of the same numbers, all visible.
- **"Broken automation that fails silently"** (frustration) — there is nothing for this feature to break. It is pure logic over data the previous step (summarizer) already validated. If the summarizer fails, this feature does not run at all (a property the scroll CLI orchestrates explicitly, not a side effect).
- **"Signal over completeness"** (vision principle 2) — empty categories are omitted from markdown; the entire section is omitted when nothing meaningful to report; thresholds are tuned to surface the genuinely-different rather than every label that ever appeared. The trends section either tells the operator something useful or it gets out of the way.

## Learnings

<!-- Updated via /compound -->
