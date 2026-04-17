# ScrollProxy Build Roadmap

> Ordered list of features to implement. Each feature is completable within a single agent context window.
> Updated by `/roadmap`, `/roadmap-triage`, and `/build-next`.

## Implementation Rules

**Every feature in this roadmap must be implemented with real data, real API calls, and real browser automation.** No exceptions.

- **No mock data** — never use hardcoded post arrays, fake JSON, or placeholder summaries. If a feature needs posts, it either extracts them from a real (or recorded) X page or reads from a prior run's saved JSON.
- **No fake Claude calls** — every summarizer invocation hits the real Anthropic API. Tests use recorded fixtures, not mocked responses.
- **No placeholder output** — markdown writer produces real files to `~/scrollproxy/runs/`. State writer produces real JSON in `~/scrollproxy/state/`.
- **No "demo mode"** — features either work end-to-end or they aren't done. `pnpm scroll` must produce a real file.
- **Real validation** — config.yaml is validated with Zod at startup, with clear error messages.
- **Real error handling** — selector failures skip that post; network errors retry with backoff; Claude failures still save raw JSON.
- **Test against real flows** — verifying a feature means running `pnpm scroll` end-to-end against a real browser session, not just unit tests.

---

## Progress

| Status | Count |
|--------|-------|
| ✅ Completed | 12 |
| 🔄 In Progress | 1 |
| ⬜ Pending | 3 |
| ⏸️ Blocked | 0 |

**Last updated**: 2026-04-17

---

## Phase 1: Foundation — "It works once"

> Scaffold the project, get a browser logged into X, scroll the feed, and extract posts as raw JSON. No summarization yet. Goal: verify extraction quality against a real 10-minute scroll.

| # | Feature | Source | Jira | Complexity | Deps | Status |
|---|---------|--------|------|------------|------|--------|
| 1 | Project scaffold (TS + pnpm + Node 20) | vision | - | S | - | ✅ |
| 2 | Config loader (YAML + Zod validation) | vision | - | S | 1 | ✅ |
| 3 | CLI entry + arg parsing (`scroll`, `login`, `--minutes`, `--dry-run`) | vision | - | S | 2 | ✅ |
| 4 | Login command (Playwright persistent context, manual login) | vision | - | M | 3 | ✅ |
| 5 | Scroller (human-like wheel scrolling + jitter + pauses) | vision | - | M | 4 | ✅ |
| 6 | Extractor (DOM parse: author, text, metrics, media, skip ads) | vision | - | L | 5 | ✅ |
| 7 | Raw JSON writer (`~/scrollproxy/runs/<run-id>/raw.json`) | vision | - | S | 6 | ✅ |

**Phase 1 exit criteria**: `pnpm login` works once; `pnpm scroll --minutes 3` produces a valid `raw.json` with ~30+ extracted posts and zero ads.

---

## Phase 2: Core — "It's actually useful"

> Add the Claude summarizer, markdown output, and cumulative state (dedup + rolling themes). Goal: first real daily run that produces an actionable summary Andrew uses instead of opening X.

| # | Feature | Source | Jira | Complexity | Deps | Status |
|---|---------|--------|------|------------|------|--------|
| 10 | State module (dedup cache — last 10k post hashes) | vision | - | M | 7 | ✅ |
| 11 | Rolling themes store (last 10 runs) | vision | - | S | 10 | ✅ |
| 12 | Claude summarizer (themes, worth-clicking, voices, noise) | vision | - | L | 10, 11 | ✅ |
| 13 | Markdown writer (human summary + links to raw JSON) | vision | - | M | 12 | ✅ |
| 14 | `--replay <run-id>` flag (re-summarize saved raw JSON) | vision | - | S | 12, 13 | ✅ |
| 15 | `--dry-run` flag (scroll + extract, skip Claude + write) | vision | - | S | 7 | 🔄 |

**Phase 2 exit criteria**: Run `pnpm scroll` daily for 3 days. Each run produces a markdown file with themes, worth-clicking items, and a dedup-aware "new since last run" section.

---

## Phase 3: Expansion — "Polish and reach"

> Optional destinations, second platform, robustness against DOM changes, scheduled runs. Only pursue after Phase 2 has been used daily for 2+ weeks.

| # | Feature | Source | Jira | Complexity | Deps | Status |
|---|---------|--------|------|------------|------|--------|
| 20 | Writer interface + NotionWriter implementation | vision | - | L | 13 | ⬜ |
| 21 | Cross-run trend detection (themes drifting over N runs) | vision | - | M | 11, 12 | ⬜ |
| 22 | Vision-based fallback when DOM selectors break | vision | - | L | 6 | ⬜ |

**Phase 3 exit criteria**: At least one additional destination is usable end-to-end; the tool survives a real X DOM change without developer intervention.

---

## Ad-hoc Requests

> Features added from notes, usage observations, or mid-build ideas. Processed after current phase unless explicitly prioritized.

| # | Feature | Source | Jira | Complexity | Deps | Status |
|---|---------|--------|------|------------|------|--------|
| - | _none yet_ | - | - | - | - | - |

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| ⬜ | Pending — not started |
| 🔄 | In Progress — currently being built |
| ✅ | Completed — feature works end-to-end |
| ⏸️ | Blocked — waiting on dependency or decision |
| ❌ | Cancelled — no longer needed |

## Complexity Legend

| Symbol | Meaning | Typical Scope |
|--------|---------|---------------|
| S | Small | 1–3 files, single module |
| M | Medium | 3–7 files, multiple modules |
| L | Large | 7–15 files, cross-cutting logic |

---

## Notes

- **Phase 1 produces no user-facing output.** That's intentional. The goal is proving we can extract posts cleanly from a real scroll before investing in summarization.
- **Feature 6 (Extractor) is the highest-risk Phase 1 item.** X's DOM is adversarial to automation; expect selector churn. Budget extra time here.
- **Feature 12 (Summarizer) is the highest-value Phase 2 item.** The prompt and output schema design determine whether the tool is useful or ignorable.
- **Phase 3 is deliberately vague.** Do not build Phase 3 items until the primary persona (Andrew) has used Phase 2 daily for two weeks and identified which expansions actually matter.
- **Out of scope permanently**: hosted service, multi-user, OAuth, write actions, analytics. See `.specs/personas/anti-persona.md`.

---

_This file is the single source of truth for `/build-next`. Features are picked in order, respecting dependencies._
_Add features with `/roadmap add`, restructure with `/roadmap reprioritize`, check status with `/roadmap status`._
