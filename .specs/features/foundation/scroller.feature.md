---
feature: Scroller
domain: foundation
source: src/scroll/scroller.ts
tests:
  - tests/foundation/scroller.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-16
---

# Scroller

**Source File**: `src/scroll/scroller.ts`, `src/cli/scroll.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Human-like wheel scrolling of the X feed

The operator has run `pnpm login` once and has a logged-in Chromium profile on disk. They now run `pnpm scroll` (or `pnpm scroll --minutes 3`) and want the tool to act like a person reading the feed for a fixed number of minutes — opening the persistent browser, landing on `x.com/home`, pushing the mouse wheel in jittered increments with random pauses between ticks, and occasionally stopping for a longer stretch as if they actually read something. At the end of the budgeted minutes, the scroll cleanly stops and returns control. The extractor (feature 6) and raw JSON writer (feature 7) will later hook into this loop — this feature's whole job is getting a real, logged-in, human-paced scroll to happen against the real X home feed.

This feature ships the `runScroll()` function that:

1. Reads `browser.userDataDir`, `browser.viewport`, `browser.headless`, and the whole `scroll` block from config.
2. Launches Playwright's `chromium.launchPersistentContext(userDataDir, { headless, viewport })` against the same user-data dir the login command writes to.
3. Opens `https://x.com/home` in the first page.
4. Detects whether the operator is actually logged in (URL stays on `/home` vs. redirects to `/login` or `/i/flow/login`); if not, prints a one-line "session expired — run pnpm login" and exits `1` without scrolling.
5. Starts a wall-clock budget (`scroll.minutes` minutes, or `--minutes` override from the CLI).
6. Runs a scroll loop: each tick dispatches a mouse wheel scroll of a jittered pixel distance, then sleeps for a random duration in `[scroll.jitterMs[0], scroll.jitterMs[1]]`.
7. Every `scroll.longPauseEvery` ticks, sleeps for a random duration in `[scroll.longPauseMs[0], scroll.longPauseMs[1]]` instead of the normal jitter (simulating the operator actually reading).
8. Emits a tick-level callback/event so feature 6 (extractor) can plug in and inspect the DOM after each scroll without re-implementing the loop. This feature does not extract; it exposes the hook.
9. Stops cleanly when wall-clock budget expires (no mid-tick kill). Closes the context. Returns a `ScrollResult` describing how many ticks ran, how long it actually ran, and the final URL.
10. On `--dry-run`, runs the exact same loop and prints a short summary to stdout (`scrolled N ticks over Ms — extractor and writer skipped`). On a normal run, prints a minimal one-line progress summary ("scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)") and a final one-line summary on exit ("scroll complete: N ticks over Ms — extractor not yet wired" for Phase 1 until feature 6 lands).

Nothing about DOM extraction, ad detection, or JSON writing runs here. Those are features 6 and 7.

### Scenario: `pnpm scroll` launches the persistent context against the same user-data dir as login

Given a valid config with `browser.userDataDir: ~/scrollproxy/chrome` and `browser.headless: false`
And the operator has previously run `pnpm login` and the directory contains a logged-in Chromium profile
When the operator runs `pnpm scroll`
Then the scroll handler expands `~` to an absolute path
And calls `chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1280, height: 900 } })`
And opens `https://x.com/home` in the first page of the context
And prints one line to stdout: `scrolling x.com for <minutes>m (persistent context: <resolved userDataDir>)`
And the process remains alive until the scroll budget expires

### Scenario: `--minutes` flag overrides `scroll.minutes` from config

Given a config with `scroll.minutes: 10`
When the operator runs `pnpm scroll --minutes 3`
Then the scroll budget is 3 minutes, not 10
And the startup log reads `scrolling x.com for 3m (persistent context: ...)`
(The CLI already parses `--minutes` into a number 1..120 via feature 3. This feature just consumes the resolved value.)

### Scenario: `--minutes 0` is rejected upstream, not here

