# General Learnings

Patterns that don't fit other categories.

---

## Code Style

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

**Keep inline when:**
- Logic is already readable (20-line decision tree)
- Used in only one place (`expandTilde` helper, 5 lines)
- Standard values (`utf-8` encoding literal)
- Contextual error messages that reference specific config fields — inline is clearer
- Tightly coupled lifecycle management (try-catch-finally with promise resolution)

**Why:** Extraction has a cost (indirection, naming, navigation). Only extract when the clarity or reuse benefit outweighs that cost. A 20-line decision tree that reads like prose doesn't need extraction. Contextual error messages benefit from being near the validation logic they describe.

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

### Extract URL Constants for Maintainability

Extract URLs used in navigation to named constants:

```typescript
const X_LOGIN_URL = 'https://x.com/login';

await page.goto(X_LOGIN_URL);
```

**Why:** If the URL changes (e.g., X rebrands again), it's updated in one place. The constant name documents what the URL is for.

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
