---
feature: Markdown Writer
domain: foundation
source: src/writer/markdown.ts
tests:
  - tests/foundation/markdown-writer.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# Markdown Writer

**Source File**: `src/writer/markdown.ts` (new), wired into `src/cli/scroll.ts` and `src/cli/replay.ts`
**Design System**: N/A (CLI tool — the "mockup" is the rendered `summary.md` text)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Render `summary.json` into a human-readable `summary.md` the operator actually opens

The operator's Phase 2 happy path now produces `raw.json` (feature 7), a dedup cache (feature 10), a rolling themes store (feature 11), and `summary.json` from Claude (feature 12). Every artifact on disk is machine-readable. None of it is the file the operator opens in the morning. This feature is the thing they actually read: a single `summary.md` under `~/scrollproxy/runs/<runId>/` that renders the Claude summary into a terse, scannable document — themes at the top, worth-clicking posts with one-sentence "why" and a real `x.com` link, voices to keep reading, a noise count, and footer links back to `raw.json` and `summary.json` for when the summary looks off. After this feature lands, the operator's daily ritual is: run `pnpm scroll`, wait, `open ~/scrollproxy/runs/<runId>/summary.md`, click 0–3 links, close the file, done.

The operator's persona is **Very Low patience for daily use**. That constraint drives every decision here. No HTML, no frontmatter the operator has to skim past, no "Executive Summary" preamble, no polite transitions. Themes are a bulleted list. Worth-clicking is a numbered list with the author, the link, and one sentence. Voices is one line per handle. Noise is one line total. The whole file fits on a laptop screen for a typical run; if it doesn't, the summarizer (feature 12) is the one who failed the "ruthless editor" contract, not this renderer.

Vision principle 2 — **"Signal over completeness"** — shows up as what this feature refuses to render. It does not render a timeline of posts, engagement metrics, post bodies, or Claude's internal reasoning. `summary.json` already made those calls; the markdown is a loyal rendering of that verdict, not a second pass at editorializing. If `summary.json` says `feedVerdict: "noise"` with zero `worthClicking`, the markdown says exactly that — it does not invent filler content.

Vision principle 3 — **"Never lose scroll effort"** — shows up in the failure modes. If `summary.json` is missing (because feature 12 wrote `summary.error.json` instead), the markdown writer is not called, no `summary.md` is written, and downstream readers see the `summary.error.json` as the authoritative signal that today's run has no renderable summary. If `summary.json` exists but has an unexpected `schemaVersion`, the writer fails loudly with a clear error and does NOT write a partial or corrupt `summary.md`. A missing markdown file is recoverable (the operator can `--replay` the run once feature 14 lands); a silently wrong markdown file would erode trust in the tool and send the operator back to opening the X app.

This feature ships the **markdown writer only** — not `--replay`'s full CLI surface (feature 14), not `--dry-run`'s skip contract (feature 15), not the pluggable `Writer` interface (feature 20). It exports a pure function that takes a `RunSummary` plus a small `MarkdownContext` and returns a markdown string, plus a file-writing helper (`writeSummaryMarkdown`) that writes it atomically next to `summary.json`. The scroll CLI calls it on the happy path after `summary.json` is written; `--replay` will call it against a saved run when feature 14 arrives.

This feature ships a `src/writer/markdown.ts` module that:

