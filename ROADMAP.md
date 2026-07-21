# MCP Vector Proxy — Roadmap

Future features, ranked by effort vs. impact. Not committed — pick what matches your priorities.

---

## P1 — High impact, moderate effort

### SDK / headless mode (DECIDED — do AFTER Phase 1-3, when a real consumer asks)

**Goal:** let MCP Router (or any MCP server) embed the search core without running our HTTP server, tray, or dashboard.

**Why deferred:** speculative SDK work locks in API decisions that may not match real consumer needs. Better to wait for an actual user (e.g., MCP Router team) and design to their requirements. Also, doing this AFTER Phase 1-3 avoids double-refactor: sqlite-vec removes the native binding (cleaner SDK), Rust tray fully decouples (no tray deps leak into SDK imports).

**Architecture:**
```
src/
├── core/                ← SDK-able, zero side effects
│   ├── vector-index.ts  (constructor options, not env vars)
│   ├── search.ts
│   ├── filter.ts
│   ├── stats.ts
│   ├── activity.ts
│   └── types.ts
├── server/              ← MCP protocol factory
├── middleware/          ← drop-in helper
├── http/                ← Express + dashboard (standalone-only)
├── supervisor/          ← tray + process management (standalone-only)
└── standalone/          ← full app entrypoint + config
```

**package.json exports:**
```json
{
  "exports": {
    ".":            "./dist/standalone/index.js",
    "./core":       "./dist/core/index.js",
    "./server":     "./dist/server/index.js",
    "./middleware": "./dist/middleware/index.js"
  }
}
```

**Three consumer use cases:**

1. **Vendor embeds search** — `import { VectorIndex, ToolFilter } from "mcp-vector-proxy/core"`. Vendor keeps their own HTTP/MCP server, uses our index internally.

2. **Add semantic discovery to existing MCP server** — `import { createSemanticTools } from "mcp-vector-proxy/server"`. Returns the 4 tool handlers (discover/execute/batch/refresh), consumer wires them to their server.

3. **Drop-in middleware** — `semanticDiscovery(myServer, { sourceClient, filter })`. One call adds semantic discovery to any MCP server.

**Refactors required:**
- `config.ts` split: env loading → `standalone/config.ts`; constants → `core/options.ts` with constructor overrides
- `VectorIndex` → constructor options instead of env reads
- `RouterConnection` → accept any Client-shaped object (not assume StdioClientTransport)
- New `middleware/semantic.ts` (~100 lines)

**Effort:** ~7-11 hours
- Core refactor to constructor options: 2-3 hours
- Split src/ into layout above: 2-3 hours
- package.json exports + tsconfig: 1 hour
- Middleware abstraction: 1-2 hours
- SDK README + use-case examples: 1-2 hours

**Caveats:**
- Wait for real consumer before building
- Plan for `1.0.0` SDK with stable API (semver discipline)
- Dual identity docs: "use as tool" vs "use as library"
- SDK guide separate from end-user README

---

### Settings panel in dashboard
**Goal:** runtime-tunable options without editing `.env` + restart.

**Options to expose:**
| Setting | Type | Range |
|---|---|---|
| Embedding model | select | `mxbai-embed-xsmall-v1` / `all-MiniLM-L6-v2` / `EmbeddingGemma-300M` |
| Hybrid search | toggle | on/off |
| Vector/BM25 blend weight | slider | 0..1 |
| Default DISCOVER_LIMIT | number | 1..50 |
| Query cache size | number | 0..1000 |
| Activity log capacity | number | 10..500 |
| Stats sample cap | number | 10..1000 |
| Poll interval | number | 1000..60000 ms |

**Persistence:** `~/.mcp-proxy/settings.json` (loaded at startup, hot-reloadable).

**Effort:** ~6-8 hours (form UI + persistence + hot-reload wiring).
**Impact:** Big UX win for tuning without restarts.

---

### Dashboard-managed filtering
**Goal:** edit allow/deny lists from the dashboard without restart.

**Approach:** hybrid config
- `.env` / `ALLOW_TOOLS` / `DENY_TOOLS` = baseline (boot only)
- `~/.mcp-proxy/filter.json` = runtime override (dashboard edits this)
- File watcher triggers regex recompile + reindex

**Effort:** ~3 hours.
**Impact:** Removes the restart penalty for scope changes.

**Risk:** if `ALLOW_REMOTE=1` is ever enabled, this becomes a security surface (any dashboard user can change scope). Mitigation: require AUTH_TOKEN before allowing filter edits.

---

## P2 — Medium impact

### Replace LanceDB with sqlite-vec (DECIDED, doing this)

**Goal:** remove LanceDB native binding, unlock native Windows ARM64, future-proof for users with 100K+ tools.

**Why sqlite-vec over JSON:** the project targets a broad audience. JSON works fine up to ~20K tools (15ms cosine scan), but for users with very large tool collections, sqlite-vec's HNSW index scales sublinearly. Same code path serves everyone.

