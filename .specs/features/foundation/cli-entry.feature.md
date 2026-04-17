---
feature: CLI Entry + Arg Parsing
domain: foundation
source: src/cli/index.ts
tests:
  - tests/foundation/cli-entry.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: implemented
created: 2026-04-16
updated: 2026-04-16

---

# CLI Entry + Arg Parsing

**Source File**: `src/cli/index.ts`, `src/cli/args.ts`, `src/cli/scroll.ts`, `src/cli/login.ts`, `src/cli/replay.ts`, `src/index.ts`, `src/login.ts`, `src/replay.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Verb-based CLI with minimal flag parsing

The operator types one of three verbs and gets on with their day: `pnpm scroll` (the whole point), `pnpm login` (first-run browser auth, wired in feature 4), and `pnpm replay <run-id>` (re-summarize an old raw.json, wired in feature 14). Flags are few and obvious: `--minutes <n>` overrides the config's `scroll.minutes`, `--dry-run` skips the summarizer and writer once those exist, and `--help` prints the three-line usage summary the operator will forget and re-check once a month.

This feature ships the CLI skeleton: parse args, route to the right command, hand off to the config loader, exit cleanly with the right code. No browser automation yet (feature 4), no summarizer (feature 12), no real writer (feature 13). The command handlers are stubs that print "not yet wired" where the real work will plug in. The parsing, routing, and error plumbing are real.

The operator has **High** patience for setup and **Very Low** patience for daily use. So: no interactive prompts, no "did you mean...?" suggestions, no wizard. Bad args produce a one-line error pointing at the offending flag and an exit code of 2 (standard Unix convention for usage errors). Unknown verbs are rejected loudly. Help text fits on one screen and lists verbs as verbs, not nouns.

### Scenario: `pnpm scroll` with no args loads config and invokes the scroll handler

Given a valid `~/scrollproxy/config.yaml` exists with `scroll.minutes: 10`
When the operator runs `pnpm scroll`
Then the config is loaded via `loadConfig()` with no explicit path
And the scroll handler is invoked with the loaded config and an empty flag set
And the effective `scroll.minutes` passed to the handler is `10` (from config)
And the process exits with status `0` on success

### Scenario: `--minutes` overrides config's `scroll.minutes`

Given a valid config with `scroll.minutes: 10`
When the operator runs `pnpm scroll --minutes 3`
Then the scroll handler receives an effective `scroll.minutes` of `3`
And the underlying config object is not mutated (override lives in the merged runtime object)

### Scenario: `--minutes` rejects non-integers and out-of-bounds values

Given any valid config
When the operator runs `pnpm scroll --minutes abc`
Then stderr names the flag: `--minutes must be an integer between 1 and 120`
And the process exits with status `2`

When the operator runs `pnpm scroll --minutes 0`
Then stderr names the flag: `--minutes must be an integer between 1 and 120`
And the process exits with status `2`

When the operator runs `pnpm scroll --minutes 9999`
Then stderr names the flag: `--minutes must be an integer between 1 and 120`
And the process exits with status `2`

(Bounds mirror the config schema in `src/config/schema.ts` so the CLI and config are never out of sync.)

### Scenario: `--dry-run` is parsed as a boolean and reaches the handler

Given any valid config
When the operator runs `pnpm scroll --dry-run`
Then the scroll handler receives `dryRun: true` in its flags
And the current stub behavior prints `scrollproxy v0.0.1 — dry-run: scroll + extract only, summarizer and writer skipped — feed not yet wired`
And the process exits with status `0`
(Real skip logic lands in features 6, 7, 12, 13. This feature just makes sure the flag is parsed and threaded through.)

### Scenario: `--config <path>` overrides the config search order

Given a valid `config.yaml` exists at `/tmp/my-config.yaml` with `scroll.minutes: 2`
And a different `config.yaml` exists in the repo root with `scroll.minutes: 10`
When the operator runs `pnpm scroll --config /tmp/my-config.yaml`
Then `loadConfig({ path: '/tmp/my-config.yaml' })` is called
And the scroll handler receives an effective `scroll.minutes` of `2`

### Scenario: Unknown flag fails fast with the flag name

Given any valid config
When the operator runs `pnpm scroll --telemetry`
Then stderr reads: `unknown flag: --telemetry (run \`pnpm scroll --help\` for usage)`
And the process exits with status `2`
(Anti-persona guardrail: mirrors the config loader's strict-mode rejection of unknown fields. Flags like `--telemetry`, `--analytics`, `--webhook` have no place in a personal tool and should not silently no-op.)

### Scenario: Unknown verb fails fast

Given the entry script routes by verb
When the operator runs `pnpm scroll` but passes a positional verb like `tsx src/cli/index.ts foo`
Then stderr reads: `unknown command: foo (expected one of: scroll, login, replay)`
And the process exits with status `2`
(Most users hit this via `pnpm scroll|login|replay`, but the dispatcher is exposed so direct invocations are possible. An unknown verb must not fall through to a default.)

### Scenario: `--help` prints a one-screen usage summary and exits 0

Given the operator has forgotten the flags
When they run `pnpm scroll --help` (or `pnpm scroll -h`)
Then stdout prints a usage block that lists:
  - three verbs: `scroll`, `login`, `replay <run-id>`
  - three flags: `--minutes <n>`, `--dry-run`, `--config <path>`
  - one environment variable: `ANTHROPIC_API_KEY`
And nothing else — no ASCII banner, no colors, no "see the website"
And the process exits with status `0`

### Scenario: `--version` prints the package version and exits 0

Given `package.json` declares `version: "0.0.1"`
When the operator runs `pnpm scroll --version` (or `-v`)
Then stdout prints exactly: `scrollproxy v0.0.1`
And the process exits with status `0`

### Scenario: `pnpm login` routes to the login handler (stub for now)

Given the operator has not yet logged in
When they run `pnpm login`
Then the login handler is invoked
And the current stub prints: `scrollproxy login — not yet wired (feature 4)`
And the process exits with status `0`
(Feature 4 replaces the stub with real Playwright-based login. This feature just ensures the verb routes.)

### Scenario: `pnpm replay <run-id>` routes to the replay handler (stub for now)

Given the operator passes a run-id as a positional arg
When they run `pnpm replay 2026-04-16-0830`
Then the replay handler is invoked with `runId: '2026-04-16-0830'`
And the current stub prints: `scrollproxy replay 2026-04-16-0830 — not yet wired (feature 14)`
And the process exits with status `0`

### Scenario: `pnpm replay` with no run-id fails with a usage hint

Given the replay verb requires a positional argument
When the operator runs `pnpm replay` with no args
Then stderr reads: `replay requires a run-id: pnpm replay <run-id>`
And the process exits with status `2`

### Scenario: Config-loader errors surface through the CLI unchanged

Given `config.yaml` contains an unknown field (e.g. `analytics: { enabled: true }`)
When the operator runs `pnpm scroll`
Then the config loader's strict-mode error is printed verbatim
And the process exits with the non-zero status the config loader already uses
(The CLI does not catch, rewrap, or swallow config errors. The loader's message format is the contract.)

### Scenario: Flags come after the verb; positionals are preserved for the verb

Given the dispatcher parses `<verb> [flags] [positionals]`
When the operator runs `pnpm replay 2026-04-16-0830 --config /tmp/alt.yaml`
Then the replay handler receives `runId: '2026-04-16-0830'` and `config` loaded from `/tmp/alt.yaml`
(Flags must be parsed relative to the verb, not the top-level script, so future verbs can add their own positionals without ambiguity.)

### Scenario: No hosted-product CLI dependencies

Given a contributor reviews `package.json`
When they look at dependencies added for this feature
Then no heavy CLI framework is present (no commander, no yargs, no oclif)
And the parser is a small hand-rolled module in `src/cli/args.ts` — under ~150 lines, no runtime deps
(Anti-persona guardrail: big CLI frameworks drag in plugin ecosystems, colored help themes, update notifiers, telemetry beacons. The operator wants a terminal tool, not a product.)

## User Journey

1. Operator has already seen `pnpm install` succeed and `~/scrollproxy/config.yaml` written on first run (features 1 and 2).
2. **They run `pnpm scroll` — the CLI parses args, loads config, routes to the scroll handler, prints the current stub message, exits 0.**
3. They run `pnpm scroll --minutes 3 --dry-run` to confirm flags are plumbed.
4. They run `pnpm scroll --help` once to re-check syntax and move on.
5. Feature 4 replaces the login stub with real Playwright login; the routing defined here does not change.

The CLI surface the operator sees daily is exactly three commands, three flags, and one environment variable. That's the whole contract. Everything else is implementation detail.

## CLI Mockup

Normal daily run:

```
$ pnpm scroll
  scrollproxy v0.0.1 — feed not yet wired (effective minutes: 10)
$
```

Dry-run:

```
$ pnpm scroll --dry-run
  scrollproxy v0.0.1 — dry-run: scroll + extract only, summarizer and writer skipped — feed not yet wired
$
```

Minute override:

```
$ pnpm scroll --minutes 3
  scrollproxy v0.0.1 — feed not yet wired (effective minutes: 3)
$
```

Help:

```
$ pnpm scroll --help
  scrollproxy v0.0.1 — scroll the feed, save the signal

  usage:
    pnpm scroll   [--minutes <n>] [--dry-run] [--config <path>]
    pnpm login    [--config <path>]
    pnpm replay   <run-id> [--config <path>]

  flags:
    --minutes <n>    override scroll.minutes from config (1..120)
    --dry-run        scroll + extract only, skip summarizer + writer
    --config <path>  load config from an explicit path
    --help, -h       show this message
    --version, -v    print version

  env:
    ANTHROPIC_API_KEY  used by the summarizer (feature 12)
$
```

Bad flag:

```
$ pnpm scroll --telemetry
  unknown flag: --telemetry (run `pnpm scroll --help` for usage)
$ echo $?
2
```

Bad value:

```
$ pnpm scroll --minutes ten
  --minutes must be an integer between 1 and 120
$ echo $?
2
```

Unknown verb (direct invocation):

```
$ tsx src/cli/index.ts foo
  unknown command: foo (expected one of: scroll, login, replay)
$ echo $?
2
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Real scroll behavior (Playwright wheel scrolling — feature 5)
- Real login behavior (Playwright persistent context — feature 4)
- Real extractor (feature 6) and raw JSON writer (feature 7)
- Real summarizer (feature 12) and markdown writer (feature 13)
- Real replay logic (feature 14) — only the routing is wired here
- Colored output, spinners, progress bars, interactive prompts — deliberately not shipped
- Subcommand-specific flags beyond the three listed — add when a feature needs them
- Shell completions — not a daily pain point for the operator; add if/when asked for

## Persona Revision Notes

Drafted in operator vocabulary throughout: **scroll**, **login**, **replay**, **feed**, **run**, **operator**. Verbs not nouns. No "session", no "task", no "authenticate". Flag names match the mental model: `--minutes` (how long to scroll), `--dry-run` (skip the output side), `--config` (which file to load).

Patience-level alignment: operator is Very-Low-patience for daily use. The happy path is one command, one line of output, exit 0. No interactive prompts, no confirmation flows, no "press any key to continue". Setup-time patience is High, but this feature has no setup — the CLI works as soon as the scaffold does.

Anti-persona check: no OAuth CLI, no hosted-product flags (`--telemetry`, `--analytics`, `--webhook`), no heavy framework (commander/yargs/oclif). Parser is hand-rolled and small. Unknown flags are rejected, not silently ignored — mirrors the config loader's strict-mode behavior so the tool cannot drift toward the hosted shape the anti-persona wants.

Frustrations addressed:
- "Tools that hide what they're doing" → every stub prints what it will eventually do and which feature wires it up, so the operator knows the state of the world.
- "Broken automation that fails silently" → bad flags exit 2, not 0; unknown verbs are rejected; config errors are not swallowed.
- "Setup wizards, onboarding flows" → no prompts, no wizards, `--help` is a flat text block.
- "Tools that summarize by averaging everything into mush" → CLI is spartan on purpose. Fewer options is the feature.

## Learnings

<!-- Updated via /compound after implementation -->
