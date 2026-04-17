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
