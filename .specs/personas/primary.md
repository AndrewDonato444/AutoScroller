# The Signal-Hungry Operator

## Context
- Operator/founder type who lives in a terminal, a browser, and Notion. Day is a mix of customer calls, building, and reading.
- Primary device is a Mac. Secondary is an iPhone where X is installed and is the single biggest attention leak.
- Highly technical — comfortable editing YAML, running `pnpm` commands, reading stack traces, tweaking Playwright selectors when they break.
- Juggles a lot of information sources: X, Slack, email, Notion, a stack of RSS feeds, group chats. X is the most valuable and the most costly.

## What They Care About
- **Getting the signal without paying the scroll tax.** They follow smart people; they know the feed has value. They don't want the dopamine loop that comes with extracting it.
- **Deterministic output.** Run the command, get the answer, close the laptop. No open-ended browsing.
- **Cumulative intelligence.** Want a tool that gets smarter each run — learns who they actually read, what themes are recurring, what's new vs. already seen.
- **Keeping their own data.** Local files. Their own API keys. No SaaS dashboard, no account, no sync.

## What Frustrates Them
- Opening X "for one thing" and losing 45 minutes.
- Tools that summarize by averaging everything into mush. They want a ruthless editor, not a polite one.
- Setup wizards, onboarding flows, OAuth dances. They'd rather edit a YAML file.
- Tools that hide what they're doing. They want to see the raw extracted posts if the summary looks off.
- Broken automation that fails silently. If the extractor breaks, they want to know immediately and see what was saved.

## Their Vocabulary
- **"Feed"** not "timeline"
- **"Scroll"** not "session" or "browse"
- **"Posts"** not "tweets" (X's own rename)
- **"Run"** not "job" or "task"
- **"Worth clicking"** not "recommended" or "suggested"
- **"Noise"** not "low-engagement" or "filtered"
- **"Summary"** not "digest" or "report"
- **"Login"** not "authenticate" or "sign in"
- Commands are verbs: `scroll`, `login`, `replay`. Not nouns like `extraction-service`.

## Patience Level
**High** for setup (will happily edit YAML, install deps, debug Playwright).
**Very Low** for daily use (run one command, get one file, done).

The tool can be fussy to configure. It can't be fussy to use.

## Success Metric
1. Hasn't opened the X app on his phone in 7 days.
2. Hasn't missed anything he would have wanted to see.
3. At least one markdown summary per week surfaces something he clicks into and is glad he did.

If all three are true for two weeks running, the tool works.
