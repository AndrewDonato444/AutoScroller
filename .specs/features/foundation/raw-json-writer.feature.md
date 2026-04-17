---
feature: Raw JSON Writer
domain: foundation
source: src/writer/raw-json.ts
tests:
  - tests/foundation/raw-json-writer.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-16
---

# Raw JSON Writer

**Source File**: `src/writer/raw-json.ts` (new), wired into `src/cli/scroll.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Serialize the extractor's in-memory run to `~/scrollproxy/runs/<run-id>/raw.json`

The operator runs `pnpm scroll`. The scroller (feature 5) scrolls `x.com/home`, the extractor (feature 6) silently collects posts as each tick lands, and right now the CLI prints the post count to stdout and then throws the whole run away when the process exits. This feature is the Phase 1 exit: take the extractor's `getPosts()` and `getStats()` at the end of a successful scroll, write them to a single `raw.json` under a timestamped run directory, and append `— saved to <path>` to the existing summary line. After this feature lands, `pnpm scroll` produces a real artifact the operator can `jq` later, `--replay` (feature 14) has a file to replay against, and the Phase 1 exit criterion ("produces a valid `raw.json` with ~30+ extracted posts and zero ads") is testable end-to-end.

This is the smallest useful writer. It is NOT the pluggable `Writer` interface from the vision — that arrives with the markdown writer in feature 13 and the Notion writer in feature 20. This feature is one function (`writeRawJson`) that knows how to lay out a run directory, serialize the run, and fsync it before the process exits. Keeping it small here is deliberate: the operator's Phase 1 goal is "prove we can extract posts cleanly from a real scroll", and the JSON file is the proof.

The operator's vision principle 3 — **"Never lose scroll effort"** — is load-bearing for this feature. If the extractor collected 80 posts and the summarizer (which doesn't exist yet) were to throw, the posts must still be on disk. That means the writer runs on the happy path AND on the "browser closed early" path, and the write is atomic (tmpfile → rename) so a crash mid-write never leaves a half-written `raw.json` that `--replay` would later choke on.

This feature ships a `writeRawJson()` function that:

1. Exports `writeRawJson({ outputDir, runId, posts, stats, meta }): Promise<{ runDir, rawJsonPath }>`. `outputDir` is the `~`-expanded value from `config.output.dir`. `runId` is the caller-provided run identifier (see scenario below). `posts` is `ExtractedPost[]` from `extractor.getPosts()`. `stats` is `ExtractorStats` from `extractor.getStats()`. `meta` is `RunMeta` — the wall-clock facts about the scroll (see schema scenario below).
2. Creates `<outputDir>/<runId>/` recursively if missing (`fs.mkdir` with `recursive: true`). Does not error if the directory already exists.
3. Writes `<outputDir>/<runId>/raw.json` atomically: first to `raw.json.tmp` in the same directory, then renamed to `raw.json`. `rename` is atomic on POSIX filesystems, so a crash between `mkdir` and `rename` leaves a `.tmp` file, never a partial `raw.json`.
4. The JSON payload has exactly this top-level shape (schema version 1): `{ schemaVersion: 1, runId, startedAt, endedAt, elapsedMs, tickCount, config: { minutes, dryRun }, stats: { postsExtracted, adsSkipped, selectorFailures, duplicateHits }, selectorFailures: SelectorFailure[], posts: ExtractedPost[] }`. Field order is stable (the serializer writes keys in a fixed order) so `git diff` and `jq` behave predictably across runs.
5. Exports a `generateRunId(now?: Date): string` helper that returns a UTC timestamp slug in the form `YYYY-MM-DDTHH-MM-SSZ` (ISO 8601 with `:` → `-` so it's a safe directory name on macOS). The scroll CLI calls this once at the **start** of the run so `startedAt` and the directory name agree.
6. Exports a `RunMeta` type with `{ startedAt: string; endedAt: string; elapsedMs: number; tickCount: number; minutes: number; dryRun: boolean }`, all ISO 8601 / numeric / boolean — no relative timestamps.
7. Serializes `selectorFailures` as a top-level array (NOT nested inside `stats`). The stats summary carries the count; the array carries the details. The operator greps the details with `jq '.selectorFailures'`.
8. Uses `JSON.stringify(payload, null, 2)` — 2-space indentation, UTF-8, trailing newline. Human-readable for the operator's `less` / `cat`. No minification.
9. Never throws in a way that kills the scroll's exit path. If the write fails (disk full, permissions), the error is caught in the CLI scroll handler, the operator sees `scroll complete: ... — posts extracted: 84 — write failed: <reason>`, and the process exits with status 1. Posts stay in memory but the operator knows exactly why the file is missing.
10. Is NOT called on `--dry-run`. Feature 6 already promises `dry-run complete: ... writer skipped`. Feature 15 (`--dry-run` flag) owns the skip contract end-to-end.

The writer does not know about markdown, summaries, Claude, or the rolling-themes store. Those are features 10, 11, 12, 13. It does not enforce retention or prune old runs — disk is the operator's problem, by design.

### Scenario: Happy-path scroll writes `raw.json` under a timestamped run directory

Given `config.output.dir` is `~/scrollproxy/runs` (the default)
And the operator runs `pnpm scroll --minutes 3` and the scroll completes successfully
And the extractor returns 84 posts, 6 ads skipped, 2 duplicate hits, 0 selector failures
When the scroll CLI hands the in-memory run to `writeRawJson()`
Then a directory `~/scrollproxy/runs/<runId>/` exists (created if missing)
And the file `~/scrollproxy/runs/<runId>/raw.json` exists
And the file contains valid JSON with `schemaVersion: 1`
And `payload.posts.length === 84`
And `payload.stats.adsSkipped === 6`
And `payload.stats.duplicateHits === 2`
And `payload.selectorFailures.length === 0`
(This is the Phase 1 exit criterion made concrete: one file the operator can open and verify.)

### Scenario: Run id is a UTC-slug directory name derived at scroll start

Given the operator starts `pnpm scroll` at `2026-04-16T14:32:07.123Z`
When the CLI calls `generateRunId(new Date('2026-04-16T14:32:07.123Z'))`
Then the returned run id is `"2026-04-16T14-32-07Z"`
And the run directory is `<outputDir>/2026-04-16T14-32-07Z/`
And `payload.startedAt` in `raw.json` is `"2026-04-16T14:32:07.000Z"` (ISO 8601, millisecond-floored)
And the directory name contains no `:` (so macOS Finder and every shell tool are happy)
(Why millisecond-floored: the directory name is seconds-precision; the JSON field preserves the original instant so `--replay` can reconstruct exact timing.)

### Scenario: Writer is atomic — a crash mid-write never leaves a corrupt `raw.json`

Given a scroll is complete and `writeRawJson()` is running
When the process is killed between the tmpfile write and the rename
Then `<runDir>/raw.json.tmp` exists (possibly partial)
And `<runDir>/raw.json` does NOT exist
And a subsequent `pnpm scroll --replay <runId>` fails fast with "no raw.json in <runDir>" rather than parsing half a file
(Vision principle 3: "Never lose scroll effort" means never leave a file that looks done but isn't. A missing file is recoverable with a re-scroll; a silently truncated one corrupts the dedup cache downstream.)

### Scenario: JSON payload shape is locked at schema version 1

Given a completed scroll with posts, stats, and one selector failure
When `writeRawJson()` serializes the payload
Then the top-level keys, in order, are: `schemaVersion`, `runId`, `startedAt`, `endedAt`, `elapsedMs`, `tickCount`, `config`, `stats`, `selectorFailures`, `posts`
And `schemaVersion` is the literal number `1`
And `config` has exactly `{ minutes: number, dryRun: boolean }` — no API keys, no user data dir, no viewport
And `stats` has exactly `{ postsExtracted, adsSkipped, selectorFailures, duplicateHits }` — all numbers
And `selectorFailures` is an array of `{ field, postIdOrIndex, tickIndex, reason }` objects (the same shape the extractor records)
And `posts` is the `ExtractedPost[]` array verbatim from `extractor.getPosts()` — the writer does not reshape, filter, or reorder posts
(Locking the shape now: feature 10 hashes `posts[].id`, feature 12's summarizer consumes `posts[]`, feature 14's `--replay` reads this exact file. A schema change later bumps `schemaVersion` to 2 and adds a reader branch.)

### Scenario: `config` block in the payload excludes secrets and browser paths

Given a config with `claude.apiKey: "sk-ant-xxx"` and `browser.userDataDir: "~/scrollproxy/chrome"`
When the writer serializes the payload
Then `payload.config` contains only `{ minutes, dryRun }`
And no API key, no user data dir, no viewport dimensions, no jitter settings appear anywhere in `raw.json`
(`raw.json` may be shared (paste a snippet, open in a gist to show a selector bug). Secrets and local filesystem paths don't belong in it. The operator's patience for setup is High; they can re-read `config.yaml` if they need full context.)

### Scenario: `selectorFailures` detail array matches the extractor's in-memory stat entries

Given the extractor recorded 3 selector failures during the run
And one of them is `{ field: "metrics.views", postIdOrIndex: "1234567890", tickIndex: 12, reason: "aria-label not found" }`
When the writer serializes the payload
Then `payload.stats.selectorFailures === 3`
And `payload.selectorFailures` is an array of length 3
And the array contains an entry with `field: "metrics.views"` and `postIdOrIndex: "1234567890"`
And the operator can run `jq '.selectorFailures[] | .field' raw.json` and see every drift point
(Frustration addressed: "tools that hide what they're doing" and "broken automation that fails silently" — the failure detail is on disk the moment the scroll ends.)

### Scenario: Empty scroll (zero posts) still writes a valid `raw.json`

Given the scroll completes but the extractor collected 0 posts (e.g., session expired mid-scroll and the scroller returned `status: 'completed'` with an empty feed, or the first-tick render was empty and the budget was 1 minute)
When the writer runs
Then `<runDir>/raw.json` exists
And `payload.posts` is `[]`
And `payload.stats.postsExtracted === 0`
And `payload.tickCount` and `payload.elapsedMs` reflect reality
(The operator can still grep an empty run to confirm "yes, the scroll ran, yes, the feed was actually empty". Silently writing nothing would be worse than writing a zero-post record.)

### Scenario: `--dry-run` skips the writer entirely

Given the operator runs `pnpm scroll --dry-run --minutes 2`
When the scroll completes
Then `writeRawJson()` is NOT called
And no `<runDir>/` is created
And no `raw.json` appears under `~/scrollproxy/runs/`
And the summary line reads: `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped`
(Dry-run already promised "writer skipped" in feature 6's CLI mockup. This feature honours that contract by making the writer opt-in at the CLI layer, not opt-out inside `writeRawJson()`.)

### Scenario: Session expired — no writer runs, no run directory created

Given the scroller returns `status: 'session_expired'`
When the CLI handles the result
Then the existing "session expired — run pnpm login to refresh" line still prints
And `writeRawJson()` is NOT called
And no `<runDir>/` is created
And the process exits with status 1 as it does today
(No posts were ever extracted. Writing an empty `raw.json` for a session-expiry would clutter `~/scrollproxy/runs/` with noise the operator can't tell apart from a real zero-post run.)

### Scenario: Browser closed early — writer still runs with whatever was collected

Given the scroller returns `status: 'browser_closed'` at `tickCount: 40` with `result.elapsedMs === 85000`
And the extractor already collected 23 posts and 1 ad skip before the browser closed
When the CLI handles the result
Then the existing "scroll ended early after 40 ticks (browser closed)" line still prints
And `writeRawJson()` IS called with the 23 posts already in memory
And `payload.tickCount === 40`, `payload.elapsedMs === 85000`, `payload.posts.length === 23`
And the summary line is appended with `— saved to <runDir>/raw.json`
And the process exits with status 1 as it does today
(Vision principle 3 in its clearest form: the scroll effort is already paid for; losing 23 posts because the browser closed is the exact failure mode the principle forbids. The exit code still reflects abnormal termination; the file reflects what was recovered.)

### Scenario: Disk write failure is reported, does not crash the process, exits with status 1

Given the scroll completes with 84 posts
And `config.output.dir` points at a path the operator cannot write to (read-only volume, permissions, disk full)
When the writer attempts `mkdir` or the final rename
Then the error is caught in the CLI scroll handler
And the summary line reads: `scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — write failed: <reason>`
And the process exits with status 1
And the extractor's posts are not recovered (they were in memory; process exit loses them — acceptable because the operator now sees the exact error and re-runs after fixing permissions)
(Frustration addressed: "broken automation that fails silently". A write failure must print the reason and exit non-zero, not swallow the error behind a cheerful `exit 0`.)

### Scenario: Successful write appends `— saved to <path>` to the summary line

Given a happy-path scroll writes `raw.json` successfully
When the CLI prints the final summary line
Then the line reads: `scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — saved to ~/scrollproxy/runs/2026-04-16T14-32-07Z/raw.json`
And the path in the summary uses `~/` notation (not the absolute expanded path) because that's what the operator sees in config and what fits on one terminal line
And the process exits with status 0
(The operator's daily patience is Very Low. One startup line + one result line is the whole UX. The saved path is the one thing they need to copy-paste into `jq` or `cat` if they care — so it appears on the result line, not a separate log.)

### Scenario: `output.dir` respects tilde expansion and respects the config override

Given `config.output.dir` is `~/work/scrollproxy/runs`
When the writer resolves the target directory
Then it expands `~` to the current user's home (reuses `expandHomeDir` from `src/scroll/scroller.ts` to stay consistent)
And it writes to `<expandedHome>/work/scrollproxy/runs/<runId>/raw.json`
And a custom config like `output.dir: /tmp/test-runs` writes to `/tmp/test-runs/<runId>/raw.json` without tilde handling
(The operator may have a non-default home dir, a multi-user machine, or be running in a sandbox. Tilde expansion lives in exactly one helper — adding a second implementation here would drift out of sync with the scroller.)

### Scenario: Writer adds no new runtime dependencies

Given a contributor reviews `package.json` after this feature lands
When they inspect new runtime deps
Then no JSON formatter is added (uses the built-in `JSON.stringify`)
And no atomic-write library is added (uses `node:fs/promises` `writeFile` + `rename`)
And no path utility is added beyond `node:path` and `node:os`
(Personal-tool simplicity principle. Playwright + Node + Zod is still the whole Phase 1 toolkit.)

### Scenario: Writer is read-only against the extractor's data — it never mutates `posts` or `stats`

Given the writer receives `posts` and `stats` from the extractor
When it serializes the payload
Then it does not sort, filter, reshape, or mutate the input arrays or objects
And an identity check (`Object.is(serializedInput.posts, input.posts)` for the reference it reads) would pass — the writer reads once, calls `JSON.stringify`, and is done
(If a future feature wants posts sorted by `postedAt`, that sort lives in the summarizer or the markdown writer, not here. `raw.json` is the faithful record of what the extractor saw, in the order it saw it.)

### Scenario: Writer never writes outside the configured `output.dir`

Given the configured `output.dir` is `~/scrollproxy/runs`
And the computed `runId` is a slug from `generateRunId()`
When `writeRawJson()` runs
Then every file it creates is under `<expandedOutputDir>/<runId>/`
And the writer does NOT create or touch anything under `~/scrollproxy/state/` (feature 10 owns state)
And the writer does NOT create or touch anything at the repo root (no accidental `raw.json` next to `package.json` in tests — tests always pass an `outputDir` override)
(Boundary enforcement: the anti-persona's "analytics tracking over time" feature request would need a cross-run writer that touches multiple run dirs. A scenario forbidding that at the feature level keeps scope honest.)

## User Journey

1. Operator has run `pnpm login` (feature 4) once. The scroller (feature 5) and extractor (feature 6) are wired; `pnpm scroll` already prints a one-line post/ad summary but nothing lands on disk.
2. They run `pnpm scroll` (or `pnpm scroll --minutes 3`). The startup line prints. They walk away. The browser opens, scrolls, closes.
3. **When the wall-clock budget expires, the extractor hands its in-memory posts to the writer. The writer creates a timestamped run directory under `~/scrollproxy/runs/`, serializes the full run to `raw.json` atomically, and returns the saved path.**
4. The final summary line prints, now with `— saved to ~/scrollproxy/runs/<runId>/raw.json` appended. That is the operator's whole terminal experience.
5. Later — hours or days — the operator `cd`s into the run dir and runs `jq '.posts | length' raw.json`, `jq '.selectorFailures' raw.json`, or `jq '.posts[] | .author.handle' raw.json` to inspect what was captured. This is how they verify the Phase 1 exit criterion and how they notice DOM drift (a sudden spike in `selectorFailures`, a sudden drop in `posts.length`).
6. When `--replay <runId>` lands in feature 14, this same `raw.json` is the input. When the summarizer lands in feature 12, `raw.json` is its canonical input for tests. When the dedup cache lands in feature 10, it reads `posts[].id` from every historical `raw.json`. This file is the Phase 1 deliverable and the Phase 2 foundation.

The operator does not interact with the writer directly. Its evidence in the terminal is exactly one phrase — `— saved to <path>` — appended to the line they already read.

## CLI Mockup

Happy path (non-dry), writer wired:

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  (browser opens on x.com/home; wheel ticks happen; extractor silently collects posts)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — saved to ~/scrollproxy/runs/2026-04-16T14-32-07Z/raw.json
$ echo $?
0
```