1. Exports `renderSummaryMarkdown(summary: RunSummary, context: MarkdownContext): string`. Pure function — no I/O, no `Date.now()`, no env reads. `MarkdownContext` is `{ rawJsonPath: string; summaryJsonPath: string; displayRawJsonPath?: string; displaySummaryJsonPath?: string }`. The `display*Path` fields are `~`-compressed paths for human readability in the footer; the canonical fields are absolute paths used when a caller needs to resolve the file. Passing only the absolute paths is valid — the renderer falls back to them when the display variants are absent.
2. Exports `writeSummaryMarkdown(params: { runDir: string; summary: RunSummary; rawJsonPath: string; summaryJsonPath?: string }): Promise<{ summaryMdPath: string }>`. Writes `<runDir>/summary.md` atomically (tmpfile → rename), same contract as feature 7's `writeRawJson` and feature 12's `summary.json` write. `summaryJsonPath` defaults to `join(runDir, 'summary.json')` when omitted.
3. Renders exactly this top-level structure, in this order, for every run:
   ```
   # ScrollProxy — <YYYY-MM-DD> <HH:MM UTC>

   **Verdict**: <signal | mixed | noise> · **New**: <newCount> · **Seen**: <seenCount> · **Model**: <model>

   ## Themes

   - <theme 1>
   - <theme 2>
   ...

   ## Worth clicking

   1. [@author](url) — <why>
   2. [@author](url) — <why>
   ...

   ## Voices

   - **@handle** — <why>
   - **@handle** — <why>
   ...

   ## Noise

   <count> posts skimmed as noise — <example 1>, <example 2>, <example 3>.

   ---

   Raw posts: `<displayRawJsonPath>`
   Summary JSON: `<displaySummaryJsonPath>`
   ```
   The header date/time is derived from `summary.summarizedAt` parsed as UTC and formatted `YYYY-MM-DD HH:MM UTC` — no locale-dependent output, no millisecond noise. The operator's vocabulary is used throughout: "Verdict" (not "rating"), "Worth clicking" (not "Recommended"), "Voices" (not "Top accounts"), "Noise" (not "Filtered"), "Raw posts" (not "Source data").
4. Handles empty sections by rendering a one-line placeholder in the operator's vocabulary, not an empty heading. Specific placeholders:
   - Empty `themes` (not allowed by `summary.json` schema — 3–7 required — but render-safe): `_(no themes — summarizer returned an empty list)_`
   - Empty `worthClicking`: `_Nothing worth clicking this run._`
   - Empty `voices`: `_No standout voices this run._`
   - Empty `noise` (`count === 0`): `No noise flagged.` (no italics — this is a success state, not a gap)
5. Formats `Worth clicking` entries as a numbered list (`1.`, `2.`, ...). Each entry is exactly one line: `N. [@author](url) — why`. The author always starts with `@`; if `summary.worthClicking[i].author` already starts with `@`, it is used as-is; if not, `@` is prepended. The link text is the author (not the URL), so the operator sees a clean `@handle — why` line and the URL is only visible on hover / when rendered. `why` is used verbatim — the renderer does not truncate, reword, or append punctuation.
6. Formats `Voices` entries as a bulleted list, each `- **@handle** — why`. Same `@` normalization as `worthClicking`. Bold is used for the handle because this section has no link (voices are a curation signal, not a link list).
7. Formats `Noise` as a single line: `<count> posts skimmed as noise — <examples joined by ", ">.` When `noise.examples` is empty but `noise.count > 0`, renders `<count> posts skimmed as noise.` (period, no examples). When `noise.count === 0`, renders `No noise flagged.` (see point 4).
8. Escapes nothing in `why` fields by default. `summary.json` content comes from Claude via a typed tool-use schema (feature 12), not from untrusted user input. If a `why` contains a character that would break markdown rendering (e.g. backticks in code snippets), it renders as-is — the operator's markdown viewer handles it. The renderer does NOT HTML-escape or markdown-escape. Vision principle 8 — "Personal tool simplicity" — wins over defensive escaping here.
9. The footer paths are single-backtick-wrapped, one per line, not in a code block. The operator's markdown viewer should render them copy-pasteable without a scroll bar. Absolute paths only when `displayRawJsonPath` / `displaySummaryJsonPath` are absent; otherwise the `~`-compressed versions. The footer is separated from the body by a `---` horizontal rule.
10. `writeSummaryMarkdown` writes `<runDir>/summary.md.tmp` then atomically renames to `<runDir>/summary.md`. Same atomic pattern as feature 7. On a crash between write and rename, `summary.md` does NOT exist (the `.tmp` remains). The output file ends with a single trailing newline, no BOM, UTF-8 encoding.
11. Is called from `src/cli/scroll.ts` on the happy path **after** `writeSummaryJson` succeeds. The CLI passes the full `RunSummary` plus the absolute paths to `raw.json` and `summary.json`. The CLI's summary line gains ` — rendered to <displaySummaryMdPath>` appended to the existing happy-path line. On markdown-writer failure (permissions, disk full, unknown `schemaVersion`), the CLI catches the error, logs `markdown render failed: <reason>` on a second line, and exits 1 — but `summary.json` and `raw.json` stay intact. The themes store is NOT rolled back; feature 12 already committed it, and a failed markdown render does not invalidate Claude's themes.
12. Rejects unknown `schemaVersion` values by throwing a typed error: `throw new Error('markdown_writer: unsupported schemaVersion <n>, expected 1')`. Future schema versions will be handled by adding a renderer fork, not by rendering a v1 template against v2 data. This matches feature 12's schema-version discipline.
13. Is NOT called on `--dry-run`. Feature 15 owns the end-to-end skip contract; dry-run's promise is "no writes, no API calls", and the markdown writer is a write.
14. Is NOT called when `summarizeRun` returned `{ status: 'error' }`. The CLI already wrote `summary.error.json` in that branch; there is no `summary.json` to render from, and `summary.error.json` is not input for this renderer. The operator's mental model is: `summary.md` present ⇔ `summary.json` present ⇔ run has a real summary.
15. Adds zero runtime dependencies. Node's `fs/promises` and `path` are enough. No templating library, no `marked`, no `remark`. The output format is stable enough to hand-render with string concatenation and a couple of `map`/`join` calls. Personal-tool simplicity.

