# MCP Vector Proxy — Code Review

Originally reviewed 2026-07-19. Fixes applied same day — see status column.

---

## Bugs

| ID | Status | Notes |
|---|---|---|
| **B1** ✅ | Fixed | `discover_tools` now serves from cache when router is down (with `warning` field in response). Only `execute_tool` requires live router. (`server.ts`) |
| **B2** ✅ | Fixed | `refresh_tools` returns `isError: true` like every other error path. (`server.ts`) |
| **B3** ✅ | Fixed | Unknown tool name returns `{ isError: true }` instead of throwing. (`server.ts`) |
| **B4** ✅ | Fixed | Whitelisted env vars passed to router-cli child (no more leaking `process.env`). (`router-connection.ts`) |
| **B5** ✅ | Fixed | `tray.ts` no longer has its own `loadDotEnv` — imports from `config.ts` whose loader runs as a side effect. New `DEFAULT_HTTP_PORT = 3456` constant in `config.ts`; tray falls back to it when `HTTP_PORT` is unset. Single source of truth for env parsing and the default port. |
| **B6** ✅ | Fixed | `shutdown()` is async, waits 200ms for transport close before exit. (`index.ts`) |
| **B7** ✅ | Fixed | README updated — model name, search semantics, removed 1M-tools claim, added dashboard + log + ALLOW_REMOTE docs. |

---

## Security

| ID | Status | Notes |
|---|---|---|
| **S1** ✅ | Fixed | Proxy refuses to bind `0.0.0.0` / `::` unless `ALLOW_REMOTE=1` is set. Loud warning at startup. (`index.ts`, `config.ts`) **Future:** bearer-token gate when remote is enabled. |

---

## Legacy / risky tech

| ID | Status | Notes |
|---|---|---|
| **L1** ✅ | Fixed | Migrated to MCP TypeScript SDK v2 packages. `createMcpExpressApp` remains available from `@modelcontextprotocol/express`; Node Streamable HTTP uses `@modelcontextprotocol/node`; upstream clients use automatic version negotiation. |
| **L2** ✅ | Bumped | TypeScript `^5.4.0` → `^5.9.0`. Latest is 7.0.2 (native Go compiler) — try after 5.9 is stable in CI. |
| **L3** ✅ | Bumped | `@types/node ^20` → `^22` (Node 22 LTS; Node 20 hit EOL April 2026). |
| **L4** ✅ | Dropped | SSE transport removed. No client was using it (Claude Desktop via stdio-bridge, Claude Code via Streamable HTTP). `/sse` and `/messages` routes gone; `sessions.sse` removed from /health. |
| **L5** ✅ | Pinned | LanceDB `^0.26.2` → `0.26.2` (exact, pre-1.0). |

---

## Startup reliability

| ID | Status | Notes |
|---|---|---|
| **ST1** ✅ | Fixed | `launch-router.ts` uses `npx --offline` after local install. `setup.ps1` pre-installs `@mcp_router/cli` to `node_modules`. |
| **ST2** ✅ | Fixed | `setup.ps1` bakes absolute `node.exe` path to `.node-path`. `tray.ts` reads it and prepends its dir to PATH. `make-exe.ps1` and `restart-tray.ps1` also read it. No PATH dependency at cold boot. |
| **ST3** ✅ | Fixed | Tray pipes proxy child stdout/stderr to `~/.mcp-proxy/proxy.log`. New tray menu item "Open Log File". |
| **ST4** ✅ | Fixed | Migrated HKCU Run key → **Task Scheduler** with `AtLogon` trigger, 30s delay, retry-on-failure (3× / 1min). `setup.ps1` removes the legacy Run-key entry. |

---

## UX improvements

| ID | Status | Notes |
|---|---|---|
| **U1** ✅ | Fixed | HTML dashboard at `/` replaces raw JSON. Tray menu item now "Open Dashboard". |
| **U2** ✅ | Fixed | New `ActivityLog` ring buffer in `server.ts` records every discover/execute/batch/refresh call with timing + outcome. `/api/recent` endpoint + activity section in dashboard with p50/p99 latency summary. |
| **U3** ✅ | Fixed | Search playground in dashboard lets you test queries without an agent. |
| **U4** ✅ | Fixed | Tray tooltip now includes `indexedAt` + `lastError` (tracked in `RouterConnection`). Cold-boot failures are visible at a glance. |
| **U5** ✅ | Fixed | "Open Log File" tray menu item + `~/.mcp-proxy/proxy.log`. |

---

## Dashboard — added ✅

`src/dashboard.ts` (new file). Single-file, no new deps:

- **`GET /`** — HTML dashboard: status card, search playground, tool browser with click-to-copy names, refresh button
- **`GET /discover?q=...`** — read-only JSON wrapper around `vectorIndex.search`
- **`GET /tools`** — JSON list of all indexed tools
- **`POST /refresh`** — trigger re-index from the dashboard
- **`GET /health`** — unchanged (JSON for monitoring)

Mounted in `index.ts` before the session routes. `vector-index.ts` got a new `indexTools` getter for the dashboard's read-only access.

