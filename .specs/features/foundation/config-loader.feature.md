---
feature: Config Loader
domain: foundation
source: src/config/load.ts
tests:
  - tests/foundation/config-loader.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-16
---

# Config Loader

**Source File**: `src/config/load.ts`, `src/config/schema.ts`, `src/config/defaults.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: YAML config file + Zod validation

The operator wants to hand-edit one YAML file to control how `pnpm scroll` behaves — how many minutes to scroll, how aggressive the human-like jitter is, which interests to nudge the summarizer toward, and where output goes. They hate setup wizards and OAuth dances; they love editing a YAML file and having the tool fail loudly when they typo something.

This feature ships a `loadConfig()` function that:

1. Looks for `config.yaml` in a known order of locations (explicit path → `./config.yaml` in repo → `~/scrollproxy/config.yaml`).
2. If none is found, writes a default `config.yaml` to `~/scrollproxy/config.yaml` on first run and loads that.
3. Parses YAML, validates against a Zod schema, and returns a typed `Config` object.
4. On any validation error, exits with a clear, operator-friendly message naming the field, the problem, and the file path — no stack traces in the happy-error path.

Nothing else in the system is wired up yet. This feature is the contract every future feature reads from.

### Scenario: First run with no config writes a default and loads it

Given the operator has just cloned the repo and has no `~/scrollproxy/config.yaml`
And no `config.yaml` exists in the repo root
When `loadConfig()` is called with no explicit path
Then a default `config.yaml` is written to `~/scrollproxy/config.yaml`
And the file contains commented sections for `scroll`, `browser`, `interests`, `output`, and `claude`
And the default values match the schema's documented defaults
And the loaded config matches those defaults
And a one-line message prints: `wrote default config to ~/scrollproxy/config.yaml — edit and re-run`

### Scenario: Explicit config path wins over defaults

Given a valid `config.yaml` exists at `/tmp/my-config.yaml`
And a different `config.yaml` exists in the repo root
When `loadConfig({ path: '/tmp/my-config.yaml' })` is called
Then the config at `/tmp/my-config.yaml` is loaded
And the repo-root and `~/scrollproxy/` configs are ignored

### Scenario: Repo-root config overrides home-dir config

Given `./config.yaml` exists in the repo root with `scroll.minutes: 5`
And `~/scrollproxy/config.yaml` exists with `scroll.minutes: 10`
When `loadConfig()` is called with no explicit path
Then `./config.yaml` is loaded
And the returned config has `scroll.minutes: 5`

### Scenario: Invalid YAML fails fast with the file path

Given `config.yaml` contains malformed YAML (e.g. unbalanced quotes, bad indentation)
When `loadConfig()` is called
Then the process exits with a non-zero status
And stderr names the file path
And stderr names the line and column where YAML parsing failed
And no stack trace is printed unless `DEBUG=scrollproxy` is set

### Scenario: Zod schema violation fails fast with the field name

Given `config.yaml` sets `scroll.minutes: "ten"` (string, not number)
When `loadConfig()` is called
Then the process exits with a non-zero status
And stderr names the field path (`scroll.minutes`)
And stderr names the expected type (`number`) and what was received (`string "ten"`)
And stderr names the file path so the operator knows what to edit
And no stack trace unless `DEBUG=scrollproxy` is set

### Scenario: Unknown fields are rejected (strict mode)

Given `config.yaml` contains a top-level `analytics: { enabled: true }` block
When `loadConfig()` is called
Then the process exits with a non-zero status
And stderr names the unknown field (`analytics`)
And the message suggests checking for a typo or removing the field
(Anti-persona guardrail: prevents silently accepting fields like `oauth`, `telemetry`, `webhook_url` that don't belong in a personal tool.)

### Scenario: Defaults fill in for omitted optional fields

Given `config.yaml` contains only `scroll: { minutes: 10 }`
When `loadConfig()` is called
Then the returned config has `scroll.minutes: 10`
And all other fields (`browser.*`, `output.*`, `claude.*`, `interests`) are populated from schema defaults
And no errors are printed

### Scenario: Required secrets are surfaced clearly when missing

Given `config.yaml` omits `claude.apiKey`
And the environment variable `ANTHROPIC_API_KEY` is not set
When `loadConfig()` is called
Then validation passes (the key is optional at load time)
And the returned config has `claude.apiKey: undefined`
(Reason: this feature loads config only. Feature 12 — Summarizer — is responsible for failing loud when the key is actually needed. Keeping it optional here means `pnpm scroll --dry-run` can run without a Claude key.)

### Scenario: Numeric bounds are enforced

Given `config.yaml` sets `scroll.minutes: 0`
When `loadConfig()` is called
Then validation fails with a bounds message (`scroll.minutes must be >= 1`)

Given `config.yaml` sets `scroll.minutes: 999`
When `loadConfig()` is called
Then validation fails with a bounds message (`scroll.minutes must be <= 120`)

### Scenario: Output directory is tilde-expanded

Given `config.yaml` sets `output.dir: ~/scrollproxy/runs`
When `loadConfig()` is called
Then the returned config has `output.dir` resolved to the absolute path (e.g. `/Users/andrew/scrollproxy/runs`)
And the directory is NOT created at load time (the writer feature owns that)

### Scenario: Interests list is trimmed and deduplicated

Given `config.yaml` sets `interests: [" AI product strategy ", "ai product strategy", "sales enablement"]`
When `loadConfig()` is called
Then the returned config has `interests: ["AI product strategy", "sales enablement"]`
(Case-insensitive dedup, whitespace trimmed. Order preserved from first occurrence.)

## User Journey

1. Operator runs `pnpm scroll` for the first time.
2. **Config loader writes `~/scrollproxy/config.yaml` and prints `edit and re-run`.**
3. Operator opens the file, sets `scroll.minutes`, maybe adds interests, saves.
4. Runs `pnpm scroll` again — config loads, feature 3 (CLI) takes over.

If the operator typos a field, they see a one-line error that names the file, the field, and what's wrong. They fix it and re-run. No wizard, no prompt.

## Config Shape (Reference)

The schema defines the exact shape. This is a human-readable sketch, not a source of truth:

```yaml
# ~/scrollproxy/config.yaml
scroll:
  minutes: 10              # how long to scroll (1..120)
  jitterMs: [400, 1400]    # min/max pause between wheel ticks
  longPauseEvery: 25       # take a long pause every N ticks
  longPauseMs: [3000, 8000]

