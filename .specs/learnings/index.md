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
