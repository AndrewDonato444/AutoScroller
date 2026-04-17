# General Learnings

Patterns that don't fit other categories.

---

## Code Style

### TypeScript Control Flow Analysis Across Function Boundaries

**Limitation:** TypeScript's control flow analysis doesn't narrow discriminated unions when the discriminant property comes from across a function boundary (like `page.evaluate()`).

**Problem:** After checking a discriminant property from `page.evaluate()`, TypeScript doesn't narrow the union type:

```typescript
const result = await page.evaluate(() => {
  if (condition) {
    return { hasData: false };
  }
  return { hasData: true, value: "...", ... };
});

if (!result.hasData) {
  return null;
}

// TypeScript still thinks result could be { hasData: false }
const value = result.value;  // ❌ Error: Property 'value' does not exist
```

**Solution:** Use explicit type assertion after the discriminant check:

```typescript
if (!result.hasData) {
  return null;
}

// Type assertion after runtime check
const { value, ... } = result as {
  hasData: true;
  value: string;
  ...
};
```

**Why:** The function boundary breaks TypeScript's control flow narrowing. Explicit type assertions after runtime checks are cleaner than complex type guards. This pattern is especially common with Playwright's `page.evaluate()`.

**When to apply:** Any time you use a discriminated union returned from `page.evaluate()`, async functions, or other cross-boundary patterns where TypeScript can't track control flow.

### Type Guards for Union Types Before Type-Specific Operations

When a value has a union type like `string | boolean`, add an explicit type guard before operations that require a specific type:

```typescript
// parseArgs returns flags as Record<string, string | boolean>
export function parseMinutesFlag(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === true) {
    return undefined;
  }
  
  // Type guard: ensure value is string before calling parseInt
  if (typeof value !== 'string') {
    throw new Error('--minutes must be an integer between 1 and 120');
  }
  
  const num = parseInt(value, 10);  // TypeScript now knows value is string
  // ...
}
```

**Why:** While parseInt coerces non-strings at runtime, TypeScript strict mode requires compile-time proof of type safety. The type guard makes the contract explicit: "this operation requires a string, here's where we verify it". Relying on implicit coercion violates TypeScript's safety guarantees.

### TypeScript Interface for JSON.parse

Create explicit interfaces with name/version types to eliminate implicit `any` from JSON.parse:

```typescript
interface PackageJson {
  name: string;
  version: string;
}

const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as PackageJson;
console.log(`${packageJson.name} v${packageJson.version}`);
```

**Why:** Eliminates implicit `any` warnings from strict mode and gives autocomplete/type safety for the parsed data.

### Named Constants for Magic Strings and Numbers

Extract repeated strings and magic numbers to named constants:

```typescript
// Strings
const STATUS_MESSAGE = 'feed not yet wired';
console.log(`${packageJson.name} v${packageJson.version} — ${STATUS_MESSAGE}`);

// Numbers
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE_ERROR = 2;
const MIN_SCROLL_MINUTES = 1;
const MAX_SCROLL_MINUTES = 120;

throw new Error(`--minutes must be an integer between ${MIN_SCROLL_MINUTES} and ${MAX_SCROLL_MINUTES}`);
process.exit(EXIT_USAGE_ERROR);
```

**Why:** Self-documenting code. The constant name explains what the value means (EXIT_USAGE_ERROR makes Unix convention explicit, MIN_SCROLL_MINUTES shows intent). Changes only need to happen in one place, and error messages update automatically.

### DRY with package.json

Read package.json for dynamic values instead of hardcoding:

```typescript
// BAD: hardcoded
console.log('scrollproxy v0.0.1');

// GOOD: read from package.json
const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as PackageJson;
console.log(`${packageJson.name} v${packageJson.version}`);
```

**Why:** Single source of truth. When version bumps, the banner updates automatically.

### Verb-Based Script Naming

Package scripts should be verbs the operator types (scroll, login, replay) not nouns (extraction-service, summarizer-runner):

```json
{
  "scripts": {
    "scroll": "tsx src/index.ts",     // GOOD: verb
    "login": "tsx src/cli/login.ts",  // GOOD: verb
    "extraction-service": "..."       // BAD: noun
  }
}
```

**Why:** Matches operator vocabulary. "I want to scroll the feed" → `pnpm scroll`. Nouns sound like services/daemons, not one-shot commands.

### Underscore Prefix for Intentionally Unused Parameters

Use underscore prefix for parameters that must exist for function signature but aren't used yet:

```typescript
// Login handler stub - config required by signature but not used yet
export async function handleLogin(_config: Config): Promise<void> {
  console.log('scrollproxy login — not yet wired (feature 4)');
}
```

**Why:** Maintains function signature contract while avoiding linter warnings. The underscore makes the intent explicit: "this parameter is required by the interface but not used in this implementation (yet)". Common for stub functions that will be filled in later.

---

## Git Workflow

<!-- Branching, commits, PRs -->

_No learnings yet._

---

## Tooling

### ESM: import.meta.url Instead of __dirname

ESM requires `import.meta.url` instead of `__dirname`. Use `fileURLToPath` to get the directory path:

```typescript
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packagePath = join(__dirname, '../package.json');
```

**Why:** `__dirname` is a CommonJS global that doesn't exist in ESM. This is the standard pattern for getting the current file's directory in ESM.

### Package Manager Lock Files Must Be Committed

Always commit `pnpm-lock.yaml` even though it's large/binary:

```gitignore
# DON'T ignore lock files
# pnpm-lock.yaml  ❌
```

**Why:** Essential for reproducible installs. Without it, `pnpm install` resolves versions fresh, which can break on CI or other developers' machines.

### Engines Field for Fast-Fail on Wrong Versions

Use `package.json` engines to fail loudly on wrong Node/pnpm version:

```json
{
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=8.0.0"
  }
}
```

**Why:** Catches version mismatches immediately with a clear error message before install completes. Better than silent failures or cryptic runtime errors later.

### Keep Package Manager Commands Consistent

If `package.json` uses `packageManager: "pnpm@..."`, ensure all scripts and env files use `pnpm` not `npm`:

```bash
# .env.local
TEST_CHECK_CMD="pnpm test"  # GOOD
TEST_CHECK_CMD="npm test"   # BAD - inconsistent with packageManager
```

**Why:** Mixing package managers causes lock file drift and version resolution differences. Pick one (usually declared in `packageManager` field) and use it everywhere.

