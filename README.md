# MCP Vector Proxy

A semantic MCP proxy that sits between AI agents and [MCP Router](https://mcprouter.com), exposing only 4 tools instead of hundreds. Uses local vector embeddings to find the right tool on demand — no OpenAI key required.

## Why

When you have 150+ MCP tools, passing all of them to an AI agent costs ~30,000 tokens per request. This proxy exposes just 4 tools (`discover_tools`, `execute_tool`, `batch_execute`, `refresh_tools`). The agent searches semantically for what it needs, then calls it — reducing token usage by ~93%.

```
Without proxy:  151 tools × ~200 tokens = 30,860 tokens per request
With proxy:     4 tool definitions + search results = ~500 tokens
```

## Architecture

```
MCP Router (all your servers)
        │ stdio
        ▼
mcp-vector-proxy  (tray-managed background process, port 3456)
  - Local embeddings: EmbeddingGemma-300M q8 (~150MB, runs offline)
  - LanceDB vector store (persistent, handles 1M+ tools, no server)
  - Hybrid search: dense vector + BM25 keyword + RRF fusion
  - Auto-syncs when tools change (MCP notifications + polling)
  - HTTP: Streamable HTTP + SSE legacy
        │
        ├── Claude Code / other agents  (HTTP → :3456/mcp)
        │
        └── Claude Desktop              (stdio-bridge → HTTP)

System tray  (node dist/tray.js, auto-starts on login)
  - Green  = connected, N tools indexed
  - Yellow = MCP Router reconnecting
  - Red    = proxy down / crashed (auto-restarts)
  - Right-click → Restart Proxy / Open Health URL / Exit
```

## Requirements

- **All platforms:** Node.js 18+, [MCP Router](https://mcprouter.com) installed and running
- **Windows:** Windows 10/11
- **macOS:** macOS 10.15+
- **Linux:** Any desktop with a system tray (GNOME, KDE, etc.)

> **First run:** EmbeddingGemma-300M (~150MB) downloads automatically on first startup and is cached to `.model-cache/`. Subsequent starts are instant.

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

**Any other agent** — point it at `http://127.0.0.1:3456/mcp` (Streamable HTTP) or `http://127.0.0.1:3456/sse` (SSE legacy).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MCPR_TOKEN` | *(from .env)* | MCP Router auth token — required |
| `HTTP_PORT` | *(none = stdio mode)* | Port for HTTP server |
| `HTTP_HOST` | `127.0.0.1` | Bind address |
| `POLL_INTERVAL_MS` | `15000` | Tool change polling interval |
| `DISCOVER_LIMIT` | `10` | Default max results from `discover_tools` |

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
  "sessions": { "streamable": 1, "sse": 0 }
}
```

Status is `"ok"` when MCP Router is connected and tools are indexed. `"disconnected"` means the proxy is up but MCP Router is unreachable (it will auto-reconnect).

## File Reference

```
src/
  index.ts          — Main proxy server (HTTP + stdio modes, hybrid vector search)
  stdio-bridge.ts   — Thin stdio→HTTP forwarder for Claude Desktop
  launch-router.ts  — Spawns MCP Router CLI with windowsHide:true
  tray.ts           — Cross-platform system tray (systray2)

dist/               — Compiled output (generated by npm run build)

.env.example        — Template for .env (copy and fill in MCPR_TOKEN)
.env                — Your config (gitignored, never commit this)

setup.ps1           — Windows: register auto-start + launch tray
setup.sh            — macOS/Linux: register auto-start + launch tray
restart-tray.ps1    — Windows: kill + restart tray
restart-tray.sh     — macOS/Linux: kill + restart tray

.lancedb/           — LanceDB vector store (auto-generated, gitignored)
.tool-meta.json     — Tool fingerprint cache (auto-generated, gitignored)
.model-cache/       — Downloaded embedding model (~150MB, gitignored)
```

## How Tool Sync Works

1. On startup, tools from MCP Router are embedded using EmbeddingGemma-300M and stored in LanceDB
2. MCP Router sends a `tools/list_changed` notification when servers change → immediate re-index
3. A polling fallback runs every 15s to catch any missed notifications
4. Re-indexing is incremental — only new or changed tools get re-embedded, cached embeddings are reused
5. Tool schema changes (new parameters) are detected via fingerprint and trigger re-indexing

## How Search Works

`discover_tools` uses **hybrid search** for best accuracy:

1. **Dense vector search** — LanceDB finds semantically similar tools using EmbeddingGemma-300M embeddings (handles paraphrasing, synonyms, conceptual matches)
2. **BM25 keyword search** — in-memory scoring finds exact tool name / keyword matches that semantic search can miss
3. **RRF fusion** — Reciprocal Rank Fusion merges both ranked lists into a single optimal ranking

This combination handles both vague queries ("something to do with files") and precise queries ("browser_screenshot") accurately at any scale.
