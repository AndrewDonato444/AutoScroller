# Learnings Index

Cross-cutting patterns learned in this codebase. Updated via `/compound`.

## Quick Reference

| Category | File | Summary |
|----------|------|---------|
| Testing | [testing.md](./testing.md) | Mocking, assertions, test patterns |
| Performance | [performance.md](./performance.md) | Optimization, lazy loading, caching |
| Security | [security.md](./security.md) | Auth, cookies, validation |
| API & Data | [api.md](./api.md) | Endpoints, data handling, errors |
| Design System | [design.md](./design.md) | Tokens, components, accessibility |
| General | [general.md](./general.md) | Other patterns |

---

## Recent Learnings

<!-- /compound adds recent learnings here - newest first -->

### 2026-04-17: Markdown Writer

**Pure Function Architecture:**
- No I/O, no Date.now(), no env reads for deterministic output (`renderSummaryMarkdown`)
- UTC timestamp formatting using `getUTCFullYear` etc. to avoid locale-dependent output
- Same inputs always produce byte-identical output (critical for `--replay` feature)

**Refactoring Patterns:**
- Extracted 11 constants (schema version, filenames, section headers, labels, placeholders)
- Extracted helper functions: `writeRawJsonAndUpdateCache`, `runSummarizerAndRenderMarkdown`
- Reduced `handleScroll` from 221 → 165 lines (26% reduction)
- Return objects over exceptions: `{ success, summaryLine, errorDetail? }`

**Testing:**
- 19 tests covering all Gherkin scenarios
- Helper functions for fixtures: `makeSummary`, `makeContext` pattern
- Test for substring absence requires section isolation (not whole document)

**UI Patterns:**
- Different formatting for error states (italic placeholders) vs success states (plain text)
- No escaping for trusted Claude output (tool-use schema, not user input)
- Display paths (~-compressed) vs absolute paths (for file ops)

**Dependencies:**
- Simple string concatenation > templating libraries for stable formats (zero runtime deps)

### 2026-04-17: Claude Summarizer

**API Patterns:**
- Anthropic SDK tool-use for structured output: define JSON schema as tool, Claude returns typed data via `tool_use` block
- AbortController for 60-second timeout on SDK calls (prevents CLI hanging)
- Single retry for transient failures (429, 5xx, network), fail fast for non-transient (401, 400, malformed response)
- Simplified retry classifier: substring check for `api_unavailable` covers all HTTP failures with one wasted retry on 401/400 but keeps logic simple

**Error Handling:**
- SDK error categorization: check `error.status` for HTTP codes, `error.name` for AbortError
- Typed error results: `{ status: 'ok'; data } | { status: 'error'; reason; rawResponse? }` instead of throws

**Data Optimization:**
- Cap posts at 200 (most recent first) to stay under token budget for single LLM call
- Flatten nested structures (`quoted.quoted` → `null`) to reduce payload size
- Counts reflect ALL posts, not just the capped subset sent to Claude

**Testing:**
- Real API integration tests validate end-to-end behavior (~19s total, but catches real auth/schema/timeout bugs)
- Mock API keys return 401, which validates the auth error path

**Refactoring:**
- Extract large schema constants (RETURN_SUMMARY_TOOL) reduced function from 115 to ~55 lines
- Extract helper for repeated field copying (toCompactPostBase) for DRY on nested transformations
- Extract error message constants for consistency

**Spec Drift:**
- Retry classifier simplified from idealized spec (separate transient/non-transient categories) to single substring check
- Rate-limited scenario claimed `api_unavailable: 429` final reason, but code returns `rate_limited` constant
- Status field bumped from `stub` to `implemented` during drift reconciliation

### 2026-04-17: State Module (Rolling Themes Store)

**JavaScript Gotchas:**
- `slice(-0)` returns full array, not empty — requires explicit `if (limit === 0) return []` check
- Timestamp mismatch bug: function calculating its own timestamp vs caller calculating a different one → log filename doesn't match actual filename. Fix: return timestamp from function.

**Architectural Consistency:**
- Followed dedup-cache patterns (quarantine, atomic write, FIFO eviction, pure functions) for operator mental model consistency
- Duplicate runId replacement critical for --replay scenario (prevents shrinking window on re-summarize)

**Design Patterns:**
- FIFO eviction from end (`slice(length - MAX_RUNS)`) keeps newest, not oldest
- Fixed key order in JSON for grep-friendly output
- Return meaningful values from helpers (timestamp) instead of void

