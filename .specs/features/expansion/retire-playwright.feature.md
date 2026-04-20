---
feature: Retire Playwright Source Layer
domain: expansion
source:
  - src/cli/scroll.ts
  - src/cli/index.ts
  - src/cli/args.ts
  - src/config/schema.ts
  - src/config/load.ts
  - src/types/post.ts
  - src/lib/expandHomeDir.ts
  - src/writer/raw-json.ts
  - src/writer/writer.ts
  - src/writer/markdown.ts
  - package.json
tests:
  - tests/expansion/retire-playwright.test.ts
  - tests/foundation/cli-entry.test.ts
  - tests/foundation/config-loader.test.ts
  - tests/foundation/project-scaffold.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-20
updated: 2026-04-20
---

# Retire Playwright Source Layer

**Source Files**: `src/cli/scroll.ts`, `src/cli/index.ts`, `src/cli/args.ts`, `src/config/schema.ts`, `src/types/post.ts` (new)
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: `pnpm scroll` stops launching Chrome — the X API source becomes the only path

The X API migration shipped its source layer (AutoScroller `cf477ad`) and pre-production hardening (`91eb3d9`). The x-api path is validated end-to-end against live X, carries full test coverage, and produces summary output indistinguishable from the Playwright path on downstream quality. The Playwright path is now dead weight: a 10-minute wall-clock scroll loop producing the same content as a 660-millisecond API pull, carrying a Chrome process that pops up on the operator's desktop every run, fragile DOM selectors that break whenever X ships a UI change, and a login flow that requires the operator to log into X through a headful browser session. This feature retires it.

Vision principle 1 — **"Ruthless editor."** — is the load-bearing principle here. The operator preference the tool is built around is keeping what earns its keep and cutting what doesn't. Playwright earned its keep for the first three months of ScrollProxy's existence because there was no viable alternative; X API pricing made scraping the only affordable read path. The 2026-04-20 Owned Reads pricing change ended that constraint. Keeping Playwright around as a "fallback" now means keeping a dependency whose only value is the scenario we'd never run anyway (operator deliberately opts into the slow, fragile path). Delete it.

Vision principle 3 — **"Invisible until called."** — is the reason Chrome popping up is not a UX quirk to tolerate but an anti-feature. The operator does not want a browser window opening on their screen every 6 hours. The Playwright path launches Chrome unconditionally (via `ensureChromeRunning` in `scroll.ts`) whenever a scroll is invoked, whether or not the operator is at the computer. Removing the path removes the pop-up. There is no second-best outcome on this — either Chrome launches or it doesn't; there is no in-between.

Vision principle 5 — **"Operator trust."** — shapes what this feature does NOT delete. Replay functionality (`src/cli/replay.ts`, `src/replay.ts`, and `tests/foundation/replay.test.ts`) operates on stored `raw.json` files, is source-agnostic, and remains useful for re-summarizing historical runs — kept. Dedup cache, rolling-themes store, trend detector, writers, and the summarizer all work on `ExtractedPost[]` regardless of which source produced the posts — kept. The `ExtractedPost` interface itself and its supporting types (`Author`, `Metrics`, `MediaItem`) relocate to a permanent home under `src/types/post.ts` — same shape, same semantics, just a home that isn't "the extract module we're deleting."

This feature ships four coordinated changes:

1. **Delete the Playwright source layer and its tests.** Removes `src/scroll/scroller.ts`, `src/extract/extractor.ts`, `src/extract/vision-fallback.ts`, `src/cli/login.ts`, `src/login.ts`, and `scripts/launch-chrome.sh`. Removes the corresponding test files: `tests/foundation/scroller.test.ts`, `tests/foundation/extractor.test.ts`, `tests/foundation/login.test.ts`, `tests/expansion/vision-fallback.test.ts`, and the Playwright-specific test cases inside `tests/foundation/scroll-handler.test.ts` and `tests/foundation/cli-entry.test.ts` (the `UT-CLI-001` "persistent context" assertion that was a pre-existing failure against the old handleScroll startup line). Removes the `playwright` dependency from `package.json`. Removes the `pnpm login` and `pnpm chrome` scripts.

