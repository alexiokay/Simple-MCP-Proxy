#!/usr/bin/env bash
# restart-tray.sh — kills and restarts the Node.js tray process (macOS/Linux)
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRAY_SCRIPT="$SCRIPT_DIR/dist/tray.js"
NODE_BIN="$(which node)"

pkill -f "node.*dist/tray.js" 2>/dev/null || true
sleep 1
nohup "$NODE_BIN" "$TRAY_SCRIPT" > "$HOME/.mcp-proxy-tray.log" 2>&1 &
echo "Tray restarted (PID $!)."
