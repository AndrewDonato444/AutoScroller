# ScrollProxy Setup on a New Mac

This is a personal tool. One operator, one machine at a time. These are the steps to bring it up on a fresh macOS install (or a different Mac).

## Prerequisites

```bash
# Homebrew packages
brew install node pnpm yq gh

# Google Chrome (real binary, not Chromium — needed for CDP attach)
brew install --cask google-chrome
```

Node 20+ and pnpm 8+ required.

## 1. Clone

```bash
git clone https://github.com/AndrewDonato444/AutoScroller.git ~/AutoScroller
cd ~/AutoScroller
pnpm install
```

## 2. Create `config.yaml`

The runtime config lives OUTSIDE the repo at `~/scrollproxy/config.yaml`. It contains your Anthropic API key, so do NOT put it in the repo.

```bash
mkdir -p ~/scrollproxy
cat > ~/scrollproxy/config.yaml <<'EOF'
# ScrollProxy Configuration

scroll:
  minutes: 10
  jitterMs: [400, 1400]
  longPauseEvery: 25
  longPauseMs: [3000, 8000]

browser:
  userDataDir: ~/scrollproxy/chrome
  headless: false
  channel: chrome
  cdpEndpoint: http://localhost:9222
  viewport:
    width: 1280
    height: 900

interests:
  - AI product strategy
  - distribution and indie dev
  - sales enablement
  - sports betting analytics

output:
  dir: ~/SecondBrain/projects/scrollproxy/runs   # or wherever your vault is
  state: ~/scrollproxy/state
  destinations: [markdown]

claude:
  model: claude-sonnet-4-6
  apiKey: sk-ant-api03-YOUR_KEY_HERE   # paste real key

extractor:
  visionFallback:
    enabled: true
    minPosts: 20
    maxSelectorFailureRatio: 0.3
    screenshotEveryTicks: 5
    maxScreenshotsPerRun: 24
EOF

chmod 600 ~/scrollproxy/config.yaml   # restrict to your user only
```

Get an API key from [console.anthropic.com](https://console.anthropic.com/settings/keys) and paste it into the `apiKey` line.

## 3. Log into X (one-time)

Chrome must NOT be launched by Playwright — Google detects that and blocks OAuth. Instead, you launch Chrome yourself with a debug port open and log in manually.

```bash
pnpm run chrome     # opens a Chrome window pointed at x.com/login
```

In the Chrome window that opens:
1. Log into X however you want (Google SSO, password, whatever)
2. Verify you see your home feed
3. Leave Chrome running (or quit — cookies persist in `~/scrollproxy/chrome`)

## 4. Smoke test

```bash
pnpm run scroll --minutes 2 --dry-run    # scrapes feed, skips Claude
```

Should print something like:
```
dry-run complete: 50 ticks over 62s — 75 posts extracted (234 ads skipped)
```

If you see 0 posts: check that your `x.com/home` tab is actually loaded and you're signed in.

Then a real run (will call Claude API, ~$0.10):

```bash
pnpm run scroll --minutes 2
```

Summary lands in `~/SecondBrain/projects/scrollproxy/runs/<timestamp>/summary.md`.

## 5. Install scheduled automation

```bash
./scripts/install-schedule.sh install
```

This creates two launchd agents:
- **`com.scrollproxy.chrome-daemon`** — keeps Chrome running continuously with the CDP port open, auto-restarts on crash.
- **`com.scrollproxy.scheduled-scroll`** — fires `pnpm run scroll --minutes 10` every 6 hours.

Verify:

```bash
./scripts/install-schedule.sh status
```

## 6. Second Brain integration (optional)

If your Second Brain reads from an Obsidian vault under git, the `scheduled-run.sh` already commits and pushes new summaries on each successful run. Just make sure `~/SecondBrain` is a git repo with a remote configured.

The prompt for feeding summaries into your Second Brain agent is at `~/SecondBrain/projects/scrollproxy/second-brain-prompt.md` (created on first run in your vault).

## Uninstall

```bash
./scripts/install-schedule.sh uninstall
```

Stops the daemons and removes the launchd plists. Does not delete your config, Chrome profile, or run history.

## Known Limitations

- **Chrome 147 on macOS 26.3.1 crashes within ~90 seconds of scrolling.** The launchd daemon restarts Chrome within 10s, and the scroll command salvages whatever posts it extracted before the crash — so runs still produce summaries, just with ~100-200 posts instead of the full 10-minute harvest. Downgrading to Chrome 146.x or switching to Brave/Arc likely resolves this.
- **X sessions eventually expire** (every few weeks). When that happens, a macOS notification fires: "ScrollProxy: re-auth needed." Run `pnpm run chrome` and log back in.
- **Promoted trend clicks stick.** If Chrome's profile ever accidentally clicks a promoted trend, the resulting search tab gets auto-restored on every Chrome launch. The scroll code now closes these tabs defensively, but if you ever see repeated 0-post runs, check `~/scrollproxy/chrome` for stale sessions.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Couldn't sign you in — this browser may not be secure` | Playwright-controlled Chrome trying to do OAuth | Don't log in through `pnpm run scroll`. Use `pnpm run chrome` and log in there, before anything else. |
| `pnpm login` opens npm registry signin | pnpm name collision with built-in `login` command | Use `pnpm run login` (or `pnpm run chrome` which is what you actually want). |
| 0 posts extracted across multiple runs | Stale non-home x.com tab in profile | Open Chrome manually and close all tabs except x.com/home. Scroll code will nuke others on next run. |
| `chrome failed to start on port 9222` | Port already in use, or launchd daemon dead | `pkill -f 'user-data-dir=.*scrollproxy/chrome' && launchctl kickstart -k gui/$(id -u)/com.scrollproxy.chrome-daemon` |
| Summary missing themes/worth-clicking | Claude API quota hit or key invalid | `echo $ANTHROPIC_API_KEY` is empty? Check `~/scrollproxy/config.yaml` has the key. |

## Files You Care About

| Path | Purpose | In git? |
|------|---------|---------|
| `~/AutoScroller/` | All source code | yes |
| `~/scrollproxy/config.yaml` | Runtime config + API key | no (has secrets) |
| `~/scrollproxy/chrome/` | Chrome profile (cookies, session) | no (huge + personal) |
| `~/scrollproxy/state/` | Dedup cache + rolling themes | no (machine-local) |
| `~/SecondBrain/projects/scrollproxy/runs/` | Daily summaries | separate git repo (vault) |
| `~/Library/LaunchAgents/com.scrollproxy.*.plist` | Schedule + daemon plists | generated by install script |
| `~/Library/Logs/scrollproxy.log` | Scroll run log | no |
| `~/Library/Logs/scrollproxy-chrome.log` | Chrome daemon stderr | no |