**Why sqlite-vec over LanceDB:** `better-sqlite3` ships prebuilt Windows ARM64 binaries. LanceDB does not. sqlite-vec is a loadable SQLite extension (~500KB). SQLite is universally available, embedded, no server.

**Approach:**
- Add `better-sqlite3` and `sqlite-vec` deps
- Migrate `vector-index.ts` to use SQLite as the backing store
- Schema:
  ```sql
  CREATE VIRTUAL TABLE tools_vec USING vec0(
    name TEXT PRIMARY KEY,
    description TEXT,
    input_schema TEXT,
    cache_key TEXT,
    embedding FLOAT[384]
  );
  ```
- Search uses vec0 KNN query; in-memory index can be dropped or kept as cache
- Migrate existing LanceDB data on first run (or just re-embed — minor one-time cost)

**Effort:** ~4-6 hours.
**Impact:** Native ARM64 support, broader scalability, simpler build, drops pre-1.0 LanceDB dep.

---

### Replace systray2 with a Rust tray binary using `tray-icon` (DECIDED, doing this)

**Goal:** native tray on every platform/arch (Windows x64/ARM64, macOS Intel/Apple Silicon, Linux x64/ARM64). Drop systray2 entirely.

**Why Rust + `tray-icon`:** Tauri-maintained crate, modern standard, single source codebase for all platforms, native ARM everywhere. The C# merged-launcher alternative was rejected because it's Windows-only — the project targets a broad audience.

**Architecture:**
```
Task Scheduler / launchd / systemd
  └─ node dist/tray.js (Node process)
       ├─ mcp-tray-{platform} ──(JSON IPC over stdio)──► native tray UI
       └─ spawn(node, dist/index.js)  ← proxy
```

**Code structure:**
- New `tray-rs/` directory:
  - `Cargo.toml` — depends on `tray-icon`, `tao` (event loop), `serde_json`
  - `src/main.rs` — ~150-200 lines: read JSON menu from stdin, emit click events on stdout
- `tray.ts` keeps current shape, swaps systray2 calls for the Rust binary
- Build script (`build-tray.sh` / `build-tray.ps1`) compiles 6 binaries via `cargo` or `cross`

**Distribution:**
- Bundle 6 prebuilt binaries in the npm package (like systray2 does):
  - `dist/tray/mcp-tray-win-x64.exe`
  - `dist/tray/mcp-tray-win-arm64.exe`
  - `dist/tray/mcp-tray-macos-x64`
  - `dist/tray/mcp-tray-macos-arm64`
  - `dist/tray/mcp-tray-linux-x64`
  - `dist/tray/mcp-tray-linux-arm64`
- `tray.ts` detects `process.platform` + `process.arch`, spawns the right one

**Protocol (JSON lines over stdio):**
- Parent → tray: `{"type":"menu","icon":"green","items":[{"title":"...","enabled":true},...]}`
- Tray → parent: `{"type":"click","seq_id":2}`

**Platform notes:**
- macOS: menu bar item, not system tray (different UX convention)
- Linux: requires `libayatana-appindicator3-1` or equivalent — document this
- Windows: standard NotifyIcon behavior

**Effort:** ~8-12 hours total
- Rust code: ~3-4 hours
- Build pipeline for 6 platforms (CI): ~2-3 hours
- `tray.ts` rewrite: ~2 hours
- Cross-platform testing: ~2-3 hours (requires access to all platforms)

**Impact:** Native tray on every platform, future-proof, drops systray2 dep, single codebase.

**Build deps going forward:** Node + Rust (cargo). End users do NOT need Rust — only prebuilt binaries ship.

---

### Native Windows ARM64 build (unblocked + DONE)

After sqlite-vec migration + Rust tray, the ARM blockers are gone:
- ~~`@lancedb/lancedb`~~ → sqlite-vec (ARM native via better-sqlite3)
- ~~`systray2`~~ → Rust tray binary (native ARM via `tray-icon` crate)

What's wired up:
- ✅ CI builds 6 platform/arch combos via GitHub Actions
- ✅ Postinstall auto-downloads right binary for current platform
- ✅ Cross-compile docs in README
- ✅ Platform support matrix in README

Still pending (needs real hardware):
- Verify `@huggingface/transformers` runs on WoA (pure JS + WASM, should work)
- Verify `better-sqlite3` ARM64 binary loads on Windows ARM
- Smoke test on Surface Pro X / Snapdragon laptops

**Effort:** Done in code; ~1-2 hours of testing pending hardware.
**Impact:** Full native ARM64 support claimed, awaiting validation.

---

## P2.5 — Output reduction (per-tool policy)

**Goal:** prevent heavy tool payloads from blowing up conversation history.

**Why now:** Real problem (50K-token results degrade agent performance on subsequent turns). Outside discussion confirmed the value.

**Why NOT like Gemini described it:** We don't need Docker/WASM sandboxes or a Python runtime. We need a per-tool policy engine.