---

## Debugging

### Zod API: .issues Not .errors

**Gotcha:** ZodError uses `.issues` array, not `.errors` (common misconception from other validation libraries like Joi, Yup):

```typescript
// WRONG:
const firstError = error.errors[0];  // undefined!

// RIGHT:
const firstIssue = error.issues[0];
const fieldPath = firstIssue.path.join('.');
```

**Why:** Discovered via node REPL testing when error handling failed silently. Zod's API is different from most validation libraries — always check `.issues`.

### Zod v4: issue.received May Be Undefined

In Zod v4, for `invalid_type` errors, the `issue.received` field may be `undefined`. Error messages need to handle this:

```typescript
const receivedType = (firstIssue as any).received;  // May be undefined
const valueStr = actualValue !== undefined ? ` "${actualValue}"` : '';

// Renders: "expected number, got undefined 'ten'"
// Not ideal, but field path and raw value are still present
```

**Why:** Zod v4 changed its internal issue representation. The spec documented "got string 'ten'" but the code emits "got undefined 'ten'". The field path, expected type, and raw value are still present, which is what the operator needs.

### YAML Parser vs Schema Validator

YAML library (`yaml` package) parses `"ten"` successfully as a string — it doesn't validate types. Type validation happens in Zod:

```typescript
// This succeeds:
const rawConfig = parseYaml('scroll:\n  minutes: "ten"');  // { scroll: { minutes: "ten" } }

// This fails:
configSchema.parse(rawConfig);  // ZodError: expected number, got string
```

**Why:** Error messages should reference "config error" not "YAML error" when the issue is type validation. YAML parsing errors are syntax (malformed quotes, bad indentation). Zod errors are schema violations.

---

## Other

### Pure Function Architecture for Deterministic Output

**Pattern:** For functions that produce output files (markdown, JSON, reports), make them pure — no I/O, no `Date.now()`, no `process.env` reads.

```typescript
// GOOD: Pure function — all inputs explicit
export function renderSummaryMarkdown(
  summary: RunSummary, 
  context: MarkdownContext
): string {
  // Timestamp comes from summary.summarizedAt, not Date.now()
  const timestamp = formatTimestamp(summary.summarizedAt);
  
  // Paths come from context, not process.cwd() or homedir()
  const rawPath = context.displayRawJsonPath || context.rawJsonPath;
  
  // Build markdown string...
  return lines.join('\n');
}

// BAD: Impure — reads system state
export function renderSummaryMarkdown(summary: RunSummary): string {
  const timestamp = new Date().toISOString();  // ❌ Non-deterministic
  const rawPath = join(homedir(), 'scrollproxy/...'); // ❌ System-dependent
  // ...
}
```

**Why:** 
1. **Deterministic** — Same inputs always produce same output, byte-for-byte
2. **Testable** — No mocks needed, just call the function
3. **Replayable** — Re-rendering old data produces identical output
4. **Diffable** — Operator can `diff` across runs and see content changes, not timestamp noise

**When to apply:** Any function that produces user-facing output files (markdown, reports, exports). Separate I/O concerns (reading/writing files) from rendering logic.

### UTC Timestamp Formatting for Cross-Machine Consistency

**Pattern:** Format timestamps using UTC date parts, not locale-dependent methods.

```typescript
// GOOD: UTC formatting
function formatTimestamp(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  
  return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
}

// BAD: Locale-dependent
function formatTimestamp(isoString: string): string {
  return new Date(isoString).toLocaleString();  // ❌ Different on every machine
}
```

**Why:** Two operators in different timezones rendering the same `summary.json` should produce byte-identical markdown. Locale-dependent formatting breaks determinism and adds noise to diffs. The UTC label in the output makes it clear the time isn't local.

**When to apply:** Any timestamp formatting in output files that should be deterministic across machines. Especially important for features like `--replay` where re-rendering should be idempotent.

### Different Formatting for Error States vs Success States

**Pattern:** Use italic placeholders for empty content (error/gap states), plain text for legitimate zero counts (success states).

```typescript
// Empty content sections (gaps) — italic placeholders
if (worthClicking.length === 0) {
  return '_Nothing worth clicking this run._\n';
}

if (voices.length === 0) {
  return '_No standout voices this run._\n';
}

// Legitimate zero counts (success) — plain text
if (noise.count === 0) {
  return 'No noise flagged.\n';  // No italics — this is good!
}
```

**Why:** Formatting conveys meaning. Italics signal "this section is usually filled but was empty this time" (a gap). Plain text signals "zero is a valid, positive outcome" (the feed was clean). The operator scans the markdown and immediately knows whether empty sections are unexpected.

**When to apply:** Any output format with optional sections that can be empty for different reasons (no data found vs. no issues detected). Make the formatting match the semantic meaning.

### Return Objects Over Exceptions for Explicit Error Handling

**Pattern:** For orchestration functions that combine multiple operations, return `{ success, data?, error? }` instead of throwing.

```typescript
// GOOD: Explicit success/failure in return type
async function runSummarizerAndRenderMarkdown(params): Promise<{
  success: boolean;
  summaryLine: string;
  errorDetail?: string;
}> {
  const summarizerResult = await summarizeRun(input);
  
  if (summarizerResult.status === 'ok') {
    try {
      const mdResult = await writeSummaryMarkdown({ ... });
      return { success: true, summaryLine: `... — rendered to ${mdResult.path}` };
    } catch (mdError: any) {
      return { 
        success: false, 
        summaryLine: `... — summarized`,
        errorDetail: `markdown render failed: ${mdError.message}` 
      };
    }
  } else {
    return { success: false, summaryLine: `... — summarizer failed` };
  }
}

// Usage
const result = await runSummarizerAndRenderMarkdown(params);
if (result.success) {
  console.log(result.summaryLine);
  process.exit(0);
} else {
  console.log(result.summaryLine);
  if (result.errorDetail) {
    console.log(result.errorDetail);
  }
  process.exit(1);
}
```

**Why:** Makes error handling explicit at call sites. The caller can see all possible outcomes in the type signature. Throwing exceptions hides failure modes and makes it harder to provide contextual error messages or partial results.

**When to apply:** Orchestration functions that combine multiple steps where some steps can fail but you want to preserve partial results or provide detailed error context. Don't use for simple utility functions (those should throw).

### Simple String Concatenation Over Templating Libraries