The module does not know about Claude, the summarizer internals, the scroller/extractor, or the rolling-themes store. It produces a markdown string from a typed summary and writes it to disk; everything upstream is the CLI's concern.

### Scenario: Happy-path scroll — `summary.md` is written next to `raw.json` and `summary.json`

Given a scroll completes successfully and feature 12 wrote `<runDir>/summary.json` with `feedVerdict: "mixed"`, 5 themes, 3 worth-clicking items, 2 voices, and `noise: { count: 42, examples: ["reply-guy politics", "crypto shilling", "vague motivational quotes"] }`
And `config.output.dir` is `~/scrollproxy/runs`
When the scroll CLI calls `writeSummaryMarkdown` after `writeSummaryJson` succeeds
Then the file `<runDir>/summary.md` exists
And the file's first line is `# ScrollProxy — 2026-04-17 09:12 UTC` (derived from `summary.summarizedAt`)
And the file contains the `## Themes`, `## Worth clicking`, `## Voices`, and `## Noise` sections in that order
And the footer has `Raw posts: \`~/scrollproxy/runs/<runId>/raw.json\`` and `Summary JSON: \`~/scrollproxy/runs/<runId>/summary.json\``
And the scroll CLI's summary line ends with ` — rendered to ~/scrollproxy/runs/<runId>/summary.md`
And `pnpm scroll` exits 0
(This is the file the operator opens. Every other artifact exists to make this one good.)

### Scenario: Worth-clicking entries render with author, real link, and one-sentence why — no marketing speak

