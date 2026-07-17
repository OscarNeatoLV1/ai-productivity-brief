#!/usr/bin/env bash
# Run ONCE on the Mac mini to schedule the daily brief at 6:00 AM (launchd).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.neato.productivity-brief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

chmod +x "$DIR/run-brief.sh"
mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/run-brief.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$DIR/brief.launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/brief.launchd.log</string>
</dict>
</plist>
PLISTEOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed LaunchAgent: $PLIST"
echo "Runs $DIR/run-brief.sh every day at 6:00 AM."
echo "Verify:  launchctl list | grep neato"