Inspecting the run afterwards:

```
$ cd ~/scrollproxy/runs/2026-04-16T14-32-07Z
$ ls
raw.json
$ jq '{posts: (.posts | length), ads: .stats.adsSkipped, drift: (.selectorFailures | length)}' raw.json
{
  "posts": 84,
  "ads": 6,
  "drift": 0
}
$ jq '.posts[0].author.handle' raw.json
"some-handle-they-follow"
```

Dry-run (writer deliberately skipped):

```
$ pnpm scroll --dry-run --minutes 2
  scrolling x.com for 2m (persistent context: /Users/andrew/scrollproxy/chrome)
  dry-run complete: 88 ticks over 120s — 56 posts extracted (3 ads skipped), writer skipped
$ ls ~/scrollproxy/runs/
# (no new run dir for this invocation)
$ echo $?
0
```

Session expired (no writer runs):

```
$ pnpm scroll
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  session expired — run pnpm login to refresh, then pnpm scroll
$ echo $?
1
```

Browser closed early (writer still runs, recovers what was collected):

```
$ pnpm scroll --minutes 10
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  (operator force-quits Chromium after ~90s)
  scroll ended early after 40 ticks (browser closed) — saved to ~/scrollproxy/runs/2026-04-16T14-45-11Z/raw.json
$ jq '.posts | length' ~/scrollproxy/runs/2026-04-16T14-45-11Z/raw.json
23
$ echo $?
1
```