**Pattern:** For stable output formats (markdown, CLI messages), use string concatenation instead of adding templating dependencies.

```typescript
// GOOD: Simple concatenation
const lines: string[] = [];
lines.push(`# ScrollProxy — ${timestamp}\n`);
lines.push(`**Verdict**: ${summary.feedVerdict}\n`);
lines.push(`## Themes\n`);
lines.push(themes.map(t => `- ${t}`).join('\n') + '\n');
return lines.join('\n');

// BAD: Template library for simple format
import Handlebars from 'handlebars';
const template = Handlebars.compile(templateString);
return template({ summary, timestamp, themes });
```

**Why:** 
1. **Zero dependencies** — No supply-chain risk, no version churn
2. **Explicit** — The format is visible in the code, not hidden in a template file
3. **Simple** — For stable formats (markdown headers, CLI output), concatenation is clearer than templates
4. **Personal tool simplicity** — Vision principle 8

**When to apply:** CLI output, markdown rendering, configuration file generation — any format that's stable and doesn't need i18n or complex conditionals. If the format changes rarely and has < 50 lines of output, concatenation is fine.

**Don't use for:** HTML (XSS risk), SQL (injection risk), or formats with complex escaping rules. Do use templating when you need i18n, partials, or complex conditionals.

### Avoid Premature Abstraction for Placeholder Stubs

Don't create shared utilities for simple placeholder stubs that will be replaced:

```typescript
// src/cli/login.ts and src/cli/replay.ts are both:
console.log('not yet implemented');
process.exit(0);

// Don't create src/utils/notImplemented.ts for this!
// They're 5-line placeholders meant to be replaced in future features.
```

**Why:** Premature abstraction adds indirection and complexity for code that will be deleted soon. Three similar lines of code is better than a premature abstraction.

### Extract Constants for Magic Strings in Error Paths

For error handling and debug paths, extract repeated strings to named constants:

```typescript
const CONFIG_DIR_NAME = 'scrollproxy';
const CONFIG_FILE_NAME = 'config.yaml';
const DEBUG_ENV_VAR = 'scrollproxy';

// Used in multiple error messages:
console.error(`file: ~/${CONFIG_DIR_NAME}/${CONFIG_FILE_NAME}`);
console.error(`(set DEBUG=${DEBUG_ENV_VAR} for full trace)`);
```

**Why:** Error messages often reference the same paths/variables. Constants ensure consistency and make updates (like renaming the debug env var) happen in one place.

### When to Extract vs When to Keep Inline

**Extract when:**
- Complex error handling (50+ lines) → extract to `handleZodValidationError()`
- Repeated logic across 3+ call sites → extract to helper function
- Magic strings in error paths → extract to constants
- Validation + setup logic that appears in multiple similar contexts → extract to `ensureUserDataDir()`
- Success/failure detection with multi-line conditional logic → extract to `isLoginSuccessful()`
- Multi-step conditional logic with clear single responsibility → extract to `calculatePauseDuration()`

**Keep inline when:**
- Logic is already readable (20-line decision tree)
- Used in only one place (`expandTilde` helper, 5 lines)
- Standard values (`utf-8` encoding literal)
- Contextual error messages that reference specific config fields — inline is clearer
- Tightly coupled lifecycle management (try-catch-finally with promise resolution)
- Extraction would require passing 6+ parameters — that's coupling, not clarity
- Each usage needs different values that don't parameterize well (e.g., config YAML strings where each test needs different field values — extracting would require parameterizing every field, making call sites harder to read than inline YAML)

**Why:** Extraction has a cost (indirection, naming, navigation). Only extract when the clarity or reuse benefit outweighs that cost. A 20-line decision tree that reads like prose doesn't need extraction. Contextual error messages benefit from being near the validation logic they describe.

**Extract Till You Drop:** Keep extracting until each function has a single responsibility and is <30 lines. Stop when extraction creates more coupling than it removes (6+ parameters is a signal to stop).

**Don't extract when it hurts performance:**
- Functions that orchestrate sequential browser operations (DOM queries, evaluations) should stay together to minimize round-trips
- Example: `extractQuotedPost()` at 128 lines does all quoted post extraction in a single `page.evaluate()` call — splitting into multiple functions would require multiple round-trips and hurt performance
- Rule: If splitting requires multiple browser context switches, keep it together even if it's long

**Don't abstract when field names and defaults differ:**
- If similar error handling blocks have different field names or default values, abstracting won't improve clarity
- Example: Four metric extractions (replies, reposts, likes, views) each have custom field names and null defaults — extracting a generic "extract metric" helper would require passing field names as parameters, making call sites harder to read
- Rule: If abstraction requires parameterizing what makes each case unique, inline is clearer

**Don't refactor appropriately-sized orchestration functions:**
- Functions that clearly show sequential steps in ~60-70 lines don't need extraction
- Example: `parseArticle()` at 66 lines shows: extract permalink → validate → extract author → extract text → extract timestamp → extract metrics → extract media → extract repost info → extract quoted post → assemble result
- Rule: If the function reads like a clear recipe and fits on one screen, leave it alone

### Exit Codes at Module Level

Extract exit codes from function scope to module level for better organization:

```typescript
// Module level
const EXIT_SUCCESS = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE_ERROR = 2;

export async function handleLogin(config: Config): Promise<void> {
  if (config.browser.headless) {
    console.error('login requires browser.headless: false');
    process.exit(EXIT_USAGE_ERROR);
  }
  // ...
  process.exit(EXIT_SUCCESS);
}
```

**Why:** Named constants make Unix exit code conventions explicit and enable potential reuse across CLI commands. If multiple commands need consistent exit codes, they're defined once at the top.

**Impact:** The Dry-Run Flag feature replaced 15+ magic number exit codes with three named constants across all CLI handlers, proving the pattern scales well for consistency.

### Verb-Specific Parameters in Shared Helpers

**Pattern:** When a shared helper function can be called from multiple CLI commands, add an optional parameter to make error messages context-specific:

```typescript
// Shared validation helper
export function validateFlags(
  flags: Record<string, string | boolean>,
  allowed: string[],
  verb?: string  // Optional verb for context-specific help messages
): void {
  const allowedSet = new Set(allowed);
  
  for (const flag of Object.keys(flags)) {
    if (!allowedSet.has(flag)) {
      const helpHint = verb ? `\`pnpm ${verb} --help\`` : '`--help`';
      throw new Error(`unknown flag: --${flag} (run ${helpHint} for usage)`);
    }
  }
}

