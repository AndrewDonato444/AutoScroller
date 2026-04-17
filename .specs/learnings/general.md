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

---

## Debugging

<!-- Common issues, debugging techniques -->

_No learnings yet._

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
