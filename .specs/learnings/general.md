# General Learnings

Patterns that don't fit other categories.

---

## Code Style

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

### Named Constants for Magic Strings

Extract repeated strings to named constants:

```typescript
const STATUS_MESSAGE = 'feed not yet wired';
console.log(`${packageJson.name} v${packageJson.version} — ${STATUS_MESSAGE}`);
```

**Why:** Self-documenting code. The constant name explains what the string means, and changes only need to happen in one place.

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

**Keep inline when:**
- Logic is already readable (20-line decision tree)
- Used in only one place (`expandTilde` helper, 5 lines)
- Standard values (`utf-8` encoding literal)

**Why:** Extraction has a cost (indirection, naming, navigation). Only extract when the clarity or reuse benefit outweighs that cost. A 20-line decision tree that reads like prose doesn't need extraction.
