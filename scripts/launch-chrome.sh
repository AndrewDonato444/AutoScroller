#!/usr/bin/env bash
# Launch a user-controlled Chrome with remote debugging enabled.
#
# ScrollProxy will attach to this Chrome over CDP (set browser.cdpEndpoint in
# config.yaml to http://localhost:9222). Because YOU launched this Chrome —
# not Playwright — Google's OAuth bot detection doesn't trigger, and you can
# log into X normally via Google SSO or password.
#
# Usage:
#   pnpm run chrome                  # uses ~/scrollproxy/chrome profile on port 9222
#   PORT=9333 pnpm run chrome        # override port
#
# Then:
#   1. Log into x.com in the Chrome window that opens.
#   2. Leave the window open.
#   3. In another terminal: pnpm run scroll

set -euo pipefail

PORT="${PORT:-9222}"
PROFILE_DIR="${PROFILE_DIR:-$HOME/scrollproxy/chrome}"
CHROME_APP="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [ ! -x "$CHROME_APP" ]; then
  echo "error: Google Chrome not found at $CHROME_APP"
  echo "install it from https://www.google.com/chrome/ and retry."
  exit 1
fi

# Make sure no other Chrome is using this profile (Chrome locks it).
if pgrep -f "user-data-dir=$PROFILE_DIR" > /dev/null; then
  echo "a Chrome is already running against $PROFILE_DIR"
  echo "close it first (Cmd+Q that window), then retry."
  exit 1
fi

mkdir -p "$PROFILE_DIR"

echo "launching Chrome for ScrollProxy"
echo "  profile:  $PROFILE_DIR"
echo "  cdp port: $PORT"
echo ""
echo "next steps:"
echo "  1. log into x.com in the Chrome window that just opened"
echo "  2. leave that Chrome window open"
echo "  3. confirm config.yaml has:  browser.cdpEndpoint: http://localhost:$PORT"
echo "  4. in another terminal:      pnpm run scroll"
echo ""

# Suppress Chrome's chatty stderr (GPU warnings, page-load telemetry, etc.).
# These messages are harmless but spam the terminal and make it look broken.
# If you ever need to debug Chrome, remove the redirect.
CHROME_LOG="$HOME/scrollproxy/chrome-launcher.log"

echo "(chrome stdout/stderr is suppressed. if something seems wrong, tail $CHROME_LOG)"
echo ""

exec "$CHROME_APP" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=PrivacySandboxSettings4 \
  "https://x.com/login" \
  > "$CHROME_LOG" 2>&1
