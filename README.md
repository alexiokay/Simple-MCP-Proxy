# MCP Vector Proxy

A semantic MCP proxy that sits between AI agents and [MCP Router](https://mcprouter.com), exposing only 4 tools instead of hundreds. Uses local vector embeddings to find the right tool on demand — no OpenAI key required.

## Why

When you have 150+ MCP tools, passing all of them to an AI agent costs ~30,000 tokens per request. This proxy exposes just 4 tools (`discover_tools`, `execute_tool`, `batch_execute`, `refresh_tools`). The agent searches semantically for what it needs, then calls it — reducing token usage by ~93%.

```
Without proxy:  151 tools × ~200 tokens = 30,860 tokens per request
With proxy:     4 tool definitions + search results = ~500 tokens
```

## Platform Support

| Platform | x64 | ARM64 | Notes |
|---|---|---|---|
| **Windows** | ✅ | ✅ | Native Rust tray binary, full Task Scheduler integration |
| **macOS** | ✅ | ✅ | Native Rust tray binary, requires launchd setup (see setup.sh) |
| **Linux** | ✅ | ✅ | Native Rust tray binary, requires systemd setup (see setup.sh) |

Prebuilt binaries are downloaded automatically at `npm install` via `scripts/fetch-tray.js`. To build from source: `npm run build:tray`.

## Cross-compiling the tray binary

The Rust tray (`tray-rs/`) compiles to 6 platform/arch combos. Each combo is a separate binary in `dist/tray/`:

```
mcp-tray-win-x64.exe
mcp-tray-win-arm64.exe
mcp-tray-macos-x64
mcp-tray-macos-arm64
mcp-tray-linux-x64
mcp-tray-linux-arm64
```

### Build for current platform

```bash
npm run build:tray      # or:
cd tray-rs && cargo build --release
```

### Cross-compile to another target

```bash
# Add the target once
rustup target add aarch64-pc-windows-msvc

# Build
cd tray-rs
cargo build --release --target aarch64-pc-windows-msvc

# Stage the binary
cp target/aarch64-pc-windows-msvc/release/mcp-tray.exe ../dist/tray/mcp-tray-win-arm64.exe
```

Common targets:
- `x86_64-pc-windows-msvc` (Windows x64)
- `aarch64-pc-windows-msvc` (Windows ARM64)
- `x86_64-apple-darwin` (macOS Intel)
- `aarch64-apple-darwin` (macOS Apple Silicon)
- `x86_64-unknown-linux-gnu` (Linux x64)
- `aarch64-unknown-linux-gnu` (Linux ARM64, requires `gcc-aarch64-linux-gnu`)

### CI builds

Push to `main` triggers [`.github/workflows/build-tray.yml`](.github/workflows/build-tray.yml) which builds all 6 binaries and uploads them as artifacts. Tagging a release (`git tag v0.2.0 && git push --tags`) attaches them to a GitHub Release, which `npm install` then downloads via the postinstall hook.

## Architecture

```
MCP Router (all your servers)
        │ stdio
        ▼
mcp-vector-proxy  (tray-managed background process, port 3456)
  - Local embeddings: mxbai-embed-xsmall-v1 q8 (~23MB, runs offline)
  - sqlite-vec persistence (native KNN vector search via vec0 virtual table)
  - Hybrid search: dense vector (sqlite-vec KNN) + BM25 keyword + RRF fusion
  - Auto-syncs when tools change (MCP notifications + polling)
  - HTML dashboard at / + JSON /health
  - HTTP: Streamable HTTP only (SSE dropped — no known client used it)
        │
        ├── Claude Code / other agents  (HTTP → :3456/mcp)
        │
        └── Claude Desktop              (stdio-bridge → HTTP)

System tray  (node dist/tray.js, auto-starts on login)
  - Green  = connected, N tools indexed
  - Yellow = MCP Router reconnecting (cache still serves discover_tools)
  - Red    = proxy down / crashed (auto-restarts)
  - Right-click → Open Dashboard / Open Log File / Restart Proxy / Exit
  - Proxy logs to ~/.mcp-proxy/proxy.log
```

## Requirements

- **All platforms:** Node.js 18+, [MCP Router](https://mcprouter.com) installed and running
- **Windows:** Windows 10/11
- **macOS:** macOS 10.15+
- **Linux:** Any desktop with a system tray (GNOME, KDE, etc.)

> **First run:** mxbai-embed-xsmall-v1 (~23MB) downloads automatically on first startup and is cached to `.model-cache/`. Subsequent starts are instant.

## Setup

### 1. Configure your token

```bash
cp .env.example .env
# Edit .env and replace "your-mcp-router-token-here" with your real MCPR_TOKEN
```

The `.env` file is gitignored. Alternatively, set `MCPR_TOKEN` as a system environment variable — it takes precedence over the `.env` file.

### 2. Install dependencies and build

```bash
npm install
npm run build
```

### 3. Register auto-start and launch the tray

**Windows:**
```powershell
npm run setup
# or: powershell -ExecutionPolicy Bypass -File setup.ps1
```

**macOS / Linux:**
```bash
npm run setup
# or: bash setup.sh
```

This registers the tray to start on every login and launches it immediately.

### 4. Connect your AI clients

**Claude Code** (`~/.claude.json`):
```json
{
  "mcpServers": {
    "mcp-vector-proxy": {
      "type": "http",
      "url": "http://127.0.0.1:3456/mcp"
    }
  }
}
```

**Claude Desktop** (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):
```json
{
  "mcpServers": {
    "mcp-vector-proxy": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-proxy/dist/stdio-bridge.js"],
      "env": { "PROXY_URL": "http://127.0.0.1:3456/mcp" }
    }
  }
}
```

**Any other agent** — point it at `http://127.0.0.1:3456/mcp` (Streamable HTTP).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MCPR_TOKEN` | *(from .env)* | MCP Router auth token — required |
| `HTTP_PORT` | *(none = stdio mode)* | Port for HTTP server |
| `HTTP_HOST` | `127.0.0.1` | Bind address. `0.0.0.0` / `::` require `ALLOW_REMOTE=1` |
| `ALLOW_REMOTE` | *(unset)* | Opt-in for non-loopback bind (no auth on `execute_tool` — leave unset unless you know what you're doing) |
| `AUTH_TOKEN` | *(unset)* | Reserved for future bearer-token gate when remote is enabled |
| `ALLOW_TOOLS` | *(unset)* | Comma-separated regex patterns. If set, only matching tools are indexed and callable. |
| `DENY_TOOLS` | *(unset)* | Comma-separated regex patterns. Matching tools are hidden and refused at execute time. |
| `DB_PATH` | `.sqlite-vec/proxy.db` | SQLite database path (stores embeddings + metadata) |
| `MODEL_DIM` | `384` | Embedding dimension. Must match the vec0 schema. Change requires deleting `DB_PATH`. |
| `POLL_INTERVAL_MS` | `15000` | Tool change polling interval |
| `DISCOVER_LIMIT` | `10` | Default max results from `discover_tools` |

## Tool Allow/Deny Lists

Scope what the proxy exposes to agents. Patterns are JavaScript regex matched against tool names. Comma-separated.

```bash
# Only expose GitHub and Slack tools
ALLOW_TOOLS=^github_.*,^slack_.*

# Hide anything destructive plus the admin tools
DENY_TOOLS=.*_delete_.*,^admin_.*

# Lock down to a single specific tool
ALLOW_TOOLS=^gmail_send_email$
```

Enforcement is layered:

1. **Index time** — denied tools are never embedded, never appear in `discover_tools` results
2. **Execute time** — `execute_tool` and `batch_execute` refuse denied tools with a clear error, even if the agent learned the name out-of-band
3. **Fingerprint** — computed on the filtered list, so changes to filtered-out tools don't trigger re-indexing

When active, the dashboard shows a yellow banner with the patterns. Changes require a proxy restart.

## Tools Exposed to Agents

| Tool | Description |
|---|---|
| `discover_tools` | Hybrid semantic + keyword search — find relevant tools by natural language query |
| `execute_tool` | Execute any MCP tool by exact name with arguments |
| `batch_execute` | Execute multiple MCP tools in parallel in a single call |
| `refresh_tools` | Force re-index all tools from MCP Router immediately |

## npm Scripts

```bash
npm run build          # Compile TypeScript → dist/
npm run setup          # Register auto-start + launch tray (platform-detected)
npm run update         # Build + restart tray (platform-detected)
```

## Updating

After changing source code:

```bash
npm run update
```

This rebuilds everything and restarts the tray (which restarts the proxy).

## Health Check

```
GET http://127.0.0.1:3456/health
```

```json
{
  "status": "ok",
  "routerConnected": true,
  "tools": 151,
  "indexedAt": "2026-02-17T15:51:21.620Z",
  "lastError": null,
  "sessions": { "streamable": 1 }
}
```

Status is `"ok"` when MCP Router is connected and tools are indexed. `"disconnected"` means the proxy is up but MCP Router is unreachable — `discover_tools` still works from cache, `execute_tool` will fail until reconnection.

## Dashboard

Open `http://127.0.0.1:3456/` in a browser (or use the tray's **Open Dashboard** menu item) for:

- Live status card (connection, tool count, indexedAt, sessions)
- **Search playground** — type a query, see ranked results with relevance bars and argument schemas
- **Tool browser** — searchable list of all indexed tools with click-to-copy names
- **Recent activity** — last 20 discover/execute/batch calls with latency, p50/p99 summary
- **Refresh button** — triggers an immediate re-index

Read-only JSON helpers (used by the dashboard, also useful for scripting):

- `GET /discover?q=<query>&limit=<n>` — same ranking as `discover_tools`
- `GET /tools` — all indexed tools as JSON
- `POST /refresh` — trigger re-index

## Log File

The tray pipes the proxy child's stdout/stderr to `~/.mcp-proxy/proxy.log`. Use the tray's **Open Log File** menu item or:

```bash
# Follow live
tail -f ~/.mcp-proxy/proxy.log        # macOS/Linux
Get-Content ~\.mcp-proxy\proxy.log -Wait   # Windows PowerShell
```

This is the first place to look when the proxy "didn't start on boot".

## File Reference

```
src/
  index.ts          — Main proxy server (HTTP + stdio modes, mounts dashboard)
  server.ts         — MCP tool handlers (discover / execute / batch / refresh)
  dashboard.ts      — HTML dashboard + /discover + /tools read-only routes
  vector-index.ts   — Embeddings + sqlite-vec KNN search + BM25 + RRF
  search.ts         — Pure BM25 / RRF functions
  filter.ts         — Tool allow/deny regex filter (3-layer enforcement)
  stats.ts          — Per-tool stats (call count, success rate, latency)
  activity.ts       — Recent activity ring buffer
  router-connection.ts — MCP Router child lifecycle, reconnection, polling
  launch-router.ts  — Spawns MCP Router CLI (offline after first install)
  tray.ts           — Spawns Rust tray binary, JSON-lines IPC
  config.ts         — Env loading + typed constants

tray-rs/            — Rust crate using tray-icon (cross-platform native tray)
scripts/fetch-tray.js — Postinstall: downloads prebuilt binary from GitHub
build-tray.ps1 / .sh — Build Rust tray for current platform

dist/               — Compiled output (generated by npm run build)

.env.example        — Template for .env (copy and fill in MCPR_TOKEN)
.env                — Your config (gitignored, never commit this)

setup.ps1           — Windows: install CLI locally + register auto-start + launch tray
setup.sh            — macOS/Linux: same
restart-tray.ps1    — Windows: kill + restart tray
restart-tray.sh     — macOS/Linux: same

.lancedb/           — Legacy LanceDB persistence (no longer used, safe to delete)
.sqlite-vec/        — SQLite + sqlite-vec persistence (auto-generated, gitignored)
.tool-meta.json     — Tool fingerprint cache (auto-generated, gitignored)
.model-cache/       — Downloaded embedding model (~23MB, gitignored)
~/.mcp-proxy/proxy.log — Runtime log written by tray (rotated manually)
```

## How Tool Sync Works

1. On startup, tools from MCP Router are embedded using mxbai-embed-xsmall-v1 and stored in SQLite (`DB_PATH`)
2. MCP Router sends a `tools/list_changed` notification when servers change → immediate re-index
3. A polling fallback runs every 15s to catch any missed notifications
4. Re-indexing is incremental — only new or changed tools get re-embedded, cached embeddings are reused
5. Tool schema changes (new parameters) are detected via fingerprint and trigger re-indexing
6. If MCP Router is unreachable, `discover_tools` still serves from the in-memory cache; only `execute_tool` requires a live router

## How Search Works

`discover_tools` uses **hybrid search** for best accuracy:

1. **Dense vector search** — sqlite-vec KNN over mxbai-embed-xsmall-v1 embeddings (handles paraphrasing, synonyms, conceptual matches; sublinear via HNSW scan)
2. **BM25 keyword search** — in-memory scoring over tool names + descriptions finds exact keyword matches that semantic search can miss
3. **RRF fusion** — Reciprocal Rank Fusion merges both ranked lists into a single optimal ranking

Embeddings live in the `tools` vec0 virtual table alongside their metadata. Vector distance from sqlite-vec is converted to cosine similarity (1 − distance for L2-normalized vectors).

This combination handles both vague queries ("something to do with files") and precise queries ("browser_screenshot") accurately.

## Migrating from LanceDB

If you're upgrading from a pre-sqlite-vec version:

1. The old `.lancedb/` directory is ignored (no longer in deps)
2. On first startup with the new code, all tools are re-embedded from scratch
3. One-time cost: ~5-25s depending on tool count (165 tools ≈ ~10s on typical hardware)
4. After successful re-index, you can delete `.lancedb/` manually

Fingerprint matches won't be honored on first run because the new DB is empty — reindexing is forced.
