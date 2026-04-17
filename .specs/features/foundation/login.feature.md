---
feature: Login Command
domain: foundation
source: src/cli/login.ts
tests:
  - tests/foundation/login.test.ts
components: []
design_refs: []
personas:
  - primary
  - anti-persona
status: specced
created: 2026-04-16
updated: 2026-04-16
---

# Login Command

**Source File**: `src/cli/login.ts`, `src/login.ts`, `src/browser/session.ts`
**Design System**: N/A (CLI tool — no UI tokens)
**Personas**: `.specs/personas/primary.md`, `.specs/personas/anti-persona.md`

## Feature: Persistent Playwright context + manual login

The operator runs `pnpm login` exactly once per machine (or again if the X session cookie expires), a real Chromium window opens on `https://x.com/login`, they type their username and password like a human, solve whatever challenge X decides to throw at them, and close the window. From that point on every `pnpm scroll` starts up in the same persistent user-data dir and is already logged in. No OAuth, no credential storage, no `.env` with passwords — the operator's own browser session on their own Mac is the authentication.

This feature ships the wiring behind the `login` verb that feature 3 already routes to. The CLI handler:

1. Reads `browser.userDataDir` and `browser.viewport` from the loaded config.
2. Creates the user-data dir if missing (so the operator doesn't have to pre-create it).
3. Refuses to run with `browser.headless: true` — login is inherently interactive.
4. Launches a Playwright **persistent context** (not an ephemeral browser) so cookies and storage persist.
5. Opens `https://x.com/login` in a single tab at the configured viewport.
6. Prints one line telling the operator what to do: log in, then close the window.
7. Waits for the browser to close (operator-driven exit — no timeout, no polling loop the operator sees).
8. On close, detects whether a logged-in state was reached (URL is `x.com/home` or `x.com/{handle}`, not `x.com/login` or `x.com/i/flow/*`) and prints a one-line result.
9. Exits `0` on success, `1` if the window was closed without reaching a logged-in state, `2` on config misuse.

Nothing about the scroll/extract loop runs here. The login command's whole job is "leave a persistent Chromium profile on disk that the scroll command can reuse."

### Scenario: `pnpm login` launches a persistent Chromium against the configured user-data dir

Given a valid config with `browser.userDataDir: ~/scrollproxy/chrome` and `browser.headless: false`
And the directory does not yet exist
When the operator runs `pnpm login`
Then the login handler expands `~` to an absolute path
And creates `~/scrollproxy/chrome` if it does not exist (recursive mkdir, ignoring EEXIST)
And launches Playwright via `chromium.launchPersistentContext(userDataDir, { headless: false, viewport: { width: 1280, height: 900 } })`
And opens `https://x.com/login` in the first page of the context
And prints exactly one line to stdout: `log in to X in the open window, then close the window when done`
And the process remains alive until the browser context closes

### Scenario: `pnpm login` refuses to run headless

Given a config with `browser.headless: true`
When the operator runs `pnpm login`
Then stderr reads: `login requires browser.headless: false — edit ~/scrollproxy/config.yaml and re-run`
And no browser is launched
And the process exits with status `2`
(Reason: the operator must physically type credentials and solve challenges. Headless login is a security antipattern and not what this tool does.)

### Scenario: Successful login detected from final URL

Given the operator has typed their credentials and X has redirected to `https://x.com/home`
When the operator closes the browser window
Then the handler reads the final URL of the last active page before the context closed
And prints: `login saved to ~/scrollproxy/chrome — you can now run pnpm scroll`
And the process exits with status `0`

### Scenario: Alternate logged-in URL (handle page) also counts as success

Given the operator's final URL is `https://x.com/andrewdonato` (handle page) rather than `/home`
When the browser closes
Then the handler treats any `x.com/*` URL that is NOT `/login`, `/i/flow/*`, `/i/flow/login`, or `/` as logged-in
And prints the same success message
And exits `0`
(X sometimes lands the operator on their handle after login. Either is fine.)

### Scenario: Window closed before login completed

Given the operator closes the window while still on `https://x.com/login` or `https://x.com/i/flow/login`
When the browser closes
Then the handler prints: `login not completed — final URL was x.com/login. Run pnpm login again.`
And the process exits with status `1`
(No retry loop, no "would you like to try again?" prompt. Just a clear report.)

### Scenario: User-data dir already exists from a prior login

Given `~/scrollproxy/chrome` already contains Chromium profile files (a prior login ran)
When the operator runs `pnpm login` again
Then the existing profile is reused (Playwright opens against the same user-data dir)
And cookies and storage from the prior session are still present
And the operator sees x.com already logged in (if the session is still valid) or the login page (if it expired)
(The user-data dir is never wiped by this command. Operator can delete it manually if they want a fresh start.)

### Scenario: Viewport is honored from config

Given a config with `browser.viewport: { width: 1440, height: 960 }`
When the operator runs `pnpm login`
Then the launched browser context uses a 1440×960 viewport
(Viewport matters less for login than for scrolling, but keeping it consistent with `pnpm scroll` means the same DOM renders — no surprises when the extractor runs later.)

### Scenario: Playwright launch failure surfaces the error clearly

Given Playwright's Chromium is not installed (first-time user forgot `pnpm exec playwright install chromium`)
When the operator runs `pnpm login`
Then the Playwright error is caught
And stderr reads: `playwright chromium not installed — run: pnpm exec playwright install chromium`
And the process exits with status `1`
(Anti-frustration: the default Playwright error is a multi-line stack trace. The operator wants one actionable line.)

### Scenario: User-data dir is a file, not a directory

Given `browser.userDataDir` points to a path that exists but is a regular file
When the operator runs `pnpm login`
Then stderr reads: `browser.userDataDir must be a directory: <path>`
And the process exits with status `2`
(Defensive — a typo in config would otherwise produce a confusing Playwright error.)

### Scenario: `--config <path>` is honored

Given a valid alternate config at `/tmp/alt-config.yaml` with a different `browser.userDataDir`
When the operator runs `pnpm login --config /tmp/alt-config.yaml`
Then the handler loads the alt config via the existing CLI plumbing (feature 3)
And the launched persistent context uses the alt config's `userDataDir`
(The CLI already threads `--config` through; this feature just consumes it.)

### Scenario: No credentials are ever read, written, or logged

Given the operator logs in through the browser UI
When the handler completes
Then no file on disk contains the operator's password, 2FA code, or API tokens created by X
And the only on-disk artifact is the Chromium user-data dir (managed by Chromium itself)
And stdout/stderr never echo the URL beyond the final logged-in URL (and even that is just the path, not query params)
(Principle: credential storage is not our problem. Chromium's own cookie jar is the entire auth story. We do not read it, copy it, or forward it anywhere.)

### Scenario: No hosted-product dependencies are introduced

Given a contributor reviews `package.json` after this feature lands
When they inspect new dependencies
Then only `playwright` (and its peer types) is added as a runtime dep
And no OAuth libraries (passport, openid-client, @octokit, etc.) are present
And no credential-manager libraries (keytar, node-keyring, etc.) are present
And no "sign in with X" SDK is present
(Anti-persona guardrail: login is a browser window, nothing more. Libraries that imply hosted-auth patterns have no place here.)

## User Journey

1. Operator has just run `pnpm install` and seen `~/scrollproxy/config.yaml` written on first `pnpm scroll` (features 1–3).
2. They edit the config if needed, then run `pnpm exec playwright install chromium` once (README directs them).
3. **They run `pnpm login`. A Chromium window opens on x.com/login. They type their credentials like a human, solve any challenge X demands, and land on the home feed.**
4. They close the window. The CLI prints `login saved to ~/scrollproxy/chrome — you can now run pnpm scroll` and exits `0`.
5. Every subsequent `pnpm scroll` (wired in features 5–7) reuses the same `~/scrollproxy/chrome` dir and starts already logged in.
6. Months later, when X's session expires, a scroll run will land on the login page and silently extract nothing. The operator re-runs `pnpm login` to refresh the session. Same one-time flow.

The operator interacts with this feature roughly twice per year. That is the target frequency.

## CLI Mockup

Happy path:

```
$ pnpm login
  log in to X in the open window, then close the window when done
  (Chromium window opens on x.com/login; operator types credentials; window closes)
  login saved to ~/scrollproxy/chrome — you can now run pnpm scroll
$ echo $?
0
```

Abandoned login:

```
$ pnpm login
  log in to X in the open window, then close the window when done
  (operator closes the window while still on x.com/login)
  login not completed — final URL was x.com/login. Run pnpm login again.
$ echo $?
1
```

Misconfigured headless:

```
$ pnpm login
  login requires browser.headless: false — edit ~/scrollproxy/config.yaml and re-run
$ echo $?
2
```

Playwright not installed:

```
$ pnpm login
  playwright chromium not installed — run: pnpm exec playwright install chromium
$ echo $?
1
```

Bad user-data dir (path is a file):

```
$ pnpm login
  browser.userDataDir must be a directory: /Users/andrew/scrollproxy/chrome
$ echo $?
2
```

## Component References

None — CLI tool, no visual components.

## Out of Scope for This Feature

- Actual scrolling or DOM extraction (features 5 and 6).
- Automatic credential entry / password autofill — deliberately never.
- Storing the operator's username or password anywhere on disk — Chromium's own cookie jar is the whole story.
- Detecting a *future* session expiry during `pnpm scroll` — that's the scroller's concern (features 5/6) and prints "session expired, run pnpm login" at extract time.
- 2FA handling, captcha solving, anti-bot maneuvering — the operator does those in the browser like a human.
- Multiple account profiles — one user-data dir, one X account. Multi-account is anti-persona territory.
- `--url` flag to point at a different login page — not a daily pain point; add if ever requested.
- Timeout-based auto-close of the browser — the operator is in control of when the window closes; no surprise kills.

## Persona Revision Notes

Drafted in operator vocabulary throughout: **login**, **run**, **operator**, **feed**, **scroll**. No "authenticate", no "sign in", no "session", no "token". The CLI verb matches the vocabulary (`pnpm login`, not `pnpm auth`). Error messages name files and commands the operator already edits or types.

Patience-level alignment:
- **Setup patience: High** — operator is fine running `pnpm exec playwright install chromium` once and editing YAML if needed. The spec leans on that: first-run Chromium install is documented, not wizarded.
- **Daily patience: Very Low** — but this command runs roughly twice a year, so it sits at the setup end of the spectrum. Even so: one command, one browser window, one line of output, exit. No prompts, no "are you sure?", no post-close confirmation screen.

Anti-persona check: the scenarios explicitly block every hosted-auth shape — no OAuth libs, no credential storage, no "sign in with X" SDK, no headless login, no multi-account profile manager. Login is literally a Chromium window pointed at x.com. That's the whole feature. Anything more and we are building the hosted product the anti-persona wants.

Frustrations addressed:
- **"Tools that hide what they're doing"** → the one stdout line tells the operator exactly what to do and where the session lives on disk. Success prints the final URL state implicitly by pointing at the saved profile.
- **"Broken automation that fails silently"** → an abandoned login exits `1` with a clear message; a misconfigured `headless: true` exits `2` with a pointer to the config file; a missing Chromium binary prints the exact command to fix it.
- **"Setup wizards, onboarding flows, OAuth dances"** → there is no wizard, no redirect dance, no account creation. A browser window, a close event, a success line.
- **"Tools that hide what they're doing"** (recurring theme) → the success line names the exact directory where the session is stored, so the operator can `rm -rf` it if they ever want to start fresh. Transparency over magic.

## Learnings

<!-- Updated via /compound after implementation -->