// Usage from different commands
validateFlags(flags, ['config'], 'login');    // "run `pnpm login --help`"
validateFlags(flags, ['config'], 'replay');   // "run `pnpm replay --help`"
validateFlags(flags, ['dry-run', 'minutes'], 'scroll');  // "run `pnpm scroll --help`"
```

**Why:** Hardcoding a specific command name (`"pnpm scroll --help"`) in a shared helper produces misleading errors when called from other commands. The optional parameter keeps the helper DRY while making error messages accurate.

**When to apply:** Shared validation, formatting, or error-handling functions that can be invoked from multiple CLI commands. The parameter cost is low (one optional arg) and the UX benefit is high (operator sees the right command in error messages).

### Extract Helper Functions for Path Operations

For path operations that need to happen in multiple phases (validation, creation, display), extract to helpers:

```typescript
// Helper: expand ~ to absolute path
function expandHomeDir(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path === '~') {
    return homedir();
  }
  return path;
}

// Helper: validate and create directory
function ensureUserDataDir(userDataDir: string): void {
  if (existsSync(userDataDir)) {
    const stats = statSync(userDataDir);
    if (!stats.isDirectory()) {
      console.error(`browser.userDataDir must be a directory: ${userDataDir}`);
      process.exit(EXIT_USAGE_ERROR);
    }
  } else {
    mkdirSync(userDataDir, { recursive: true });
  }
}

// Usage
const userDataDir = expandHomeDir(config.browser.userDataDir);
ensureUserDataDir(userDataDir);
```

**Why:** Path expansion and validation are error-prone and need to happen in a specific order (expand, then validate, then create). Extracting to helpers makes the main function's intent clear and ensures the operations happen consistently. The main function went from 108 to ~75 lines — readable without being over-abstracted.

### Extract Regex Patterns to Constants When Used in Browser Context

When the same regex pattern is used multiple times, especially when passed to browser context via `page.evaluate()`, extract it to a constant:

```typescript
// BAD: Duplicated regex pattern in 4 places
await page.evaluate(() => {
  const match = ariaLabel.match(/^([\d.,kKmM]+)/);  // Duplicated!
  // ...
});

// GOOD: Single constant passed to browser context
const METRIC_VALUE_PATTERN = /^([\d.,kKmM]+)/;

await page.evaluate(({ metricPattern }) => {
  const pattern = new RegExp(metricPattern);
  const match = ariaLabel.match(pattern);
  // ...
}, { metricPattern: METRIC_VALUE_PATTERN.source });
```

**Why:** 
1. Single source of truth for the pattern
2. Can't reference constants directly in `page.evaluate()` — must pass `.source` as parameter
3. Eliminates duplication (4 instances → 1 constant)

**When to apply:** Any regex used 2+ times, especially in browser context functions.

### Extract Helper When Logic Appears Twice (If Messaging Differs)

When the same logic appears twice with only messaging differences, extract to a helper with a message parameter:

```typescript
// BAD: Duplicated quarantine logic (~8 lines × 2)
// In schema validation path:
const epochMs = Date.now();
const corruptPath = join(resolvedStateDir, `seen-posts.json.corrupt-${epochMs}`);
await rename(cachePath, corruptPath);
console.log(`dedup cache schema ${version} not supported; quarantined and started fresh`);

// In corruption path:
const epochMs = Date.now();
const corruptPath = join(resolvedStateDir, `seen-posts.json.corrupt-${epochMs}`);
await rename(cachePath, corruptPath);
console.log(`dedup cache corrupt; quarantined to seen-posts.json.corrupt-${epochMs}, starting fresh`);

// GOOD: Single helper with message parameter
async function quarantineCorruptCache(
  cachePath: string,
  resolvedStateDir: string,
  logMessage: string
): Promise<void> {
  const epochMs = Date.now();
  const corruptPath = join(resolvedStateDir, `seen-posts.json.corrupt-${epochMs}`);
  await rename(cachePath, corruptPath);
  console.log(logMessage);
}

// Usage
await quarantineCorruptCache(cachePath, resolvedStateDir, 
  `dedup cache schema ${parsed.schemaVersion} not supported by this build; quarantined and started fresh`);

await quarantineCorruptCache(cachePath, resolvedStateDir,
  `dedup cache corrupt; quarantined to seen-posts.json.corrupt-${epochMs}, starting fresh`);
```

**Why:** Eliminates ~8 lines of duplication. Even when messages differ, the core operation (rename + log) is identical. Parameterizing the message keeps both call sites clear while ensuring the quarantine operation stays consistent.

**When to apply:** When the same multi-line logic (4+ lines) appears twice with only string literals differing. If it appears 3+ times, extraction is mandatory (see next pattern).

### Extract Display Formatting Helper (4+ Occurrences)

When the same formatting pattern appears 4+ times, extract to a helper even if it's simple:

```typescript
// BAD: Duplicated display path formatting (4 occurrences in scroll.ts)
const displayPath1 = rawJsonPath.replace(expandHomeDir('~'), '~');
const displayPath2 = writeResult.rawJsonPath.replace(expandHomeDir('~'), '~');
// ... 2 more times

// GOOD: Single helper function
function formatDisplayPath(path: string): string {
  return path.replace(expandHomeDir('~'), '~');
}

// Usage
const displayPath = formatDisplayPath(rawJsonPath);
```

**Why:** Even simple one-liners benefit from extraction at 4+ call sites. If the formatting rule changes (e.g., also abbreviate `/Users/username`), it's updated in one place. The helper name also documents the intent: "convert absolute paths back to tilde notation for user-friendly display."

**When to apply:** Any formatting/transformation pattern used 4+ times, even if it's a single expression.

### Extract Orchestration Helper to Consolidate Duplicate Update Logic

When the same multi-step orchestration (load → transform → save → format) appears in multiple code paths, extract to a helper that returns the formatted result:

```typescript
// BAD: Duplicated cache update + summary formatting (appears in 2 paths: browser_closed, successful completion)
const cache = await loadDedupCache(stateDir);
const { newPosts, seenPosts, newHashes } = partitionPosts(posts, cache);
const updatedCache = appendHashes(cache, newHashes);
await saveDedupCache(updatedCache, stateDir);
const displayPath = formatDisplayPath(rawJsonPath);
summaryLine += ` — ${newPosts.length} new, ${seenPosts.length} already seen — saved to ${displayPath}`;

