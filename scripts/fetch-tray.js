#!/usr/bin/env node
/**
 * Postinstall script: downloads the correct prebuilt Rust tray binary
 * for the current platform/arch from the latest GitHub release.
 *
 * Skips gracefully if:
 *   - Not running interactively (npm install --silent / CI without GITHUB_TOKEN)
 *   - Offline
 *   - The dev already built locally via build-tray.{ps1,sh}
 *
 * This file is invoked via "postinstall" in package.json.
 */
const { createWriteStream, existsSync, mkdirSync, renameSync } = require("fs");
const { pipeline } = require("stream/promises");
const path = require("path");

const REPO = "alexiokay/Simple-MCP-Proxy";
const DIST_DIR = path.join(process.cwd(), "dist", "tray");

function platformName() {
  switch (process.platform) {
    case "win32": return "win";
    case "darwin": return "macos";
    case "linux": return "linux";
    default: return process.platform;
  }
}

function archName() {
  switch (process.arch) {
    case "x64": return "x64";
    case "arm64":
    case "aarch64": return "arm64";
    default: return process.arch;
  }
}

function binaryName() {
  const p = platformName();
  const a = archName();
  const ext = process.platform === "win32" ? ".exe" : "";
  return `mcp-tray-${p}-${a}${ext}`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "mcp-vector-proxy-fetch-tray", Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

async function main() {
  const name = binaryName();
  const dest = path.join(DIST_DIR, name);

  // Skip if dev already built locally
  if (existsSync(dest)) {
    console.log(`[fetch-tray] ${name} already present, skipping download.`);
    return;
  }

  mkdirSync(DIST_DIR, { recursive: true });

  console.log(`[fetch-tray] Resolving latest release for ${name}...`);
  let release;
  try {
    release = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch (e) {
    console.warn(`[fetch-tray] Could not reach GitHub: ${e.message}`);
    console.warn(`[fetch-tray] Run locally:  npm run build:tray`);
    return;
  }

  const asset = (release.assets || []).find((a) => a.name === name);
  if (!asset) {
    console.warn(`[fetch-tray] No prebuilt binary for ${name} in release ${release.tag_name}.`);
    console.warn(`[fetch-tray] Run locally:  npm run build:tray`);
    return;
  }

  console.log(`[fetch-tray] Downloading ${asset.name} (${asset.size} bytes)...`);
  try {
    await download(asset.browser_download_url, dest + ".part");
    renameSync(dest + ".part", dest);
    console.log(`[fetch-tray] Saved: ${dest}`);
  } catch (e) {
    console.warn(`[fetch-tray] Download failed: ${e.message}`);
    console.warn(`[fetch-tray] Run locally:  npm run build:tray`);
  }
}

main().catch((e) => {
  console.warn(`[fetch-tray] Unexpected error: ${e.message}`);
  // Never fail npm install over this
});