Disk write failure (loud, non-zero exit, no silent loss):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — write failed: EACCES: permission denied, mkdir '/read-only/scrollproxy/runs/2026-04-16T14-32-07Z'
$ echo $?
1
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Markdown output (feature 13). `raw.json` is the machine-readable record; markdown is the human-readable summary.
- Claude summarization (feature 12). The writer never reads or interprets post text.
- Cross-run dedup / the 10k-hash cache (feature 10). `raw.json` is a single-run snapshot; cross-run state lives under `~/scrollproxy/state/`.
- Rolling-themes store (feature 11).
- `--replay <runId>` consumption (feature 14). This feature writes the file; feature 14 reads it.
- Writer interface abstraction (feature 20). `writeRawJson()` is a concrete function, not a plugin point. When feature 13 lands, the shared interface can be refactored then.
- Notion integration (feature 20).
- Retention / old-run pruning. The operator owns disk space. Personal-tool simplicity.
- Compression (gzip, zstd). Phase 1 posts are small; readability beats bytes.
- Concurrent run safety (two `pnpm scroll` instances at once). `generateRunId()` is seconds-precision; two scrolls started in the same second would collide. Phase 1 is single-user, sequential. Feature 10+ may revisit.
- Schema migration tooling. When `schemaVersion` bumps to 2, feature 14's replay reader adds a branch; there is no migration utility.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **run** (the artifact and the act), **scroll** (the command and the verb), **posts** / **ads** (the nouns X uses), **session expired** (the error they already read from feature 5), **raw.json** / **run dir** (filesystem objects they'll `cat` and `jq`), **saved to** (the phrase that points at the file), **write failed** (the error, named the way a Unix tool would). No "export", no "output artifact", no "persistence layer", no "digest file" — every one of those would hide what the tool actually does under product-y abstraction.

