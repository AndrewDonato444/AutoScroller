---
feature: Project Scaffold
domain: foundation
source: package.json
tests:
  - tests/foundation/project-scaffold.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-16

---

# Project Scaffold

**Source File**: `package.json`, `tsconfig.json`, `.nvmrc`, `src/index.ts`, `src/cli/login.ts`, `src/cli/replay.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: TypeScript + pnpm + Node 20 project scaffold

The first thing the operator needs is a working repo they can `pnpm install` into and run a single command from. No browser automation yet, no Claude calls — just a TypeScript project that boots, prints a version banner, and exits cleanly. This is the floor everything else stands on.

The operator is highly technical and lives in a terminal, so the scaffold should fail loudly if Node is the wrong version, install fast with pnpm, and produce a `pnpm scroll` command that runs end-to-end (even if all it does today is print "scrollproxy v0.0.1 — feed not yet wired").

### Scenario: Fresh clone installs cleanly on Node 20+

Given the operator has Node 20 or newer installed
And pnpm 8 or newer installed
When they run `pnpm install` in the repo
Then dependencies install without errors
And no peer-dependency warnings block the install
And `node_modules/typescript` is present

### Scenario: pnpm scroll runs the CLI entry

Given dependencies are installed
When the operator runs `pnpm scroll`
Then the process executes `src/index.ts` via the TypeScript runtime
And it prints a one-line banner including the package name and version (e.g. `scrollproxy v0.0.1`)
And it exits with status code 0

### Scenario: Wrong Node version fails fast with a clear message

Given the operator is on Node 18 (below the required 20)
When they run `pnpm install` or `pnpm scroll`
Then the engines check rejects the install or run
And the error names the required version (Node >= 20)
And the operator is not left guessing what went wrong

### Scenario: TypeScript strict mode is on from day one

Given a contributor opens `tsconfig.json`
When they inspect compiler options
Then `strict` is true
And `noImplicitAny`, `strictNullChecks`, and `noUnusedLocals` are effectively enabled
And the build target is at least ES2022 with NodeNext module resolution

### Scenario: Repo layout matches the documented module boundaries

Given a contributor opens the repo
When they look at `src/`
Then they see directories that map 1:1 to the vision's core modules:
  - `src/cli/` (CLI entry, arg parsing — added in feature 3)
  - `src/scroller/` (Playwright scroller — added in feature 5)
  - `src/extractor/` (DOM parsing — added in feature 6)
  - `src/summarizer/` (Claude — added in feature 12)
  - `src/writer/` (markdown writer — added in feature 13)
  - `src/state/` (dedup, themes — added in feature 10)
  - `src/config/` (YAML + Zod — added in feature 2)
And only `src/index.ts` and `src/cli/` placeholders ship in this feature; the others are empty placeholder directories with `.gitkeep` so future features land in the expected place

### Scenario: License, README, and .gitignore are present and correct for a personal tool

Given the operator clones the repo
When they look at the root
Then `README.md` describes ScrollProxy in one paragraph and lists `pnpm install`, `pnpm login`, `pnpm scroll`
And `.gitignore` excludes `node_modules/`, `dist/`, `.env`, `.env.local`, `~/scrollproxy/` is N/A (lives outside repo) but local `runs/`, `state/`, and any `*.log` are excluded
And the existing `LICENSE` is unchanged

### Scenario: pnpm scripts are verbs, not nouns

Given a contributor opens `package.json`
When they read the `scripts` section
Then commands are named as verbs the operator types: `scroll`, `login`, `replay`, `dev`, `build`, `typecheck`
And there are no noun-style scripts like `extraction-service` or `summarizer-runner`
(Replay/login may be stubs that print "not yet implemented" and exit 0 — the names are reserved so future features slot in without renaming.)

### Scenario: No hosted-product dependencies sneak in

Given a contributor reviews `package.json`
When they look at dependencies
Then there is no auth library, no OAuth client, no analytics SDK, no telemetry beacon, no hosted-error-reporting service
And the only runtime deps in this feature are TypeScript tooling (tsx or ts-node) and what is strictly required to print a version banner

## User Journey

1. Operator clones the repo on their Mac.
2. **They run `pnpm install` and then `pnpm scroll` to confirm the floor works.**
3. They proceed to feature 2 (config loader) once the banner prints.

The operator never sees a setup wizard. The whole onboarding is: clone, install, run one command, see a banner. If any of those fail, they get a terminal error pointing at the exact thing to fix (Node version, missing pnpm, etc.).

## CLI Mockup

There is no UI. The "mockup" is the terminal session the operator sees on first run:

```
$ git clone <repo> && cd AutoScroller
$ pnpm install
  Lockfile is up to date, resolution step is skipped
  Packages: +<n>
  Done in 4.2s

$ pnpm scroll
  scrollproxy v0.0.1 — feed not yet wired
$
```

And the failure path on the wrong Node version:

```
$ pnpm install
  ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported engine
  Your Node version is incompatible with "scrollproxy@0.0.1".
  Expected: >=20.0.0
  Got: 18.19.0
$
```

That terminal output IS the user interface for this feature. No colors, no spinners, no progress bars, no ascii art. The operator wants signal: did it work, what version, what to fix.

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Config loading (feature 2)
- Real CLI argument parsing (feature 3) — this feature only ships `pnpm scroll` as a script that runs `src/index.ts`
- Playwright install (feature 4)
- Anything that requires network calls

Note: Test runner setup (vitest) shipped with this feature so the scaffold itself could be verified (UT-001 through UT-006 in `tests/foundation/project-scaffold.test.ts`). Originally planned for feature 2 (Zod schema), but pulling it forward cost nothing and gave the scaffold its own regression coverage.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **scroll**, **run**, **login**, **feed**, **operator**. No "user", no "session", no "authenticate", no "task". Commands named as verbs (`scroll`, `login`, `replay`) per the persona's stated preference.

Patience-level alignment: operator is High-patience for setup, Very-Low for daily use. This feature is pure setup, so a slightly opinionated repo structure (placeholder directories matching future modules) is acceptable — it pays off in every later feature by giving them a known place to land. Daily-use surface is just `pnpm scroll`, which is one command and one line of output.

Anti-persona check: explicitly excluded auth libraries, OAuth clients, telemetry, and hosted-product dependencies. The scaffold cannot accidentally drift toward a hosted SaaS shape because there is no place for those deps to live without a contributor noticing.

Frustrations addressed:
- "Tools that hide what they're doing" → banner prints version and a clear "feed not yet wired" message so the operator knows the floor works without misleading them into thinking the feed is ready.
- "Broken automation that fails silently" → engines field on package.json makes wrong-Node failures loud and immediate.
- "Setup wizards, onboarding flows" → install + one command. No prompts.

## Learnings

### Test Strategy

**Pull test runner forward if it gives regression coverage with zero implementation cost.** Originally planned to add vitest in feature 2 (Zod schema), but pulling it forward to feature 1 (scaffold) cost nothing and gave the scaffold its own regression tests (UT-001 through UT-006). This pattern applies to any foundational infrastructure: if the tool is needed eventually and can validate the current feature without scope creep, ship it now.

### Spec Maintenance

**Keep "Source File" header and "Out of Scope" in sync with actual implementation decisions.** The spec header initially listed only 4 source files but the implementation shipped 6 (added src/cli/login.ts and src/cli/replay.ts as placeholder stubs). The "Out of Scope" section said "test runner setup in feature 2" but vitest shipped in this feature. Drift was caught in Layer 2 check and reconciled. Lesson: when scope evolves during implementation, update the spec header and exclusions before committing.
