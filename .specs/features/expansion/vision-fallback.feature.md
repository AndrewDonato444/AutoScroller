---
feature: Vision Fallback
domain: expansion
source: src/extract/vision-fallback.ts
tests:
  - tests/expansion/vision-fallback.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# Vision Fallback

**Source File**: `src/extract/vision-fallback.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Claude-vision rescue of a run when the DOM extractor drops too many posts

The DOM extractor (feature 6) is the highest-risk Phase 1 component — X's DOM is adversarial and selectors drift. Today, when X renames a `data-testid` or restructures the timeline article, the operator sees the final line report a post count far below what a three-minute scroll should yield, tracks the breakage down via selector-failure entries in `raw.json`, and patches one named constant in `extractor.ts`. That patching loop is acceptable per the primary persona's high setup-patience — but only if the run isn't already lost. When a scroll lands with five posts instead of eighty, the operator has lost the scroll effort and the morning's signal in one shot, which violates principle 3 ("Never lose scroll effort") of the vision.

This feature adds a vision-based fallback: after every run, the extractor's stats are checked against a configured threshold. If the run looks broken — either the absolute post count is below a floor, or the selector-failure ratio is above a ceiling — the scroller's captured screenshots are fed to Claude's vision API, which reads each screenshot and returns structured posts matching the same `ExtractedPost` shape. These vision-extracted posts are merged into the extractor's accumulator (deduped by id when the permalink is legible, otherwise by a content hash), the run continues to feature 7's writer, and the markdown summary carries a visible banner that tells the operator this run was rescued by vision and the DOM extractor needs attention.

The vision fallback is never the primary path. DOM parsing is faster, cheaper, and preserves the vision's "behave like a person reading" posture. Vision is strictly a rescue. If the DOM extractor reports a healthy run, vision never runs — not as a cross-check, not as a "second opinion", not as a parallel pipeline. The vision fallback exists for one purpose: to keep the daily scroll producing signal on the day X ships a DOM change, so the operator isn't forced to drop what they're doing and patch selectors before morning reading.

This feature ships:

1. A screenshot capture hook wired into the scroller — every N ticks (default: 5), the scroller takes a full-timeline screenshot and stashes it in `~/scrollproxy/runs/<run-id>/screenshots/tick-<N>.png`. Screenshots are captured unconditionally during the scroll (cheap, local) but only sent to the vision API if the fallback triggers. If the run succeeds, the screenshots directory is deleted on writer exit so disk use stays bounded.
2. A `createVisionFallback({ config })` factory that exposes `shouldTrigger(stats, posts)` and `rescue({ runId, screenshots, existingPosts, existingStats })`. `shouldTrigger` returns `true` if the DOM extractor's stats cross the configured thresholds. `rescue` sends screenshots to Claude's vision API, parses the structured response into `ExtractedPost[]`, merges them with the DOM-extracted posts, and returns `{ posts, visionStats }`.
3. A `VisionStats` record — `{ screenshotsSent, visionPostsExtracted, visionPostsMerged, visionDuplicatesSkipped, apiCalls, apiErrors, costEstimateUsd }` — that is serialized into `raw.json` alongside the existing selector failures so the operator can audit exactly what the vision path added.
4. A config block under `extractor.visionFallback` in `config.yaml` — `{ enabled: boolean, minPosts: number, maxSelectorFailureRatio: number, screenshotEveryTicks: number, maxScreenshotsPerRun: number }` — validated by the existing Zod schema. Defaults: `enabled: true`, `minPosts: 20`, `maxSelectorFailureRatio: 0.3`, `screenshotEveryTicks: 5`, `maxScreenshotsPerRun: 24`.
5. A banner emitted by the markdown writer (feature 13) when `visionStats.visionPostsMerged > 0`: `⚠ This run was rescued by vision fallback — DOM extractor dropped posts; selectors likely drifted. See raw.json for selector failures.` Banner wording is fixed so the operator's eye learns to catch it.
6. A final CLI summary line that changes from `scroll complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped)` to `scroll complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), vision rescued <V> more` on a rescued run. `--dry-run` never calls the vision API; it only reports that a rescue *would* have triggered.
7. Hard budget enforcement: no more than `maxScreenshotsPerRun` screenshots are sent to Claude per run (default 24, covering ~24 ticks × ~8 visible posts = ~192 posts, which is well above the ~80–150 the DOM extractor produces on a healthy three-minute scroll). If a run somehow produces more screenshots, the oldest are dropped; the stat records the drop.

Nothing about altering the DOM extractor's selector constants happens here. The DOM extractor stays unchanged. The fallback sits alongside it, subscribes to the same run lifecycle, and takes over only when the DOM extractor has failed.

### Scenario: Healthy run — vision never runs, screenshots are cleaned up

Given the operator runs `pnpm scroll --minutes 3`
And the DOM extractor returns 84 posts with 6 ads skipped and 0 selector failures
When the run completes
Then `shouldTrigger(stats, posts)` returns `false`
And no screenshots are sent to the Claude vision API
And `visionStats.apiCalls` is `0`
And the `~/scrollproxy/runs/<run-id>/screenshots/` directory is deleted before the writer exits
And the final CLI line is the unchanged feature 6 shape: `scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped)`
(Why: vision is a rescue path, not a parallel path. A healthy DOM run pays zero API cost and leaves zero residual disk use. The operator should never be charged for a run that worked.)

### Scenario: Broken run — post count below floor triggers rescue

Given the operator runs `pnpm scroll --minutes 3`
And the DOM extractor returns 4 posts due to a renamed post `data-testid`
And `config.extractor.visionFallback.enabled` is `true` and `minPosts` is `20`
When the run completes and the fallback check runs
Then `shouldTrigger` returns `true` with reason `"postCountBelowFloor"`
And the vision fallback sends the captured screenshots to Claude's vision API
And vision returns 71 structured posts in the same `ExtractedPost` shape
And the merged post list contains 72 posts (1 DOM post overlap with vision, deduped by id)
And `visionStats.visionPostsMerged` is `71`
And the final CLI line reads: `scroll complete: 132 ticks over 180s — 4 posts extracted (6 ads skipped), vision rescued 71 more`
(Why: this is the primary rescue case — X renamed a selector, DOM extraction collapses, and the operator's morning summary is still produced. Without this, the scroll effort is lost and the operator must choose between fixing selectors or skipping the day.)

### Scenario: Broken run — selector failure ratio above ceiling triggers rescue

Given the DOM extractor returns 60 posts but 28 of them have at least one field-level selector failure
And `config.extractor.visionFallback.maxSelectorFailureRatio` is `0.3`
When the fallback check runs
Then `shouldTrigger` returns `true` with reason `"selectorFailureRatioAboveCeiling"`
And the vision fallback runs against the captured screenshots
And vision-extracted posts with cleaner field coverage take precedence on merge conflicts (vision post with full metrics wins over a DOM post with null fields for the same id)
(Why: a "60 posts, all with broken metrics" run is indistinguishable from a "DOM works fine" run by post count alone. Ratio-based triggering catches the case where X changed a field-level test-id without breaking the article selector.)

### Scenario: Fallback is disabled by config — degraded run is accepted as-is

Given `config.extractor.visionFallback.enabled` is `false`
And the DOM extractor returns 4 posts
When the run completes
Then `shouldTrigger` is never called
And no vision API calls are made
And the final CLI line reads: `scroll complete: 132 ticks over 180s — 4 posts extracted (6 ads skipped)` with no rescue suffix
And `raw.json` omits the `visionStats` block entirely (not even a zeroed record)
(Why: the operator must be able to turn this off. Some days they'd rather know the DOM is broken and fix it immediately than burn API credits to paper over it. Config, not a runtime prompt.)

### Scenario: `--dry-run` never calls the vision API, but reports whether rescue would have triggered

Given the operator runs `pnpm scroll --dry-run --minutes 2`
And the DOM extractor returns 3 posts (would trigger a rescue)
When the run completes
Then the vision fallback evaluates `shouldTrigger` as `true`
But no screenshots are sent to Claude
And no vision API calls are made
And the final CLI line reads: `dry-run complete: 88 ticks over 120s — 3 posts extracted (3 ads skipped), writer skipped (vision rescue would have triggered: postCountBelowFloor)`
(Dry-run's contract per feature 15: "scroll + extract, skip Claude + writer". Vision is Claude, so dry-run must skip it too. But reporting the *decision* is free and useful — the operator trying to debug a broken selector needs to see that the fallback would have kicked in.)

### Scenario: Screenshots are captured during the scroll at a configurable cadence

Given `config.extractor.visionFallback.screenshotEveryTicks` is `5`
And the scroll runs 132 ticks
When the scroller's tick hook fires
Then a full-timeline screenshot is saved on tick 0, 5, 10, ..., 130 (27 screenshots)
And each screenshot is written to `~/scrollproxy/runs/<run-id>/screenshots/tick-<N>.png` where `<N>` is the zero-padded tick index
And screenshot capture adds less than 200ms per tick (operator-visible latency check)
And the scroll loop is not blocked waiting for disk writes — captures run in the background with a bounded concurrency of 2
(Why: screenshots must be captured eagerly because the timeline is virtualized — tick 12's content is gone by tick 15. They must be captured cheaply because a healthy run should pay as little as possible for a path it never uses.)

### Scenario: Screenshot budget is enforced — oldest dropped if over cap

Given `config.extractor.visionFallback.maxScreenshotsPerRun` is `24`
And the scroller produces 27 screenshots over the scroll
When the fallback rescue runs
Then only 24 screenshots are sent to the Claude vision API
And the 3 oldest are dropped
And `visionStats.screenshotsDropped` is `3`
And the dropped files are deleted from disk before the writer exits
(Why: vision API cost scales linearly with images and Claude charges per image. A hard budget protects the operator from a runaway run. Keeping the newest screenshots biases toward the end of the feed, which the operator hadn't seen before, over the top which they may have seen yesterday.)

### Scenario: Vision-extracted posts match the `ExtractedPost` shape exactly

Given the vision API returns structured JSON for the posts in a screenshot
When the fallback parses the response
Then each post is shaped as the feature 6 `ExtractedPost` type: `id`, `url`, `author: {handle, displayName, verified}`, `text`, `postedAt`, `metrics: {replies, reposts, likes, views}`, `media: [{type, url}]`, `isRepost`, `repostedBy`, `quoted`, `extractedAt`, `tickIndex`
And any field that vision cannot read from the screenshot is set to `null`, not omitted, not a string, not `0`
And `extractedAt` is the ISO timestamp the vision API call completed
And `tickIndex` is the tick of the screenshot the post was seen in (not the scroll's final tick index)
(Shape parity with feature 6 is non-negotiable: raw.json, the state cache (feature 10), and the summarizer (feature 12) all consume `ExtractedPost[]`. A vision post that is shaped differently would require a parallel pipeline downstream, which is exactly what the anti-persona check forbids.)

### Scenario: Vision posts are deduped against DOM posts by id, then by content hash

Given the DOM extractor captured post `id: "999"` at tick 3
And vision also extracts that same post from the tick-5 screenshot
When the merge runs
Then the vision version is dropped as a duplicate
And `visionStats.visionDuplicatesSkipped` is incremented by 1
And the merged post list contains the DOM version, not the vision version
And if a vision post has no legible permalink, dedup falls back to a content hash of `"<handle>|<text>"` against the DOM accumulator
(Why: the DOM extractor, when it works on a post, produces cleaner, more reliable data than a vision read of the same pixels. Dedup priority goes to DOM. The content-hash fallback handles the case where vision can read the post text but not the permalink's numeric id.)

### Scenario: Vision posts fill fields the DOM extractor left null — same-id merge is field-wise

Given the DOM extractor captured post `id: "999"` with `metrics.views: null` due to a selector drift on the views button
And vision extracts the same post from a screenshot with `metrics.views: 5400`
When the merge runs on the same id
Then the merged post has `metrics.views: 5400`
And other DOM fields are preserved (`metrics.replies`, `author.handle`, `text` stay from the DOM version)
And the merge is a field-wise fill-null, not a blind vision override
(Why: this is the "60 posts with broken metrics" rescue path. DOM provides structure; vision fills holes. A blind vision override would throw away the cleaner DOM fields for the ones it did parse correctly.)

### Scenario: Vision API failure is fail-loud but does not throw

Given the Claude vision API returns a 5xx error or times out after the configured retry budget
When the fallback runs
Then `visionStats.apiErrors` is incremented with `{ screenshotPath, errorMessage, attempt }`
And the posts the DOM extractor did capture are still emitted unchanged
And the markdown writer's banner instead reads: `⚠ Vision fallback was triggered but failed (see visionStats.apiErrors in raw.json) — DOM extractor selectors likely need patching.`
And the final CLI line reads: `scroll complete: 132 ticks over 180s — 4 posts extracted (6 ads skipped), vision rescue failed (see raw.json)`
And the exit code is still `0` (the run produced what it could; the writer still runs)
(Principle 3: never lose scroll effort. Principle 7: fail gracefully, fail loudly. A vision failure is not a scroll failure — the operator keeps what the DOM extractor got, and they learn immediately that vision didn't save them so they must patch selectors themselves.)

### Scenario: Vision API cost is estimated and recorded per run

Given the vision fallback sent 18 screenshots to Claude
And the configured model is `claude-sonnet-4-6` (Claude Sonnet 4.6)
When the fallback completes
Then `visionStats.costEstimateUsd` is populated using the public per-image and per-token rates for that model
And the estimate is a number rounded to 4 decimal places, not a string
And the estimate is visible in `raw.json` under `visionStats`
And the markdown banner does NOT include the cost (operator can `jq` it if they want; the banner stays short)
(Why: the operator keeps their own data and their own API keys — cost visibility is their concern, not a dashboard's. An in-file number they can grep later is the right fit for the primary persona's style. Costs in the banner would add daily chatter the persona's very-low daily patience doesn't tolerate.)

### Scenario: Screenshots are deleted on writer exit, whether or not rescue ran

Given the scroll has produced 27 screenshot files on disk
When the writer (feature 7) has finished writing `raw.json`
Then the `~/scrollproxy/runs/<run-id>/screenshots/` directory is removed
And `raw.json` does not contain file paths to those screenshots (they're gone)
And `raw.json` does contain the `visionStats` block if the fallback ran, or no `visionStats` block if it did not
And if the writer itself crashes, the screenshots are still cleaned up on next scroll startup via a "stale screenshots" sweep in the CLI entry (feature 3 territory, honored here by the vision fallback not adding any file that would survive a crash)
(Why: screenshots are an internal implementation detail of the rescue path, not an output the operator consumes. `~/scrollproxy/runs/` is the operator's folder; keeping `.png`s in it would clutter the one place they do browse. Disk use stays bounded regardless of run outcome.)

### Scenario: Vision fallback uses the existing Claude client — no new SDK

Given a contributor reviews `package.json` after this feature lands
When they inspect new runtime dependencies
Then no new image-handling library is added (sharp, jimp, image-size)
And no new Anthropic SDK version is added (the existing `@anthropic-ai/sdk` already handles multimodal input per feature 12)
And no screenshot library beyond Playwright's built-in `page.screenshot()` is added
(Personal-tool simplicity per the primary persona. Playwright's `page.screenshot()` returns a Buffer that can be base64-encoded inline on the Claude API call. Existing client, existing API key.)

### Scenario: Vision prompt instructs Claude to return strict JSON matching `ExtractedPost`

Given the fallback sends a screenshot to Claude
When it constructs the prompt
Then the prompt includes the exact TypeScript type definition of `ExtractedPost` (inlined in the vision module)
And the prompt requires a JSON array response, one object per visible post, matching that shape
And the prompt instructs Claude to skip promoted posts and ads (matching feature 6's skip rules)
And the response is parsed with `JSON.parse` and checked to be an array; parse failures or non-array responses throw and are caught and recorded as `apiErrors`, not silently accepted
(Why: downstream consumers (raw.json writer, state dedup, summarizer) trust the shape. Parse-boundary error recording at the vision layer prevents a malformed response from poisoning the accumulator. The prompt's inlined type definition keeps Claude aligned with the DOM path's expected shape; deeper per-field validation is currently left to downstream consumers.)

### Scenario: Vision fallback is read-only — no `page.click`, no write actions inferred from the screenshot

Given the vision API returns structured JSON for posts
When the merge runs
Then no action is taken that would interact with the page (no click, no keyboard, no fill)
And no field in `ExtractedPost` or `VisionStats` implies a write operation (no `react`, `like`, `follow`, `reply`)
And the vision prompt does NOT ask Claude to identify "posts worth replying to" or "accounts worth following" — only to extract the same structured data the DOM extractor would
(Principle 1: read-only, always. A vision-capable agent inside a browser is a tempting place to add "while you're there, could you also..." features. Blocking this at the spec level prevents anti-persona creep. See `.specs/personas/anti-persona.md` — hosted/write-action products are out of scope permanently, not "not yet".)

### Scenario: Thresholds are config-driven — no hardcoded "broken-run" definitions

Given an operator wants to tune the fallback to only trigger when the post count is below 10, not 20
When they edit `config.yaml` to set `extractor.visionFallback.minPosts: 10`
And they run `pnpm scroll`
Then the fallback uses `10` as the floor
And a run with 15 posts does NOT trigger the fallback
And if the operator sets `enabled: false`, the fallback is skipped regardless of thresholds
(Why: the primary persona edits YAML happily. They are the one person who knows what a "broken run" looks like on their feed. A hardcoded threshold would force them into the code; a config field fits their setup-patience posture.)

### Scenario: Vision fallback never runs on an empty/stalled first tick

Given the DOM extractor returns 0 posts because the feed never loaded (network stall, session expired)
And `getStats().selectorFailures` is also 0 (the articles never rendered)
When the fallback check runs
Then `shouldTrigger` returns `false`
And no vision API call is made
And the final CLI line reflects the empty run: `scroll complete: 0 ticks over 3s — 0 posts extracted (0 ads skipped)` or the session-expired line from feature 5
(Why: an empty run is not a DOM-drift rescue case — it's a connectivity / auth case. Burning API credits on empty screenshots would be wasteful. The trigger requires *some* evidence of a scroll (ticks > 0) AND low extraction to be considered a drift.)

### Scenario: Only one rescue attempt per run — no retry loop on marginal rescues

Given the DOM extractor returned 4 posts and the fallback triggered
And the vision rescue itself only returned 6 additional posts
When the fallback completes
Then the merged list is accepted at 10 posts
And the fallback does NOT re-trigger itself on the merged list
And `visionStats.apiCalls` reflects only the one rescue pass
(Why: preventing infinite / recursive rescue loops. If the rescue itself was weak — perhaps screenshots were blurry — the operator sees a rescued banner with a low count and knows to investigate. They would rather see an honest count than a second round of API calls chasing a bad situation.)

## User Journey

1. Operator has been running `pnpm scroll` daily for weeks. DOM extractor has been healthy — average run lands ~80 posts, ~5 ads skipped, 0 selector failures.
2. One morning, X ships a DOM change that renames the post article's test-id from `tweet` to `post`.
3. Operator runs `pnpm scroll` as usual.
4. The scroller captures screenshots every 5 ticks in the background (as it has on every run — the operator never noticed, the capture is sub-200ms per tick).
5. The DOM extractor finds zero matches for the old `POST_SELECTOR`. Returns 0 posts.
6. **The fallback's `shouldTrigger` returns `true` with reason `postCountBelowFloor`. The screenshots are sent to Claude's vision API. Claude returns 78 structured posts. Those are merged into the (empty) DOM accumulator. `raw.json` carries them as usual.**
7. Writer produces the markdown summary with a banner: `⚠ This run was rescued by vision fallback — DOM extractor dropped posts; selectors likely drifted. See raw.json for selector failures.`
8. Final CLI line: `scroll complete: 132 ticks over 180s — 0 posts extracted (6 ads skipped), vision rescued 78 more`.
9. Operator reads the summary as usual. Signal is preserved. They see the banner and know they need to patch `POST_SELECTOR` at their convenience — today, tonight, or tomorrow morning. The tool bought them time.
10. Next run, after the operator has patched `POST_SELECTOR`, the DOM extractor works again and vision does not run.

The operator never interacts with the fallback directly. It is a silent rescue subscriber to the run lifecycle. The only user-visible evidence is the banner in the markdown and the `vision rescued <V> more` suffix on the final CLI line.

## CLI Mockup

Healthy run (fallback does not trigger — unchanged from feature 6):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 84 posts extracted (6 ads skipped)
$ echo $?
0
```

