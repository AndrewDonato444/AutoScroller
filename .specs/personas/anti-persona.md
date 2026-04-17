# Anti-Persona: The Casual Social Media User

## Who This Is
- A non-technical person who wants a "smart Twitter summary app."
- Expects to install from an app store, sign in with their X account via OAuth, and get a pretty daily digest email.
- Has no terminal, doesn't know what pnpm is, has never edited a YAML file.
- Wants a product, not a tool. Wants it hosted, maintained, and supported.
- May also be a growth marketer who wants analytics, engagement tracking, or a way to schedule posts.

## Why They're Out of Scope

Serving them would require everything ScrollProxy is explicitly not:

- **Hosted service** — would need auth, multi-tenancy, a server, billing, a marketing site.
- **Write actions** — scheduling, replying, liking. ScrollProxy is read-only on principle; adding writes introduces ToS risk and changes the tool's character.
- **OAuth flow** — X's API access for third-party tools is expensive and heavily rate-limited. Our approach (persistent browser session on the user's own machine) is the entire point.
- **Generic appeal** — would force the summarizer to be "polite and complete" rather than "ruthless editor for one operator's interests." The sharpness of the output depends on the narrowness of the audience.
- **Analytics/engagement tracking** — would require capturing metric changes over time, a totally different data model, and would push the tool toward surveillance rather than consumption.

## What to Say If Requested

> "ScrollProxy is a single-user CLI tool that runs on your own Mac with your own logged-in browser. If you want a hosted digest product, this isn't it — and making it one would break what makes it useful."

Feature requests that come from this persona (hosted auth, OAuth, scheduled posting, engagement analytics, multi-user dashboards, mobile apps) should be declined, not deferred. They're out of scope permanently, not "not yet."
