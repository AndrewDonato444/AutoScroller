---
feature: X API Production Hardening
domain: expansion
source:
  - src/sources/xListAdapter.ts
  - src/sources/xApiClient.ts
  - src/xAuth.ts
  - src/xRefresh.ts
  - src/lib/repoRoot.ts
tests:
  - tests/expansion/x-api-hardening.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-20
updated: 2026-04-20
---

# X API Production Hardening

**Source Files**: `src/sources/xListAdapter.ts`, `src/sources/xApiClient.ts`, `src/xAuth.ts`, `src/xRefresh.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Make the X API source layer safe for unattended scheduled invocation before Phase 3 retires Playwright

The X API source shipped functionally complete in the prior migration commit (AutoScroller `cf477ad`). It passes end-to-end validation under the specific conditions operators have exercised it in: manual invocation from the repo root, fresh access token, serial code paths. Three distinct failure modes hide in that "specific conditions" caveat. None of them trigger under current usage; all of them will trigger the moment the source moves from manual operation to a scheduled task that fires on a timer, rotates tokens mid-cadence, and may be invoked from a working directory that isn't the repo root. This feature closes the three gaps as a single hardening pass so the handoff from validation to production is a one-step commit, not a three-patch chase.

Vision principle 6 — **"Cumulative intelligence. Each run builds on prior runs via dedup and rolling themes."** — is why retweet attribution matters: `repostedBy = author` collapses two distinct signals into one, and the rolling-themes store now has weeks of retweets attributed to the wrong person because Playwright had the attribution right and this adapter silently broke it. Any operator digging back through `voices.md` to understand "who's consistently amplifying X" gets the wrong answer until the adapter is fixed AND until enough new runs have aggregated to overwhelm the bad data. Fixing attribution now caps the contamination window.

Vision principle 5 — **"Operator trust. The tool should never fail silently."** — is why the refresh race matters. The failure mode is invisible: Claude summarizer gets fewer posts than expected because one list pull 401'd after the other list's refresh invalidated its token, and the operator sees a short summary with no indication why. No error, no log, no Telegram alert — just quiet signal loss. Serializing refresh eliminates the failure before it ever produces a misleadingly-thin summary.

Vision principle 2 — **"Signal over completeness."** — shapes how this spec groups work. These three fixes do not share a module, do not share a test file, and could each be a tiny PR on its own. They ship as one feature because they share one goal (unblock scheduled invocation) and one gate (must complete before Phase 3 deletes Playwright). Splitting them across three commits adds ceremony without adding safety — the operator cares that x-api is ready for the scheduler, not that hardening was choreographed across three stanzas.

This feature ships three changes:

1. **Retweet attribution in the adapter** — when an incoming tweet has `referenced_tweets[type=retweeted]`, the adapter resolves the referenced tweet from `includes.tweets`, uses the referenced tweet's author (looked up in `usersById`) as `ExtractedPost.author`, uses the current (retweeting) tweet's author as `ExtractedPost.repostedBy`, and uses the referenced tweet's full text as `ExtractedPost.text`. Non-retweet tweets are unchanged. If the referenced tweet can't be resolved (missing from `includes.tweets` or its author isn't in `usersById`), the adapter falls back to the current behavior and records a warning rather than dropping the post or producing a partially-wrong record. This is the same "degrade gracefully, name what you don't have" posture the rest of the codebase uses (see `extractor.ts` vision fallback).

2. **Serialized token refresh in the API client** — `getValidToken()` gains an in-flight refresh promise cache. When the cached token is near expiry and a concurrent caller hits the proactive-refresh branch, the first caller's `refreshAccessToken()` promise is stored in a module-local `inFlightRefresh` variable. Subsequent callers that enter `getValidToken()` before the refresh resolves `await` the same stored promise instead of issuing their own refresh request. Once the promise resolves, `inFlightRefresh` is cleared. The reactive-refresh branch (401 handler in `xGet`) uses the same mechanism. No lock primitives, no queues — just a shared promise. This matches the Node.js idiom for "coalesce concurrent async work."

3. **Repo-root-relative `.env.local` resolution** — `xAuth.ts`, `xRefresh.ts`, and `xApiClient.ts` stop resolving `.env.local` via `process.cwd()`. Instead, each file computes a repo-root-relative path via `fileURLToPath(import.meta.url)` and walks up the directory tree from its source location. The canonical path becomes `{repo-root}/.env.local`, same file, independent of where the process was invoked from. This matches the pattern already in use at `src/config/load.ts:9-11` (the existing config loader uses a package-root-relative default path for `config.yaml`). The shared path-resolution logic extracts into a tiny helper (`src/lib/repoRoot.ts`) so all three consumers point at the same code — one bug to fix, one test to write, one place to update if the repo ever moves.

### Scenario: Retweet preserves original author and full text
Given the X API returns a tweet `T1` with `author_id = retweeter_id` and `referenced_tweets = [{ type: 'retweeted', id: 'T0' }]`
And `includes.tweets` contains `T0` with `author_id = original_id` and full text `"Original thought in full"`
And `includes.users` contains both `retweeter_id` and `original_id`
When the adapter processes `T1`
Then the resulting `ExtractedPost.author.handle` equals the original author's username
And `ExtractedPost.repostedBy` equals the retweeter's username
And `ExtractedPost.isRepost` is `true`
And `ExtractedPost.text` equals `"Original thought in full"` (the referenced tweet's full text, not the retweet wrapper)

### Scenario: Retweet with unresolvable reference degrades gracefully
Given the X API returns a tweet `T1` with `referenced_tweets = [{ type: 'retweeted', id: 'T0' }]`
And `includes.tweets` does NOT contain `T0` (missing expansion, API omission, whatever)
When the adapter processes `T1`
Then the resulting `ExtractedPost.author` falls back to the current tweet's author (the retweeter)
And `ExtractedPost.repostedBy` equals the retweeter's username
And `ExtractedPost.isRepost` is `true`
And `ExtractedPost.text` equals the current tweet's text (truncated retweet wrapper, same as pre-hardening behavior)
And no exception is thrown

### Scenario: Quoted tweet is unchanged by hardening
Given the X API returns a tweet with `referenced_tweets = [{ type: 'quoted', id: 'T0' }]` and no retweet reference
When the adapter processes the tweet
Then `ExtractedPost.author` equals the current tweet's author
And `ExtractedPost.repostedBy` is `null`
And `ExtractedPost.isRepost` is `false`
And `ExtractedPost.text` equals the current tweet's text
(Quote tweets remain V2-deferred per the adapter's existing scope.)

### Scenario: Non-referenced tweet is unchanged by hardening
Given the X API returns a tweet with no `referenced_tweets` field
When the adapter processes the tweet
Then every `ExtractedPost` field equals the pre-hardening behavior exactly

### Scenario: Concurrent `getValidToken` calls issue exactly one refresh
Given the cached access token is within the proactive-refresh window (<2 minutes to expiry)
And the refresh endpoint is instrumented to count invocations
When 5 `xGet` calls are issued in parallel via `Promise.all`
Then `refreshAccessToken()` is invoked exactly 1 time (not 5)
And all 5 calls receive the same refreshed access token
And all 5 calls complete successfully

### Scenario: Reactive 401 refresh is also serialized
Given the first `xGet` call receives a 401 response and triggers a reactive refresh
And a second `xGet` call fires while the refresh is still in flight
When both calls complete
Then `refreshAccessToken()` is invoked exactly 1 time across both calls
And both calls receive the post-refresh token
And the in-flight cache is cleared after the refresh resolves (next near-expiry check triggers a fresh refresh)

### Scenario: Refresh failure does not wedge the in-flight cache
Given a refresh attempt fails (e.g., X returns 500 or the refresh token is revoked)
When the failing refresh promise rejects
Then the `inFlightRefresh` cache is cleared (set back to `null`)
And the next `getValidToken` call starts a fresh refresh attempt rather than awaiting the rejected promise forever
And the rejection propagates to the original caller(s) as a thrown error

### Scenario: `.env.local` resolves to the repo root regardless of `cwd`
Given `.env.local` exists at `{repo-root}/.env.local` with valid credentials
And the process is invoked from a working directory that is NOT the repo root (e.g., `/tmp`)
When any of `xAuth.ts`, `xRefresh.ts`, or `xApiClient.ts` reads the env file
Then the read succeeds against `{repo-root}/.env.local` (not `{cwd}/.env.local`)
And the credentials load correctly

### Scenario: Missing `.env.local` at the resolved path fails loudly with a clear error
Given `.env.local` does NOT exist at the resolved repo-root path
When `xRefresh.ts` attempts to read it
Then the error message includes the absolute path that was attempted
And the error does NOT mention `process.cwd()` (since that's no longer the resolution basis)
And the operator can fix it by creating the file at the indicated path

### Scenario: Repo-root helper produces a stable path across consumers
Given three distinct source files (`xAuth.ts`, `xRefresh.ts`, `xApiClient.ts`) call the shared repo-root helper
When each resolves the path to `.env.local`
Then all three produce the identical absolute path
And the path matches the output of `git rev-parse --show-toplevel` from the same machine

## Non-goals (explicit)

Flagged during code review but deliberately OUT of scope for this spec:

- **Retweet text is still ≤280 chars** — if the original tweet is longer than 280 chars (edited tweets, expanded threading), the full text would require a separate expansion. Current API tier doesn't reliably return long text on referenced tweets; accepting truncation at the original's length, which is still strictly better than the retweet wrapper.
- **Scope verification after token exchange** — `xAuth.ts` doesn't check returned scopes match requested scopes. Low-signal fix; one-line nice-to-have; skipped to keep this spec focused.
- **Media type catchall** — `type: 'animated_gif' → 'gif'` mapping is fine; other unknown types falling into `'gif'` is a nice-to-have tightening, not a production blocker.
- **Bookmark user-ID caching** — $0.01/run cost; ignored.
- **Port-conflict hint in `xAuth.ts`** — one-line ergonomic improvement; ignored.
- **Silent `--source` boolean-flag fallback** — one-line fix; ignored.
- **Scheduler investigation** — not SDD-shaped; separate discovery task.
- **Phase 3 cleanup** — gated on this spec landing and a parallel-run validation window.

Each of these is individually small; they accumulate into "polish the hardening pass later" rather than blocking it now.

## Test plan

All tests live in `tests/expansion/x-api-hardening.test.ts` with test IDs prefixed `XH-`:

- **XH-01** — Retweet attribution (happy path): builds a mock `XApiListResponse` with one retweet, asserts all six fields of `ExtractedPost`.
- **XH-02** — Retweet unresolvable reference (graceful degrade): mock response missing `includes.tweets[T0]`, assert fallback behavior.
- **XH-03** — Quoted tweet unchanged: mock response with quoted reference, assert no attribution rewrite.
- **XH-04** — Plain tweet unchanged: mock response with no references, assert byte-equal to pre-hardening adapter output.
- **XH-05** — Parallel `getValidToken` issues single refresh: stub `refreshAccessToken()` with a counter + delayed resolution, invoke 5× in parallel, assert count = 1.
- **XH-06** — Reactive 401 coalescing: stub `fetch` to return 401 on first request, assert concurrent retries share the single refresh.
- **XH-07** — Failed refresh clears in-flight cache: stub `refreshAccessToken()` to reject, assert subsequent calls retry fresh (not hang on dead promise).
- **XH-08** — Repo-root `.env.local` resolution: unit-test the `repoRoot()` helper directly; assert output matches `import.meta.url`-derived expectation regardless of `process.cwd()`.
- **XH-09** — Consumers use the shared helper: grep-style assertion (or import-graph inspection) that all three consumer files import from `src/lib/repoRoot.ts` rather than inlining `process.cwd()`.

## Self-check drift prompts

When implementation lands, re-read each scenario and confirm:

- The test file name and test IDs match the spec.
- Fallback behavior on unresolvable retweet reference matches scenario XH-02 exactly (same `author`, same `text`, same `isRepost`, no throw).
- The `inFlightRefresh` promise is cleared in BOTH the resolved-success AND rejected-failure paths — the third scenario (XH-07) is easy to miss.
- Every call site that previously used `path.resolve(process.cwd(), '.env.local')` now uses the shared helper. No stragglers.

## Learnings

**Singleflight for coalescing concurrent async work.** The `let inFlight: Promise<T> | null` pattern with `.finally(() => inFlight = null)` is the cleanest Node idiom for "multiple callers trigger the same expensive operation; issue it once, share the result." Key detail: `.finally()` runs on both resolve AND reject. Using `.then(..., () => inFlight = null)` would wedge the cache on rejection. This applies beyond token refresh — anywhere a shared resource has per-caller triggers (cache warmup, connection init, etc.).

**vitest worker threads do not support `process.chdir()`.** Tests that wanted to prove "behavior X is independent of cwd" by mutating cwd at runtime throw `ERR_WORKER_UNSUPPORTED_OPERATION`. The cleaner assertion is often behavioral: spy on `process.cwd()` and verify the code under test never calls it. "If the code doesn't reach for cwd, the result is definitionally cwd-independent." Stronger guarantee, survives the worker-thread constraint.

**SDD scope is "shared goal," not "shared module."** Three fixes lived in three different files with three different failure modes, but they all had to ship before the same downstream gate (Phase 3 Playwright retirement). Grouping them as one feature with three scenarios produced cleaner output than three micro-features — the spec doc explains the connective tissue ("make x-api production-ready"), and the commit lands as one coherent hardening pass. Split when goals diverge; group when gates align.

**Map lookups in adapters beat inline `.find()` calls.** The retweet attribution fix required resolving references across `includes.users` and `includes.tweets`. Building a `usersById: Map` and `tweetsById: Map` once at the top of `adaptListResponse` and reusing them across all tweets in the batch is cleaner than nested `.find()` per tweet — O(n) vs O(n×m), and the Map constructor is a clear "this is my lookup table" signal to readers.

