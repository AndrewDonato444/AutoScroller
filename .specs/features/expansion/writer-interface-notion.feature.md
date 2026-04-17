---
feature: Writer Interface + NotionWriter
domain: expansion
source: src/writer/writer.ts
tests:
  - tests/expansion/writer-interface.test.ts
  - tests/expansion/notion-writer.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-17
updated: 2026-04-17
---

# Writer Interface + NotionWriter

**Source Files**:
- `src/writer/writer.ts` (new — defines the `Writer` interface and the `runWriters` orchestrator)
- `src/writer/markdown.ts` (existing — refactor to conform to `Writer`)
- `src/writer/notion.ts` (new — `NotionWriter` implementation)
- `src/config/schema.ts` (extended — `output.destinations` replaces single-destination assumption)
- `src/cli/scroll.ts` and `src/cli/replay.ts` (refactored — call `runWriters` instead of `writeSummaryMarkdown` directly)

**Design System**: N/A (CLI tool — the operator's "UI" for this feature is a Notion page they open in the morning alongside (or instead of) `summary.md`)

**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Pluggable writers — the operator picks where the summary lands, and one failure doesn't lose the others

Vision principle 5 is explicit: **"Pluggable outputs. Writer is an interface — MarkdownWriter now, NotionWriter later. No refactor needed to add destinations."** Phase 2 shipped the markdown writer as a concrete module wired directly into the scroll and replay CLIs. It works, it's the operator's default, and it's going to stay the default. But the operator also lives in Notion — he keeps a daily journal page there, and the one-click jump from "summary.md" to "action" he currently does in his head would be cheaper if `summary.md` content landed as a child page under his `ScrollProxy` Notion parent. That's the user-visible motivation. The engineering motivation is that writing a second destination now (before there's a third) forces a clean seam — if we add a third destination later (Obsidian, Raindrop, a local RSS feed), we should be writing an implementation of the same interface and not touching `scroll.ts` or `replay.ts`.

This feature does three things, in this order:

1. **Extracts a `Writer` interface** at `src/writer/writer.ts`. The interface is the smallest thing that lets the operator plug in a destination without any further CLI changes. It takes a `RunSummary` plus a small `WriteContext` (paths, run-id, display paths) and returns a `WriteReceipt` describing what was written and where — either `{ ok: true; kind: 'file' | 'notion' | ...; displayLocation: string }` or `{ ok: false; reason: string }`. The orchestrator (`runWriters`) calls each enabled writer, collects their receipts, and folds them into the CLI's summary line. No exceptions escape `runWriters` — a writer that throws is recorded as `{ ok: false, reason }` and the next writer runs.

2. **Refactors `MarkdownWriter` to conform.** `src/writer/markdown.ts` already exports `renderSummaryMarkdown` and `writeSummaryMarkdown`. Both stay — `renderSummaryMarkdown` is still a pure function and is still callable from `NotionWriter` (see below, rationale: Notion API client can't paste markdown in one call, but the same `RunSummary` feeds both renderers, so the markdown form is available for the operator's Notion database field `Markdown` if they want a searchable text column). The new thing is a `MarkdownWriter` object that implements `Writer` and delegates to `writeSummaryMarkdown`. No behavior changes. No new tests for the rendering — it's the same pure function. The only new test surface is "the `Writer` interface contract is honored by `MarkdownWriter`".

3. **Adds `NotionWriter`** at `src/writer/notion.ts`. It takes the same `RunSummary`, converts it to Notion blocks (not markdown — Notion's API speaks blocks, and piping markdown through a third-party converter is both extra dependency and extra failure mode), and creates a new child page under the operator's configured Notion parent. The page title matches the markdown's `# ScrollProxy — YYYY-MM-DD HH:MM UTC` header. The page body is the same four sections (Themes / Worth clicking / Voices / Noise) in the same order, using the same persona vocabulary — this is a loyal re-rendering of `summary.json`, not a remix.

The orchestrator layer changes one place in the CLI: the call site that used to be `await writeSummaryMarkdown(...)` becomes `await runWriters({ writers, summary, context })`. The CLI's summary line gains one `— rendered to <location>` clause per writer that succeeded, and zero per writer that failed (failures log on their own line). `pnpm scroll` exits 0 if at least the markdown writer succeeded (markdown is the contract-of-last-resort — vision principle 3: "never lose scroll effort"). It exits 1 only if **every** enabled writer failed, or if the markdown writer specifically failed. A Notion failure alone does not exit 1 — the markdown is still on disk, the operator can still open it, and the next run will re-attempt Notion.

Vision principle 8 — **"Personal tool simplicity"** — shows up as what `NotionWriter` refuses to do. It does not create a database if one doesn't exist. It does not query for existing runs and update them. It does not support multiple Notion workspaces. It does not attempt rich two-way sync. It does exactly one thing: "POST /v1/pages with a `parent: { page_id: <configured parent> }` and a body of blocks derived from the summary". If the parent page doesn't exist, the API returns 404 and the writer returns `{ ok: false, reason: 'notion_parent_not_found: <id>' }`. If the integration token lacks access, the API returns 403 and the writer returns `{ ok: false, reason: 'notion_not_authorized' }`. No auto-retry on config errors; one retry on transient 5xx/429 (same policy as the summarizer, feature 12).

Anti-persona guardrails — the anti-persona wanted OAuth, multi-workspace, engagement analytics, a hosted dashboard. `NotionWriter` has **none of those**: it uses a single **personal integration token** the operator creates once in Notion's developer settings and stores in `config.notion.token` or `NOTION_TOKEN` env; it targets a single configured parent page ID; it does not read back from Notion; it does not track engagement or visits or anything else. Adding any of those things would push the tool toward hosted SaaS — out of scope permanently.

### Exports from `src/writer/writer.ts`

```typescript
export interface WriteContext {
  runId: string;
  runDir: string;
  rawJsonPath: string;
  summaryJsonPath: string;
  displayRawJsonPath?: string;
  displaySummaryJsonPath?: string;
}

export type WriteReceipt =
  | { ok: true; kind: 'file' | 'notion'; displayLocation: string }
  | { ok: false; reason: string };

export interface Writer {
  /** Short identifier used in logs, e.g. "markdown", "notion". */
  readonly id: string;

  /** Render + persist. Must NOT throw — all failures return ok:false. */
  write(summary: RunSummary, context: WriteContext): Promise<WriteReceipt>;
}

export interface RunWritersResult {
  receipts: Array<{ id: string; receipt: WriteReceipt }>;
  markdownSucceeded: boolean;
  anySucceeded: boolean;
}

export async function runWriters(params: {
  writers: Writer[];
  summary: RunSummary;
  context: WriteContext;
}): Promise<RunWritersResult>;
```

Key contract points:

1. **`write` must never throw.** Every writer wraps its I/O in try/catch and returns `{ ok: false, reason }`. This is enforced by `runWriters` defensively (`try { await writer.write(...) } catch (e) { receipt = { ok: false, reason: e.message } }`) so a new writer that forgets the rule doesn't break the run, but well-behaved writers never hit the `catch`.
2. **`runWriters` runs writers sequentially, not in parallel.** Rationale: the markdown writer is the cheapest and most important; it should run first and fastest. Running Notion in parallel would save ~1s on a ~10s scroll, at the cost of making log ordering confusing and making it harder to reason about "which file is written when the process is killed". For a single-user CLI that runs once a day, sequential is correct.
3. **Order is caller-controlled.** The CLI passes writers in priority order. Markdown is always first (recover-from-everything invariant).
4. **Receipts, not exceptions.** The CLI reads `result.markdownSucceeded` and `result.anySucceeded` to choose its exit code; it reads `result.receipts[*].receipt` to build the summary line and error log lines. No try/catch around `runWriters` itself.

### Exports from `src/writer/markdown.ts` (additions — existing exports unchanged)

```typescript
export const markdownWriter: Writer;
```

`markdownWriter.id === 'markdown'`. `markdownWriter.write(summary, context)` calls the existing `writeSummaryMarkdown({ runDir: context.runDir, summary, rawJsonPath: context.rawJsonPath, summaryJsonPath: context.summaryJsonPath, displayRawJsonPath: context.displayRawJsonPath, displaySummaryJsonPath: context.displaySummaryJsonPath })` and converts the result to a receipt. Errors (disk full, unsupported schemaVersion) become `{ ok: false, reason: 'markdown: <message>' }`. The existing `renderSummaryMarkdown` and `writeSummaryMarkdown` functions remain exported and continue to work — callers who already import them (none outside the writer module after this refactor, but the exports stay for tests) keep working.

### Exports from `src/writer/notion.ts` (new)

```typescript
export interface NotionWriterConfig {
  token: string;          // Personal integration token (starts with 'secret_' or 'ntn_')
  parentPageId: string;   // UUID of the Notion page that new summary pages live under
  model?: string;         // Optional — defaults to summary.model for the page property
}

export function createNotionWriter(config: NotionWriterConfig): Writer;
```

`createNotionWriter` returns a `Writer` with `id === 'notion'`. The factory pattern (rather than a singleton like `markdownWriter`) exists because Notion needs configuration; the CLI constructs it once per invocation after loading the YAML config.

The implementation:

1. Uses `@notionhq/client` (the official Notion SDK — one new runtime dependency, and the only one this feature adds). No custom HTTP wrapper.
2. Constructs a page creation payload:
   - `parent: { page_id: config.parentPageId }`
   - `properties: { title: [{ text: { content: '<title>' } }] }` where `<title>` is `ScrollProxy — YYYY-MM-DD HH:MM UTC` (same format as the markdown header, derived from `summary.summarizedAt`, UTC).
   - `children: [...]` — the block list described below.
3. Block list matches the markdown structure section-for-section. Each section is a `heading_2` block followed by content blocks:
   - **Themes** → `bulleted_list_item` per theme. If empty, one `paragraph` with italic text `(no themes — summarizer returned an empty list)`.
   - **Worth clicking** → `numbered_list_item` per entry, rich text with a link on `@author` followed by ` — <why>`. If empty, one `paragraph` with italic `Nothing worth clicking this run.`.
   - **Voices** → `bulleted_list_item` per voice, rich text with bold `@handle` followed by ` — <why>`. If empty, one `paragraph` with italic `No standout voices this run.`.
   - **Noise** → single `paragraph` with the same sentence the markdown would render: `<N> posts skimmed as noise — <examples>.` / `<N> posts skimmed as noise.` / `No noise flagged.`.
   - **Footer** → `divider` block, then two `paragraph` blocks: `Raw posts: <displayRawJsonPath>` and `Summary JSON: <displaySummaryJsonPath>`. Paths go in inline code (Notion `code` annotation on the rich text).
4. Handles Notion API errors:
   - `401` / token invalid → `{ ok: false, reason: 'notion_not_authorized: token invalid or revoked' }`
   - `403` / parent page not shared with the integration → `{ ok: false, reason: 'notion_not_authorized: integration not added to parent page <id>' }`
   - `404` / parent page id wrong → `{ ok: false, reason: 'notion_parent_not_found: <id>' }`
   - `429` → one retry after `retry-after` header (or 2s default). If second attempt fails, `{ ok: false, reason: 'notion_rate_limited' }`
   - `5xx` → one retry after 2s. If second attempt fails, `{ ok: false, reason: 'notion_unavailable: <status>' }`
   - Network error / timeout (10s) → `{ ok: false, reason: 'notion_timeout' }`
   - Unknown / schema version mismatch → `{ ok: false, reason: 'notion: <message>' }`
5. On success, returns `{ ok: true, kind: 'notion', displayLocation: 'https://notion.so/<page-id-without-dashes>' }`. The URL is constructed from the Notion API response's `id` field (Notion URLs are the same domain with the dash-less UUID as the slug).
6. Adds **zero** extra state to `~/scrollproxy/state/`. The Notion page ID from the response is logged in the CLI summary line, but not persisted — if the operator wants history, Notion has it natively.

### Config extension (`src/config/schema.ts`)

The config gains a writers section. Existing single-destination config keeps working (the default destinations list contains only `'markdown'`).

```typescript
// Existing output block stays, minus the `format` field:
output: z.object({
  dir: z.string(),
  state: z.string(),
  destinations: z.array(z.enum(['markdown', 'notion'])).default(['markdown']),
}),

// New optional block (only required if 'notion' is in destinations):
notion: z.object({
  token: z.string().optional(),      // falls back to process.env.NOTION_TOKEN
  parentPageId: z.string(),           // required if notion destination is enabled
}).optional(),
```

`output.format` is **removed** as a config key — it was always `'markdown'` anyway, and keeping it alongside `destinations` would create two sources of truth. Existing configs that set `output.format: 'markdown'` are silently stripped by Zod (the outer `configSchema` uses `.strict()` for top-level keys, but the `output` nested object uses default Zod behavior and drops unknown fields without warning). The operator's YAML is accepted as if the `format` key weren't there; `destinations` is the only source of truth.

Validation rules enforced by the loader:
- If `destinations` contains `'notion'`, `notion.parentPageId` must be set. Error: `config: destinations includes 'notion' but notion.parentPageId is not configured`.
- `notion.token` can come from `config.notion.token` OR `process.env.NOTION_TOKEN`. If `'notion'` is in destinations and neither is set, error at startup: `config: destinations includes 'notion' but neither config.notion.token nor NOTION_TOKEN env is set`.
- `destinations` may not be empty. Error: `config: output.destinations must have at least one writer`.

### CLI orchestration changes

`src/cli/scroll.ts` currently calls `writeSummaryMarkdown` directly inside `runSummarizerAndRenderMarkdown`. After this feature:

1. The CLI builds a `writers: Writer[]` array at startup based on `config.output.destinations`:
   - `'markdown'` → `markdownWriter` (always included if present in destinations)
   - `'notion'` → `createNotionWriter({ token: config.notion.token ?? process.env.NOTION_TOKEN, parentPageId: config.notion.parentPageId })` (constructed once per run)
2. After `writeSummaryJson` succeeds, instead of `await writeSummaryMarkdown(...)`, it calls:
   ```
   const { receipts, markdownSucceeded, anySucceeded } = await runWriters({ writers, summary, context });
   ```
3. Summary line assembly loops over successful receipts:
   ```
   summaryLine += receipts
     .filter(r => r.receipt.ok)
     .map(r => ` — rendered to ${r.receipt.displayLocation}`)
     .join('');
   ```
4. Failure log lines loop over failed receipts (on separate lines, one per failure):
   ```
   for (const r of receipts.filter(r => !r.receipt.ok)) {
     console.log(`${r.id} render failed: ${r.receipt.reason}`);
   }
   ```
5. Exit code:
   - If `!markdownSucceeded` → exit 1 (markdown is the floor; losing it is the "never lose scroll effort" violation).
   - Else if `!anySucceeded` → exit 1 (shouldn't be reachable if markdown is enabled and succeeded, but covers the degenerate case of a destinations list that excludes markdown and all others failed — see scenario below).
   - Else → exit 0 (markdown present; other writers may have failed but that's recoverable on the next run or via `--replay`).

`src/cli/replay.ts` changes identically — same orchestrator, same policy. This means `--replay` also attempts Notion posting, which is the right behavior (the operator replays when they want a fresh summary; that includes the Notion page).

### Scenario: Default config — only markdown writer runs, no Notion calls

Given the operator's config has `output.destinations: ['markdown']` (or is omitted entirely — `markdown` is the default)
And `config.notion` is undefined
And no `NOTION_TOKEN` env var is set
When `pnpm scroll --minutes 3` completes and the summarizer succeeds
Then `writers` is constructed as `[markdownWriter]`
And `runWriters` calls `markdownWriter.write` exactly once
And no Notion SDK is imported, no HTTP request to `api.notion.com` is made
And `<runDir>/summary.md` exists
And the CLI summary line ends with ` — rendered to ~/scrollproxy/runs/<runId>/summary.md`
And `pnpm scroll` exits 0
(Default behavior unchanged. Operators who never configure Notion see zero difference from Phase 2 in observable output. Implementation note: `@notionhq/client` is imported statically at the top of `src/writer/notion.ts`, so the SDK is loaded at startup even for markdown-only runs. No network or auth calls are made unless a Notion writer is actually constructed — the dependency cost is the extra import evaluation, not runtime side effects.)

### Scenario: Notion destination enabled — both writers run, both succeed

Given `output.destinations: ['markdown', 'notion']` and `notion.parentPageId: 'abc123...'`
And `config.notion.token` is `'secret_validtoken...'`
And the Notion API returns 200 with `id: 'def456...'` for the page creation request
When `pnpm scroll` completes successfully
Then `writers` is constructed as `[markdownWriter, notionWriter]` (markdown first — priority order)
And `markdownWriter.write` runs first, writes `summary.md`, returns `{ ok: true, kind: 'file', displayLocation: '~/scrollproxy/runs/<runId>/summary.md' }`
And `notionWriter.write` runs second, POSTs to `/v1/pages`, returns `{ ok: true, kind: 'notion', displayLocation: 'https://notion.so/def456...' }`
And the CLI summary line ends with ` — rendered to ~/scrollproxy/runs/<runId>/summary.md — rendered to https://notion.so/def456...`
And `pnpm scroll` exits 0
(Two writers, one summary, two `rendered to` clauses in order. The operator's eye walks the line left-to-right and sees both destinations. `https://notion.so/...` is a clickable link in most modern terminals.)

### Scenario: Notion fails (network), markdown succeeds — exit 0, failure logged but run considered complete

Given `output.destinations: ['markdown', 'notion']` and Notion is configured
And the Notion API request times out (10s)
When `pnpm scroll` completes
Then `markdownWriter` succeeds and `summary.md` is written
And `notionWriter` returns `{ ok: false, reason: 'notion_timeout' }`
And the CLI prints the summary line ending with only ` — rendered to ~/scrollproxy/runs/<runId>/summary.md` (no Notion URL — failed writers do not appear in the summary line)
And on the next line prints `notion render failed: notion_timeout`
And `pnpm scroll` exits 0 (markdown succeeded — the operator has a summary to read)
And `summary.json` and `raw.json` remain intact
(Vision principle 3: never lose scroll effort. A Notion failure is a Notion problem, not a ScrollProxy problem. The operator opens `summary.md` and moves on; tomorrow's run retries Notion automatically.)

### Scenario: Markdown fails but Notion succeeds — still exit 1 because markdown is the floor

Given `output.destinations: ['markdown', 'notion']` and Notion is configured
And the disk is full — `writeSummaryMarkdown` throws `ENOSPC`
But the Notion API call succeeds
When `pnpm scroll` reaches the writer phase
Then `markdownWriter.write` returns `{ ok: false, reason: 'markdown: ENOSPC: no space left on device' }`
And `notionWriter.write` returns `{ ok: true, kind: 'notion', displayLocation: 'https://notion.so/...' }`
And the CLI summary line ends with ` — rendered to https://notion.so/...` (only the successful receipt appears)
And a separate line prints `markdown render failed: markdown: ENOSPC: no space left on device`
And `pnpm scroll` exits 1
And `summary.json` and `raw.json` remain intact
(Markdown is the contract of last resort. Even if Notion worked, losing the local markdown file is a failure state — the operator's daily habit is to `open summary.md`, and we can't promise that worked when it didn't. Exit 1 makes cron/launchd send a notification.)

### Scenario: Notion-only config with no markdown destination — exit 1 if Notion fails

Given `output.destinations: ['notion']` (operator explicitly opted out of markdown)
And Notion fails
When `pnpm scroll` completes the scroll and summarizer
Then `markdownSucceeded` is `false` (the markdown writer was never in the list, so it never "succeeded")
And `anySucceeded` is `false`
And `pnpm scroll` exits 1
And the failure line `notion render failed: <reason>` is logged
And `summary.json` is still on disk (the operator can `--replay` to retry all writers)
(Edge case, but real: the operator who trusts Notion enough to disable markdown has to accept that a Notion outage means no summary rendered today. The raw data is still recoverable via `--replay`.)

### Scenario: Notion destination configured but token is missing — fail at config load, before scrolling

Given `output.destinations: ['notion']` in config.yaml
And `config.notion.token` is not set AND `NOTION_TOKEN` env var is not set
When `pnpm scroll` starts up and the config loader runs
Then the loader fails with `config: destinations includes 'notion' but neither config.notion.token nor NOTION_TOKEN env is set`
And exits 1 **before launching the browser**
And the operator has not paid the scroll cost for a run that was doomed at step 1
(Fail fast, fail loudly — config errors are detected at startup, not halfway through a 10-minute scroll. This is the same principle as the YAML validation in the config-loader feature.)

### Scenario: Notion destination configured but parentPageId is missing — fail at config load

Given `output.destinations: ['notion']` and `config.notion.token: 'secret_...'` but `config.notion.parentPageId` is absent
When the config loader runs
Then validation fails with a Zod error whose path is `notion.parentPageId` and whose message notes the field is required when `'notion'` is in destinations
And `pnpm scroll` exits 1 before scrolling
(Same fail-fast principle. The operator's YAML is the source of truth; if it's incomplete, the tool doesn't silently degrade.)

### Scenario: Config with removed `output.format` key is silently accepted (stripped)

Given a Phase 2 config.yaml that still has `output.format: markdown`
When the config loader parses it
Then Zod strips the unknown nested field `output.format` silently (the inner `output` schema does not use `.strict()`)
And the resulting config object has `output.destinations` defaulted to `['markdown']` (if the operator didn't also set destinations)
And `pnpm scroll` proceeds normally using markdown as the only destination
And exit code is 0 for a successful run
(This is a backwards-compatible config path: Phase 2 configs that specified `output.format: markdown` still work, because the effective behavior — markdown-only output — is the default for `destinations`. A stricter fail-loud migration was considered but not implemented; the silent strip keeps old configs working and the `destinations` key is the source of truth going forward.)

### Scenario: Notion rate-limited once, retried, succeeds

Given `destinations: ['markdown', 'notion']` is configured
And the first POST to `/v1/pages` returns `429` with `retry-after: 2`
And the retried POST returns `200`
When `pnpm scroll` runs through the writer phase
Then `notionWriter.write` returns `{ ok: true, kind: 'notion', displayLocation: 'https://notion.so/...' }`
And the CLI summary line includes both ` — rendered to ~/scrollproxy/runs/<runId>/summary.md` and ` — rendered to https://notion.so/...`
And `pnpm scroll` exits 0
(Same single-retry policy as the Claude summarizer: transient rate limits are routine, not errors worth surfacing. Retry once, then give up.)

### Scenario: Notion parent page not shared with the integration (403) — not retried, clear reason

Given `destinations: ['markdown', 'notion']` and a token that exists but hasn't been granted access to the configured parent page
When the Notion API returns 403 with body mentioning "integration does not have access"
Then `notionWriter.write` returns `{ ok: false, reason: 'notion_not_authorized: integration not added to parent page <id>' }`
And no retry is attempted (403 is not transient)
And markdown succeeds
And the CLI exits 0 with the markdown render line and the failure log line
(This is the #1 Notion integration setup pitfall. The error message names the exact fix: "add the integration to the parent page in Notion's share menu". We don't retry because retrying a 403 is a bug; the operator has to change something in Notion before the next run works.)

### Scenario: `--dry-run` skips all writers — markdown and Notion both untouched

Given the operator runs `pnpm scroll --minutes 3 --dry-run` with `destinations: ['markdown', 'notion']`
When the scroll completes
Then `runWriters` is NOT called
And no `summary.md` is written
And no request is made to `api.notion.com`
And the summary line reads `dry-run complete: <N> ticks over <M>s — <P> posts extracted (<A> ads skipped), writer skipped` (unchanged from feature 15)
(Feature 15 owns the end-to-end dry-run contract. "Writer skipped" is plural in intent — every writer is a write, and dry-run's promise is no writes. This scenario exists to make sure the orchestrator inherits the skip, not that each writer has to implement its own dry-run check.)

### Scenario: `--replay <run-id>` exercises all writers, not just markdown

Given a saved `<runDir>/raw.json` exists
And `destinations: ['markdown', 'notion']` is configured
When the operator runs `pnpm replay <run-id>`
Then the summarizer runs against the saved posts
And `runWriters` is called with both writers
And a new Notion page is created (replay creates a fresh page — Notion history is intentional)
And `summary.md` is overwritten
And the replay summary line reads `replayed <run-id>: summarized (<X> themes, <Y> worth clicking) — rendered to ~/scrollproxy/runs/<run-id>/summary.md — rendered to https://notion.so/<new-page-id>`
(Replay is a first-class way to retry a failed Notion write from a previous run. The operator's workflow: see last night's cron failed Notion, set `NOTION_TOKEN`, run `pnpm replay <last-night-run-id>`, confirm the Notion page exists, close the laptop.)

### Scenario: A writer that throws instead of returning ok:false does not crash `runWriters`

Given a hypothetical buggy third writer that throws an uncaught exception from `write(...)` (this shouldn't happen in first-party writers, but the orchestrator is defensive)
When `runWriters` iterates to that writer
Then the exception is caught inside `runWriters`
And the receipt for that writer is `{ ok: false, reason: '<error message>' }`
And the next writer in the list still runs
And the final `RunWritersResult` reports the failure in `receipts` but does not rethrow
(Defensive orchestration. A buggy writer is a developer problem, not an operator problem — the operator's daily run should never be blocked by an uncaught exception from a new destination someone added last week.)

### Scenario: Order of writers matches config — markdown always before Notion

Given `destinations: ['notion', 'markdown']` (operator wrote them in an unusual order)
When the CLI constructs the `writers` array
Then the array is still `[markdownWriter, notionWriter]` — the CLI reorders to guarantee markdown runs first
And the reorder happens silently (no log line, no warning — `buildWriters` just pushes markdown first when present, then appends notion)
(Markdown-first is the "never lose scroll effort" invariant. The config is a set, not an ordered list — the CLI enforces the priority. We could reject the misordering at config load, but silently reordering is friendlier for an operator who was experimenting.)

### Scenario: One new runtime dependency (@notionhq/client) added for the Notion writer

Given the operator has never enabled Notion
When `pnpm list --depth 0` is inspected
Then `@notionhq/client` is listed in dependencies (used by `src/writer/notion.ts`)
And the SDK module is evaluated at startup on every `pnpm scroll` invocation because `notion.ts` uses a top-level static import (`import { Client } from '@notionhq/client'`) and `scroll.ts`/`replay.ts` statically import `createNotionWriter`
And no network request is made to `api.notion.com` during a markdown-only run (the `Client` is only instantiated and called inside `createNotionWriter` + `write`, which only run when `'notion'` is in `destinations`)
(Static-import tradeoff: the SDK module is loaded eagerly for simplicity (one new dep, no dynamic-import ceremony in the CLI path). The runtime cost that matters for the operator — no auth calls, no HTTP to Notion on markdown-only runs — is preserved. If startup time ever becomes a concern, the import can be moved inside `createNotionWriter` as a dynamic `await import(...)`.)

### Scenario: `MarkdownWriter` still produces byte-identical output to Phase 2

Given an identical `RunSummary` and identical `WriteContext`
When the Phase 2 call (`writeSummaryMarkdown(...)` directly) and the Phase 3 call (`runWriters({ writers: [markdownWriter], ... })`) both run against a fresh tmp dir
Then the two `summary.md` files are byte-identical
And `sha256sum` of both is the same
(Refactor invariant. The Writer interface is supposed to be a seam, not a rewrite. If the markdown output diverged byte-for-byte from Phase 2, `--replay` on old runs would produce different summary.md files, which breaks the operator's `diff yesterday today` habit.)

### Scenario: The Notion page body uses the same persona vocabulary as the markdown

Given a summary with `feedVerdict: 'mixed'`, 5 themes, 3 worth-clicking, 2 voices, noise count 42
When `notionWriter` renders the page blocks
Then the page title is exactly `ScrollProxy — 2026-04-17 09:12 UTC`
And the first `heading_2` block text is `Themes`
And the second is `Worth clicking` (not "Recommended", not "Top Picks")
And the third is `Voices` (not "Top Accounts")
And the fourth is `Noise` (not "Filtered" or "Low Signal")
And the footer paragraphs say `Raw posts: ~/scrollproxy/runs/<runId>/raw.json` and `Summary JSON: ~/scrollproxy/runs/<runId>/summary.json`
(Same persona vocabulary as the markdown. The operator's mental model is "the Notion page is what the markdown says, rendered as Notion blocks." Any divergence in wording would feel like two different tools.)

## User Journey

1. **Setup (once)**: Operator creates a Notion internal integration at `notion.so/profile/integrations`, copies the token, creates a Notion page named "ScrollProxy Runs" in their workspace, shares it with the integration.
2. Operator edits `config.yaml`: sets `output.destinations: ['markdown', 'notion']`, sets `notion.parentPageId` to the page UUID, sets `notion.token` (or exports `NOTION_TOKEN`).
3. **Every morning**: cron (or manual) runs `pnpm scroll`. Markdown is written as before. Notion page is created under the configured parent.
4. Terminal output now has a second `— rendered to <notion-url>` clause. Operator Cmd-clicks the URL.
5. Browser opens to the Notion page in the operator's journal workspace. Same four sections, same persona vocabulary, same links.
6. Operator reads Themes, clicks one Worth-clicking link, closes the tab. Total time: same ~90 seconds as the markdown flow.
7. Once a week operator glances at their Notion parent page and sees the last 7 daily summaries as child pages — ambient memory without effort.

## UI Mockup

ScrollProxy is a CLI tool. The "UI" is the terminal summary line + the Notion page Notion's own UI renders.

### Terminal: both writers succeed (happy path)

```
$ pnpm scroll --minutes 10
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
scroll complete: 184 ticks over 603s — 84 posts extracted (6 ads skipped) — 38 new, 46 already seen — summarized (5 themes, 3 worth clicking) — saved to ~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json — rendered to ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md — rendered to https://notion.so/a1b2c3d4e5f6
$
```

### Terminal: Notion fails, markdown succeeds

```
$ pnpm scroll --minutes 10
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
scroll complete: 184 ticks over 603s — 84 posts extracted (6 ads skipped) — 38 new, 46 already seen — summarized (5 themes, 3 worth clicking) — saved to ~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json — rendered to ~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.md
notion render failed: notion_not_authorized: integration not added to parent page a1b2c3d4e5f6
$ echo $?
0
```

### Terminal: markdown fails, Notion succeeds (exit 1 because markdown is the floor)

```
$ pnpm scroll --minutes 10
scrolling x.com for 10m (persistent context: ~/scrollproxy/chrome)
scroll complete: 184 ticks over 603s — 84 posts extracted (6 ads skipped) — 38 new, 46 already seen — summarized (5 themes, 3 worth clicking) — saved to ~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json — rendered to https://notion.so/a1b2c3d4e5f6
markdown render failed: markdown: ENOSPC: no space left on device, rename '...summary.md.tmp' -> '...summary.md'
$ echo $?
1
```

### Terminal: config error at startup (fail fast)

```
$ pnpm scroll --minutes 10
config: destinations includes 'notion' but neither config.notion.token nor NOTION_TOKEN env is set
$ echo $?
1
```

### Notion page (rendered by Notion — shown here as block sketch)

```
┌─ Page title ──────────────────────────────────────────────────────────┐
│  ScrollProxy — 2026-04-17 09:12 UTC                                    │
└────────────────────────────────────────────────────────────────────────┘

  Themes
  • agent orchestration patterns
  • indie-dev distribution
  • sales enablement tooling
  • distributed training tricks
  • sports-betting odds math

  Worth clicking
  1. @someone — Concrete pattern for state sharing between agents — worth
     reading, not just bookmarking.
  2. @devgrinder — Teardown of a mid-market GTM motion that actually
     shipped revenue.
  3. @oddsnerd — Clean derivation of a closing-line value edge the
     operator has been chasing.

  Voices
  • @smalleraccount — Three deep cuts on AI product strategy this run —
    keep reading.
  • @pragmabuilder — Consistent signal on distribution tactics for
    one-person shops.

  Noise
  42 posts skimmed as noise — reply-guy politics, crypto shilling, vague
  motivational quotes.

  ─────────────────────────────────────────────────────────────────────

  Raw posts: `~/scrollproxy/runs/2026-04-17T09-02-14Z/raw.json`
  Summary JSON: `~/scrollproxy/runs/2026-04-17T09-02-14Z/summary.json`
```

The `@handle` entries in "Worth clicking" are inline links (href = post URL). The `@handle` entries in "Voices" are bold, no link (voices are a curation signal, not a link list — same as the markdown).

### `config.yaml` — minimal Notion-enabled config

```yaml
scroll:
  minutes: 10

browser:
  userDataDir: ~/scrollproxy/chrome
  headless: false
  viewport: { width: 1280, height: 900 }

interests: [ai-product-strategy, indie-dev, sales-enablement, sports-betting]

output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state
  destinations: [markdown, notion]

notion:
  parentPageId: a1b2c3d4-e5f6-7890-abcd-ef1234567890
  # token can live here, or set NOTION_TOKEN env var
  # token: secret_...

claude:
  model: claude-sonnet-4-6
```

## Component References

N/A — CLI tool, no UI components.

## Learnings

<!-- Updated via /compound after implementation -->
