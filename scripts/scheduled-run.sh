#!/usr/bin/env bash
# Entry point called by launchd every 6 hours.
#
# launchd starts with a minimal PATH so we need to source the user's shell
# profile to pick up pnpm/node paths and the ANTHROPIC_API_KEY env var
# (if they have it in ~/.zshrc instead of config.yaml).

set -uo pipefail

# Source interactive zsh env so PATH includes Homebrew + asdf + pnpm
if [ -f "$HOME/.zshrc" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.zshrc"
fi

# In case pnpm lives somewhere zshrc doesn't cover, try common paths.
export PATH="$PATH:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"

# Timestamp each run in the log for scannability.
echo ""
echo "======================================================================"
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] scrollproxy scheduled run"
echo "======================================================================"

cd "$(dirname "$0")/.." || exit 1

# Kill any stale ScrollProxy Chrome from a previous run. We relaunch a fresh
# Chrome on every scheduled run to avoid Chrome's 60-minute hang-watchdog
# killing an idle browser between runs. Session cookies persist in the
# user-data-dir so login survives the restart.
#
# `pgrep -f` matches the full command line — we target processes that were
# launched with our specific user-data-dir flag. That way we never touch the
# user's normal Chrome.
pkill -f 'user-data-dir=.*scrollproxy/chrome' 2>/dev/null || true

# Give Chrome a moment to actually exit and release the profile lock.
sleep 2

# 10 minutes is the sweet spot per Andrew's preference.
pnpm run scroll --minutes 10
RUN_EXIT=$?

# After the scroll, shut ScrollProxy's Chrome down so it doesn't sit idle
# for 6 hours waiting to get killed by the hang watchdog or balloon RAM.
# ensureChromeRunning() will boot a fresh one on the next scheduled run.
pkill -f 'user-data-dir=.*scrollproxy/chrome' 2>/dev/null || true

exit $RUN_EXIT
