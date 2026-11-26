#!/bin/bash
# Install the two launchd jobs: the 08:00 sweep, and the always-on dashboard server.
# Re-runnable. `./install.sh server` installs only the server (hunts stay on demand);
# `./install.sh uninstall` removes both. LADDER_LABEL_PREFIX changes the launchd label prefix.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
NODE="$(command -v node)"
PREFIX="${LADDER_LABEL_PREFIX:-com.ladder}"
SWEEP_LABEL="$PREFIX.sweep"
SERVE_LABEL="$PREFIX.server"
MODE="${1:-install}"
HOUR="${LADDER_SWEEP_HOUR:-8}"
MIN="${LADDER_SWEEP_MIN:-0}"

if [ "$MODE" = "uninstall" ]; then
  for L in "$SWEEP_LABEL" "$SERVE_LABEL"; do
    launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
    rm -f "$LA/$L.plist"
    echo "removed $L"
  done
  exit 0
fi

mkdir -p "$LA" "$DIR/sweep/logs"

LABELS=("$SWEEP_LABEL" "$SERVE_LABEL")
[ "$MODE" = "server" ] && LABELS=("$SERVE_LABEL")

if [ "$MODE" != "server" ]; then
cat > "$LA/$SWEEP_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SWEEP_LABEL</string>
  <key>ProgramArguments</key>
    <array><string>$NODE</string><string>--no-warnings</string><string>$DIR/sweep/run-sweep.mjs</string><string>--scheduled</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MIN</integer></dict>
  <!-- if the Mac was asleep at 08:00, run as soon as it wakes -->
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$DIR/sweep/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/sweep/logs/launchd.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict></plist>
PLIST
fi

cat > "$LA/$SERVE_LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$SERVE_LABEL</string>
  <key>ProgramArguments</key>
    <array><string>$NODE</string><string>--no-warnings</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/sweep/logs/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/sweep/logs/server.err.log</string>
</dict></plist>
PLIST

for L in "${LABELS[@]}"; do
  launchctl bootout "gui/$(id -u)/$L" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA/$L.plist"
  echo "loaded $L"
done

echo
[ "$MODE" != "server" ] && echo "  sweep   : daily at $(printf '%02d:%02d' "$HOUR" "$MIN")  (launchctl kickstart -k gui/$(id -u)/$SWEEP_LABEL to fire now)"
echo "  server  : http://localhost:${LADDER_PORT:-7777}  (auto-restarts, survives reboot)"