browser:
  userDataDir: ~/scrollproxy/chrome
  headless: false          # must be false for login run
  viewport: { width: 1280, height: 900 }

interests:
  - AI product strategy
  - distribution and indie dev
  - sales enablement
  - sports betting analytics

output:
  dir: ~/scrollproxy/runs
  state: ~/scrollproxy/state
  format: markdown         # 'markdown' only in v1

claude:
  model: claude-sonnet-4-6
  apiKey: null             # optional; env ANTHROPIC_API_KEY overrides
```

## CLI Mockup

Success path on first run:

```
$ pnpm scroll
  wrote default config to ~/scrollproxy/config.yaml — edit and re-run
$
```

Typo path:

```
$ pnpm scroll
  config error: scroll.minutes — expected number, got string "ten"
  file: ~/scrollproxy/config.yaml
  (set DEBUG=scrollproxy for full trace)
$
```

Unknown-field path:

```
$ pnpm scroll
  config error: unknown field "analytics" at top level
  file: ~/scrollproxy/config.yaml
  (remove the field, or check the schema in src/config/schema.ts)
$
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- CLI arg parsing (feature 3) — `loadConfig` is called from `src/index.ts` directly here; arg overrides come later.
- Actually using any of the config values (scroller, extractor, claude) — later features consume; this one only loads and validates.
- Creating output directories — writer feature owns that (feature 7 for raw JSON, feature 13 for markdown).
- `.env` / environment variable merging beyond the single `ANTHROPIC_API_KEY` override — keep it narrow.
- Live config reload — load-once semantics only.

## Persona Revision Notes

Drafted in operator vocabulary: **config**, **feed**, **run**, **operator**, **scroll**. The YAML field names match the vocabulary too — `scroll.minutes`, not `session.duration`; `interests`, not `topics_of_interest`.

Patience-level alignment: High for setup (operator is happy to edit YAML) → Very Low for daily use (config loads silently and succeeds, or fails with one line pointing at the exact field). No retries, no prompts, no "would you like me to fix this?" interactive recovery. The operator would rather see a typo report and fix it in their editor than be walked through a wizard.

Anti-persona check: strict-mode schema rejects unknown fields by design. A contributor cannot quietly add `analytics.enabled: true` or `oauth.clientId` without the loader screaming. This is the guardrail that keeps the tool from drifting toward the hosted-product shape the anti-persona would expect.

Frustrations addressed:
- "Tools that hide what they're doing" → error messages name the exact field and file.
- "Broken automation that fails silently" → Zod strict-mode + non-zero exit on any validation failure.
- "Setup wizards, onboarding flows" → first-run writes a default file and exits. No prompts.
- "Tools that summarize by averaging everything into mush" → interests list is explicit and operator-controlled, so the future summarizer gets a sharp hint about what matters.

## Learnings

<!-- Updated via /compound after implementation -->
