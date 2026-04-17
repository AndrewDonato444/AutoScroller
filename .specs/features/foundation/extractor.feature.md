---
feature: Extractor
domain: foundation
source: src/extract/extractor.ts
tests:
  - tests/foundation/extractor.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-16
---

# Extractor

**Source File**: `src/extract/extractor.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: DOM extraction of posts from the X feed during a scroll

The operator has run `pnpm login` once, the scroller (feature 5) now runs a jittered wheel-scroll against `x.com/home` for the budgeted minutes and exposes an `onTick` hook after every tick. Today that hook fires into empty space — the CLI prints `scroll complete: N ticks over Ms — extractor not yet wired`. This feature is the extractor that subscribes to the tick hook, parses the posts currently rendered in the timeline DOM, skips ads and promoted posts, normalizes each post into a typed object with author / text / metrics / media / permalink, deduplicates within the run by post id, and accumulates the full set in memory so feature 7 can write it as `raw.json`. After this feature lands, the scroll run still writes nothing to disk (feature 7 owns the writer), but the scroller's on-exit summary changes from "extractor not yet wired" to `scroll complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped)`.

The extractor is the highest-risk Phase 1 item per the roadmap — X's DOM is adversarial to automation and selectors will churn. This spec therefore nails down the structured post shape, the skip rules, and the fail-loud-not-silent behavior so that when (not if) selectors break, the operator sees exactly which posts were dropped and why, and the scroll never throws.

This feature ships a `createExtractor()` factory and an `ExtractedPost` type that:

1. Exports an `ExtractedPost` type with the fields: `id`, `url`, `author` (`{ handle, displayName, verified }`), `text`, `postedAt` (ISO string or `null` if unreadable), `metrics` (`{ replies, reposts, likes, views }`, each a number or `null`), `media` (array of `{ type: 'image' | 'video' | 'gif', url }`), `isRepost` (boolean), `repostedBy` (handle or `null`), `quoted` (nested `ExtractedPost` or `null`), `extractedAt` (ISO string), and `tickIndex` (the scroll tick it was first seen on).
2. Exports a `createExtractor()` factory that returns `{ onTick, getPosts, getStats }`. `onTick` is the callback wired into `runScroll({ onTick })`. `getPosts()` returns the accumulated `ExtractedPost[]` at any time. `getStats()` returns `{ postsExtracted, adsSkipped, selectorFailures, duplicateHits }`.
3. On each tick, queries the page for `article[data-testid="tweet"]` (current selector; tracked as a constant `POST_SELECTOR` so a contributor can patch one place when X renames it), then for each article evaluates an in-page function to read the structured fields.
4. Skips any article that contains `[data-testid="placementTracking"]`, the visible `"Ad"` or `"Promoted"` label span, or any descendant matching `[data-testid*="promoted"]`. Skipped ads are counted in `getStats().adsSkipped` and never returned from `getPosts()`.
5. Deduplicates by `id` (the numeric post id parsed from the permalink `/status/<id>` path). If the same post appears in a later tick, it is not appended again — the original entry (with its earlier `tickIndex`) stays. The duplicate hit is counted in `getStats().duplicateHits`.
6. For reposts (retweets), the article's outer "reposted by X" header sets `isRepost: true` and `repostedBy: "<handle>"`. The post body fields (author, text, metrics, media, postedAt) describe the original post, not the reposter.
7. For quoted posts, the inner quoted card is parsed into a nested `ExtractedPost` and attached as `quoted`. The outer post's `text` does NOT include the quoted post's text.
8. If any single field fails to parse (selector not found, unparseable number, missing permalink), the extractor records one `selectorFailures` stat entry with `{ field, postIdOrIndex, tickIndex, reason }` (kept in memory for feature 7 to serialize later), sets that field to `null` on the post, and still emits the post — partial data is better than silent drop. If the entire article fails (no permalink, no id), the whole article is dropped and counted as a selector failure with `field: "post"` .
9. Never throws. Every per-article evaluation is wrapped so one broken article cannot poison the loop. A full-page exception inside the `onTick` hook is allowed to propagate so the scroller's hook-error logging kicks in; it does not happen in normal operation because per-article errors are trapped first.
10. On scroll exit, the CLI reads `getStats()` and `getPosts().length` to print the post-extraction summary line. In `--dry-run`, the summary line reads `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped`.

Nothing about file writing, JSON serialization, or dedup-across-runs happens here. Those are features 7 (raw JSON writer) and 10 (state / cross-run dedup).

### Scenario: Extractor subscribes to the scroller's tick hook and collects posts per tick

Given the operator runs `pnpm scroll --minutes 3`
And the scroller invokes `runScroll({ onTick })` where `onTick` is the extractor's callback
When the scroller completes its first tick on `x.com/home`
Then the extractor queries the page for `article[data-testid="tweet"]`
And for each matching article, it evaluates an in-page function that reads the structured post fields
And each successfully parsed post is appended to the extractor's in-memory list
And `getPosts().length` reflects the number of unique posts seen so far
And the scroller's loop is not blocked — the hook awaits the extractor before the next pause, per feature 5's contract

### Scenario: Ads and promoted posts are skipped, never returned

Given the timeline contains a mix of posts and at least one promoted post
And the promoted article contains `[data-testid="placementTracking"]` or a visible `"Ad"`/`"Promoted"` label
When the extractor's tick hook runs
Then the promoted article is not parsed into an `ExtractedPost`
And `getStats().adsSkipped` is incremented for each skipped ad
And `getPosts()` never contains that article's content
(Vision principle: "zero ads" is part of the Phase 1 exit criteria. If an ad leaks through, feature 12's summary quality degrades immediately.)

### Scenario: Structured post shape is typed and complete

Given a non-ad, non-repost article on the feed from `@someone` that says "hello world" with 12 replies, 34 reposts, 560 likes, 7.2k views, one image, and a permalink `/someone/status/1234567890`
When the extractor parses that article
Then the resulting `ExtractedPost` has `id: "1234567890"`, `url: "https://x.com/someone/status/1234567890"`, `author.handle: "someone"`, `text: "hello world"`, `metrics: { replies: 12, reposts: 34, likes: 560, views: 7200 }`, `media: [{ type: "image", url: "<resolved image src>" }]`, `isRepost: false`, `repostedBy: null`, `quoted: null`
And `extractedAt` is an ISO 8601 timestamp
And `tickIndex` is the 0-indexed tick the post was first seen on
(Shape parity: this type is the input to feature 7's `raw.json` and feature 12's summarizer prompt. Locking it here prevents churn later.)

### Scenario: Metric strings like "1.2k" and "3.4M" are parsed into numbers

Given a post with `"1.2k replies"`, `"3.4M likes"`, `"560 views"`
When the extractor parses metrics
Then `replies` is `1200`, `likes` is `3400000`, `views` is `560`
And an unparseable metric string results in `null` for that field, not `0`, not a string, not a throw
(`null` vs `0` matters: zero is a real value the operator cares about ("noisy thread nobody engaged with"); unknown is a signal that the selector needs attention.)

### Scenario: Repost is marked with `isRepost` and `repostedBy`, body describes the original

Given an article on the feed where `@andrew` reposted a post originally by `@someone` that says "hello world"
When the extractor parses that article
Then the post has `isRepost: true`, `repostedBy: "andrew"`, `author.handle: "someone"`, `text: "hello world"`
And the post `id` / `url` point to the original post's permalink, not any reposter-specific URL
(Why: the summarizer's job is to notice voices worth paying attention to. The original author is the signal; the reposter is metadata.)

### Scenario: Quoted post is nested as an `ExtractedPost`, parent text does not contain quote body

Given a post by `@outer` that says "this is wild" and quotes a post by `@inner` that says "huge if true"
When the extractor parses that article
Then the outer post has `text: "this is wild"` and `quoted: <ExtractedPost for @inner>`
And `quoted.text` is `"huge if true"`
And `quoted.author.handle` is `"inner"`
And the outer `text` does NOT contain `"huge if true"`
(Clean separation: the summarizer needs the two texts distinguishable to decide whether the quote is the point or the top-level commentary is.)

### Scenario: Deduplication within a run by post id

Given the scroller has completed tick 3 and the extractor has already recorded a post with `id: "999"` at `tickIndex: 3`
When tick 5 re-renders the same post (still visible in the virtual timeline)
Then the extractor does NOT append a second entry for `id: "999"`
And `getStats().duplicateHits` is incremented by 1
And the original entry's `tickIndex` remains `3`, not `5`
(Rationale: X's virtualized timeline re-renders the same article repeatedly as the operator scrolls past and back. Recording every DOM instance would inflate post counts, confuse the summarizer, and waste bytes in `raw.json`.)

### Scenario: Selector failure on a single field degrades gracefully

Given an article that parses cleanly for every field EXCEPT the `views` metric (e.g., X has renamed the test-id for views)
When the extractor parses that article
Then the post is still emitted with `metrics.views: null`
And `getStats().selectorFailures` contains one entry with `{ field: "metrics.views", postIdOrIndex: "<id>", tickIndex: <N>, reason: "<short message>" }`
And no exception escapes the extractor
(Principle 7: fail gracefully, fail loudly. A single missing field must never drop the whole post; it must be visible in stats so the operator can see where the DOM has drifted.)

### Scenario: Article with no permalink or no id is dropped as a whole-post selector failure

Given an article in the DOM that has no `a[href*="/status/"]` descendant (e.g., a skeleton row or a malformed entry)
When the extractor attempts to parse it
Then no post is emitted
And `getStats().selectorFailures` contains one entry with `{ field: "post", postIdOrIndex: "<tickIndex-N>", tickIndex: <N>, reason: "no permalink" }`
And no exception escapes the extractor
(Without an id, deduplication is impossible and the post can't be referenced by the summarizer's output. Drop is correct.)

### Scenario: Per-article parse error is trapped; the scroll loop never dies

Given a single article throws during in-page evaluation (e.g., unexpected DOM shape causes a null dereference inside the page function)
When the extractor encounters that article
Then the error is caught in the per-article scope
And `getStats().selectorFailures` is incremented with `reason: "<error message>"`
And the remaining articles on that tick are still parsed
And `onTick` resolves without throwing
And the scroll loop continues per the scroller spec
(Per feature 5's tick-hook contract: a broken extractor logs each failure on its own line but does not kill the scroll. This spec makes that concrete at the per-article level.)

### Scenario: Tick hook is idempotent across rapid re-invocations

Given the scroller calls `onTick` twice in quick succession on the same tick index due to a timing re-entry (defensive case)
When the extractor runs
Then posts with ids already in the accumulator are not duplicated
And `getStats().postsExtracted` reflects unique posts, not invocation count
(Why: dedup is the source of truth. The accumulator is keyed on id; tick indices are metadata, not the dedup key.)

### Scenario: Final scroll summary line reports post and ad counts

Given the scroll completes its wall-clock budget
When the CLI builds the final summary line
Then it reads the extractor's `getPosts().length` (as `P`) and `getStats().adsSkipped` (as `A`)
And a non-dry run prints: `scroll complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped)`
And a dry run prints: `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped`
(This replaces the Phase 1 placeholder `— extractor not yet wired` line set by feature 5. Raw JSON writing — "saved to ..." — is feature 7.)

### Scenario: Selector constants live in one place so a contributor can patch DOM churn in one file

Given X changes the test-id for the post article from `tweet` to `post`
When a contributor patches the extractor
Then they edit one named constant (`POST_SELECTOR`, `AD_MARKER_SELECTORS`, `METRIC_SELECTORS`, `PERMALINK_SELECTOR`, `MEDIA_SELECTORS`) at the top of `extractor.ts`
And no selector strings appear inline inside loop bodies or helper functions
(Highest-risk Phase 1 item: selector churn is expected. One-file patch is the anti-frustration move.)

### Scenario: Extractor adds no new runtime dependencies

Given a contributor reviews `package.json` after this feature lands
When they inspect new runtime dependencies
Then no HTML parsing lib is added (cheerio, jsdom) — parsing happens via Playwright's `page.evaluate`
And no selector lib is added (css-what, postcss-selector-parser)
And no relative-time parser is added (dayjs, date-fns, moment) — `postedAt` is read directly from X's `<time datetime="...">` attribute as an ISO string, no parsing required
(Personal-tool simplicity. Playwright + Node is still the whole toolkit.)

### Scenario: Extractor is read-only; no `page.click`, no network writes

Given the extractor's tick hook is running
When it parses posts
Then the only page-level operations it uses are read-only: `page.$$` / `page.$$eval` / `page.evaluate`
And it performs no `page.click`, no `page.fill`, no `page.keyboard.type`, and initiates no XHR / fetch beyond what X itself runs
And no function in the extractor's public surface implies writes (no `react`, `like`, `follow`, `reply`)
(Principle 1: read-only, always. This is the same anti-persona guardrail feature 5 asserts for the scroll loop, restated at the extraction layer.)

### Scenario: `--dry-run` still runs the extractor in full

Given the operator runs `pnpm scroll --dry-run --minutes 2`
When the scroll loop runs
Then the extractor's tick hook fires on every tick exactly as in a normal run
And posts are accumulated in memory
And `getPosts()` returns the parsed list at the end
And no writer runs (feature 7 is skipped on dry-run per feature 3's contract)
And the final line reads: `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped`
(Dry-run means "scroll + extract, skip Claude + writer". This feature is the "extract" half of that contract.)

### Scenario: `postedAt` is read from the `<time>` element's `datetime` attribute, not the relative label

Given a post with a `<time datetime="2026-04-16T14:32:00.000Z">2h</time>` element
When the extractor parses the post
Then `postedAt` is `"2026-04-16T14:32:00.000Z"`
And the relative-time label `"2h"` is ignored
And if the `datetime` attribute is missing, `postedAt` is `null` and a selector failure is recorded with `field: "postedAt"`
(No relative-time parser needed; X always ships the absolute timestamp in the attribute. If the attribute disappears, that's a selector-failure signal, not a parsing problem.)

### Scenario: Empty feed tick yields no posts, no errors, no stats

Given a tick where `article[data-testid="tweet"]` matches zero elements (first tick on a slow-loading feed, or a network stall)
When the extractor runs
Then no posts are appended
And `getStats().selectorFailures` is NOT incremented (empty result is not a failure)
And `onTick` resolves without throwing
(Zero-matches is a legitimate transient state on `x.com/home`. Only actual parse errors count as failures.)

## User Journey

1. Operator has run `pnpm login` once (feature 4) and the scroller (feature 5) runs clean against their logged-in `x.com/home`.
2. They run `pnpm scroll` (or `pnpm scroll --minutes 3`). The scroller opens the persistent context as before.
3. **As each wheel tick lands, the extractor silently reads the posts currently rendered in the timeline, skips ads, dedups against posts it's already recorded, and accumulates a list in memory. The operator sees nothing new in the terminal during the scroll — same one startup line, same walk-away experience.**
4. When the wall-clock budget expires, the browser closes and the CLI prints: `scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped)`.
5. If the DOM has drifted and a field or whole post fails to parse, the selector failures sit in the extractor's stats. Feature 7 will serialize them into `raw.json` so the operator can `jq` them later. For now, the operator sees the `posts extracted` count drop below what they'd expect and knows to look at the DOM.
6. On a dry-run, the extractor runs in full; only feature 7's writer is skipped. The final line reads: `dry-run complete: 88 ticks over 120s — 56 posts extracted (3 ads skipped), writer skipped`.

The operator doesn't interact with the extractor directly — it's a silent subscriber to the tick hook. The only user-visible evidence is the updated summary line.

## CLI Mockup

Happy path (non-dry), extractor wired:

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  (browser opens on x.com/home; wheel ticks happen; extractor silently collects posts)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped)
$ echo $?
0
```