**Approach:**
```json
{
  "fetch_web_page":    { "maxTokens": 2000, "mode": "truncate" },
  "query_database":    { "maxTokens": 1000, "mode": "summarize" },
  "list_files":        { "maxTokens": 500,  "mode": "first_n", "n": 100 },
  "default":           { "mode": "passthrough" }
}
```

Three modes:
- **passthrough** (default) — no change. Safe.
- **truncate** — hard cap with smart break (sentence/paragraph boundary, not mid-token)
- **summarize** — local small model summarizes; uses existing embedding infra where possible, dedicated tiny model otherwise

**Policy source:** `~/.mcp-proxy/policies.json` — editable in dashboard.

**Effort:** ~6-8 hours (truncate is easy, summarize needs a small local model).
**Impact:** High for users with verbose tools (web fetch, log search, file ops). No effect for users with simple tools.

**Risk:** Wrong policy wrecks agent capability. Mitigation: passthrough default, easy override per-tool, dashboard warning when a policy triggers.

---



### Persistent activity log
**Goal:** observability data survives restart.

**Approach:** SQLite at `~/.mcp-proxy/activity.db`. Stream writes, rotate after N rows or M days.

**Effort:** ~3 hours.
**Impact:** Necessary for trend analysis ("this tool started failing yesterday").

---

### Health probes per tool
**Goal:** know a tool is broken before the agent tries it.

**Approach:** periodic background call with no-op args (where possible) or schema validation. Mark unhealthy in the dashboard.

**Effort:** ~4 hours.
**Impact:** Useful for ops, especially with many MCP servers.

---

### Schema diff viewer
**Goal:** when a tool's schema changes, show what changed.

**Approach:** store previous schema snapshots, deep-diff on reindex, surface in dashboard.

**Effort:** ~3 hours.
**Impact:** Operational visibility. Pairs well with the Stats tab.

---

### Time-series activity chart
**Goal:** visual trend of activity over time.

**Approach:** bucket activity into 1-minute intervals, render as sparkline or bar chart in the dashboard.

**Effort:** ~4 hours.
**Impact:** Nice to have, mostly aesthetic.

---

## Explicitly rejected (considered, declined)

Documented so they don't get re-proposed.

| Idea | Why rejected |
|---|---|
| **Cross-encoder re-ranking** | Adds 200-400MB deps, doubles latency. Not worth it at <500 tools. |
| **Compact schema in discover** | Loses field descriptions/enums — hurts agent comprehension more than it saves tokens. |
| **Failure-aware re-ranking** | Signal too noisy. Penalties hurt active-development workflows (developer iterating on a tool). |
| ~~Drop LanceDB for JSON~~ | JSON is the right tool for ≤20K tools, but the project targets a broad audience where 100K+ scale matters. JSON caps out at "acceptable" while sqlite-vec scales. Decision: use sqlite-vec instead. See P2 above. |
| ~~Result truncation policy~~ | **Replaced by P2.5 above** — per-tool reduction policy with multiple modes, not global truncation. |
| **Hierarchical discovery** | Only matters at 500+ tools. Current ceiling is ~10K, typical user has 100-200. |
| **Fine-tuned embeddings** | Requires training data the user doesn't have. Massive effort. |
| **Learning-to-rank** | Same problem — needs thousands of interactions to train meaningfully. |
| **Tool deduplication** | Hard to define "duplicate" safely. Risk of hiding the wrong tool. |
| **Auto-convert tools → Skills** | Wrong abstraction layer. Skills encode workflows (multi-step patterns); tools expose atomic capabilities. Auto-generation would produce low-value wrappers and lose MCP universality. Skills should be human-authored. |
| **"Inflate schema at execution" (lazy discovery)** | Technically impossible as described — model needs schema BEFORE execution to generate args. The correct version (`get_schema(name)` as a separate tool call) hurts agent comprehension. Will likely become native in MCP spec after 2026-07-28 (Extensions) — wait for the protocol to solve this. |
| **C# merged launcher as tray** | Technically cleaner than IPC (zero cross-process communication), uses .NET already in the project, native AnyCPU. **But** Windows-only — conflicts with the project's broader-audience goal. Chose Rust + `tray-icon` instead for cross-platform parity. |
| **Fork systray2 + add ARM binary** | Smallest-effort ARM unblock (~2-3 hours). Rejected because the underlying Rust crate is older and we'd own a fork forever. A new minimal Rust binary on the modern `tray-icon` crate is cleaner long-term. |
| **Docker/WASM sandbox for payload reduction** | Massive complexity for what's essentially text reduction. Per-tool policy (see P2.5) achieves 90% of the value at 1% of the complexity. |

---

## Dependency / versioning items to revisit

- **L1** — verify `createMcpExpressApp` survives MCP SDK v2.0 (after 2026-07-28). Migration may be needed.
- **S1 follow-up** — bearer-token gate when `ALLOW_REMOTE=1`. Currently just a warning.
- **LanceDB pin** — currently `0.26.2` (exact). Pre-1.0; minor bumps may break.
