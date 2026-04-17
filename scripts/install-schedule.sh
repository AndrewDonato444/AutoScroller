#!/usr/bin/env bash
# Install or uninstall the launchd schedule for ScrollProxy.
#
# Usage:
#   ./scripts/install-schedule.sh install
#   ./scripts/install-schedule.sh uninstall
#   ./scripts/install-schedule.sh status

set -euo pipefail

LABEL="com.scrollproxy.scheduled-scroll"
CHROME_LABEL="com.scrollproxy.chrome-daemon"
TEMPLATE="$(dirname "$0")/launchd/${LABEL}.plist"
CHROME_TEMPLATE="$(dirname "$0")/launchd/${CHROME_LABEL}.plist"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
INSTALLED_CHROME_PLIST="$HOME/Library/LaunchAgents/${CHROME_LABEL}.plist"
LOG_PATH="$HOME/Library/Logs/scrollproxy.log"
CHROME_LOG_PATH="$HOME/Library/Logs/scrollproxy-chrome.log"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

install() {
  if [ ! -f "$TEMPLATE" ] || [ ! -f "$CHROME_TEMPLATE" ]; then
    echo "error: template plist(s) missing in $(dirname "$0")/launchd/"
    exit 1
  fi

  mkdir -p "$(dirname "$INSTALLED_PLIST")"
  mkdir -p "$(dirname "$LOG_PATH")"

  # 1. Chrome daemon plist — launchd keeps Chrome alive forever, restarts on crash.
  sed -e "s|__HOME__|${HOME}|g" "$CHROME_TEMPLATE" > "$INSTALLED_CHROME_PLIST"

  # 2. Scheduled-run plist — fires the scroll every 6h and just attaches via CDP.
  sed \
    -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|${PATH}|g" \
    "$TEMPLATE" > "$INSTALLED_PLIST"

  chmod +x "$PROJECT_DIR/scripts/scheduled-run.sh"

  # Kill any stale orphan Chromes from the old "spawn-and-forget" setup so
  # launchd doesn't fight them for the profile lock.
  pkill -f 'user-data-dir=.*scrollproxy/chrome' 2>/dev/null || true
  sleep 1

  # (Re)load both with launchd. bootout is idempotent.
  launchctl bootout "gui/$(id -u)/${CHROME_LABEL}" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

  launchctl bootstrap "gui/$(id -u)" "$INSTALLED_CHROME_PLIST"
  launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST"

  echo "✓ installed chrome daemon: $INSTALLED_CHROME_PLIST"
  echo "  Chrome stays alive continuously, restarts automatically if it dies"
  echo "  log: $CHROME_LOG_PATH"
  echo ""
  echo "✓ installed scheduled scroll: $INSTALLED_PLIST"
  echo "  schedule: every 6 hours"
  echo "  duration: 10 minutes per run"
  echo "  log:      $LOG_PATH"
  echo ""
  echo "Chrome should already be starting up. To run a scroll immediately:"
  echo "  launchctl kickstart -k gui/$(id -u)/${LABEL}"
}

uninstall() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/${CHROME_LABEL}" 2>/dev/null || true
  rm -f "$INSTALLED_PLIST" "$INSTALLED_CHROME_PLIST"
  # Also kill Chrome since launchd won't restart it anymore
  pkill -f 'user-data-dir=.*scrollproxy/chrome' 2>/dev/null || true
  echo "✓ uninstalled. logs left at $LOG_PATH, $CHROME_LOG_PATH"
}

status() {
  if [ -f "$INSTALLED_PLIST" ]; then
    echo "installed: $INSTALLED_PLIST"
  else
    echo "not installed"
    return
  fi

  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    echo "loaded:    yes"
    launchctl print "gui/$(id -u)/${LABEL}" | grep -E 'state|last exit|runs' || true
  else
    echo "loaded:    no"
  fi

  if [ -f "$LOG_PATH" ]; then
    echo ""
    echo "last 20 log lines ($LOG_PATH):"
    tail -20 "$LOG_PATH"
  fi
}

case "${1:-}" in
  install)   install ;;
  uninstall) uninstall ;;
  status)    status ;;
  *)
    echo "usage: $0 {install|uninstall|status}"
    exit 1
    ;;
esac