---

## Priority status (all original items)

| Original | Priority | Status |
|---|---|---|
| B1 — cache search when router down | P0 → **P2** (overstated) | ✅ Fixed |
| B2, B3 — error shape consistency | P0 | ✅ Fixed |
| S1 — refuse `HTTP_HOST=0.0.0.0` | P0 | ✅ Fixed |
| Dashboard (U1, U2, U3, U5) | P1 | ✅ Fixed |
| B7 — README sync | P1 | ✅ Fixed |
| ST1, ST3 — pin CLI + log file | P1 | ✅ Fixed |
| ST2, ST4 — absolute node path + Task Scheduler | P2 (promoted) | ✅ Fixed |
| B4 — env whitelist | P2 | ✅ Fixed |
| L1 — migrate to MCP SDK v2 and verify `createMcpExpressApp` | P2 | ✅ Done |
| L2, L3 — bump TS + @types/node | P3 | ✅ Fixed |
| L4 — drop SSE if unused | P3 | Open |
| L5 — pin LanceDB exactly | P3 | ✅ Fixed |
| B5 — tray/proxy port single source of truth | (new) | Open |
| U4 — richer tray tooltip | (new) | Open |

---

## What's still open

- **L1** — MCP SDK v2 migration is complete; typecheck and production build pass.
- **S1 follow-up** — bearer-token gate when `ALLOW_REMOTE=1` (skipped — currently just a warning, not needed unless remote is enabled)

---

## Additions (post-review)

### Query LRU cache
100-entry LRU on query embeddings in `vector-index.ts`. Hot queries (`"send email"`, `"create issue"`) skip the 5-20ms embed step on repeats. Map delete+set on hit moves entry to most-recently-used; eviction from front.

### Per-tool statistics (`stats.ts` + Stats tab)
Strategic pivot toward observability. New `ToolStats` class accumulates per-tool counters (callCount, successCount, failureCount, latency samples capped at 100, lastError, lastCalledAt, firstCalledAt). Recorded on every `execute_tool` and `batch_execute` call.

- `GET /api/stats?sort=calls|failures|latency|name` — aggregated summaries with computed p50/p95/p99/avg/successRate
- New **Stats** tab in the dashboard with sortable per-tool table
- Success-rate bar (green/yellow/red), latency chips (slow/veryslow highlighting), last-error rows
- Resets on proxy restart (no persistence yet)

### Tool allow/deny lists (`filter.ts` + enforcement)
Security boundary for scoping what the proxy exposes to agents.

- `ALLOW_TOOLS` / `DENY_TOOLS` env vars — comma-separated regex patterns on tool names
- Enforced at **three layers**: index time (filtered tools never embedded), execute time (`execute_tool`/`batch_execute` refuse with clear error), fingerprint (computed on filtered list so denied-tool changes don't trigger reindex churn)
- Dashboard shows a yellow banner when filter is active, with the patterns displayed
- `GET /api/filter` endpoint for programmatic access
- New `src/filter.ts` module — single source of truth for the regex compilation and `isToolAllowed()` check
- Changes require a proxy restart (env vars read at module load)

---

## Dependency versions as of 2026-07-19

| Dep | Pin | Latest | Action |
|---|---|---|---|
| `@modelcontextprotocol/client` | `^2.0.0` ✅ | 2.0.0 | Client APIs + automatic version negotiation |
| `@modelcontextprotocol/server` | `^2.0.0` ✅ | 2.0.0 | Server APIs + stdio transport |
| `@modelcontextprotocol/core` | `^2.0.0` ✅ | 2.0.0 | MCP protocol types |
| `@modelcontextprotocol/node` | `^2.0.0` ✅ | 2.0.0 | Node Streamable HTTP transport |
| `@modelcontextprotocol/express` | `^2.0.0` ✅ | 2.0.0 | Express integration |
| `typescript` | `^5.9.0` ✅ | 7.0.2 | Try 7.0 after 5.9 stabilizes |
| `@types/node` | `^22.0.0` ✅ | 22.x / 24.x | Current |
| `express` | `^5.2.1` | 5.x | Current |
| `@huggingface/transformers` | `^3.8.1` | 3.x | Fine |
| `@lancedb/lancedb` | `0.26.2` ✅ (exact) | 0.2x | Pinned until 1.0 |
| `systray2` | `^2.1.4` | 2.x | Stable |

---

## Next steps for the user

1. `npm install` — pull TS 5.9 + @types/node 22
2. `npm run build` — rebuild (already done during review; do again if you touched anything)
3. Run `powershell -ExecutionPolicy Bypass -File setup.ps1` — this:
   - Pre-installs `@mcp_router/cli` locally
   - Writes `.node-path`
   - Migrates Run-key → Task Scheduler
   - Launches the tray now
4. Open `http://127.0.0.1:3456/` — verify the dashboard
5. On next cold boot failure, check `~/.mcp-proxy/proxy.log`
6. To remove the auto-start later: `Unregister-ScheduledTask -TaskName 'MCPVectorProxyTray' -Confirm:$false`
