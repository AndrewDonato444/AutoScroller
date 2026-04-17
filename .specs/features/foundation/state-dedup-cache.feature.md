---
feature: State Module (Dedup Cache)
domain: foundation
source: src/state/dedup-cache.ts
tests:
  - tests/foundation/state-dedup-cache.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-17
---

# State Module (Dedup Cache)

**Source File**: `src/state/dedup-cache.ts` (new), wired into `src/cli/scroll.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Track the last 10k post hashes so each scroll can tell new from already-seen

The operator runs `pnpm scroll` daily. Feature 7 now lands a faithful `raw.json` per run. But on day two the operator wants to know what's **new since yesterday** — the point of the tool is signal, not a redundant re-read of the same feed. This feature is the cumulative-intelligence foundation: a tiny state file under `~/scrollproxy/state/` that remembers the last 10,000 post hashes the operator has seen, plus the helper functions a run uses to ask "have I already seen this post?" and "record these new ones for next time."

Vision principle 6 — **"Cumulative intelligence. Each run builds on prior runs via dedup and rolling themes. The tool should get better at separating signal from noise over time."** — is load-bearing for this feature. The cache is the substrate feature 12 (summarizer) reads to produce the "new since last run" section and feature 13 (markdown writer) renders as the `## New` block. Without this feature, every daily run looks identical to the first; with it, the operator gets a genuine delta per run.

This feature is just the **dedup cache** — not the rolling themes store (feature 11), not the summarizer (feature 12). The two state files live side-by-side under `~/scrollproxy/state/` but own different shapes and different update cadences. Keeping them separate lets feature 11 ship independently without touching the dedup invariants.

This feature ships a `src/state/dedup-cache.ts` module that:

1. Exports `loadDedupCache(stateDir: string): Promise<DedupCache>`. Reads `<stateDir>/seen-posts.json`. If the file does not exist, returns an empty cache (first run). If the file is corrupt (invalid JSON, wrong `schemaVersion`), it is renamed to `seen-posts.json.corrupt-<timestamp>` and an empty cache is returned — a corrupt dedup file must never kill a scroll.
2. Exports `saveDedupCache(cache: DedupCache, stateDir: string): Promise<{ statePath: string }>`. Serializes the cache to `<stateDir>/seen-posts.json` atomically (tmpfile → rename, same pattern as feature 7). Creates `<stateDir>/` recursively if missing.
3. Exports `hashPost(post: ExtractedPost): string`. Returns a stable 16-hex-char SHA-256 prefix of `post.id`. Stable means: same `post.id` always yields the same hash, across runs, across machines, across Node versions. 16 hex chars = 64 bits of entropy — at 10k items the birthday-paradox collision probability is ~2.7×10⁻¹², effectively zero.
4. Exports `DedupCache` as a small record, not a class: `{ schemaVersion: 1; hashes: string[] }`. `hashes` is a FIFO list — oldest hash at index `0`, newest at the end. This is the only ordering invariant and feature 11 will mirror it.
5. Exports `partitionPosts(posts: ExtractedPost[], cache: DedupCache): { newPosts: ExtractedPost[]; seenPosts: ExtractedPost[]; newHashes: string[] }`. Walks `posts` in extraction order, hashes each, splits into new vs. seen using the cache's `hashes` set. Returns the dedup-free `newHashes` (no duplicates within the current run) in first-seen order, ready to append to the cache.
6. Exports `appendHashes(cache: DedupCache, newHashes: string[]): DedupCache`. Returns a new cache (does not mutate input) with `newHashes` appended, then truncated from the front so `hashes.length <= MAX_CACHE_SIZE`. Default `MAX_CACHE_SIZE = 10000`. Eviction is FIFO: when the cache is full, the oldest hashes fall off the front.
7. Exports a `CACHE_SCHEMA_VERSION = 1` constant and enforces it on read. A file with `schemaVersion !== 1` triggers the same "rename to .corrupt-<timestamp>, return empty" path as a parse failure — future-you adds a reader branch when bumping to `2`, not a silent migration.
8. Is wired into `src/cli/scroll.ts` on the happy path **after** `writeRawJson` succeeds: load cache → partition posts → append newHashes → save cache. The summary line is extended with `— N new, M already seen` between the existing "posts extracted" fragment and the "saved to" fragment. If the cache load or save fails, the scroll still exits 0 (the raw.json is already on disk); the failure is logged on its own line as `dedup cache failed: <reason>` and the operator knows to investigate.
9. Is NOT called on `--dry-run`. Feature 15 owns the end-to-end skip contract; dry-run already promises "no writes", and the dedup cache is a write.
10. Is NOT called when the scroll returns `status: 'session_expired'` or when `writeRawJson` itself failed — no posts were persisted, so there is nothing to mark as "seen". `browser_closed` with ≥1 recovered post IS processed (those posts landed on disk and should count as seen).
11. Adds zero runtime dependencies. `node:crypto` ships with Node 20; `node:fs/promises` and `node:path` are already in use. No `lru-cache`, no `quick-lru`, no `keyv`. Personal-tool simplicity.