Dry-run, extractor wired:

```
$ pnpm scroll --dry-run --minutes 2
  scrolling x.com for 2m (persistent context: /Users/andrew/scrollproxy/chrome)
  dry-run complete: 88 ticks over 120s — 56 posts extracted (3 ads skipped), writer skipped
$ echo $?
0
```

Selector drift (X renamed a field — extractor still finishes):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped)
  (84 posts but all metrics.views are null — operator greps the raw JSON once feature 7 lands and sees the selector-failure entries)
$ echo $?
0
```

Session expired (unchanged from feature 5 — extractor never runs):

```
$ pnpm scroll
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  session expired — run pnpm login to refresh, then pnpm scroll
$ echo $?
1
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Writing `raw.json` to disk (feature 7).
- Cross-run deduplication via the 10k post-hash cache (feature 10). This feature dedups within a single run only.
- Rolling themes / cumulative intelligence (feature 11).
- Claude summarization (feature 12).
- Markdown output (feature 13).
- `--replay` handling (feature 14) — the extractor runs live only; replay reads a saved `raw.json` and skips extraction entirely.
- Thread / reply-chain reconstruction — each post is parsed as a standalone article. If X shows a thread inline, each visible post is extracted independently.
- Post translation or language detection — `text` is captured verbatim.
- Image OCR or video transcript — `media[]` contains URLs only.
- Vision-based fallback when selectors break (feature 22, Phase 3).
- Network interception of X's internal GraphQL — DOM parsing only, per the vision's "behave like a person reading" principle.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **post** (never "tweet"), **feed** (never "timeline"), **scroll** / **run** / **tick** / **extractor**, **session** only in "session expired" (the error the operator already reads from feature 5), **ad** / **promoted** (X's own label the operator sees), **selector** (the operator is technical and edits Playwright selectors when they break — vision says so). No "digest", no "engagement metrics" (used "metrics"), no "impression" (used "views" — X's own label). The error path says `posts extracted` and `ads skipped` — the same two words the operator would use describing what the tool should do.

