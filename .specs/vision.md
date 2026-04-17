# ScrollProxy — Vision

> A CLI tool that scrolls X so you don't have to, then tells you what was worth seeing.

---

## Overview

ScrollProxy is a personal CLI tool that logs into X (Twitter) using a persistent browser session, scrolls the home feed for a configurable number of minutes, extracts every post it encounters, and uses Claude to produce a structured summary. The output answers four questions: What were the dominant themes? Who posted something worth attention? What's new vs. already seen? What should I actually click into and read?

The tool builds cumulative memory across runs — deduplicating posts, tracking rolling themes, and getting smarter about what to surface over time.

**Target users**: Andrew Donato (sole user). Power X consumer who wants the signal without the scroll. Interests: AI product strategy, distribution and indie dev, sales enablement, sports betting analytics.

**Core value proposition**: Replace passive, addictive feed scrolling with a deterministic "go read my feed for me" command that produces a structured, actionable summary in under 2 minutes of reading time.

---

## Key Screens / Areas

ScrollProxy is a CLI tool — no screens. The key "areas" are functional modules:

| Area | Purpose | Priority |
|------|---------|----------|
| CLI entry | Arg parsing, orchestration, `pnpm scroll` / `pnpm login` | Core |
| Scroller | Playwright browser automation — scroll X feed with human-like behavior | Core |
| Extractor | DOM parsing — pull structured post data from X timeline | Core |
| Summarizer | Claude API — ruthless feed analyst producing themed, prioritized summary | Core |
| Writer (Markdown) | Write human-readable summary + raw JSON to local files | Core |
| State / Dedup | Track seen posts (last 10k) and rolling themes (last 10 runs) | Core |
| Config | YAML config for scroll params, browser settings, interests, output | Core |
| Writer (Notion) | Notion integration for summary output | Phase 3 |
| Scheduled runs | Cron/launchd for automated daily runs | Phase 3 |

---

## Tech Stack

| Layer | Technology | Reason |
|-------|------------|--------|
| Language | TypeScript (Node 20+) | Best Playwright ecosystem, matches existing conventions |
| Browser automation | Playwright | Persistent contexts, better anti-bot posture than Puppeteer |
| LLM | Anthropic Claude API (claude-sonnet-4-6) | Existing keys + prompt patterns |
| Config | config.yaml + Zod validation | Hand-editable, fail-fast on invalid config |
| Output (v1) | Local markdown in `~/scrollproxy/runs/` | Zero dependencies, trivially portable |
| State | JSON files in `~/scrollproxy/state/` | Dedup cache, seen-post hashes, rolling themes |
| Package manager | pnpm | Andrew's default |
| Runtime | CLI via `pnpm scroll` / `pnpm login` | Simple, no server |

---

## Design Principles

1. **Read-only, always.** Never post, reply, like, or perform any write action on X. This is a consumption tool.
2. **Signal over completeness.** The summarizer's job is to tell you what matters, not to summarize everything. If the feed is noise, say so.
3. **Never lose scroll effort.** If the summarizer fails, still write raw JSON. If the browser crashes, save whatever was collected.
4. **Human-like automation.** Mouse wheel scrolling, jittered distances, random pauses, occasional long stops. Behave like a person reading.
5. **Pluggable outputs.** Writer is an interface — MarkdownWriter now, NotionWriter later. No refactor needed to add destinations.
6. **Cumulative intelligence.** Each run builds on prior runs via dedup and rolling themes. The tool should get better at separating signal from noise over time.
7. **Fail gracefully, fail loudly.** Selector failures skip that post (never throw). Config errors fail fast with clear messages. First run without login detects and guides.
8. **Personal tool simplicity.** No multi-user, no auth server, no cloud, no distribution. Every decision should favor simplicity for a single-user local tool.

---

## Out of Scope (v1)

- Multiple platforms (LinkedIn, Reddit — Phase 3)
- GUI of any kind — CLI only
- Cloud hosting — runs on Andrew's Mac only
- Write actions on X (posting, replying, liking)
- Credential storage — session persistence via Chrome user data dir only
- Notion/Obsidian integration — local markdown output only (hooks designed for v2)
- Vision-based fallback when DOM selectors break (Phase 3)
- Cross-run trend detection beyond rolling themes (Phase 3)

---

## Build Phases

### Phase 1 — "It works once"
Project scaffold, config loader, CLI, `pnpm login` command, scroller + extractor. Output: raw JSON only. Goal: verify extraction quality against a real 10-minute scroll.

### Phase 2 — "It's actually useful"
Claude summarizer with full schema, markdown writer, dedup + rolling themes state. Goal: first real daily run that produces an actionable summary.

### Phase 3 — "Polish and expand"
Notion writer, second platform, vision fallback for DOM changes, scheduled runs (cron/launchd), cross-run trend detection.

---

## Success Criteria

Within two weeks of first real use:

1. Andrew has not opened the X app on his phone in 7 days.
2. He hasn't missed anything he would have wanted to see.
3. The daily markdown file has surfaced at least one thing he actually clicked through and was glad he did.

If those three are true, v1 shipped. Everything else is polish.

---

_This file was created by `/vision` from the ScrollProxy technical spec._
_Update with `/vision --update` to reflect what's been built and learned._
