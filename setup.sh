#!/usr/bin/env bash
# setup.sh — one-time setup for macOS and Linux.
# Registers the tray to auto-start on login and launches it now.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAY_SCRIPT="$SCRIPT_DIR/dist/tray.js"
NODE_BIN="$(which node)"

if [ -z "$NODE_BIN" ]; then
  echo "Error: node not found in PATH" >&2
  exit 1
fi

# ── macOS: launchd plist ──────────────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  PLIST_DIR="$HOME/Library/LaunchAgents"
  PLIST="$PLIST_DIR/com.mcp-vector-proxy.tray.plist"
  mkdir -p "$PLIST_DIR"

  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mcp-vector-proxy.tray</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$TRAY_SCRIPT</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>StandardOutPath</key>
  <string>$HOME/.mcp-proxy-tray.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.mcp-proxy-tray.log</string>
</dict>
</plist>
EOF

  # Modern launchctl API (macOS 10.10+): bootstrap/bootout instead of deprecated load/unload
  launchctl bootout "gui/$(id -u)/com.mcp-vector-proxy.tray" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Auto-start registered via launchd."
  echo "Tray launched."

# ── Linux: XDG autostart ──────────────────────────────────────────────────────
else
  AUTOSTART_DIR="$HOME/.config/autostart"
  DESKTOP="$AUTOSTART_DIR/mcp-vector-proxy-tray.desktop"
  mkdir -p "$AUTOSTART_DIR"

  cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=MCP Vector Proxy Tray
Exec=$NODE_BIN $TRAY_SCRIPT
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
EOF

  echo "Auto-start registered via XDG autostart."

  # Kill any existing tray and launch
  pkill -f "node.*dist/tray.js" 2>/dev/null || true
  sleep 1
  nohup "$NODE_BIN" "$TRAY_SCRIPT" > "$HOME/.mcp-proxy-tray.log" 2>&1 &
  echo "Tray launched (PID $!)."
fi

echo ""
echo "Done! The tray will auto-start on every login."