Patience-level alignment:
- **Daily patience: Very Low.** The operator sees one startup line, one result line. The extractor adds no per-tick chatter, no progress bar, no "parsing..." spinner. A broken field silently sets `null` in memory; the operator notices by the post count, not by a scrolling error stream. This is deliberate: `/pnpm scroll` must stay walk-away-able.
- **Setup patience: High.** The operator is expected to grep `raw.json` (feature 7) and patch one named selector constant in `extractor.ts` when X renames a test-id. That's acceptable because patching one constant is the exact kind of fussy-config work they enjoy. It's the *daily* surface that has to stay terse.
- No "X extraction in progress" footer, no "post 43 of 128 parsed" counter. The operator should be able to start the scroll, walk to get coffee, and come back to a one-line summary with counts.

Anti-persona check: the scenarios block every shape of hosted / multi-user / write-action / analytics product the anti-persona would expect.
- **No analytics tracking across runs** — this feature's dedup is within a run only; cross-run history lives in feature 10's state module. The anti-persona's "engagement tracking over time" would need a totally different data model.
- **No write actions at the extraction layer** — a scenario explicitly forbids `page.click` / `page.fill` / `page.keyboard.type` inside the extractor. A contributor tempted to wire a "react to posts I like" button at the tick hook is blocked by the spec, not a code review afterthought.
- **No network interception / GraphQL scraping** — per the vision's "behave like a person reading" and "read-only, always" principles. DOM parsing only. Network interception would look like a scraper, not a reader.
- **Read-only, always** is re-asserted at this layer rather than deferred to feature 5.
- No HTML-parse lib, no relative-time parser, no selector lib. Personal-tool simplicity preserved — Playwright + Node is still the whole toolkit.