2. **Collapse the dispatch in `src/cli/scroll.ts`.** The current `handleScroll` has a dispatch at the top (`if (flags.source === 'x-api') return handleScrollXApi(...)`), then the long Playwright body, then `handleScrollXApi` defined separately. Collapse to one function: the body of `handleScrollXApi` becomes the body of `handleScroll`. Drop the `source` field from `ScrollFlags`, drop `minutes` (the x-api path never consulted it), drop the `ScrollSource` type. The `--source` and `--minutes` CLI flags go away — `--source` becomes an unknown flag (error), and `--minutes` similarly. Remove the `-api` suffix from new run IDs: with Playwright gone, distinguishing "which source produced this run" is no longer meaningful; existing runs keep their suffixed directory names but new runs produce clean IDs.

3. **Relocate `ExtractedPost` + supporting types.** Create `src/types/post.ts` containing `ExtractedPost`, `Author`, `Metrics`, `MediaItem`, and `SelectorFailure` interfaces — copied verbatim from `src/extract/extractor.ts` (minus all the Playwright-era selector constants and helper functions). Update every import across the codebase: `src/cli/replay.ts`, `src/cli/scroll.ts`, `src/sources/xListAdapter.ts`, `src/sources/xListSource.ts`, `src/state/dedup-cache.ts`, `src/summarizer/summarizer.ts`, `src/writer/raw-json.ts`, `src/xTestSource.ts`. The `SelectorFailure` type is no longer referenced anywhere after the extractor deletes; it comes along to `src/types/post.ts` only if a downstream consumer still uses it, otherwise dropped.

4. **Soften the config schema.** `config.yaml` in `~/scrollproxy/` currently has populated `scroll:`, `browser:`, and `extractor:` blocks from the pre-migration era. Update `src/config/schema.ts` to make those three sections optional (`.optional()` on each top-level key) so an operator's existing config loads cleanly without editing. The fields are accepted but unused; a future "remove vestigial config fields" pass can clean them out of YAML. This is the same non-breaking posture the migration has used throughout — existing config files keep working, new config files don't need the dead sections.

### Scenario: `pnpm scroll` pulls from the X API without launching Chrome
Given the operator has a populated `config.yaml` with `x.lists` populated and fresh tokens in `.env.local`
And no Chrome process is running on port 9222
When the operator runs `pnpm scroll` (no flags)
Then no Chrome process is launched
And the scroll pulls posts from the configured X lists
And a new run directory is created at `runs/{runId}/` (no `-api` suffix)
And `summary.md`, `summary.json`, and `raw.json` are written
And the run exits with code 0

### Scenario: `pnpm scroll --dry-run` preserves dry-run semantics
Given the same setup as above
When the operator runs `pnpm scroll --dry-run`
Then the scroll pulls posts from the configured X lists
And NO run directory is created
And the summarizer is NOT invoked
And the operator sees a summary line with per-list counts and "(dry-run — skipping write + summarize)"
And the run exits with code 0

### Scenario: `pnpm scroll --source playwright` is rejected as an unknown flag
Given Playwright has been retired
When the operator runs `pnpm scroll --source playwright`
Then the CLI exits non-zero with an "unknown flag" error
And the error message references `--help` for usage