Given the operator runs `pnpm scroll --minutes 0`
When the CLI arg parser (feature 3) rejects the value
Then this feature never runs
(Guardrail: the scroller trusts its input. Bounds enforcement lives in the CLI arg parser and the config loader.)

### Scenario: Headless mode is honored from config

Given a config with `browser.headless: true`
When the operator runs `pnpm scroll`
Then the persistent context is launched with `headless: true`
And no visible browser window appears
(Unlike login, which refuses to run headless, the scroller accepts headless so automated/scheduled runs can work without a visible window. The operator opts into headless by editing config after login has written the profile.)

### Scenario: Session expired — land on login page instead of home

Given the operator's stored session cookie has expired
When the scroll handler navigates to `https://x.com/home`
And X redirects the page to `https://x.com/login` or `https://x.com/i/flow/login`
Then the handler detects the redirect by reading the final URL after `goto` settles
And prints: `session expired — run pnpm login to refresh, then pnpm scroll`
And closes the context cleanly
And exits with status `1`
And no scroll ticks occur
(Anti-frustration: scrolling an empty login page for 10 minutes would be the worst possible failure mode. The check runs before the scroll loop starts.)

### Scenario: Jittered wheel ticks with random pauses between them

Given a config with `scroll.jitterMs: [400, 1400]` and `scroll.longPauseEvery: 25`
When the scroll loop runs
Then each tick dispatches a mouse wheel scroll via `page.mouse.wheel(0, <jittered pixel delta>)`
And the pixel delta is a random integer in a human-plausible range (default: 400–1200 px per tick)
And after each tick (except long-pause ticks), the loop sleeps a random duration uniformly sampled from `[400, 1400]` ms
And the random numbers are drawn from a seedable source so tests can verify distributions
(Using `page.mouse.wheel` — not `window.scrollBy` — because X's virtualized timeline responds differently to user-gesture scrolls than to script-driven ones. This is what makes the scroll look human to the app.)

### Scenario: Long pause every N ticks simulates reading

Given a config with `scroll.longPauseEvery: 25` and `scroll.longPauseMs: [3000, 8000]`
When the scroll loop completes its 25th tick (and again at 50, 75, …)
Then instead of the normal jitter pause, the loop sleeps a random duration in `[3000, 8000]` ms
And the tick counter continues from there (no reset)
(The operator-persona pause: every ~25 wheel ticks, the real operator stops to read something. Scripted "scroll forever at fixed speed" is detectable and unhuman.)

### Scenario: Wall-clock budget terminates the loop cleanly

Given `scroll.minutes: 3`
When the scroll loop has been running for 180 seconds (wall clock)
Then the loop finishes the current tick's pause and exits before the next tick
And the context is closed via `context.close()`
And the process prints: `scroll complete: <N> ticks over <M>s — extractor not yet wired`
And the process exits `0`
(No mid-pause kill — the loop checks `Date.now() - start >= budget` between ticks. This keeps timing predictable and makes the final tick's extraction — once feature 6 lands — always complete.)

### Scenario: `--dry-run` still performs the real scroll loop

Given the operator runs `pnpm scroll --dry-run --minutes 2`
When the scroll handler runs
Then the persistent context is launched as normal
And the scroll loop runs for 2 minutes with real wheel ticks
And no extractor or writer runs (those features land in 6, 7, and later)
And the final line reads: `dry-run complete: <N> ticks over <M>s — extractor and writer skipped`
And the process exits `0`
(Reason: `--dry-run` means "scroll + extract only, skip Claude and writer" per feature 3's contract. In Phase 1, "extractor and writer skipped" is accurate because they don't exist yet. Once feature 6 lands, `--dry-run` will scroll + extract and skip the writer and summarizer.)

### Scenario: Tick hook exposes the page after each scroll without coupling to the extractor

Given feature 6 (extractor) will need to inspect the DOM after each scroll
When `runScroll()` is called with an optional `onTick` callback
Then after each wheel tick (and before the tick's post-tick pause), `onTick({ page, tickIndex, elapsedMs })` is awaited before the pause starts
And `tickIndex` is 0-indexed (first tick is `tickIndex: 0`)
And if `onTick` throws, the error is caught, logged as one line (`tick <N> hook error: <message>`), and the loop continues
And if no callback is provided, the loop runs unchanged
(This is the seam for feature 6. No extraction logic lives in the scroller; the extractor subscribes. Loud-not-silent: a broken extractor does not kill the scroll, but every failure is visible on stdout.)

### Scenario: Browser crash or `context.close` mid-scroll exits cleanly

Given the scroll loop is mid-way through a run
When Chromium crashes, the operator manually closes the window, or the context emits `close`
Then the loop detects the closed context on the next tick and stops
And the handler prints: `scroll ended early after <N> ticks (<reason>)` where reason is `browser closed` or the Playwright error message
And the process exits with status `1`
(Principle 3 from vision: "never lose scroll effort". The extractor and writer, once wired, will commit whatever they have on context close. This feature just exits cleanly.)

### Scenario: Playwright chromium binary not installed — one-line fix

Given Playwright's Chromium is not installed (first-time contributor forgot `pnpm exec playwright install chromium`)
When `pnpm scroll` is run
Then the Playwright error is caught
And stderr reads: `playwright chromium not installed — run: pnpm exec playwright install chromium`
And the process exits with status `1`
(Same anti-frustration pattern as the login command. One actionable line, no Node stack trace unless `DEBUG=scrollproxy` is set.)

### Scenario: User-data dir missing — operator hasn't logged in yet

Given `browser.userDataDir` points to a directory that does not exist
When `pnpm scroll` is run
Then the handler detects the missing dir before launching Playwright
And stderr reads: `no Chromium profile found at <userDataDir> — run pnpm login first`
And the process exits with status `1`
(Anti-frustration: launching Playwright against a nonexistent dir would create an empty profile and silently land on x.com/login, which would then trigger the "session expired" path. That's a lot of wasted seconds and a misleading error. Detect upfront.)

### Scenario: `--config <path>` is honored

Given a valid alternate config at `/tmp/alt-config.yaml` with a different `browser.userDataDir` and `scroll.minutes`
When the operator runs `pnpm scroll --config /tmp/alt-config.yaml`
Then the alt config is loaded via the existing CLI plumbing (feature 3)
And the scroll loop uses the alt config's values
(The CLI already threads `--config` through; this feature just consumes it.)

### Scenario: No write actions are performed on X

Given the scroll loop is running
When a tick occurs
Then the only page-level operations used are `page.goto('https://x.com/home')`, `page.url()`, `page.mouse.wheel(...)`, and DOM-read operations the tick hook may later perform
And no `page.click`, `page.fill`, `page.keyboard.type`, or any interaction that would post, like, reply, follow, or submit a form is ever invoked by this feature or its helpers
And the scroller's public API exposes no functions that imply writes (no `post`, `reply`, `like`, `follow` names)
(Principle 1 from vision: "Read-only, always". Anti-persona guardrail: this is the boundary the tool must not cross. A contributor who adds a `page.click` to a "reply" selector breaks a design principle, not just a feature.)

### Scenario: Only playwright is required as a new runtime dependency

Given a contributor reviews `package.json` after this feature lands
When they inspect new dependencies
Then no browser-automation alternative is added (puppeteer, selenium, webdriver-io, cypress)
And no human-input-simulation helper lib is added (the jitter is implemented inline — Math.random + sleep)
And no scheduling lib is added (setInterval/Timeout is enough for wall-clock budgeting)
(Principle: personal-tool simplicity. Playwright plus standard Node timers is the whole toolkit.)

## User Journey

1. Operator has run `pnpm login` once and has a logged-in Chromium profile in `~/scrollproxy/chrome` (feature 4).
2. They run `pnpm scroll` (defaults to `scroll.minutes` from config) or `pnpm scroll --minutes 3` for a quick test.
3. **The browser opens on x.com/home. The scroller runs for the budgeted minutes, mouse-wheel scrolling with jittered pauses and occasional long reads. The operator can watch or walk away.**
4. When the budget expires, the browser closes and the CLI prints `scroll complete: <N> ticks over <M>s — extractor not yet wired` (Phase 1) or, once feature 6 lands, the count of extracted posts.
5. If the session has expired (months later), the scroller lands on the login page, prints one line, and exits `1`. The operator re-runs `pnpm login` to refresh, then re-runs `pnpm scroll`.
6. If Chromium crashes, the operator closes the window, or the system goes to sleep mid-scroll, the scroller prints `scroll ended early after <N> ticks (<reason>)` and exits `1`. No data loss — once feature 7 is wired, partial raw JSON will be written by the writer's crash handler.

The operator runs `pnpm scroll` once per day — sometimes more if they want a mid-day check-in. That is the target frequency.

## CLI Mockup

Happy path (non-dry):

```
$ pnpm scroll --minutes 3
  scrolling x.com for 3m (persistent context: /Users/andrew/scrollproxy/chrome)
  (browser opens on x.com/home; wheel ticks happen; operator can watch or walk away)
  scroll complete: 132 ticks over 180s — extractor not yet wired
$ echo $?
0
```

Dry-run:

```
$ pnpm scroll --dry-run --minutes 2
  scrolling x.com for 2m (persistent context: /Users/andrew/scrollproxy/chrome)
  dry-run complete: 88 ticks over 120s — extractor and writer skipped
$ echo $?
0
```

Session expired:

```
$ pnpm scroll
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  session expired — run pnpm login to refresh, then pnpm scroll
$ echo $?
1
```

No Chromium profile yet:

```
$ pnpm scroll
  no Chromium profile found at /Users/andrew/scrollproxy/chrome — run pnpm login first
$ echo $?
1
```

Chromium binary missing:

```
$ pnpm scroll
  playwright chromium not installed — run: pnpm exec playwright install chromium
$ echo $?
1
```

Browser closed mid-scroll:

```
$ pnpm scroll --minutes 10
  scrolling x.com for 10m (persistent context: /Users/andrew/scrollproxy/chrome)
  (operator closes the browser window after ~4 minutes)
  scroll ended early after 167 ticks (browser closed)
$ echo $?
1
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- DOM extraction / post parsing (feature 6).
- Raw JSON writing (feature 7).
- Ad detection, skip rules, selector churn handling (feature 6 and eventually feature 22).
- Any summarizer or Claude interaction (feature 12).
- Markdown writing (feature 13).
- Dedup cache / rolling themes state (features 10, 11).
- Multi-tab or multi-account scrolling — one tab, one account, always.
- Smart "scroll until new posts stop appearing" logic — wall-clock budget only in v1.
- Scheduled / cron runs (Phase 3).
- Vision-based fallback when selectors break (feature 22).
- Replay of a recorded scroll (feature 14 owns `--replay`; this feature handles live scrolls only).

## Persona Revision Notes

Drafted in operator vocabulary throughout: **scroll**, **feed**, **run**, **posts**, **operator**, **login**, **session**. No "session duration" (used "minutes"), no "browsing session" (used "scroll"), no "authenticate" (used "login"). CLI labels and error messages name the files and commands the operator already edits and types — `pnpm login`, `~/scrollproxy/chrome`, `scroll.minutes`, `pnpm exec playwright install chromium`.

Patience-level alignment:
- **Daily patience: Very Low.** `pnpm scroll` is the daily-driver verb. Scenarios deliberately keep the output to one startup line and one result line — no progress bars, no per-tick chatter, no "fetching posts..." spinner. The operator should be able to start the scroll, walk to get coffee, and come back to a one-line summary.
- **Setup patience: High.** The fact that the operator has to run `pnpm login` separately before `pnpm scroll` ever works is acceptable — they'd rather have two clear verbs than one "smart" verb that guesses.
- Errors are single lines pointing to the exact fix: `run pnpm login`, `run: pnpm exec playwright install chromium`. This matches the login-command pattern established in feature 4.

Anti-persona check: the scenarios block every shape of hosted / multi-user / write-action product the anti-persona would expect. Only Playwright is added as a runtime dep (no scheduling lib, no headless-browser alternative, no human-input-simulation lib). Read-only is asserted as a scenario (`no click/fill/type`) rather than a footnote — the spec itself is the guardrail for contributors who might otherwise wire a "reply on my behalf" into the tick hook. Headless is *allowed* here (unlike login) because scheduled / background scrolls are a legitimate v1 use case for the same operator, not a hosted-product signal.

Frustrations addressed:
- **"Tools that hide what they're doing"** → startup line names the user-data dir, end line names the tick count and wall-clock duration. No hidden retries. No magic.
- **"Broken automation that fails silently"** → session-expired, missing-profile, missing-Chromium-binary, and mid-scroll browser-close all exit `1` with a one-line actionable message. The tick-hook error path logs each failure on its own line so a broken extractor is visible immediately, not masked.
- **"Opening X 'for one thing' and losing 45 minutes"** → the scroller replaces the behavior itself: fixed wall-clock budget, no interactive continuation, browser closes when the budget expires. No temptation to "just scroll a bit more".
- **"Setup wizards, onboarding flows"** → no prompts. If the session expired or the profile is missing, the tool tells the operator exactly which verb to run next.

## Learnings

### Interface Forward Compatibility for Pending Features

**Pattern:** The `dryRun` parameter was added to `ScrollOptions` interface for feature #15 (scheduled in Phase 2) but not used in current implementation. Kept in interface but not destructured in function signature to avoid TypeScript TS6133 unused variable error.

```typescript
// Interface: forward compatible
export interface ScrollOptions {
  dryRun: boolean;  // For feature #15, not used yet
  // ...
}

// Function: only destructure what's used now
export async function runScroll(options: ScrollOptions): Promise<ScrollResult> {
  const { userDataDir, headless, viewport, budgetMinutes, jitterMs, ... } = options;
  // dryRun NOT destructured — will be added when feature #15 lands
}
```

**Why:** Clean separation between interface definition (forward compatibility) and actual usage (current feature scope). Interface changes are cheap; adding parameters later requires no signature changes.

### Helper Extraction: Extract Till You Drop

**Applied:** Extracted 4 helper functions from `runScroll` to reduce complexity:
1. `calculatePauseDuration` — pause logic (normal vs long pause)
2. `invokeTickHook` — tick hook invocation with error handling
3. `initializeBrowserSession` — browser context setup + session validation
4. `MS_PER_MINUTE` constant — magic number elimination

**Stopped:** Further extraction of scroll loop body would require passing 6+ parameters (page, tickCount, startTime, budgetMs, rng, onTick) and increase complexity rather than reducing it.

**Principle:** Extract until each function has a single responsibility and is <30 lines. Stop when extraction creates more coupling than clarity.

### Spec Timing Precision for Async Callbacks

**Drift found:** Spec said `onTick` is awaited "after each wheel tick and its post-tick pause" but code invokes hook after wheel tick and BEFORE the pause (wheel → hook → pause, not wheel → pause → hook).

**Root cause:** Spec intent was "inspect DOM after scroll settles" but implementation chose to fire hook immediately after wheel so pause acts as natural debounce for next tick. The spec wording didn't precisely describe this ordering.

**Fixed:** Updated spec to explicitly document the sequence: "after each wheel tick (and before the tick's post-tick pause), `onTick({...})` is awaited before the pause starts".

**Learning:** For async operations with multiple steps, specs must be precise about order. "After X and Y" is ambiguous — does Y happen before or after callback? Use explicit sequence: "after X (and before Y), callback is awaited before Y starts".