Given a `summary.json` with `worthClicking: [{ postId: "1780123456789012345", url: "https://x.com/someone/status/1780123456789012345", author: "@someone", why: "Concrete pattern for state sharing between agents — worth reading, not just bookmarking." }]`
When `renderSummaryMarkdown` renders the worth-clicking section
Then the rendered section contains exactly `1. [@someone](https://x.com/someone/status/1780123456789012345) — Concrete pattern for state sharing between agents — worth reading, not just bookmarking.`
And the section does NOT contain the string `postId`, `engagement`, `trending`, or `recommended`
And the link text is `@someone` (not the raw URL)
And `why` is rendered verbatim, including em-dashes, with no truncation
(Persona vocabulary: "worth clicking" not "recommended". The operator's job is to click or not click; `postId` is a debugging detail that belongs in `raw.json`, not the summary they read at 9am.)

### Scenario: Author handle without `@` prefix is normalized

Given a `summary.json` with `worthClicking[0].author: "someone"` (no `@` prefix — should not happen per feature 12's schema, but render-safe)
When the markdown renders that entry
Then the output line starts with `1. [@someone](...)` — the `@` is prepended exactly once
And a `voices` entry with `handle: "@someoneelse"` renders as `- **@someoneelse** — ...` (no double `@`)
(Defensive normalization so the operator always sees consistent `@handle` formatting, regardless of upstream formatting drift.)

### Scenario: Empty worth-clicking and empty voices render terse placeholders, not empty headings

Given a `summary.json` with `worthClicking: []` and `voices: []` (a quiet feed)
When the markdown renders
Then the `## Worth clicking` section body is exactly `_Nothing worth clicking this run._`
And the `## Voices` section body is exactly `_No standout voices this run._`
And neither section is omitted (the headings still appear in the same order, so the file structure is stable across runs)
And the operator can grep across their run history for `Nothing worth clicking this run` to see how often the feed was empty
(Structural stability matters for an operator who greps. Missing sections would make `grep -c "## Worth clicking"` lie.)

### Scenario: Noise section reads like a human sentence, not a data dump

Given a `summary.json` with `noise: { count: 42, examples: ["reply-guy politics", "crypto shilling", "vague motivational quotes"] }`
When the markdown renders the noise section
Then the section body is exactly `42 posts skimmed as noise — reply-guy politics, crypto shilling, vague motivational quotes.`
And the examples are joined with `, ` (comma + space), not bullets or newlines
And the sentence ends with a period
Given a second scenario where `noise.examples` is empty but `noise.count === 7`
Then the body is exactly `7 posts skimmed as noise.` (period, no trailing em-dash or examples list)
Given a third scenario where `noise.count === 0`
Then the body is exactly `No noise flagged.` (no italics — this is a success state)
(Persona vocabulary: "Noise" not "Filtered". A single sentence is all the operator reads; a bulleted list of examples would make them feel the tool is padding.)

### Scenario: Header timestamp is derived from `summarizedAt` in UTC, not the local clock

Given a `summary.json` with `summarizedAt: "2026-04-17T09:12:48.000Z"`
And the machine's local timezone is `America/Los_Angeles` (UTC-7)
When the markdown renders
Then the header line is `# ScrollProxy — 2026-04-17 09:12 UTC` (UTC, not local time)
And the header does not contain `PST`, `PDT`, or any offset string
And two operators on different timezones rendering the same `summary.json` would produce byte-identical `summary.md` files
(Deterministic output: the rendered file is a function of `summary.json`, not the machine. That matters for `--replay` and for the operator who expects `diff <yesterday's summary.md> <today's>` to show content changes, not timezone changes.)

### Scenario: Footer uses `~`-compressed paths when display variants are provided

Given `context.rawJsonPath` is `/Users/andrew/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`
And `context.displayRawJsonPath` is `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`
And `context.summaryJsonPath` and `context.displaySummaryJsonPath` are set similarly
When the markdown renders
Then the footer reads `Raw posts: \`~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json\`` (backtick-wrapped, `~`-compressed)
And `Summary JSON: \`~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json\``
Given a second scenario where only the absolute paths are passed (no `display*` fields)
Then the footer renders the absolute paths instead (`/Users/andrew/...`)
(The footer is a handoff from "here's what Claude said" to "here's where the raw data is". `~` is what the operator types in their shell; absolute paths are a fallback for when the caller hasn't pre-compressed.)

### Scenario: Atomic write — a crash mid-write never leaves a corrupt `summary.md`

Given `summary.json` exists and `writeSummaryMarkdown` is called
When the process is killed between the tmpfile write and the rename
Then `<runDir>/summary.md.tmp` exists (possibly partial)
And `<runDir>/summary.md` does NOT exist
And a subsequent read of `<runDir>/summary.md` fails with ENOENT (the operator sees a missing file, not a truncated one)
(Same atomicity contract as feature 7's `raw.json` and feature 12's `summary.json`. A missing file is recoverable via `--replay` (feature 14); a half-written one would confuse the operator into thinking the summary was just terse.)

### Scenario: Unknown schemaVersion throws a clear error — no partial render

Given a `summary.json` on disk from a future version with `schemaVersion: 2`
When the markdown writer is called with that summary
Then `renderSummaryMarkdown` throws `Error: markdown_writer: unsupported schemaVersion 2, expected 1`
And `<runDir>/summary.md` is NOT written (and `.tmp` is cleaned up or absent)
And the scroll CLI catches the error, logs `markdown render failed: markdown_writer: unsupported schemaVersion 2, expected 1`, and exits 1
And `summary.json` and `raw.json` remain intact
(Version mismatches happen when an operator rolls the binary back but keeps state forward. Failing loudly with the expected version is the "fail gracefully, fail loudly" principle — no silent corruption, no "close enough" render.)

### Scenario: `summary.error.json` present instead of `summary.json` — markdown writer is not called

Given the summarizer returned `{ status: 'error', reason: 'rate_limited' }` and the CLI wrote `<runDir>/summary.error.json`
And `<runDir>/summary.json` does NOT exist
When the scroll CLI reaches the markdown-writer step
Then `writeSummaryMarkdown` is NOT called
And `<runDir>/summary.md` is NOT written
And the scroll CLI's error-path summary line (from feature 12) is unchanged: `... — summarizer failed: rate_limited — saved to ...`
And `pnpm scroll` exits 1 (unchanged from feature 12's contract)
(The operator's mental model: `summary.md` present ⇔ `summary.json` present. Never render `summary.error.json` into markdown — the error file is for forensic grep, not morning reading.)

### Scenario: `--dry-run` skips the markdown writer entirely

Given the operator runs `pnpm scroll --minutes 3 --dry-run`
When the scroll completes
Then `writeSummaryMarkdown` is NOT called
And no `summary.md` is written
And the scroll summary line reads `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped` (unchanged from features 6 and 12)
(Dry-run promise: "no writes, no API calls". The markdown writer is a write; feature 15 owns the end-to-end contract; this feature honors it today.)

### Scenario: Output is deterministic — same `summary.json` renders byte-identical `summary.md`

Given two invocations of `renderSummaryMarkdown` with the same `RunSummary` and `MarkdownContext`
When both outputs are compared byte-for-byte
Then the outputs are identical
And no timestamp, hostname, or env-derived string leaks into the rendered file
And `sha256sum` of the two outputs is the same
(Determinism is what makes `--replay` (feature 14) trustworthy. If the renderer read `Date.now()` or `process.env.USER`, replaying yesterday's run would silently mutate the `summary.md` and the operator's `diff` habit would start producing noise.)

### Scenario: No runtime dependencies added — the renderer is string concatenation

Given a freshly cloned repo with `node_modules` reinstalled
When the operator runs `pnpm list --depth 0 | grep -E '(marked|remark|unified|mdast)'`
Then the command returns no results
And `package.json` has the same dependency count as before this feature (zero new runtime deps)
(Personal-tool simplicity. The markdown format is stable string concatenation; a templating library would be dead weight and a supply-chain surface for a single-user local CLI.)

## User Journey

1. Operator runs `pnpm scroll` in the morning (or cron fires it overnight).
2. Scroller scrolls x.com/home; extractor collects posts; `raw.json` is written; dedup cache updates.
3. Summarizer (feature 12) calls Claude and writes `summary.json`; themes store updates.
4. **Markdown writer runs**: renders `summary.json` into `summary.md` under the same run directory.
5. Scroll CLI's final line reports `— rendered to ~/scrollproxy/runs/<runId>/summary.md`.
6. Operator runs `open ~/scrollproxy/runs/<runId>/summary.md` (or clicks the terminal hyperlink).
7. Operator reads themes (10 seconds), scans worth-clicking (30 seconds), clicks 0–3 links, closes the file.
8. Operator goes back to building. Total feed-consumption time: under 2 minutes.

## UI Mockup

ScrollProxy is a CLI tool — no UI tokens. The operator's "UI" is the rendered `summary.md` in whatever markdown viewer they use (iA Writer, Obsidian, Typora, GitHub preview, or plain `cat`).

### `summary.md` — happy-path render (a mixed day)

```
# ScrollProxy — 2026-04-17 09:12 UTC

**Verdict**: mixed · **New**: 38 · **Seen**: 46 · **Model**: claude-sonnet-4-6

## Themes

- agent orchestration patterns
- indie-dev distribution
- sales enablement tooling
- distributed training tricks
- sports-betting odds math

## Worth clicking

1. [@someone](https://x.com/someone/status/1780123456789012345) — Concrete pattern for state sharing between agents — worth reading, not just bookmarking.
2. [@devgrinder](https://x.com/devgrinder/status/1780123456789099999) — Teardown of a mid-market GTM motion that actually shipped revenue.
3. [@oddsnerd](https://x.com/oddsnerd/status/1780123456789022222) — Clean derivation of a closing-line value edge the operator has been chasing.

## Voices

- **@smalleraccount** — Three deep cuts on AI product strategy this run — keep reading.
- **@pragmabuilder** — Consistent signal on distribution tactics for one-person shops.

## Noise

42 posts skimmed as noise — reply-guy politics, crypto shilling, vague motivational quotes.

---

Raw posts: `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`
Summary JSON: `~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json`
```

### `summary.md` — empty-feed render (the rare "nothing today" day)

```
# ScrollProxy — 2026-04-17 09:12 UTC

**Verdict**: noise · **New**: 22 · **Seen**: 58 · **Model**: claude-sonnet-4-6

## Themes

- recycled politics discourse
- generic AI hype
- crypto shilling

## Worth clicking

_Nothing worth clicking this run._

## Voices

_No standout voices this run._

## Noise

74 posts skimmed as noise — reply-guy politics, crypto shilling, vague motivational quotes.

---

Raw posts: `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`
Summary JSON: `~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json`
```

### Terminal output on happy-path scroll (one line extended by this feature)

```
$ pnpm scroll --minutes 10
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
scroll complete: 184 ticks over 603s — 84 posts extracted (6 ads skipped) — 38 new, 46 already seen — summarized (5 themes, 3 worth clicking) — saved to ~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json — rendered to ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md
$
```

### Terminal output when markdown render fails (rare — disk full / permissions)

```
$ pnpm scroll --minutes 10
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
scroll complete: 184 ticks over 603s — 84 posts extracted (6 ads skipped) — 38 new, 46 already seen — summarized (5 themes, 3 worth clicking) — saved to ~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json
markdown render failed: ENOSPC: no space left on device, rename '...summary.md.tmp' -> '...summary.md'
$ echo $?
1
```

## Component References

N/A — CLI tool, no UI components.

## Learnings

<!-- Updated via /compound -->

### Display Path Pattern for User-Facing Output

**Pattern:** Writer functions receive both absolute paths (for file operations) and optional `display*` paths (~-compressed) for user-facing output.

```typescript
export interface MarkdownContext {
  rawJsonPath: string;           // Absolute: /Users/.../raw.json
  summaryJsonPath: string;        // Absolute: /Users/.../summary.json
  displayRawJsonPath?: string;   // Display: ~/scrollproxy/runs/.../raw.json
  displaySummaryJsonPath?: string;
}

// Render uses display paths when available, falls back to absolute
const rawPath = context.displayRawJsonPath || context.rawJsonPath;
```

**Why:** CLI layer does the tilde compression once; writer doesn't need to know about `expandHomeDir`. The absolute paths are used for file operations, display paths for footer rendering. Clean separation of concerns.

**Where applied:** `writeSummaryMarkdown` receives display paths from CLI, markdown footer uses them for operator-friendly output.

### No Escaping for Trusted LLM Output

**Decision:** The markdown renderer does NOT escape `why` fields in worth-clicking/voices sections.

**Rationale:** Content comes from Claude via typed tool-use schema (feature 12), not from untrusted user input. If a `why` contains markdown special characters (backticks, brackets), it renders as-is. The operator's markdown viewer handles it.

**Trade-off:** If Claude returned malicious markdown, it would render. But Claude is the trusted source (vision principle 8: "Personal tool simplicity"). Defensive escaping would add complexity for a non-existent threat model.

**Where applied:** `renderWorthClicking` and `renderVoices` use `item.why` verbatim, no `escapeMarkdown()` call.