**Testing:**
- No mocks, real filesystem in isolated temp directories
- Edge case coverage: limit=0, empty arrays, boundary conditions

### 2026-04-17: State Module (Dedup Cache)

**Helper Extraction:**
- Extract when logic appears twice with only messaging differences (quarantineCorruptCache helper)
- Extract display formatting at 4+ occurrences (formatDisplayPath helper)
- Extract orchestration helpers to consolidate duplicate update logic (updateDedupCacheAndGetSummary)

**When NOT to Extract:**
- Error handling blocks with different exit codes (parameterizing reduces clarity)
- Long sequential functions with clear phases (extraction harms readability)

**Testing:**
- Scaffold tests verify `.gitkeep` files exist in all module directories, even after real code is added
- When creating new module directories, add `.gitkeep` to satisfy scaffold tests

**Spec Drift:**
- "Same as feature X" can cause drift when only some pattern aspects are copied
- Be explicit about what's shared vs different when referencing prior features
- Root cause: Implementation makes judgment calls about what "same as" means

### 2026-04-16: Raw JSON Writer

**Atomic File Writes:**
- tmpfile → rename pattern (POSIX rename atomicity) is sufficient for crash-safe writes
- Simpler than explicit fsync and avoids platform-specific semantics
- Test by verifying tmpfile cleanup after successful write

**ID Generation Timing:**
- Generate time-based IDs at flow start, not when first needed
- Ensures run directory name and JSON payload timestamps agree
- Anti-pattern: generating ID at write time ties it to end-of-flow, not start

**Error Handling Layering:**
- Workers (utilities) throw on failure
- Orchestrators (CLI handlers) catch and format for user context
- Keeps error messaging in one place instead of spread across utilities

**Testing Patterns:**
- Use timestamped temp directories to avoid test conflicts
- Verify structure with JSON.parse, not string matching
- Test read-only behavior with deep copy comparison

**Spec Drift:**
- Forward-looking specs (describing ideal patterns like explicit fsync) vs simpler actual implementation
- Update spec to match reality when simpler approach still meets requirements
- Root cause: specs anticipate best practices, implementation discovers what's sufficient

### 2026-04-16: Extractor

**TypeScript:**
- Control flow analysis doesn't narrow discriminated unions across `page.evaluate()` boundaries → use explicit type assertions after runtime checks
- Destructuring with type assertion after discriminant check is cleaner than complex type guards

**Refactoring:**
- Extract constants for regex duplication (4 instances → 1 constant)
- Extract helper functions to consolidate duplicated logic (~20 lines across 4 places → 1 function)
- Don't break up functions when splitting would require multiple browser round-trips (performance concern)
- Don't abstract error handling when field names and defaults differ per case
- Don't refactor appropriately-sized orchestration functions (~60-70 lines showing clear sequential steps)

**Spec Drift:**
- Hypothetical selector names in spec vs actual implementation (spec: `METRIC_SELECTORS`, code: aria-label substring matching)
- Root cause: spec drafted before implementation made different choices, wasn't updated when feature landed
- Fix: update spec to enumerate actual constants and explain implementation choice

### 2026-04-16: Scroller

**Helper Extraction:**
- Extract Till You Drop — keep extracting until each function is <30 lines with single responsibility
- Stop when extraction creates coupling (6+ parameters is a signal)
- Applied: extracted 4 helpers from scroll loop, stopped before over-abstracting

**Interface Design:**
- Forward compatibility: add parameters to interface early for pending features
- Don't destructure unused parameters until feature lands — avoids TS6133 errors
- Interface changes are cheap; signature changes require coordination

**Spec Precision:**
- Timing precision for async callbacks: "after X and Y" is ambiguous
- Be explicit: "after X (and before Y), callback is awaited before Y starts"
- 0-based indexing in code vs 1-based in error messages must be documented

**Refactoring:**
- Single Responsibility Principle: each extracted helper handles one concern
- Magic number elimination: `MS_PER_MINUTE` constant for time conversions
- Centralize error handling: `invokeTickHook` wraps try-catch consistently

### 2026-04-16: Login Command

**Playwright:**
- Use `launchPersistentContext(userDataDir)` (not `launch + newContext`) to persist cookies across runs
- Browser context 'close' event fires when operator closes window (not programmatic close)
- userDataDir must exist or be creatable — implemented recursive mkdir