### Scenario: `pnpm login` command no longer exists
Given Playwright has been retired
When the operator runs `pnpm login`
Then the npm-script either doesn't exist in `package.json` or fails
And if the script exists as a stub, it prints a deprecation message and exits non-zero
(Acceptable implementation: delete the `login` npm-script entirely — `pnpm login` then falls through to pnpm's built-in login command, which is unrelated to ScrollProxy. The tool itself has no login verb.)

### Scenario: `pnpm chrome` script is gone
Given Playwright has been retired
When the operator runs `pnpm chrome`
Then the npm-script is not defined in `package.json`
And `scripts/launch-chrome.sh` no longer exists in the repo

### Scenario: No Playwright code remains in `src/`
Given Playwright has been retired
When any `.ts` file under `src/` is inspected
Then none of them import from `'playwright'`
And no file under `src/scroll/` or `src/extract/` exists (both directories are deleted)

### Scenario: Playwright is not a dependency
Given Playwright has been retired
When `package.json` is inspected
Then `playwright` is not listed in `dependencies` or `devDependencies`
And no `package-lock` / `pnpm-lock` entry pins a playwright version

### Scenario: `ExtractedPost` is importable from its new home
Given the `ExtractedPost` type has relocated to `src/types/post.ts`
When any downstream file (writer, summarizer, state, source) imports `ExtractedPost`
Then the import path is `'../types/post.js'` (relative to the importer's depth)
And the type shape is byte-identical to the pre-move definition
And no file imports `ExtractedPost` from `src/extract/extractor.ts` (which no longer exists)

### Scenario: Existing `config.yaml` with vestigial sections loads cleanly
Given a `config.yaml` that still contains the old `scroll:`, `browser:`, and `extractor:` blocks
When the config loader parses it
Then validation succeeds
And the fields are accessible on the parsed `Config` object (as optional, possibly undefined)
And no "unknown field" error is raised

### Scenario: Downstream pipeline tests still pass
Given Playwright-specific tests have been deleted
And all remaining tests use the relocated `ExtractedPost` import
When `pnpm test` runs
Then all non-Playwright test files pass
And no test is orphaned by an import that no longer resolves

## Non-goals (explicit)

- **Deleting `replay.ts`** — replay reads stored `raw.json`, source-agnostic, useful for re-summarizing historical runs. Stays.
- **Rewriting `DOC-034` (ScrollProxy tech spec) body** — separate follow-up; handled in SecondBrain repo, not AutoScroller.
- **Updating `profile.md` ScrollProxy entry** — same, SecondBrain follow-up.
- **Archiving `migration-2026-04-x-api.md`** — same, SecondBrain follow-up.
- **Stripping the vestigial `scroll:`, `browser:`, `extractor:` sections from `config.yaml`** — the schema goes optional in this spec so the file still loads; editing the file's contents is a separate, trivially safe follow-up once everyone has verified the new shape.
- **Removing the `-api` suffix from already-produced run directory names** — existing run dirs keep their names (they're already processed; renaming would break references in summarized history). New runs use suffix-free IDs.
- **Refactoring `src/xTestSource.ts` or `src/xExplore.ts`** — those utility scripts remain useful after the Playwright retirement. They import `ExtractedPost` and just need their import path updated.
- **Investigating what scheduler is firing ScrollProxy every 6h** — separate discovery task, tracked in the migration doc.

## Test plan

New test file `tests/expansion/retire-playwright.test.ts` covers the regression-guard scenarios that don't belong to any existing behavioral test suite:

- **RP-01** — No `.ts` file under `src/` imports from `'playwright'`.
- **RP-02** — The directories `src/scroll/` and `src/extract/` do not exist.
- **RP-03** — `package.json` has no `playwright` in `dependencies` or `devDependencies`; no `login` or `chrome` script.
- **RP-04** — `src/types/post.ts` exports `ExtractedPost`, `Author`, `Metrics`, `MediaItem` with correct shapes.
- **RP-05** — No file imports `ExtractedPost` from the old `src/extract/extractor.ts` path.
- **RP-06** — Config loader accepts a `config.yaml` with populated `scroll:` + `browser:` + `extractor:` sections (backward-compat).
- **RP-07** — Config loader accepts a `config.yaml` with NONE of those sections (forward-clean).
- **RP-08** — New run IDs generated during an x-api run do NOT contain the `-api` suffix.

Existing tests that need updating:

- `tests/foundation/cli-entry.test.ts` — the `UT-CLI-001` "persistent context" assertion becomes irrelevant (the Playwright startup line is deleted); rewrite to assert the x-api startup line format, or delete the case if redundant with `RP-01`.
- `tests/foundation/scroll-handler.test.ts` — if any cases exercise the Playwright branch of `handleScroll`, delete or rewrite against the unified handler.

Existing tests that get deleted entirely:

- `tests/foundation/scroller.test.ts`
- `tests/foundation/extractor.test.ts`
- `tests/foundation/login.test.ts`
- `tests/expansion/vision-fallback.test.ts`

## Self-check drift prompts

When implementation lands, verify:

- Every file previously importing `ExtractedPost` from `'../extract/extractor.js'` or similar now imports from the new path. One grep. Zero stragglers.
- The x-api run ID no longer ends in `-api`. Look at the newest run directory name after a test invocation.
- `pnpm test` passes with no orphaned imports, no missing-module errors.
- `package.json` is visually clean of Playwright references — not just programmatically asserted absent.
- The `~/scrollproxy/config.yaml` file on the operator's disk still loads (manually run `pnpm scroll --dry-run` and confirm it parses).
- The deletion was TOTAL — no residual references in comments, error messages, or CLI help text that mention Chrome, Playwright, or "browser session." Grep for `playwright`, `chrome`, `browser session`, `CDP` across src/ after landing.

## Learnings

**Type-only shim patterns outlive their primary consumers.** `VisionStats` and `SelectorFailure` were both defined alongside the Playwright extractor, consumed by writers and raw-json serialization downstream. Deleting the extractor deleted the original definitions; the writers still carried optional typed references to those shapes. Rather than ripple-delete every `visionStats?: VisionStats` in the writer interfaces (which would have touched 6+ files and every test that constructed a mock `WriteContext`), we defined `type VisionStats = Record<string, never>` as a local no-op in each writer file. Same shape never actually appears at runtime post-retirement; every downstream consumer that optionally typed against it still compiles. Pragmatic when killing a feature whose type was spread thin across infrastructure — preserves compatibility at the type layer while the runtime forgets it exists.

**Relocating types is the cheapest deletion refactor.** The hardest part of deleting `src/extract/extractor.ts` wasn't the Playwright-specific extraction code — that had one caller (the scroll handler, also being deleted). It was the `ExtractedPost` + supporting interfaces that eight downstream files imported. Moving those types to `src/types/post.ts` as a single Write + bulk sed across 10 import sites landed the deletion without touching any downstream semantics. Lesson: when a module is being retired but carries types consumed elsewhere, relocate the types first as a non-behavioral PR, then delete the module cleanly. Trying to delete the module while downstream imports still point at it creates a thicket.

**Backward-compat via `.optional()` beats breaking config schemas.** The operator's `config.yaml` had populated `scroll:`, `browser:`, and `extractor:` sections that are now vestigial. Softening the zod schema with `.optional()` on each top-level block meant zero breakage: existing configs keep loading, new configs don't need the dead sections, and the schema documents what's retired without forcing synchronized disk edits. The cost is a few `config.browser?.userDataDir` guards where access was previously unconditional — a small, honest tax for a migration-safe move. The alternative (strict deletion + operator-side YAML edit) would have worked but with zero safety net if we missed a consumer.

**Test suites accumulate pre-existing failures that only surface during retirement.** The `cli-entry.test.ts` UT-CLI-001 case was failing against the Playwright startup line before this feature landed — flagged at commit time, verified via stash-and-retest as pre-existing, marked out of scope for the hardening feature. Retiring Playwright forced the question: the test was asserting against a line that no longer exists in any code path. Deleting the case as part of this feature was the right call — trying to preserve a test that couldn't describe any real behavior would have been pure ceremony. Watch for the pattern: a test that was failing against dead code is a signal the code was dead before the test was, and the right fix is deletion, not "update the assertion."