// GOOD: Single helper that orchestrates and returns summary fragment
async function updateDedupCacheAndGetSummary(
  posts: ExtractedPost[],
  stateDir: string,
  rawJsonPath: string
): Promise<string> {
  const cache = await loadDedupCache(stateDir);
  const { newPosts, seenPosts, newHashes } = partitionPosts(posts, cache);
  const updatedCache = appendHashes(cache, newHashes);
  await saveDedupCache(updatedCache, stateDir);
  
  const displayPath = formatDisplayPath(rawJsonPath);
  return ` — ${newPosts.length} new, ${seenPosts.length} already seen — saved to ${displayPath}`;
}

// Usage
summaryLine += await updateDedupCacheAndGetSummary(posts, config.output.state, writeResult.rawJsonPath);
```

**Why:** The orchestration appears in both successful completion and browser-closed-with-partial-results paths. Extracting ensures both code paths stay synchronized — if we add a new step (e.g., log cache size), it happens in both places automatically. The helper also has clear single responsibility: "update cache and produce summary fragment."

**When to apply:** Multi-step orchestration (3+ operations) that appears in 2+ code paths. If the steps must stay synchronized, extract even at 2 occurrences (don't wait for 3+).

### Extract Large Data Structures to Constants

When a function contains large inline data structures (like JSON schemas), extract them to module-level constants:

```typescript
// BAD: 60-line schema inline in function
async function callClaude(client, model, prompt) {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [{
      name: 'return_summary',
      description: 'Return the structured summary',
      input_schema: {
        type: 'object',
        properties: {
          themes: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 7 },
          worthClicking: { /* ... 40 more lines ... */ },
          // ...
        },
      },
    }],
    messages: [{ role: 'user', content: prompt }],
  });
}

// GOOD: Extract schema constant
const RETURN_SUMMARY_TOOL: Anthropic.Tool = {
  name: 'return_summary',
  description: 'Return the structured summary of the feed',
  input_schema: {
    type: 'object',
    properties: {
      themes: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 7 },
      worthClicking: { /* ... full schema ... */ },
      // ...
    },
    required: ['themes', 'worthClicking', 'voices', 'noise', 'feedVerdict'],
  },
};

async function callClaude(client, model, prompt) {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    tools: [RETURN_SUMMARY_TOOL],  // Clean!
    messages: [{ role: 'user', content: prompt }],
  });
}
```

**Impact:** Reduced `callClaude` from 115 to ~55 lines. The schema is now reusable, testable in isolation, and doesn't obscure the function's control flow.

**When to apply:** Any inline data structure > 20 lines (especially schemas, config objects, validation rules). Extract when the data structure is stable enough to name and reuse.

### Extract Helper Functions to Consolidate Repeated Field Copying

When building compact/transformed objects from source objects, extract a helper for repeated field copying:

```typescript
// BAD: Repeated field copying in multiple places
const compactPost = {
  id: post.id,
  url: post.url,
  author: post.author,
  text: post.text,
  postedAt: post.postedAt,
  metrics: post.metrics,
  media: post.media,
  isRepost: post.isRepost,
  repostedBy: post.repostedBy,
  quoted: post.quoted ? {
    id: post.quoted.id,      // Duplicated again!
    url: post.quoted.url,
    author: post.quoted.author,
    // ... 6 more fields
  } : null,
};

// GOOD: Extract base transformation
function toCompactPostBase(post: ExtractedPost): Omit<CompactPost, 'quoted'> {
  return {
    id: post.id,
    url: post.url,
    author: post.author,
    text: post.text,
    postedAt: post.postedAt,
    metrics: post.metrics,
    media: post.media,
    isRepost: post.isRepost,
    repostedBy: post.repostedBy,
  };
}

function flattenQuotedChains(post: ExtractedPost): CompactPost {
  return {
    ...toCompactPostBase(post),
    quoted: post.quoted
      ? { ...toCompactPostBase(post.quoted), quoted: null }
      : null,
  };
}
```

**Why:** Eliminates duplication when transforming nested structures. If a field is added to `ExtractedPost`, it's added in one place, not three.

**When to apply:** Any transformation that copies 5+ fields and needs to handle nested structures of the same type.

### Extract Helper Functions to Consolidate Duplicated Logic

When similar code blocks appear 3-4 times with only data differences, extract to a helper function:

```typescript
// BAD: Duplicated failure recording (~20 lines × 4 metrics)
if (rawReplies === null && parsedReplies === null) {
  failures.push({
    field: 'metrics.replies',
    postIdOrIndex: postId,
    tickIndex,
    reason: 'metric element not found',
  });
}
if (rawReposts === null && parsedReposts === null) {
  failures.push({ /* ... */ });
}
// ... 2 more times for likes and views

// GOOD: Single helper function
function recordMetricFailure(
  metricName: string,
  rawValue: string | null,
  parsedValue: number | null,
  postId: string,
  tickIndex: number,
  failures: SelectorFailure[]
): void {
  if (rawValue === null && parsedValue === null) {
    failures.push({
      field: `metrics.${metricName}`,
      postIdOrIndex: postId,
      tickIndex,
      reason: 'metric element not found',
    });
  }
}

// Usage
recordMetricFailure('replies', rawReplies, parsedReplies, postId, tickIndex, failures);
recordMetricFailure('reposts', rawReposts, parsedReposts, postId, tickIndex, failures);
recordMetricFailure('likes', rawLikes, parsedLikes, postId, tickIndex, failures);
recordMetricFailure('views', rawViews, parsedViews, postId, tickIndex, failures);
```

**Why:** Eliminates ~15 lines of duplicated code while improving maintainability. If the failure recording logic changes, update one function instead of four blocks.

**When to apply:** Similar blocks repeated 3+ times where only data (field names, values) differs.

### Orchestrator Interface Design

**Pattern:** When designing orchestrator functions that coordinate multiple operations, return all meaningful signals even if current callers only use a subset.

```typescript
// GOOD: Return full information
export interface RunWritersResult {
  receipts: Array<{ id: string; receipt: WriteReceipt }>;
  markdownSucceeded: boolean;  // CLI needs this for exit code
  anySucceeded: boolean;        // Not used now, but might be needed later
}

