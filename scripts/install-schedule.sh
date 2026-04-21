#!/usr/bin/env bash
# Install or uninstall the launchd schedule for ScrollProxy.
#
# Usage:
#   ./scripts/install-schedule.sh install
#   ./scripts/install-schedule.sh uninstall
#   ./scripts/install-schedule.sh status

set -euo pipefail

LABEL="com.scrollproxy.scheduled-scroll"
TEMPLATE="$(dirname "$0")/launchd/${LABEL}.plist"
INSTALLED_PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_PATH="$HOME/Library/Logs/scrollproxy.log"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

install() {
  if [ ! -f "$TEMPLATE" ]; then
    echo "error: template plist missing at $TEMPLATE"
    exit 1
  fi

  mkdir -p "$(dirname "$INSTALLED_PLIST")"
  mkdir -p "$(dirname "$LOG_PATH")"

  # Scheduled-run plist — fires pnpm run scroll every 6h. X API only, no browser.
  sed \
    -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    -e "s|__PATH__|${PATH}|g" \
    "$TEMPLATE" > "$INSTALLED_PLIST"

  chmod +x "$PROJECT_DIR/scripts/scheduled-run.sh"

  # (Re)load with launchd. bootout is idempotent.
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$INSTALLED_PLIST"

  echo "✓ installed scheduled scroll: $INSTALLED_PLIST"
  echo "  schedule: every 6 hours"
  echo "  source:   X API (lists + bookmarks)"
  echo "  log:      $LOG_PATH"
  echo ""
  echo "To run a pull immediately:"
  echo "  launchctl kickstart -k gui/$(id -u)/${LABEL}"
}

uninstall() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$INSTALLED_PLIST"
  echo "✓ uninstalled. log left at $LOG_PATH"
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
