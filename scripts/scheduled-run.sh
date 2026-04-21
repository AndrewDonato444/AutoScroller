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

# X API Owned Reads pull — no browser, no scrolling, no Chrome.
# Pulls configured lists + bookmarks, dedups, summarizes, writes.
# Typically finishes in ~30-60s depending on list sizes and Claude latency.
pnpm run scroll
RUN_EXIT=$?

# Sync summary files to the SecondBrain git remote so a cloud-scheduled
# agent can read them without needing local filesystem access.
# .gitignore in SecondBrain excludes raw.json + screenshots/ from commits,
# so only summary.json + summary.md are pushed.
if [ $RUN_EXIT -eq 0 ]; then
  BRAIN_DIR="$HOME/SecondBrain"
  if [ -d "$BRAIN_DIR/.git" ]; then
    (
      cd "$BRAIN_DIR" || exit 0
      git add projects/scrollproxy/runs/ 2>/dev/null || true
      if ! git diff --cached --quiet 2>/dev/null; then
        git -c commit.gpgsign=false commit -m "scrollproxy: sync run summaries ($(date '+%Y-%m-%dT%H:%M'))" >/dev/null 2>&1 || true
        git push origin main >/dev/null 2>&1 || echo "[scrollproxy] git push failed; summaries committed locally only"
      fi
    )
  fi
fi

exit $RUN_EXIT