export async function runWriters(params): Promise<RunWritersResult> {
  // ... run all writers
  return {
    receipts,
    markdownSucceeded: receipts.some(r => r.id === 'markdown' && r.receipt.ok),
    anySucceeded: receipts.some(r => r.receipt.ok),
  };
}

// Usage: caller selects what matters
const { receipts, markdownSucceeded } = await runWriters(...);
// anySucceeded not used — that's OK, no variable declared for it
```

**Why:** The orchestrator provides full information, consumers select what matters for their logic. Extra return values have minimal overhead. Example: `runWriters()` returns `anySucceeded` even though CLI handlers only check `markdownSucceeded` for exit codes — a future monitoring dashboard might need `anySucceeded`.

**When to apply:** Orchestrator functions that produce multiple meaningful signals. Don't return kitchen-sink objects with 20 fields, but do return the 3-5 core signals that different callers might care about.

**Anti-pattern:** Only returning what the first caller needs, then refactoring the return type when a second caller needs something else. Better to anticipate the obvious signals upfront.

### Static Imports with No Side Effects

**Pattern:** Static imports that load modules at startup are acceptable even for conditional features (like Notion writer for markdown-only runs) as long as the imported module has no side effects.

```typescript
// notion.ts
import { Client } from '@notionhq/client';  // Static import at top

export function createNotionWriter(config: NotionWriterConfig): Writer {
  const client = new Client({ auth: config.token });  // SDK only instantiated here
  // ...
}

// scroll.ts
import { createNotionWriter } from '../writer/notion.js';  // Static import

// Even markdown-only runs pay module load cost, but no auth/network cost
const writers = config.output.destinations.includes('notion')
  ? [markdownWriter, createNotionWriter(notionConfig)]
  : [markdownWriter];
```

**Trade-off:** 
- **Pro:** Simpler code (no dynamic imports, no conditional loading)
- **Con:** Module evaluation cost paid every run (even markdown-only)
- **Acceptable if:** The imported module has no side effects (no I/O, no network calls, no global registration on import)

**How to check:**
1. Does the module perform I/O on import? (file reads, env access)
2. Does it register globals or modify shared state?
3. Does it make network calls?
4. If all "no" → static import is fine

**Example:** `@notionhq/client` SDK defines classes and exports them. The `Client` constructor makes no network calls until methods like `pages.create()` are invoked. Static import is acceptable.

**When to avoid:** Modules that perform expensive initialization on import (database connections, file scanning, heavy parsing). In those cases, use dynamic `await import(...)` inside the conditional path.

### Spec Drift: Aspirational Design vs Sufficient Implementation

**Problem:** Specs written before implementation often describe idealized patterns that turn out to be unnecessary when implementation discovers what's _sufficient_ to meet requirements.

**Example patterns:**
- **Lazy loading** (spec: "dynamic import to reduce startup cost") → Static import chosen (no side effects, simpler code)
- **Debug logging** (spec: "log when reordering destinations for visibility") → Silent reordering chosen (operator doesn't need the noise)
- **Strict validation** (spec: "reject unknown keys with migration hints") → Shallow strict chosen (smoother config migration)

**Why drift happens:** Specs anticipate best practices and optimization opportunities. Implementation discovers trade-offs:
- Is the optimization worth the complexity?
- Does the logging add value or just noise?
- Is fail-loud validation helping or hurting UX?

**This drift is healthy** when the simpler approach still meets all Gherkin scenarios.

**How to reconcile:** 
1. Update the spec to describe what was actually built
2. Add a note explaining why the simpler choice was made
3. Don't create unnecessary complexity in code just to match forward-looking specs

**Root cause:** Tests that don't encode aspirational details allow drift to survive. If the spec said "logs destination reorder" but no test checked for that log line, implementation could skip it without failing tests.

**Learning:** Specs are planning documents, not contracts. If implementation finds a simpler path that meets requirements, the spec should be updated to match reality. Don't leave specs as "what we thought we'd build" — update them to "what we actually built."

**When to apply:** During drift-check or code review, when actual implementation diverges from spec's anticipated patterns. Ask: "Does this divergence still meet the Gherkin scenarios?" If yes, update the spec. If no, fix the implementation.

### Extract URL Constants for Maintainability

Extract URLs used in navigation to named constants:

```typescript
const X_LOGIN_URL = 'https://x.com/login';

await page.goto(X_LOGIN_URL);
```

**Why:** If the URL changes (e.g., X rebrands again), it's updated in one place. The constant name documents what the URL is for.

### Atomic File Write Pattern

**Pattern:** Use tmpfile → rename for crash-safe writes instead of explicit fsync.

```typescript
const tmpPath = rawJsonPath + '.tmp';

// Write to tmpfile first
await writeFile(tmpPath, jsonContent, 'utf-8');

// Rename to final location (atomic on POSIX)
await rename(tmpPath, rawJsonPath);
```

**Why:** POSIX `rename()` is atomic by spec — either the new file appears completely or the old file remains unchanged. If the process crashes between `writeFile` and `rename`, the tmpfile remains but the final file is never corrupted. This is simpler than explicit `fsync()` (which has platform-specific semantics) and sufficient for preventing partial writes.

**When to apply:** Any file that must never appear in a partial state (config files, cache files, run artifacts that downstream tools will consume).

### Generate IDs Early in the Flow

**Pattern:** Generate time-based IDs at the start of a flow, not when they're first needed.

```typescript
// CLI handler (start of flow)
const startedAt = new Date();
const runId = generateRunId(startedAt);

// Later, writer uses the pre-generated ID
await writeRawJson({ runId, ... });
```

**Why:** If the ID is based on a timestamp and used in multiple places (directory name, JSON payload), generating it once ensures all uses agree. Generating it late (e.g., in the writer) would tie the ID to when the write happens, not when the flow started, causing misalignment.

**When to apply:** Run IDs, session IDs, request IDs — anything that needs to be consistent across multiple operations in a flow.

### Error Handling Layering

**Pattern:** Workers throw, orchestrators catch and format.

```typescript
// Worker (utility layer)
export async function writeRawJson(params) {
  await writeFile(tmpPath, content);  // Throws on failure
  await rename(tmpPath, finalPath);   // Throws on failure
  return { runDir, rawJsonPath };
}