Frustrations addressed:
- **"Tools that hide what they're doing"** → the post and ad counts land in the final line. Stats are in memory for feature 7 to serialize. Every dropped post is visible as a selector-failure entry rather than a silent loss.
- **"Broken automation that fails silently"** → single-field drift degrades gracefully (`null`, stat entry); whole-post drift drops one post with a `field: "post"` stat entry; per-article exceptions never kill the loop. The operator sees "count is lower than expected", opens `raw.json` (feature 7), and sees exactly which fields and which posts drifted. One-file patch (`POST_SELECTOR` et al.) restores the run.
- **"Summarize by averaging everything into mush"** → this feature never averages. Metrics are per-post, typed as numbers or `null`. Reposts preserve the original author (the signal) and tag the reposter (the metadata). Quoted posts are nested, not concatenated. The summarizer (feature 12) receives clean, structured, unmerged data.
- **"Setup wizards, onboarding flows"** → extractor has no config, no prompts. It subscribes to the tick hook the operator already agreed to by running `pnpm scroll`.
- **"Opening X 'for one thing' and losing 45 minutes"** → the extractor adds no reason for the operator to linger on the scroll. The data they actually care about is captured for them; they never have to watch the scroll to "make sure it got that one post". The final line is the whole UX.

## Learnings

<!-- Updated via /compound after implementation -->