Broken run — rescue succeeds:

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 0 posts extracted (6 ads skipped), vision rescued 78 more
$ echo $?
0
```

Broken run — rescue fails (vision API 5xx):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 4 posts extracted (6 ads skipped), vision rescue failed (see raw.json)
$ echo $?
0
```

Dry-run — rescue would have triggered but no API call made:

```
$ pnpm scroll --dry-run --minutes 2
  scrolling x.com for 2m (persistent context: /Users/andrew/scrollproxy/chrome)
  dry-run complete: 88 ticks over 120s — 3 posts extracted (3 ads skipped), writer skipped (vision rescue would have triggered: postCountBelowFloor)
$ echo $?
0
```

Fallback disabled by config:

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  scroll complete: 132 ticks over 180s — 4 posts extracted (6 ads skipped)
$ echo $?
0
```

## Raw JSON Excerpt (shape illustration)

```json
{
  "runId": "2026-04-17T09-00-00Z",
  "ticks": 132,
  "durationMs": 180012,
  "adsSkipped": 6,
  "selectorFailures": [ ... ],
  "posts": [ ... ],
  "visionStats": {
    "screenshotsSent": 18,
    "screenshotsDropped": 0,
    "visionPostsExtracted": 82,
    "visionPostsMerged": 78,
    "visionDuplicatesSkipped": 4,
    "apiCalls": 18,
    "apiErrors": [],
    "costEstimateUsd": 0.1248,
    "triggerReason": "postCountBelowFloor"
  }
}
```

(No `visionStats` block appears if the fallback was disabled or never triggered.)

## Config Block (additions to config.yaml)

```yaml
extractor:
  visionFallback:
    enabled: true
    minPosts: 20
    maxSelectorFailureRatio: 0.3
    screenshotEveryTicks: 5
    maxScreenshotsPerRun: 24
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Modifying the DOM extractor's selector constants. Selector churn is still patched in `extractor.ts`; the fallback only rescues runs, it does not heal the DOM extractor.
- Running the vision fallback as a parallel / second-opinion pipeline on healthy runs. Vision is strictly a rescue path.
- OCR / transcript extraction from post media (images and videos). The vision API reads the post's rendered structure; it does not transcribe image content or videos.
- Learning from vision extractions to auto-patch DOM selectors. That would be a separate feature and is out of scope for the persona's "edit one named constant" workflow.
- Network interception of X's internal GraphQL as an alternative rescue path. Per principle 4 ("human-like automation"), screenshots are the legitimate-looking rescue path; XHR interception would look like a scraper.
- Streaming the vision API response. Batch JSON response is simpler and the operator already waits for feature 12's summarizer; the rescue fits inside that wait window.
- Cost alerting / hard cost caps in USD. The `maxScreenshotsPerRun` is the cost cap; a separate USD cap would add config surface without value for a single-user tool.
- Dashboard / admin surface for vision stats. `raw.json` + `jq` is the operator's "dashboard".
- Auto-tuning `minPosts` from run history. The operator edits YAML; that's the contract.
- Running vision during `--replay` (feature 14). Replay reads a saved `raw.json`; it does not re-screenshot and does not re-rescue. If the original run was rescued, the replay sees the already-merged posts.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **scroll** / **run** / **tick** / **extractor**, **selectors** (the operator is explicitly the kind of person who patches Playwright selectors — the primary persona says so verbatim), **fallback** / **rescue** (matches the failure-mode framing the operator already uses internally: "my run was broken, what rescued it?"), **vision** (the operator knows Claude has a vision mode — no need to euphemize it). No "OCR", no "multimodal extraction", no "image intelligence". No "digest" (used "summary"). No "quota" (used "budget", per the operator's preference for concrete over abstract).

Patience-level alignment:
- **Daily patience: Very Low.** The fallback adds exactly one token to the final CLI line on a rescued run (`, vision rescued <V> more`) and one banner line to the markdown. On a healthy run, it adds nothing — no "fallback armed", no "screenshots captured", no "considering rescue" messages. The operator sees the same one startup line, the same walk-away experience.
- **Setup patience: High.** The config block adds five fields the operator can tune. `enabled: true` is the default, but an operator who wants to force selector fixes instead of papering over them flips it to `false` and the fallback never runs. Thresholds are numeric, not enums — the operator is trusted to pick values.
- The `costEstimateUsd` field is in `raw.json`, not the banner and not the CLI line. The operator can `jq '.visionStats.costEstimateUsd' raw.json` if they want to see it. Daily UX stays terse.

Anti-persona check: the scenarios block every shape of hosted / multi-user / write-action / analytics product the anti-persona would expect.
- **No hosted fallback service.** The vision API calls go from the operator's machine to Claude directly using the operator's existing API key (feature 12's key). No ScrollProxy server, no relay, no rate limiting tier.
- **No write actions inferred from the vision read.** A scenario explicitly forbids a prompt that asks Claude to identify "posts worth replying to" or "accounts to follow". The vision's job is extraction, not recommendation-for-interaction. A contributor tempted to add "while you're in the screenshot, also suggest replies" is blocked by the spec, not code review.
- **No analytics across runs.** The fallback's stats live in the run's `raw.json`. There is no cross-run vision-stats file, no "vision was needed N times this week" metric. That's cumulative intelligence the operator can assemble with `jq` across their `runs/` folder if they want, but the tool does not bake it in.
- **No OAuth, no account, no dashboard.** The feature adds five config fields and one banner. No onboarding change.
- **Read-only at the vision layer too** — the existing read-only invariant is re-asserted here so the "vision can see, therefore vision can act" drift is pre-blocked.
- **No new runtime deps.** A scenario asserts no new image lib, no new Anthropic SDK, no new screenshot lib beyond Playwright's built-in. Personal-tool simplicity preserved.

Frustrations addressed:
- **"Tools that hide what they're doing"** → the rescue banner is explicit: "this run was rescued by vision fallback — DOM extractor dropped posts; selectors likely drifted". The operator reads their summary knowing whether it came from the normal path or the rescue path. `raw.json` has full `visionStats` for audit.
- **"Broken automation that fails silently"** → when X ships a DOM change, today the operator sees "3 posts extracted" and may not notice at a glance that it's broken. With this feature, the rescued run produces a summary AND a banner, so the operator sees both the signal they need for the morning AND the signal that the code needs attention. If the vision API also fails, the CLI line and banner both say "vision rescue failed — selectors likely need patching".
- **"Summarize by averaging everything into mush"** → vision posts are merged into the same typed `ExtractedPost` shape, deduped by id, field-filled only where DOM left `null`. The summarizer (feature 12) gets clean structured data, not a blended soup of DOM and vision text.
- **"Setup wizards, onboarding flows"** → the feature ships enabled by default with sensible thresholds. Operators who want to tune it edit five fields in `config.yaml`.
- **"Opening X 'for one thing' and losing 45 minutes"** → this feature strengthens the walk-away contract. On the one morning X ships a breaking DOM change, the operator's daily summary still lands. They don't have to open X themselves while they debug selectors.
- **"Never lose scroll effort" (principle 3)** → this is the feature's central purpose. The scroll happened; the screenshots were captured; even if the DOM parse collapsed, the operator still gets their summary.

## Learnings

<!-- Updated via /compound after implementation -->