// Orchestrator (CLI layer)
try {
  const result = await writeRawJson({ ... });
  console.log(`saved to ${result.rawJsonPath}`);
} catch (error) {
  console.log(`write failed: ${error.message}`);
  process.exit(1);
}
```

**Why:** Keeps error formatting in one place (the layer that knows the user's context) instead of spreading it across utilities. The worker focuses on the operation; the orchestrator decides how to present failures to the user.

**When to apply:** Any utility function called from a CLI handler or orchestrator. Let low-level functions throw; catch and format at the layer that has user context.

---

## Spec Maintenance

### Spec Frontmatter Must List All Entry Points

When a feature has multiple entry files (main implementation + shims for routing), all must be listed in the spec's Source File frontmatter:

```markdown
---
feature: CLI Entry + Arg Parsing
domain: foundation
source: src/cli/index.ts
---

# CLI Entry + Arg Parsing

**Source File**: `src/cli/index.ts`, `src/cli/args.ts`, `src/cli/scroll.ts`, `src/cli/login.ts`, `src/cli/replay.ts`, `src/index.ts`, `src/login.ts`, `src/replay.ts`
```

**Why:** Entry shims (like src/login.ts that routes pnpm login → src/cli/login.ts) are part of the feature's public surface. They may be added during scaffolding after the spec is written. Drift detection needs the complete list to verify alignment. If a file is invoked by package.json scripts or imported by the user, it's an entry point.

### Spec Drift: Anticipated Architecture vs Actual Implementation

**Problem:** Spec anticipated a modular split (e.g., `src/browser/session.ts` for Playwright plumbing), but implementation landed as a simpler inline version in `src/cli/login.ts`.

**Why drift happened:** When writing the spec, it's natural to plan for modularity. During implementation, a 150-line feature doesn't need the extra abstraction. Simpler is better.

**How to reconcile:** Update the spec header and frontmatter to list actual source files, remove nonexistent files. Don't create empty files just to match the spec.

**Learning:** Specs are planning documents, not contracts. If implementation finds a simpler path that still meets all Gherkin scenarios, the spec should be updated to match reality.

### Spec Mockups vs Code Reality: Path Expansion

**Problem:** Spec mockup showed user-friendly shorthand `~/scrollproxy/chrome` in success message, but code expands `~` to absolute path before printing (e.g., `/Users/andrew/scrollproxy/chrome`).

**Why drift happened:** Mockups prioritize readability and use the same vocabulary as config files. Code expands `~` early (before validation) so error messages and success messages all use absolute paths.

**How to reconcile:** Clarify in the spec that `~` is expanded before printing, with a concrete example showing the resolved path.

**Learning:** Mockups should use operator vocabulary, but when there's a mismatch between user input (`~`) and actual output (absolute path), the spec needs a note explaining the transformation.

### Status Field Maintenance Across Phases

**Problem:** Spec status was `specced` after spec creation, but wasn't bumped to `implemented` after tests passed and drift was checked.

**Why drift happened:** The spec was updated during spec creation (status: specced), but the build/refactor/drift agents didn't update it again. Status tracking fell through the cracks.

**How to prevent:** Each phase should update status:
- After spec approved → `status: specced`
- After tests written and passing → `status: tested`
- After implementation complete and drift-checked → `status: implemented`

**Learning:** Status is part of the frontmatter contract. If drift-check agents are reconciling spec vs code, they should also verify status matches reality and update it if needed.

### Interface Forward Compatibility for Pending Features

**Pattern:** Add parameters to interface early for upcoming features, but don't destructure them in function signatures until the feature is actually implemented.

```typescript
// Interface: documents what's coming
export interface ScrollOptions {
  userDataDir: string;
  dryRun: boolean;  // For feature #15 (scheduled for Phase 2), not used yet
  onTick?: (ctx: TickHookContext) => Promise<void>;
}

// Function: only destructure what's used now
export async function runScroll(options: ScrollOptions): Promise<ScrollResult> {
  const { userDataDir, onTick, rng = Math.random } = options;
  // dryRun NOT destructured — will be added when feature #15 lands
}
```

**Why:** Avoids TypeScript TS6133 unused variable errors while keeping interface stable. When feature #15 lands, just add `dryRun` to the destructuring — no signature change needed. Interface changes are cheap; function signature changes require coordination.

**Anti-pattern:** Destructuring unused parameters to "match the interface" creates linter warnings and confusion about what's actually implemented.

### 0-Based Index Documentation in Specs

**Problem:** Code uses 0-based indexing (`tickIndex: 0` for first tick), but test error messages and human language naturally use 1-based counting ("tick 1 hook error" on the 2nd call).

**Solution:** Explicitly document the indexing in the spec:

```markdown
### Scenario: Tick hook exposes the page after each scroll
...
Then `onTick({ page, tickIndex, elapsedMs })` is awaited
And `tickIndex` is 0-indexed (first tick is `tickIndex: 0`)
And if `onTick` throws, the error is logged as `tick <N> hook error: <message>`
```

**Why:** Prevents drift between spec, code, and tests. The spec clarifies that `tickIndex: 0` is the first tick, while the error message uses `tickIndex + 1` for human readability ("tick 1 hook error" when `tickIndex: 0` throws). Without this note, drift agents flag a mismatch between 0-based code and 1-based error messages.

**When to apply:** Any time code uses 0-based indexing but user-facing output (logs, errors, CLI messages) uses 1-based counting, document the mapping in the spec.

### Spec Drift: Hypothetical Names vs Actual Implementation Choices

**Problem:** Spec listed hypothetical constant names (e.g., `METRIC_SELECTORS`, `MEDIA_SELECTORS`) before implementation, but the actual implementation chose a different pattern (finer-grained per-field constants like `PERMALINK_SELECTOR`, `USER_NAME_SELECTOR`, plus a shared regex pattern).

**Why drift happened:** When drafting specs, it's natural to anticipate patterns based on similar features. During implementation, the actual DOM structure and selector stability led to a different (better) choice. The spec wasn't updated when the feature landed.

**How to reconcile:** Update the spec scenario to enumerate the actual constants and patterns in the code. Add a clarifying note about why the implementation differs (e.g., "metrics use aria-label substring matching rather than a dedicated selector constant").

**Root cause:** Specs are written before implementation and contain educated guesses about the solution. Implementation discovers the actual best approach. **Specs must be updated to match what was actually built, not left as a historical record of what was anticipated.**

**Learning:** When drift-checking, look for hypothetical names in specs (especially in "constants at the top of the file" scenarios). If the spec lists specific identifiers, verify they actually exist in the code. Update the spec to match reality rather than expecting implementation to match hypothetical names.

**When to apply:** Any spec scenario that enumerates specific identifiers (constant names, function names, type names) should be verified against actual code during drift-check and updated if they differ.

### Spec Drift: "Same Pattern as Feature X" Can Cause Incomplete Copying

**Problem:** Spec stated "uses the same atomic-write pattern as feature 7" and described all stylistic details from feature 7 (2-space indentation, UTF-8, trailing newline). Implementation copied the atomic write pattern (`tmpfile → rename`) but NOT the trailing newline. Spec initially claimed both files have trailing newlines; code only added it to one.

**Why drift happened:** When specs reference prior features with "same as feature X", it's natural to assume all aspects transfer. During implementation, only the core pattern (atomic write) was needed; the cosmetic detail (trailing newline) was intentionally skipped for the state file since it's internal plumbing, not a user-inspected artifact like `raw.json`.

**How to reconcile:** Update the spec to explicitly enumerate what's shared vs what differs:

```markdown
### Scenario: Atomic save pattern (same as feature 7, but no trailing newline)