The module does not know about markdown, Claude, rolling themes, or the `--replay` flag. It does not expose the cache over any network, nor does it include user-identifiable data in the on-disk file — just SHA-256 prefixes of X's own post IDs.

### Scenario: First scroll ever — no state file exists, every post is new, file is created

Given `<stateDir>/seen-posts.json` does not exist
And a scroll completes with 84 extracted posts (all distinct `post.id` values)
When the CLI loads the cache, partitions posts, and saves
Then `loadDedupCache(stateDir)` returns `{ schemaVersion: 1, hashes: [] }`
And `partitionPosts(posts, cache)` returns `newPosts.length === 84`, `seenPosts.length === 0`, `newHashes.length === 84`
And `saveDedupCache(appendHashes(cache, newHashes), stateDir)` writes `<stateDir>/seen-posts.json`
And the saved file contains `{ schemaVersion: 1, hashes: [<84 stable hashes>] }`
And the summary line reads `... — 84 posts extracted (6 ads skipped) — 84 new, 0 already seen — saved to ~/scrollproxy/runs/<runId>/raw.json`
(Day one is the moment the cumulative-intelligence story starts; the first scroll must produce a file for the second scroll to read.)

### Scenario: Second scroll with overlap — seen posts are correctly identified

Given `<stateDir>/seen-posts.json` exists with 84 hashes from a prior run
And today's scroll extracts 60 posts, of which 22 have `post.id` values that map to hashes already in the cache
When the CLI partitions the run
Then `partitionPosts(posts, cache)` returns `newPosts.length === 38` and `seenPosts.length === 22`
And `newHashes.length === 38` (the 22 seen posts do not appear in `newHashes`)
And the saved cache now has `84 + 38 === 122` hashes, oldest first
And the summary line reads `... — 60 posts extracted — 38 new, 22 already seen — saved to ...`
(The operator's "what's new since yesterday" question is answered in the summary line on day two without waiting for feature 12.)

### Scenario: Cache at capacity — FIFO eviction drops oldest hashes

Given the cache contains exactly `MAX_CACHE_SIZE === 10000` hashes
And the new run contributes 150 brand-new hashes
When `appendHashes(cache, newHashes)` runs
Then the returned cache's `hashes.length === 10000`
And the first 150 hashes of the prior cache are no longer present
And the last 150 hashes of the returned cache are exactly the new hashes in first-seen order
And the operator does not see any warning — eviction is routine, not exceptional
(Bounded storage matters for a file the operator never prunes. 10k posts is roughly 3–4 months of daily scrolls; older than that, "already seen" stops being a useful signal anyway.)

### Scenario: Stable hash — same post.id always produces the same hash

Given an `ExtractedPost` with `id: "1780123456789012345"`
When `hashPost(post)` is called multiple times, in different processes, on different Node versions, on different machines
Then it returns the same 16-hex-char string every time
And the output is `sha256("1780123456789012345").slice(0, 16)` (deterministic — no salt, no secret, no timestamp)
(Instability here would silently corrupt dedup across upgrades. The operator cares "did I see this?" — the answer must not change because Node patched its crypto implementation.)

### Scenario: Duplicate post within a single run is counted once

Given a scroll where the extractor returned 60 posts, but two entries share the same `post.id` (the extractor's own dedup missed an edge case, or the same post appeared twice on the page)
When `partitionPosts(posts, cache)` runs with an empty cache
Then `newHashes.length === 59` (the duplicate contributes one hash, not two)
And `newHashes` preserves first-seen order
And `newPosts.length === 60` and `seenPosts.length === 0` — the `posts` partition is unaffected; only the cache input is deduped
(The cache's job is to track distinct posts, not raw occurrences. Double-counting within a run would leak into tomorrow's "X new" number and erode the operator's trust in the delta.)

### Scenario: Corrupt state file is quarantined, not crash

Given `<stateDir>/seen-posts.json` exists but its contents are `{"not valid json`
When `loadDedupCache(stateDir)` runs
Then the corrupt file is renamed to `<stateDir>/seen-posts.json.corrupt-<epochMs>`
And `loadDedupCache` returns `{ schemaVersion: 1, hashes: [] }`
And a one-line warning is logged: `dedup cache corrupt; quarantined to seen-posts.json.corrupt-<epochMs>, starting fresh`
And the scroll continues as if it were day one
(Frustration addressed: "broken automation that fails silently." The operator sees exactly what happened and keeps the old file for forensic review — they can `cat` it, `jq` it, or delete it at their pace.)

### Scenario: Schema mismatch is treated the same as corruption

Given `<stateDir>/seen-posts.json` parses as valid JSON but contains `{ "schemaVersion": 2, "hashes": [...] }`
When `loadDedupCache(stateDir)` runs
Then the file is renamed to `<stateDir>/seen-posts.json.corrupt-<epochMs>`
And an empty cache is returned
And a warning is logged: `dedup cache schema 2 not supported by this build; quarantined and started fresh`
(A future ScrollProxy version may bump the schema. This build must not crash when it sees a forward-version file written by that future build; it must also not silently pretend it understands. Quarantine is the honest middle.)

### Scenario: Atomic save — a crash mid-write never produces a half-written cache

Given a scroll completes and `saveDedupCache` is running
When the process is killed between the tmpfile write and the rename
Then `<stateDir>/seen-posts.json.tmp` exists (possibly partial)
And `<stateDir>/seen-posts.json` is untouched (either the prior version, or absent if this was day one)
And the next scroll's `loadDedupCache` returns the prior cache (or empty on day one) — never a truncated file
(Same atomic-write pattern as feature 7. Losing the mid-write state is acceptable; silently truncating the cumulative history would ruin the operator's "what's new" signal going forward.)

### Scenario: Cache save happens AFTER the raw.json write

Given a scroll with 60 posts is completing
When the CLI sequences its post-scroll work
Then `writeRawJson(...)` completes first and `<runDir>/raw.json` exists
And only then does the CLI load, update, and save the dedup cache
And if `writeRawJson` throws, the dedup cache is NOT modified and NOT saved — the cache only records posts the operator actually has on disk
(If dedup ran first and the raw.json write then failed, the cache would remember posts the operator cannot inspect. The `raw.json` is the source of truth; the cache is derived state.)

### Scenario: --dry-run skips the dedup cache entirely

Given the operator runs `pnpm scroll --dry-run --minutes 2`
When the scroll completes
Then `loadDedupCache` is NOT called
And `saveDedupCache` is NOT called
And no change is made to `<stateDir>/seen-posts.json`
And the summary line reads `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped` (unchanged from feature 7)
(Dry-run means no writes anywhere. Feature 15 owns the flag end-to-end; this feature honours it by skipping at the CLI layer.)

### Scenario: Session expired — no cache work happens

Given the scroller returns `status: 'session_expired'`
When the CLI handles the result
Then the existing "session expired — run pnpm login to refresh" line still prints
And `loadDedupCache` is NOT called
And `saveDedupCache` is NOT called
And the process exits with status 1 as it does today
(No posts were extracted, no `raw.json` exists, there is nothing to mark as "seen".)

### Scenario: Browser closed early — recovered posts are counted as seen

Given the scroller returns `status: 'browser_closed'` and the extractor recovered 23 posts
And `writeRawJson` persisted those 23 posts to `<runDir>/raw.json`
When the CLI runs the dedup pass
Then `loadDedupCache`, `partitionPosts`, and `saveDedupCache` all run
And those 23 posts' hashes are appended to the cache
And the summary line reads `scroll ended early after 40 ticks (browser closed) — 23 new, 0 already seen — saved to <runDir>/raw.json`
And the process exits with status 1 (unchanged from feature 7)
(Vision principle 3 in its dedup form: the scroll effort is paid for; those 23 posts should not re-appear as "new" tomorrow. The non-zero exit reflects abnormal termination; the cache reflects what landed on disk.)

### Scenario: Dedup cache save failure is loud but non-fatal

Given the scroll and `writeRawJson` both succeed
And the dedup cache save fails (disk full, permissions on `<stateDir>`)
When the CLI handles the error
Then the error is caught
And the primary summary line reads `scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — saved to ~/scrollproxy/runs/<runId>/raw.json`
And a second line reads `dedup cache failed: <reason> (next run will re-count some posts as new)`
And the process exits with status 0 — the raw.json is the primary artifact; the cache is derived state that can rebuild naturally
(Frustration addressed: "broken automation that fails silently." The operator sees the reason and knows the consequence. The tool does not throw away a successful scroll because a derived-state write stumbled.)

### Scenario: State file shape is locked at schema version 1

Given a run that grows the cache to 122 hashes
When `saveDedupCache` serializes the payload
Then the top-level keys, in order, are: `schemaVersion`, `hashes`
And `schemaVersion` is the literal number `1`
And `hashes` is a JSON array of strings, each exactly 16 hex characters long
And no other keys appear in the file — no `createdAt`, no `lastRunId`, no `hostname`, no operator metadata
And `JSON.stringify(payload, null, 2)` is used — 2-space indentation, UTF-8
(Locking the shape keeps the file self-describing and grep-friendly. Any additional field is a future-proofing temptation that invites anti-persona features — "track who posted what, when, and across how many runs" is a surveillance model ScrollProxy explicitly rejects.)

### Scenario: State file contains no secrets and no post content

Given a run with 84 extracted posts, each containing `author`, `text`, `metrics`, `media`
When `saveDedupCache` serializes the payload
Then the on-disk file contains only hashes — no post text, no author handles, no URLs, no media links, no metrics, no API keys
And the file is safe to paste into an issue, commit accidentally, or share to debug
(The anti-persona's "send my reading history to a cloud dashboard" feature request would need richer state. Hashes-only at rest is the firewall.)

### Scenario: State directory is respected from config and expanded

Given `config.output.state` is `~/scrollproxy/state` (the default)
When `loadDedupCache` and `saveDedupCache` resolve the path
Then `~` is expanded via the same `expandHomeDir` helper the scroller and writer use
And the cache file lives at `<expandedHome>/scrollproxy/state/seen-posts.json`
And a custom config like `output.state: /tmp/test-state` writes to `/tmp/test-state/seen-posts.json` without tilde handling
And the state directory is created with `fs.mkdir(..., { recursive: true })` if missing
(One home-dir helper. Same pattern as the raw.json writer.)

### Scenario: State module never writes outside `output.state`

Given the configured `output.state` is `~/scrollproxy/state`
When any dedup-cache function runs
Then every file it creates is under `<expandedStateDir>/`
And the module does NOT read or write anything under `~/scrollproxy/runs/` (feature 7 owns runs)
And the module does NOT touch any file at the repo root during tests (tests always pass an explicit `stateDir`)
(Boundary enforcement: runs are run-scoped, state is cross-run. The two directories stay independent so a `rm -rf ~/scrollproxy/runs` does not clobber dedup history, and vice versa.)

### Scenario: Module adds no new runtime dependencies

Given a contributor reviews `package.json` after this feature lands
When they inspect new runtime deps
Then no hashing library is added (uses `node:crypto`'s `createHash('sha256')`)
And no atomic-write library is added (reuses the `writeFile` + `rename` pattern from feature 7)
And no LRU / cache library is added (FIFO eviction is a 3-line array slice)
And no dependency is added at all — the module is pure Node stdlib
(Playwright + Node + Zod + @anthropic-ai/sdk is still the whole toolkit. Personal-tool simplicity.)

## User Journey

1. The operator has already been running `pnpm scroll` and collecting `raw.json` files under `~/scrollproxy/runs/`. They can see `jq '.posts | length'` numbers but every run feels identical — no sense of "what's new."
2. **They pull this build. On the next `pnpm scroll`, the summary line has a new fragment: `— 84 new, 0 already seen`. On day one it is always all-new. On day two the same command reports `— 38 new, 22 already seen`, which is the first concrete evidence the tool is learning their feed.**
3. Under the hood: after the scroll's `writeRawJson` lands the `raw.json`, the CLI loads `~/scrollproxy/state/seen-posts.json` (empty on day one, populated thereafter), partitions the run's posts into new vs. seen, appends the new hashes with FIFO eviction at 10k, and saves the cache atomically.
4. The operator can `cat ~/scrollproxy/state/seen-posts.json` at their pace and see an ordered array of 16-char hex strings. That is all. There is no post content, no PII, no API key, nothing platform-identifying beyond the file's existence. The operator's "keeping their own data" principle (from their persona) is honoured at the shape level, not just the location level.
5. The cache is invisible plumbing until feature 12 (summarizer) and feature 13 (markdown writer) land, at which point the same `seen-posts.json` becomes the `## New` section of the daily markdown — no migration, no retooling. This feature's one-line CLI surface (`— N new, M already seen`) is a preview of the signal the full pipeline will eventually produce.
6. If the cache ever goes sideways (corrupt, schema mismatch, disk full), the operator sees a one-line warning, the original file is preserved under a `.corrupt-<timestamp>` suffix, and the next scroll starts fresh. The worst case is one day's worth of "new vs. seen" noise — never a crashed scroll.

## CLI Mockup

Happy path on day one (no cache yet, all posts are new):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — 84 new, 0 already seen — saved to ~/scrollproxy/runs/2026-04-16T14-32-07Z/raw.json
$ echo $?
0
$ cat ~/scrollproxy/state/seen-posts.json | jq '.hashes | length'
84
```

Happy path on day two (22 posts overlap with day one):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 118 ticks over 180s — 60 posts extracted (4 ads skipped) — 38 new, 22 already seen — saved to ~/scrollproxy/runs/2026-04-17T14-30-02Z/raw.json
$ echo $?
0
$ cat ~/scrollproxy/state/seen-posts.json | jq '.hashes | length'
122
```

Inspecting the state file (hashes only — no post content, no PII):

```
$ jq '{version: .schemaVersion, count: (.hashes | length), sample: .hashes[:3]}' ~/scrollproxy/state/seen-posts.json
{
  "version": 1,
  "count": 122,
  "sample": [
    "a1b2c3d4e5f60718",
    "0f1e2d3c4b5a6978",
    "deadbeefcafef00d"
  ]
}
```

Dry-run (cache untouched):

```
$ pnpm scroll --dry-run --minutes 2
  scrolling x.com for 2m (persistent context: /Users/andrew/scrollproxy/chrome)
  dry-run complete: 88 ticks over 120s — 56 posts extracted (3 ads skipped), writer skipped
$ # (no change to ~/scrollproxy/state/seen-posts.json)
```

Session expired (no cache work):

```
$ pnpm scroll
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  session expired — run pnpm login to refresh, then pnpm scroll
$ echo $?
1
```

Browser closed early (partial posts are recorded as seen):

```
$ pnpm scroll --minutes 10
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll ended early after 40 ticks (browser closed) — 23 new, 0 already seen — saved to ~/scrollproxy/runs/2026-04-16T14-45-11Z/raw.json
$ echo $?
1
```

Dedup cache save failure (loud, but scroll still exits 0 because the raw.json is safe):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — saved to ~/scrollproxy/runs/2026-04-16T14-32-07Z/raw.json
  dedup cache failed: EACCES: permission denied, open '/Users/andrew/scrollproxy/state/seen-posts.json.tmp' (next run will re-count some posts as new)
$ echo $?
0
```

Corrupt state file is quarantined, not crashed on:

```
$ echo "{not valid" > ~/scrollproxy/state/seen-posts.json
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  dedup cache corrupt; quarantined to seen-posts.json.corrupt-1713280000000, starting fresh
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped) — 84 new, 0 already seen — saved to ~/scrollproxy/runs/2026-04-16T14-32-07Z/raw.json
$ ls ~/scrollproxy/state/
seen-posts.json
seen-posts.json.corrupt-1713280000000
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Rolling themes store (feature 11). Separate file, separate shape, separate lifetime.
- Claude summarizer (feature 12). The cache is a set-membership oracle; the summarizer is the prose engine that reads it.
- Markdown writer's `## New` section (feature 13). The summary line's `— N new, M already seen` is the only user-facing rendering this feature ships.
- `--replay <runId>` flag (feature 14). Replay reads `raw.json`, not the cache; the cache's job is cross-run, not within-run.
- Cross-run trend detection (feature 21, Phase 3). The dedup cache is a set, not a history — it remembers *whether* a post was seen, not *when* or *how often*.
- Vision-based fallback (feature 22, Phase 3). The dedup cache is DOM-shape-independent; it only consumes `post.id`.
- Explicit cache-reset / `--clear-cache` CLI flag. The operator can `rm ~/scrollproxy/state/seen-posts.json` and the next scroll treats every post as new — no dedicated UX for an operation done once a year.
- Encryption / at-rest protection. Hashes-only is already low-sensitivity by design; encryption would add a key-management problem for a personal tool.
- Multi-machine sync. Each machine keeps its own cache. Two Macs would report different "new" numbers for the same feed — and that is the right behaviour for a single-user local tool. Hosted sync is anti-persona territory.
- Schema migration tooling. When `schemaVersion` bumps to 2, the loader adds a read branch; quarantine-and-reset is the default for any unrecognized version.
- Configurable `MAX_CACHE_SIZE`. The 10k limit is a constant exported from this module. If 10k proves wrong after real use, the constant changes in one place; no YAML key for it.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **run** (the scroll artifact), **scroll** (the command), **post** (X's own noun), **new** and **already seen** (human-readable dedup verdicts), **cache** (the file's role, matching how they'd describe it in conversation), **state** (the directory's role, matching the existing `output.state` config key). No "cache layer", no "deduplication service", no "persistence tier", no "entity identifier" — every one of those would smuggle in a SaaS architecture vocabulary the operator explicitly rejects.

Patience-level alignment:
- **Daily patience: Very Low.** The dedup feature adds exactly one fragment — `— N new, M already seen` — to the existing summary line, between "posts extracted" and "saved to". No new lines on the happy path. No spinners. No confirmation. The operator runs `pnpm scroll`, reads one line, learns today's delta, closes the laptop.
- **Setup patience: High.** The operator is expected to understand that `~/scrollproxy/state/seen-posts.json` grows over time, that FIFO eviction kicks in at 10k, and that a corrupt file is quarantined rather than crashed on. All of that is in the scenarios above; no CLI onboarding wizard is required.
- Error messages are written as the operator would write them: `dedup cache corrupt; quarantined to <path>, starting fresh` reads like a diff header, not a stack trace or a product notification. `next run will re-count some posts as new` explains the consequence in plain English so the operator doesn't have to read source.
- The state file's on-disk shape (2-space JSON, keys in fixed order) mirrors `raw.json`'s stylistic choices. The operator's `jq` muscle memory transfers one-to-one between the two files.

Anti-persona check: every shape of hosted / multi-user / analytics / surveillance product the anti-persona would expect is blocked at the feature level.
- **No post content in state** — a scenario forbids text, author, URL, or metric data in `seen-posts.json`. The anti-persona's "show me my reading trends over time" feature would need richer state; hashes-only is the firewall.
- **No user identity in state** — no hostname, no account, no session cookie derived-value, no device fingerprint. The file is portable and anonymised by its shape.
- **No cloud sync** — a scenario forbids writing anywhere but `output.state`. The anti-persona's "sync my reading history across devices" feature would require a network call this module will never make.
- **No write actions derived from state** — the cache is read-only against X. Knowing the operator has seen a post does not, under any branch of this feature, trigger a "mark as read" API call or a like. That was never on the table and it remains never on the table.
- **No analytics / engagement model** — a single boolean per post (seen or not) is the entire model. A counter of how many times a post appeared across runs, or how long it stayed in the feed, would be the beginning of a reading-habits analytics product; it is explicitly out of scope.
- **No multi-cache for "work" vs. "personal"** — one operator, one feed, one cache per machine. Splitting into multiple caches would invite a config key, a CLI flag, and a UX for choosing between them — all complexity the single-user principle forbids.
- **No retention / pruning policy beyond FIFO-at-10k** — the operator owns disk space. The cache is bounded by count, not by time, so "retain last 30 days" is never a config decision.

Frustrations addressed:
- **"Cumulative intelligence"** (persona "what they care about" item 3) — the summary line's `— N new, M already seen` is the first concrete piece of evidence the tool is learning the operator's feed. On day one it reads all-new; on day seven it reads mostly-seen-a-little-new, which is the signal they actually want.
- **"Keeping their own data"** (persona item 4) — the cache is a local file under `~/scrollproxy/state/`, hashes-only, no network, no account. The operator can `rm` it, `mv` it, `git`-ignore it, or back it up with their dotfiles. No SaaS dashboard ever reads it.
- **"Broken automation that fails silently"** (frustration) — corrupt files quarantine loudly, save failures print the reason and the consequence, and schema mismatches trigger the same quarantine path. The operator always knows what happened and what's next.
- **"Tools that hide what they're doing"** (frustration) — the state file is human-readable JSON with two keys. One `jq` pipe shows the entire cache. The daily summary line names the delta in plain English. No hidden state, no opaque counters.
- **"Deterministic output"** (persona item 2) — `hashPost` is stable across Node versions and machines; the cache itself has a fixed key order; eviction is FIFO (deterministic, not LRU or probabilistic). The same inputs always produce the same outputs.
- **"Tools that summarize by averaging everything into mush"** (frustration) — this feature does not summarize anything. It splits the run into two buckets (new, already-seen) with bright lines, and leaves the prose to feature 12.

## Learnings

### Project-Specific Conventions

**.gitkeep in module directories:** This project maintains `.gitkeep` files in all module directories (`src/state/`, `src/writer/`, `src/config/`) even after they contain real implementation files. This is intentional — the scaffold tests verify these files exist. When implementing a new module, remember to add the `.gitkeep` file to satisfy test UT-004.

**Why:** Consistency with the existing module structure. All first-class module directories have `.gitkeep` files regardless of whether they contain other files.

### Implementation Choices

**No trailing newline on state files:** The dedup cache's `saveDedupCache` writes `JSON.stringify(payload, null, 2)` without appending `\n`, unlike the raw-json writer (feature 7) which does `JSON.stringify(...) + '\n'`. This is intentional — the state file doesn't need the trailing newline that makes raw.json easier to `cat` and pipe through jq, since state files are internal plumbing not user-inspected artifacts.

**Root cause of original drift:** The spec described using the "same atomic-write pattern as feature 7" and initially assumed all stylistic choices (including trailing newline) would transfer. During implementation, only the atomic write pattern (`tmpfile → rename`) was copied; the trailing newline was not. The spec was updated to reflect this intentional difference.

### Helper Extraction

**Quarantine helper (2 occurrences):** Extracted `quarantineCorruptCache` helper to eliminate duplication — it appeared twice in `loadDedupCache` with different log messages (corruption vs schema mismatch). Extracting to a helper with a `logMessage` parameter eliminated ~8 lines of duplication.

**Display path helper (4 occurrences):** Extracted `formatDisplayPath` helper in `scroll.ts` — the pattern `path.replace(expandHomeDir('~'), '~')` appeared 4 times. Single helper improves maintainability.

**Update-and-summarize helper:** Extracted `updateDedupCacheAndGetSummary` to consolidate duplicate cache update logic that appeared in both the `browser_closed` and successful completion paths. Reduced duplication from ~15 lines × 2 to a single 8-line helper.

### Refactoring Decisions

**When NOT to extract:**
- Error handling blocks with different exit codes (5 lines each, different control flow) — parameterizing would reduce clarity
- Long sequential functions with clear phases (`handleScroll` at 136 lines) — extraction would harm readability of the flow
- User-facing error messages — intentionally inline for context

**Type safety improvement:** Replaced `any[]` with `ExtractedPost[]` for better type safety in function signatures.