Patience-level alignment:
- **Daily patience: Very Low.** The writer adds exactly one phrase — `— saved to <path>` — to the existing one-line result. No "writing raw.json..." spinner, no progress on byte counts, no "✓ saved" confirmation on its own line. The operator runs `pnpm scroll`, reads one line, and is done. If they want to inspect, they `jq` at their own pace.
- **Setup patience: High.** The operator is expected to grep `raw.json` with `jq`, read the schema once to know what's in there, and understand that `selectorFailures` is the diagnostic channel for DOM drift. None of that needs a wizard, a help command, or a readme stub.
- The path in the summary uses `~/` (not the absolute expanded path) deliberately — `~/scrollproxy/runs/<runId>/raw.json` fits on one terminal line; the absolute `/Users/andrew/scrollproxy/runs/...` often doesn't. The operator already knows what `~` points to.
- The atomic-write scenario (tmpfile → rename) is a setup-layer concern; the operator never sees the `.tmp` file on a happy path. It only becomes visible if they're grepping after a crash, which is the exact case where hiding it would be a frustration.

Anti-persona check: the scenarios block every shape of hosted / multi-user / write-action / analytics product the anti-persona would expect.
- **No cloud sync / no network writes** — a scenario forbids the writer from touching anything outside `output.dir`. The anti-persona's "send my digest to my email" feature request would require a network call at this layer; the spec says the writer only hits the local filesystem.
- **No cross-run analytics** — a scenario forbids touching `~/scrollproxy/state/`. The anti-persona's "engagement trends over 30 days" feature would need the writer to update a rolling aggregate; this spec keeps the writer strictly single-run and defers cross-run state to feature 10, which is the anti-persona's "we don't support hosted analytics" firewall.
- **No secrets in the file** — `config.claude.apiKey` never enters `raw.json`. The anti-persona's "ship my digest to a SaaS dashboard" use case would invite copying the file off-machine; scrubbing the payload in advance is a read-only-principle guardrail.
- **No minification / no binary format** — the file is indented JSON the operator can `cat`. The anti-persona's "performant JSON streaming" product concern doesn't apply to a sub-megabyte file written once per run.
- **No writer interface yet** — a scenario names this explicitly. Over-abstracting (`Writer` interface, `RawJsonWriter implements Writer`) before the markdown writer exists would be exactly the kind of "designed by a product team, not a user" complexity the anti-persona ships and the primary persona rejects.
- **No retention policy, no pruning** — the operator owns disk space. Adding a "keep last 30 days" policy would require config, a CLI flag, and a scheduler; Phase 1 does not earn that complexity.