...
Then `saveDedupCache` writes using the same atomic-write pattern as feature 7
  (tmpfile → rename for crash safety)
And the payload is serialized with `JSON.stringify(payload, null, 2)`
  (2-space indentation, UTF-8, no trailing newline)
And unlike feature 7's raw.json, state files do NOT append '\n'
  (state files are internal plumbing, not user-inspected artifacts)
```

**Root cause:** "Same as X" specs are underspecified. They assume readers will know which aspects to copy and which to adapt. Implementation makes judgment calls about what "same as" means, and those calls may differ from spec author's intent.

**Learning:** When specs reference another feature's pattern, be explicit:
1. What's shared (atomic write via tmpfile → rename)
2. What's intentionally different (no trailing newline)
3. Why the difference matters (internal vs user-facing files)

**When to apply:** Any time a spec says "same as feature X", "mirrors feature Y's approach", or "uses the pattern from Z". List the shared elements explicitly and note any intentional differences.

### Spec Drift: Forward-Looking Specs vs Simpler Implementation

**Problem:** Spec described an idealized implementation with explicit `fsync()` for atomicity, but the actual implementation used a simpler `writeFile + rename` pattern that's sufficient on POSIX filesystems.

**Why drift happened:** When writing specs before implementation, it's natural to anticipate best-practice patterns (like explicit fsync for durability). During implementation, discovering that POSIX `rename()` atomicity is sufficient leads to a simpler solution. The spec wasn't updated when the simpler approach was chosen.

**How to reconcile:** Update the spec to describe the actual implementation pattern, with a note explaining why it's sufficient (e.g., "POSIX rename atomicity prevents partial writes; explicit fsync not needed"). Don't create unnecessary complexity in code just to match a forward-looking spec.

**Root cause:** Specs are planning documents, not contracts. If implementation finds a simpler path that still meets all Gherkin scenarios (atomic writes, crash safety), the spec should be updated to match reality.

**Learning:** When drift-checking, look for implementation details in specs (especially in "how it works" scenarios). If the spec describes a technique that wasn't actually used, verify the actual approach still meets the requirement, then update the spec to document what was built.

**When to apply:** Any spec scenario that describes implementation techniques (fsync, transactions, locks, caching strategies) rather than behavioral outcomes. Verify the code uses those techniques or update the spec to describe the actual approach.

---

## JavaScript Gotchas

### slice(-0) Returns Full Array, Not Empty Array

**Gotcha:** JavaScript's `slice(-0)` doesn't behave like other negative indices — it returns the full array instead of an empty array.

```typescript
// Expected behavior with limit=0
const items = [1, 2, 3, 4, 5];
const result = items.slice(-0);  // ❌ Returns [1, 2, 3, 4, 5], not []

// Solution: explicit check
if (limit === 0) {
  return [];
}
const result = items.slice(-limit);  // Now safe for all positive limits
```

**Why:** JavaScript treats `-0` as `0` when slicing, and `slice(0)` returns the entire array from index 0. Other negative indices work as expected (`slice(-1)` gets last item, `slice(-2)` gets last two), but `-0` is a special case.

**When it surfaces:** Functions that take a `limit` parameter and use `slice(-limit)` to get the last N items. The `limit=0` edge case requires explicit handling.

**Real-world impact:** Test failure on `recentThemes(store, 0)` expected `[]` but got all themes. The `Math.min(limit, store.runs.length)` approach alone was insufficient — the explicit zero-check is mandatory.

### Timestamp Mismatch Between Caller and Function

**Problem:** When both a function and its caller calculate timestamps independently, the logged filename doesn't match the actual filename.

```typescript
// BAD: Function calculates its own timestamp
async function quarantineCorruptFile(themesPath: string, resolvedStateDir: string): Promise<void> {
  const epochMs = Date.now();  // Calculated here
  const corruptPath = join(resolvedStateDir, `rolling-themes.json.corrupt-${epochMs}`);
  await rename(themesPath, corruptPath);
}

// Caller also calculates timestamp for logging
catch (error) {
  const epochMs = Date.now();  // Calculated here (different timestamp!)
  await quarantineCorruptFile(themesPath, resolvedStateDir);
  console.log(`quarantined to rolling-themes.json.corrupt-${epochMs}`);  // Wrong!
}

// GOOD: Function returns the timestamp it uses
async function quarantineCorruptFile(
  themesPath: string, 
  resolvedStateDir: string
): Promise<number> {  // Returns timestamp
  const epochMs = Date.now();
  const corruptPath = join(resolvedStateDir, `rolling-themes.json.corrupt-${epochMs}`);
  await rename(themesPath, corruptPath);
  return epochMs;  // Caller uses this for logging
}

// Caller uses returned timestamp
const epochMs = await quarantineCorruptFile(themesPath, resolvedStateDir);
console.log(`quarantined to rolling-themes.json.corrupt-${epochMs}`);  // Correct!
```

**Why:** The two `Date.now()` calls happen milliseconds apart. The function's call determines the actual filename, but the caller's call determines the logged filename. They can differ, making the log message misleading.

**Root cause:** Functions that perform file operations with timestamps should return the timestamp they used, not expect callers to calculate it independently.

**When to apply:** Any function that generates timestamped filenames, temporary files, or backup files. Return the timestamp so callers can log accurately or use it in other operations.
