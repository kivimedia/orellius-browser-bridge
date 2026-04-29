#!/usr/bin/env bash
# Launch Firefox with WebDriver BiDi enabled, profile = "orellius".
# Required before using Orellius for Firefox so host/bidi-driver.js can
# connect to the Firefox Remote Agent at 127.0.0.1:9222.

set -euo pipefail

PROFILE="${1:-orellius}"
PORT="${2:-9222}"

# Resolve Firefox binary. Override with FIREFOX_PATH if needed.
if [[ -n "${FIREFOX_PATH:-}" ]]; then
  FF="$FIREFOX_PATH"
elif command -v firefox >/dev/null 2>&1; then
  FF=$(command -v firefox)
elif [[ -d "/Applications/Firefox.app" ]]; then
  FF="/Applications/Firefox.app/Contents/MacOS/firefox"
else
  echo "Firefox not found. Set FIREFOX_PATH env var or install Firefox." >&2
  exit 1
fi

echo "Launching Firefox profile \"$PROFILE\" with --remote-debugging-port=$PORT"
echo "(Profile must already exist. Run: $FF -P  to create it the first time.)"
echo

"$FF" -P "$PROFILE" --remote-debugging-port="$PORT" &
disown