Frustrations addressed:
- **"Never lose scroll effort"** (vision principle 3) — the writer runs on the happy path AND on `browser_closed`, and writes atomically so a crash mid-write never produces a half-file. A scroll that made it to 40 ticks before the browser died still lands 23 posts on disk.
- **"Broken automation that fails silently"** — a disk write failure is a loud one-line error with a non-zero exit code. The operator knows the exact `errno` / message and re-runs after fixing.
- **"Tools that hide what they're doing"** — the final summary line names the saved path. `selectorFailures` lands as a top-level array, not buried three levels deep, so one `jq '.selectorFailures'` is the whole drift view.
- **"Setup wizards, onboarding flows"** — zero prompts, zero extra config keys (uses `output.dir` that already exists in the schema). `run-id` generation is internal; the operator never specifies one for a fresh scroll.
- **"Opening X 'for one thing' and losing 45 minutes"** — the file exists precisely so the operator *doesn't* have to re-open X to check what happened in the feed. `jq '.posts[] | select(.metrics.likes > 1000) | .url' raw.json` answers "anything big happen" in one line, at the operator's pace, in their terminal.
- **"Summarize by averaging everything into mush"** — the writer never averages. Posts are serialized verbatim, in extraction order, with their selector failures itemized. The summarizer (feature 12) receives a file of raw truth, not a pre-chewed summary.

## Learnings

<!-- Updated via /compound after implementation -->