**Path Operations:**
- Expand `~` in paths before ALL operations (validation, mkdir, display) via `expandHomeDir()` helper
- Check if path is file vs directory (existsSync + statSync) before mkdir — clear error if path is a file
- Early validation pattern: check config constraints before expensive operations (headless check before browser launch)

**Helper Extraction:**
- Exit codes extracted to module level for organization and potential reuse
- Path expansion → `expandHomeDir()` helper (used 3+ times)
- Directory validation + creation → `ensureUserDataDir()` helper (multi-step logic)
- Success detection → `isLoginSuccessful()` helper (multi-line conditional)
- Don't extract contextual error messages — inline is clearer

**Testing:**
- Test helper bugs are subtle (setTimeout resolving early caused false positives) — verify helpers work
- Tests need proper config or they hang waiting for browser
- Test duplication (runCli, config fixtures) is acceptable for self-containment
- Skipping tests requiring external deps (Chromium) is OK — document with clear comments

**Spec Drift:**
- Anticipated modular split vs simpler inline implementation — update spec to match reality, don't create empty files
- Spec mockups use `~` shorthand, code expands early — clarify transformation with concrete example
- Status field maintenance: update at each phase boundary (specced → tested → implemented)

### 2026-04-16: CLI Entry + Arg Parsing

**TypeScript:**
- Type guards for union types before type-specific operations (e.g., `typeof value !== 'string'` before parseInt)
- Explicit type narrowing is better than relying on implicit coercion

**Code Style:**
- Named constants for magic numbers (exit codes, validation bounds) — self-documenting and error messages update automatically
- Underscore prefix for unused parameters in stub functions (_config) — maintains signature contract
- Extract helpers when logic is duplicated 3+ times (validateFlagsOrExit, loadConfigFromFlags)

**Spec Maintenance:**
- Spec frontmatter must list ALL entry points, including routing shims (src/login.ts, src/replay.ts)
- CLI stub messages must match spec vocabulary ("feed not yet wired" not "handler not yet wired")
- Hardcoded values in stubs that will be replaced soon are OK — don't extract prematurely

### 2026-04-16: Config Loader

**Testing:**
- process.env mocking doesn't work → use dependency injection (homeDir option)
- Temporary directories for isolation (tmpdir + unique timestamp, cleanup in afterEach)
- No mocking of core libraries (yaml, zod) in integration tests — verify real wiring
- Async test assertions require Error objects, not raw ZodError instances

**Code Style:**
- Three-file config pattern (schema, defaults, load) — single responsibility per file
- Operator-friendly error messages (field path, expected/received, file path, debug hint)
- Extract constants for magic strings in error paths (DEBUG_ENV_VAR, CONFIG_FILE_NAME)
- Extract function for complex error handling (50+ line handlers)
- Skip extraction when already readable (20-line decision trees)

**Tooling/Debugging:**
- ZodError uses `.issues` not `.errors` (common misconception from Joi/Yup)
- Zod v4: `issue.received` may be undefined — handle in error messages
- YAML parser accepts invalid types as strings — validation errors come from Zod
- Keep package manager commands consistent (pnpm in package.json → pnpm everywhere)

**Security:**
- Zod `.strict()` mode rejects unknown fields (anti-persona guardrail against analytics/OAuth)

### 2026-04-16: Project Scaffold

**Testing:**
- Test-the-scaffold pattern for foundational features (validate structure, not behavior)
- CLI integration tests with try/catch for error capture (stdout/stderr visibility)
- Negative assertions for anti-patterns (explicitly test forbidden deps don't exist)

**Tooling:**
- ESM requires `import.meta.url` + `fileURLToPath` instead of `__dirname`
- Always commit lock files (pnpm-lock.yaml) for reproducible installs
- Use engines field in package.json for fast-fail on wrong Node/pnpm version

**Code Style:**
- TypeScript interfaces for JSON.parse eliminate implicit `any`
- Named constants for magic strings (self-documenting)
- Read package.json for version/name (DRY, single source of truth)
- Verb-based script naming (scroll, login, replay) not nouns
- Avoid premature abstraction for placeholder stubs that will be replaced

---

## How This Works

1. **Feature-specific learnings** → Go in the spec file's `## Learnings` section
2. **Cross-cutting learnings** → Go in category files below
3. **General patterns** → Go in `general.md`

The `/compound` command analyzes your session and routes learnings to the right place.
