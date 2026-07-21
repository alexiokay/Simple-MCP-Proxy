#!/usr/bin/env bash
# build-tray.sh - Build the Rust tray binary for the current macOS/Linux arch
# and copy it to dist/tray/.
#
# For cross-compile to other targets, use:
#   rustup target add aarch64-apple-darwin
#   cargo build --release --target aarch64-apple-darwin
#   cp target/aarch64-apple-darwin/release/mcp-tray dist/tray/mcp-tray-macos-arm64

set -e
cd "$(dirname "$0")"

if [ ! -f tray-rs/Cargo.toml ]; then
    echo "No tray-rs/ directory found - skipping Rust tray build."
    exit 0
fi

echo "Building Rust tray (release)..."
(cd tray-rs && cargo build --release)

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64) ARCH="x64" ;;
    arm64|aarch64) ARCH="arm64" ;;
esac
case "$PLATFORM" in
    darwin) PLATFORM="macos" ;;
    linux) PLATFORM="linux" ;;
esac

mkdir -p dist/tray
DEST="dist/tray/mcp-tray-${PLATFORM}-${ARCH}"
cp "tray-rs/target/release/mcp-tray" "$DEST"
chmod +x "$DEST"
echo "Tray binary: $DEST"
