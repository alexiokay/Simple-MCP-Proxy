/**
 * Minimal HTML dashboard for browser access.
 *
 * Routes:
 *   GET /            → HTML page (status + search playground + tool browser)
 *   GET /discover?q= → JSON search results (read-only, no router needed)
 *   GET /tools       → JSON list of all indexed tools
 *   POST /refresh    → trigger re-index (requires router connection)
 *
 * No new dependencies. Uses inline HTML + vanilla JS.
 */
import { Router } from "express";

import { DISCOVER_LIMIT } from "./config.js";
import type { VectorIndex } from "./vector-index.js";
import type { RouterConnection } from "./router-connection.js";
import type { ActivityLog } from "./activity.js";
import type { ToolStats } from "./stats.js";
import { getFilterSummary } from "./filter.js";

export function createDashboardRouter(
    vectorIndex: VectorIndex,
    router: RouterConnection,
    activity: ActivityLog,
    stats: ToolStats,
): Router {
    const r = Router();

    // ── Read-only JSON helpers ───────────────────────────────────────────────

    r.get("/discover", async (req, res) => {
        const q = (req.query.q as string ?? "").trim();
        if (!q) { res.status(400).json({ error: "Missing ?q=" }); return; }
        if (vectorIndex.toolCount === 0) {
            res.status(503).json({ error: "No tools indexed yet." });
            return;
        }
        const limit = Math.min(parseInt((req.query.limit as string) ?? String(DISCOVER_LIMIT), 10) || DISCOVER_LIMIT, 50);
        try {
            const results = await vectorIndex.search(q, limit);
            res.json({ query: q, count: results.length, routerConnected: router.isConnected, results });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    r.get("/tools", (_req, res) => {
        const tools = vectorIndex.indexTools.map((t) => ({
            name: t.name,
            description: t.description,
        }));
        res.json({ count: tools.length, indexedAt: vectorIndex.indexedAt || null, tools });
    });

    r.get("/api/recent", (_req, res) => {
        res.json({ entries: activity.snapshot() });
    });

    r.get("/api/stats", (req, res) => {
        const sortBy = (req.query.sort as "calls" | "name" | "latency" | "failures") ?? "calls";
        const allowed = ["calls", "name", "latency", "failures"];
        const sb = allowed.includes(sortBy) ? sortBy : "calls";
        res.json({
            totalCalls: stats.totalCalls,
            tools: stats.snapshot(sb as "calls" | "name" | "latency" | "failures"),
        });
    });

    r.get("/api/filter", (_req, res) => {
        res.json(getFilterSummary());
    });

    r.post("/refresh", async (_req, res) => {
        const client = router.activeClient;
        if (!client || !router.isConnected) {
            res.status(503).json({ error: "MCP Router not connected." });
            return;
        }
        try {
            const result = await vectorIndex.buildIndex(client, "dashboard");
            res.json({ ok: true, ...result, total: vectorIndex.toolCount, indexedAt: vectorIndex.indexedAt });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    // ── HTML dashboard at / ──────────────────────────────────────────────────

    r.get("/", (_req, res) => {
        res.type("html").send(DASHBOARD_HTML);
    });

    return r;
}

// ─── Inline HTML ────────────────────────────────────────────────────────────

const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Vector Proxy</title>
<style>
  :root {
    --bg: #0a0e1a;
    --bg-elev: #11172a;
    --bg-elev-2: #161d33;
    --border: rgba(148, 163, 184, 0.10);
    --border-strong: rgba(148, 163, 184, 0.18);
    --text: #e2e8f0;
    --text-dim: #94a3b8;
    --text-mute: #64748b;
    --accent: #6366f1;
    --accent-2: #818cf8;
    --accent-glow: rgba(99, 102, 241, 0.45);
    --green: #22c55e;
    --green-glow: rgba(34, 197, 94, 0.35);
    --yellow: #eab308;
    --yellow-glow: rgba(234, 179, 8, 0.35);
    --red: #ef4444;
    --red-glow: rgba(239, 68, 68, 0.35);
    --radius: 12px;
    --radius-sm: 8px;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 4px 12px rgba(0,0,0,0.2);
    --shadow-lg: 0 4px 16px rgba(0,0,0,0.3), 0 12px 40px rgba(0,0,0,0.25);
  }
  * { box-sizing: border-box; }
  html {
    /* Always reserve space for the scrollbar so centered content doesn't
       shift horizontally when a panel becomes scrollable. */
    scrollbar-gutter: stable;
    overflow-y: scroll;
  }
  html, body { height: 100%; }
  /* WebKit scrollbar styling - make it visible but unobtrusive */
  ::-webkit-scrollbar { width: 12px; height: 12px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: rgba(148, 163, 184, 0.20);
    border-radius: 6px;
    border: 3px solid transparent;
    background-clip: padding-box;
  }
  ::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.35); background-clip: padding-box; }
  * { scrollbar-color: rgba(148, 163, 184, 0.30) transparent; scrollbar-width: thin; }
  body {
    margin: 0;
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", system-ui, sans-serif;
    color: var(--text);
    background:
      radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99, 102, 241, 0.10), transparent 60%),
      radial-gradient(ellipse 60% 40% at 100% 0%, rgba(139, 92, 246, 0.06), transparent 50%),
      var(--bg);
    background-attachment: fixed;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* ── Top bar ─────────────────────────────────────────────────────────────── */
  .topbar {
    position: sticky; top: 0; z-index: 50;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    background: rgba(10, 14, 26, 0.72);
    border-bottom: 1px solid var(--border);
  }
  .topbar-inner {
    max-width: 1080px; margin: 0 auto;
    padding: 14px 24px;
    display: flex; align-items: center; gap: 16px;
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-weight: 600; font-size: 15px; letter-spacing: -0.01em;
  }
  .brand-icon {
    width: 28px; height: 28px;
    display: grid; place-items: center;
    border-radius: 8px;
    background: linear-gradient(135deg, var(--accent), #8b5cf6);
    box-shadow: 0 4px 12px var(--accent-glow);
    font-size: 14px;
  }
  .brand-sub { color: var(--text-dim); font-weight: 400; font-size: 13px; }
  .topbar-spacer { flex: 1; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 12px;
    border-radius: 999px;
    font-size: 12px; font-weight: 500;
    border: 1px solid var(--border-strong);
    background: var(--bg-elev);
    transition: all .2s ease;
  }
  .status-pill.ok { color: #86efac; border-color: rgba(34,197,94,0.25); background: rgba(34,197,94,0.06); }
  .status-pill.warn { color: #fde68a; border-color: rgba(234,179,8,0.25); background: rgba(234,179,8,0.06); }
  .status-pill.err { color: #fecaca; border-color: rgba(239,68,68,0.25); background: rgba(239,68,68,0.06); }
  .status-pill .pulse {
    width: 8px; height: 8px; border-radius: 50%;
    background: currentColor;
    box-shadow: 0 0 0 0 currentColor;
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
    70% { box-shadow: 0 0 0 6px transparent; opacity: 0.7; }
    100% { box-shadow: 0 0 0 0 transparent; opacity: 1; }
  }

  /* ── Layout ──────────────────────────────────────────────────────────────── */
  .wrap { max-width: 1080px; margin: 0 auto; padding: 28px 24px 96px; }

  .hero {
    margin-bottom: 28px;
  }
  .hero h1 {
    margin: 0 0 6px;
    font-size: 28px; font-weight: 600; letter-spacing: -0.02em;
    background: linear-gradient(135deg, #fff 0%, #cbd5e1 100%);
    -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .hero .sub { color: var(--text-dim); font-size: 14px; }

  /* ── Stat cards ──────────────────────────────────────────────────────────── */
  .grid {
    display: grid; gap: 12px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin-bottom: 32px;
  }
  .card {
    position: relative;
    background: linear-gradient(180deg, var(--bg-elev) 0%, rgba(17, 23, 42, 0.6) 100%);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    transition: border-color .2s ease, transform .2s ease;
  }
  .card:hover { border-color: var(--border-strong); }
  .card .k {
    color: var(--text-mute);
    font-size: 11px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.06em;
  }
  .card .v {
    font-size: 22px; font-weight: 600; margin-top: 6px;
    letter-spacing: -0.01em; word-break: break-word;
    color: var(--text);
  }
  .card .v.small { font-size: 13px; font-weight: 400; color: var(--text-dim); }
  .card .v.green { color: #86efac; }
  .card .v.red { color: #fecaca; }

  /* ── Tabs ────────────────────────────────────────────────────────────────── */
  .tabs {
    display: flex; gap: 4px;
    padding: 4px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 20px;
    width: fit-content;
  }
  .tab {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-size: 13px; font-weight: 500;
    color: var(--text-dim);
    background: transparent; border: none;
    cursor: pointer;
    transition: all .15s ease;
    display: inline-flex; align-items: center; gap: 8px;
  }
  .tab:hover { color: var(--text); }
  .tab.active {
    background: var(--bg-elev-2);
    color: var(--text);
    box-shadow: var(--shadow);
  }
  .tab .count {
    font-size: 11px; padding: 2px 6px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.10);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
  .tab.active .count { background: var(--accent); color: white; }
  .panel { display: none; animation: fadeIn .25s ease; }
  .panel.active { display: block; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

  /* ── Section header ──────────────────────────────────────────────────────── */
  .section-head {
    display: flex; align-items: baseline; gap: 12px;
    margin: 0 0 14px;
  }
  .section-head h2 {
    margin: 0;
    font-size: 13px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--text-dim);
  }
  .section-head .hint { color: var(--text-mute); font-size: 12px; }

  /* ── Inputs / buttons ────────────────────────────────────────────────────── */
  .input-wrap {
    position: relative; flex: 1;
  }
  .input-wrap .icon {
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    color: var(--text-mute); pointer-events: none;
    font-size: 14px;
  }
  input {
    width: 100%;
    font: inherit; color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 14px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input.with-icon { padding-left: 38px; }
  input::placeholder { color: var(--text-mute); }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }
  button {
    font: inherit; font-weight: 500;
    color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 11px 16px;
    cursor: pointer;
    transition: all .15s ease;
    display: inline-flex; align-items: center; gap: 6px;
  }
  button:hover { border-color: var(--accent); color: white; }
  button.primary {
    background: linear-gradient(135deg, var(--accent), #7c3aed);
    border-color: transparent;
    color: white;
    box-shadow: 0 2px 8px var(--accent-glow);
  }
  button.primary:hover { transform: translateY(-1px); box-shadow: 0 4px 14px var(--accent-glow); }

  .row { display: flex; gap: 10px; margin-bottom: 16px; align-items: center; }
  .row input { flex: 1; }

  /* ── Results / items ─────────────────────────────────────────────────────── */
  ul.list { list-style: none; padding: 0; margin: 0; }
  ul.list > li {
    padding: 14px 16px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    margin-bottom: 8px;
    transition: border-color .15s ease, background .15s ease, transform .15s ease;
    animation: slideIn .2s ease backwards;
  }
  ul.list > li:hover {
    border-color: var(--border-strong);
    background: var(--bg-elev-2);
  }
  @keyframes slideIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  ul.list > li:nth-child(1) { animation-delay: 0ms; }
  ul.list > li:nth-child(2) { animation-delay: 30ms; }
  ul.list > li:nth-child(3) { animation-delay: 60ms; }
  ul.list > li:nth-child(4) { animation-delay: 90ms; }
  ul.list > li:nth-child(5) { animation-delay: 120ms; }

  .item-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .name {
    font-family: ui-monospace, "SF Mono", SFMono-Regular, monospace;
    color: var(--accent-2);
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    transition: color .15s ease;
  }
  .name:hover { color: white; }
  .score {
    color: var(--text-mute);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    padding: 3px 8px;
    background: rgba(148,163,184,0.08);
    border-radius: 999px;
    flex-shrink: 0;
  }
  .score.green { color: #86efac; background: rgba(34,197,94,0.10); }
  .score.red { color: #fecaca; background: rgba(239,68,68,0.10); }
  .desc { color: var(--text-dim); margin-top: 8px; font-size: 13px; line-height: 1.5; }
  .bar {
    height: 4px;
    background: rgba(148,163,184,0.10);
    border-radius: 2px;
    margin-top: 10px;
    overflow: hidden;
  }
  .bar > div {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    border-radius: 2px;
    transition: width .35s cubic-bezier(.2,.8,.2,1);
  }
  .schema {
    color: var(--text-mute);
    font-size: 11px;
    margin-top: 10px;
    padding: 8px 10px;
    background: rgba(2, 6, 23, 0.4);
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    white-space: pre-wrap;
    line-height: 1.55;
    border: 1px solid var(--border);
  }
  .meta-line {
    display: flex; gap: 12px; align-items: center;
    margin-top: 8px;
    font-size: 12px; color: var(--text-mute);
  }
  .badge {
    display: inline-block;
    font-size: 10px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.05em;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(148,163,184,0.10);
    color: var(--text-dim);
  }
  .badge.discover { background: rgba(99,102,241,0.15); color: #c7d2fe; }
  .badge.execute { background: rgba(34,197,94,0.15); color: #86efac; }
  .badge.batch { background: rgba(234,179,8,0.15); color: #fde68a; }
  .badge.refresh { background: rgba(148,163,184,0.15); color: #cbd5e1; }

  /* ── Empty state ─────────────────────────────────────────────────────────── */
  .empty {
    padding: 48px 24px;
    text-align: center;
    color: var(--text-mute);
    background: var(--bg-elev);
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius);
  }
  .empty .ico { font-size: 28px; opacity: 0.6; margin-bottom: 8px; }
  .empty .title { font-size: 14px; color: var(--text-dim); margin-bottom: 4px; }
  .empty .desc { font-size: 12px; }

  /* ── Toast ───────────────────────────────────────────────────────────────── */
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border-strong);
    padding: 12px 18px;
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg);
    opacity: 0; transform: translateY(8px);
    transition: all .2s ease;
    pointer-events: none;
    font-size: 13px;
    z-index: 100;
  }
  .toast.show { opacity: 1; transform: none; }

  /* ── Misc ────────────────────────────────────────────────────────────────── */
  a { color: var(--accent-2); }
  .latencies {
    display: inline-flex; gap: 12px; align-items: center;
    font-size: 12px; color: var(--text-mute);
  }
  .latencies b { color: var(--text); font-weight: 500; font-variant-numeric: tabular-nums; }
  .latencies .sep { opacity: 0.4; }

  @media (max-width: 640px) {
    .topbar-inner { padding: 12px 16px; }
    .wrap { padding: 20px 16px 64px; }
    .hero h1 { font-size: 22px; }
    .grid { grid-template-columns: repeat(2, 1fr); }
    .row { flex-direction: column; align-items: stretch; }
    .row button { width: 100%; justify-content: center; }
    .tabs { width: 100%; overflow-x: auto; }
  }

  /* ── Filter banner ───────────────────────────────────────────────────────── */
  .filter-banner {
    margin-bottom: 20px;
    padding: 12px 16px;
    background: rgba(234, 179, 8, 0.08);
    border: 1px solid rgba(234, 179, 8, 0.25);
    border-radius: var(--radius);
    font-size: 13px;
    color: #fde68a;
  }
  .filter-banner b { color: #fbbf24; }
  .filter-banner code {
    font-family: ui-monospace, monospace;
    background: rgba(2, 6, 23, 0.5);
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 12px;
  }

  /* ── Stats table ─────────────────────────────────────────────────────────── */
  .sort-controls .sort-btn {
    padding: 6px 12px;
    font-size: 12px;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .sort-controls .sort-btn.active {
    background: var(--bg-elev-2);
    color: var(--text);
    border-color: var(--border-strong);
  }
  .stats-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  .stats-table th, .stats-table td {
    padding: 12px 16px;
    text-align: left;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .stats-table th {
    background: rgba(2, 6, 23, 0.4);
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-mute);
  }
  .stats-table tr:last-child td { border-bottom: none; }
  .stats-table tr:hover td { background: rgba(99, 102, 241, 0.04); }
  .stats-table td.tool { font-family: ui-monospace, monospace; color: var(--accent-2); cursor: pointer; }
  .stats-table td.tool:hover { color: white; }
  .stats-table td.num { font-variant-numeric: tabular-nums; color: var(--text); }
  .stats-table .rate-bar {
    display: inline-block;
    height: 6px; width: 60px;
    background: rgba(148,163,184,0.15);
    border-radius: 3px;
    overflow: hidden;
    vertical-align: middle;
    margin-right: 8px;
  }
  .stats-table .rate-bar > div {
    height: 100%;
    background: var(--green);
    border-radius: 3px;
  }
  .stats-table .rate-bar.warn > div { background: var(--yellow); }
  .stats-table .rate-bar.bad > div { background: var(--red); }
  .stats-table tr.error-row td {
    background: rgba(239, 68, 68, 0.04);
    color: var(--text-mute);
    font-size: 12px;
    padding: 8px 16px 12px;
  }
  .stats-table .latency-chip {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    background: rgba(148,163,184,0.10);
    color: var(--text-dim);
  }
  .stats-table .latency-chip.slow { background: rgba(234,179,8,0.15); color: #fde68a; }
  .stats-table .latency-chip.veryslow { background: rgba(239,68,68,0.15); color: #fecaca; }
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <div class="brand-icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      </div>
      <div>
        MCP Vector Proxy
        <div class="brand-sub" id="brandSub">loading...</div>
      </div>
    </div>
    <div class="topbar-spacer"></div>
    <div class="status-pill warn" id="statusPill">
      <span class="pulse"></span>
      <span id="statusText">Starting...</span>
    </div>
  </div>
</div>

<div class="wrap">

  <div class="hero">
    <h1>Semantic gateway to your MCP tools</h1>
    <div class="sub" id="sub">Loading status...</div>
  </div>

  <div class="grid" id="status"></div>
  <div id="filterBanner" style="display:none"></div>

  <div class="tabs">
    <button class="tab active" data-tab="playground">Playground</button>
    <button class="tab" data-tab="tools">Tools <span class="count" id="tabToolsCount">0</span></button>
    <button class="tab" data-tab="activity">Activity <span class="count" id="tabActivityCount">0</span></button>
    <button class="tab" data-tab="stats">Stats <span class="count" id="tabStatsCount">0</span></button>
  </div>

  <!-- Playground -->
  <div class="panel active" id="panel-playground">
    <div class="section-head">
      <h2>Search</h2>
      <span class="hint">Natural language query - ranking is hybrid (vector + BM25)</span>
    </div>
    <div class="row">
      <div class="input-wrap" style="flex:1">
        <span class="icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input id="q" class="with-icon" placeholder="e.g. create a github issue" autofocus>
      </div>
      <button class="primary" onclick="runSearch()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        Search
      </button>
      <button onclick="refresh()" title="Re-index from MCP Router">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
        Refresh
      </button>
    </div>
    <ul class="list" id="results"></ul>
  </div>

  <!-- Tools -->
  <div class="panel" id="panel-tools">
    <div class="section-head">
      <h2>All tools</h2>
      <span class="hint" id="toolsHint"></span>
    </div>
    <div class="row">
      <div class="input-wrap">
        <span class="icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        </span>
        <input id="filter" class="with-icon" placeholder="filter by name or description...">
      </div>
    </div>
    <ul class="list" id="tools"></ul>
  </div>

  <!-- Activity -->
  <div class="panel" id="panel-activity">
    <div class="section-head">
      <h2>Recent activity</h2>
      <span class="hint">Last 20 calls, in-memory ring buffer (capacity 50)</span>
    </div>
    <div class="row">
      <div class="latencies" id="latencies">No activity yet.</div>
    </div>
    <ul class="list" id="activity"></ul>
  </div>

  <!-- Stats -->
  <div class="panel" id="panel-stats">
    <div class="section-head">
      <h2>Per-tool statistics</h2>
      <span class="hint" id="statsHint">Aggregated since proxy start</span>
    </div>
    <div class="row" style="margin-bottom:16px">
      <div class="sort-controls" style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="sort-btn active" data-sort="calls">Sort: calls</button>
        <button class="sort-btn" data-sort="failures">failures</button>
        <button class="sort-btn" data-sort="latency">latency</button>
        <button class="sort-btn" data-sort="name">name</button>
      </div>
    </div>
    <div id="statsTable"></div>
  </div>

</div>

<div class="toast" id="toast"></div>

<script>
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const fmt = (s) => s ? new Date(s).toLocaleString() : "-";
const fmtTime = (s) => s ? new Date(s).toLocaleTimeString() : "-";

// ── Tabs ──────────────────────────────────────────────────────────────────
$$(".tab").forEach(t => t.addEventListener("click", () => {
  $$(".tab").forEach(x => x.classList.remove("active"));
  $$(".panel").forEach(x => x.classList.remove("active"));
  t.classList.add("active");
  $("#panel-" + t.dataset.tab).classList.add("active");
}));

// ── Status pill ───────────────────────────────────────────────────────────
function setStatus(kind, text) {
  const pill = $("#statusPill");
  pill.className = "status-pill " + kind;
  $("#statusText").textContent = text;
}

// ── Load status ───────────────────────────────────────────────────────────
let currentSort = "calls";
async function loadStatus() {
  try {
    const [h, t, a, s, f] = await Promise.all([
      fetch("/health").then(r => r.json()),
      fetch("/tools").then(r => r.json()),
      fetch("/api/recent").then(r => r.json()),
      fetch("/api/stats?sort=" + currentSort).then(r => r.json()),
      fetch("/api/filter").then(r => r.json()),
    ]);

    // Filter banner
    if (f.active) {
      const parts = [];
      if (f.allowed.length) parts.push('<b>ALLOW:</b> ' + f.allowed.map(p => '<code>' + escapeHtml(p) + '</code>').join(" "));
      if (f.denied.length) parts.push('<b>DENY:</b> ' + f.denied.map(p => '<code>' + escapeHtml(p) + '</code>').join(" "));
      $("#filterBanner").className = "filter-banner";
      $("#filterBanner").style.display = "block";
      $("#filterBanner").innerHTML = '⚠ Tool filter active — only matching tools are indexed and callable. ' + parts.join(" &nbsp; ");
    } else {
      $("#filterBanner").style.display = "none";
    }

    if (h.status === "ok") {
      setStatus("ok", "Connected - " + h.tools + " tools");
      $("#sub").textContent = "Serving live traffic";
      $("#brandSub").textContent = h.tools + " tools indexed";
    } else if (h.tools > 0) {
      setStatus("warn", "Router down - serving cache");
      $("#sub").textContent = "discover_tools works from cache; execute_tool will fail until reconnect";
      $("#brandSub").textContent = h.tools + " tools cached";
    } else {
      setStatus("warn", "Starting up...");
      $("#sub").textContent = "Indexing tools for the first time";
      $("#brandSub").textContent = "starting...";
    }

    $("#status").innerHTML = [
      ["Tools", h.tools],
      ["Indexed", '<span class="v small">' + fmt(h.indexedAt) + '</span>'],
      ["Sessions", (h.sessions?.streamable ?? 0)],
      ["Last error", h.lastError
        ? '<span class="v small red">' + escapeHtml(h.lastError) + '</span>'
        : '<span class="v small green">none</span>'],
    ].map(([k, v]) => '<div class="card"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>').join("");

    renderTools(t.tools || []);
    renderActivity(a.entries || []);
    renderStats(s);

    const lat = (a.entries || []).filter(e => e.type !== "refresh").map(e => e.latencyMs).sort((x, y) => x - y);
    if (lat.length) {
      const p50 = lat[Math.floor(lat.length / 2)];
      const p99 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.99))];
      const avg = Math.round(lat.reduce((s, x) => s + x, 0) / lat.length);
      $("#latencies").innerHTML =
        'p50 <b>' + p50 + 'ms</b> <span class="sep">/</span> ' +
        'p99 <b>' + p99 + 'ms</b> <span class="sep">/</span> ' +
        'avg <b>' + avg + 'ms</b> <span class="sep">/</span> ' +
        'n=' + lat.length;
    } else {
      $("#latencies").textContent = "No activity yet.";
    }
  } catch (e) {
    setStatus("err", "Proxy unreachable");
    $("#sub").textContent = "Failed to load status: " + e;
    $("#brandSub").textContent = "offline";
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────
function latencyClass(ms) {
  if (ms === null) return "";
  if (ms >= 2000) return "veryslow";
  if (ms >= 500) return "slow";
  return "";
}

function renderStats(data) {
  const tools = data.tools || [];
  $("#tabStatsCount").textContent = data.totalCalls || 0;
  $("#statsHint").textContent = data.totalCalls + " total calls across " + tools.length + " tools";

  if (tools.length === 0) {
    $("#statsTable").innerHTML = '<div class="empty"><div class="ico">📊</div><div class="title">No tool calls yet</div><div class="desc">Per-tool statistics appear once tools are executed via execute_tool or batch_execute</div></div>';
    return;
  }

  const rows = tools.map(t => {
    const rate = Math.round(t.successRate * 100);
    const rateClass = rate >= 95 ? "" : rate >= 80 ? "warn" : "bad";
    const p50 = t.p50 !== null ? t.p50 + 'ms' : '-';
    const p99 = t.p99 !== null ? t.p99 + 'ms' : '-';
    const avg = t.avg !== null ? t.avg + 'ms' : '-';
    const lastErr = t.lastError
      ? '<tr class="error-row"><td colspan="6"><b>Last error:</b> ' + escapeHtml(t.lastError) +
        (t.lastErrorAt ? ' <span style="opacity:.6">· ' + fmtTime(t.lastErrorAt) + '</span>' : '') + '</td></tr>'
      : '';
    return '<tr>' +
        '<td class="tool" onclick="copyName(\\'' + t.name.replace(/'/g, "\\\\'") + '\\')">' + escapeHtml(t.name) + '</td>' +
        '<td class="num">' + t.callCount + '</td>' +
        '<td class="num"><span class="rate-bar ' + rateClass + '"><div style="width:' + rate + '%"></div></span>' + rate + '%</td>' +
        '<td class="num"><span class="latency-chip">' + p50 + '</span></td>' +
        '<td class="num"><span class="latency-chip ' + latencyClass(t.p99) + '">' + p99 + '</span></td>' +
        '<td class="num" style="color:var(--text-mute);font-size:11px">' + fmtTime(t.lastCalledAt) + '</td>' +
      '</tr>' + lastErr;
  }).join("");

  $("#statsTable").innerHTML =
    '<table class="stats-table">' +
      '<thead><tr>' +
        '<th>Tool</th><th>Calls</th><th>Success</th><th>p50</th><th>p99</th><th>Last</th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
}

// Sort button clicks
$$(".sort-btn").forEach(b => b.addEventListener("click", () => {
  $$(".sort-btn").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  currentSort = b.dataset.sort;
  loadStatus();
}));

// ── Tools ─────────────────────────────────────────────────────────────────
let allTools = [];
function renderTools(tools) {
  allTools = tools;
  $("#tabToolsCount").textContent = tools.length;
  $("#toolsHint").textContent = tools.length + " indexed - click any name to copy";
  applyFilter();
}
function applyFilter() {
  const f = $("#filter").value.toLowerCase().trim();
  const list = (f
    ? allTools.filter(t => t.name.toLowerCase().includes(f) || (t.description || "").toLowerCase().includes(f))
    : allTools
  ).slice(0, 200);
  if (list.length === 0) {
    $("#tools").innerHTML = '<div class="empty"><div class="ico">∅</div><div class="title">No tools match</div><div class="desc">Try a different filter</div></div>';
    return;
  }
  $("#tools").innerHTML = list.map(t =>
    '<li onclick="copyName(\\'' + t.name.replace(/'/g, "\\\\'") + '\\')">' +
      '<div class="item-head">' +
        '<div class="name">' + escapeHtml(t.name) + '</div>' +
      '</div>' +
      '<div class="desc">' + escapeHtml(t.description || "(no description)") + '</div>' +
    '</li>'
  ).join("");
}
$("#filter").addEventListener("input", applyFilter);

// ── Search ────────────────────────────────────────────────────────────────
async function runSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  $("#results").innerHTML = '<li style="color:var(--text-mute);text-align:center;padding:32px">Searching...</li>';
  try {
    const r = await fetch("/discover?q=" + encodeURIComponent(q));
    const data = await r.json();
    if (!data.results || data.results.length === 0) {
      $("#results").innerHTML = '<div class="empty"><div class="ico">∅</div><div class="title">No matches</div><div class="desc">Try a more specific or different query</div></div>';
      return;
    }
    $("#results").innerHTML = data.results.map(x => {
      const pct = Math.max(0, Math.min(100, (x.relevance || 0) * 100));
      const schema = x.inputSchema ? formatSchema(x.inputSchema) : "";
      return '<li>' +
        '<div class="item-head">' +
          '<div class="name" onclick="copyName(\\'' + x.name.replace(/'/g, "\\\\'") + '\\')">' + escapeHtml(x.name) + '</div>' +
          '<span class="score">' + (x.relevance || 0).toFixed(4) + '</span>' +
        '</div>' +
        '<div class="desc">' + escapeHtml(x.description || "(no description)") + '</div>' +
        '<div class="bar"><div style="width:' + pct + '%"></div></div>' +
        (schema ? '<div class="schema">' + schema + '</div>' : '') +
      '</li>';
    }).join("");
  } catch (e) {
    $("#results").innerHTML = '<li style="color:#fecaca">Error: ' + escapeHtml(String(e)) + '</li>';
  }
}
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

function formatSchema(s) {
  if (!s || typeof s !== "object") return "";
  const req = s.required || [];
  const props = Object.entries(s.properties || {}).map(([k, v]) => {
    const r = req.includes(k) ? " (required)" : "";
    return "  " + k + ": " + (v.type || "any") + r;
  });
  return props.join("\\n");
}

// ── Activity ──────────────────────────────────────────────────────────────
function renderActivity(entries) {
  $("#tabActivityCount").textContent = entries.length;
  if (!entries.length) {
    $("#activity").innerHTML = '<div class="empty"><div class="ico">⌛</div><div class="title">No activity yet</div><div class="desc">Run a search or call an MCP tool to see it here</div></div>';
    return;
  }
  $("#activity").innerHTML = entries.slice(0, 20).map(e => {
    const cls = e.success ? "green" : "red";
    return '<li>' +
      '<div class="item-head">' +
        '<div style="display:flex;align-items:center;gap:10px">' +
          '<span class="badge ' + e.type + '">' + e.type + '</span>' +
          '<span class="name" style="cursor:default">' + escapeHtml(e.detail) + '</span>' +
        '</div>' +
        '<span class="score ' + cls + '">' + e.latencyMs + 'ms</span>' +
      '</div>' +
      '<div class="meta-line">' +
        '<span>' + fmtTime(e.ts) + '</span>' +
        (e.error ? '<span style="color:#fecaca">' + escapeHtml(e.error) + '</span>' : '') +
      '</div>' +
    '</li>';
  }).join("");
}

// ── Refresh ───────────────────────────────────────────────────────────────
async function refresh() {
  toast("Re-indexing...");
  try {
    const r = await fetch("/refresh", { method: "POST" });
    const data = await r.json();
    if (data.ok) {
      toast("Indexed " + data.total + " tools (+" + data.added + " new)");
      loadStatus();
    } else {
      toast(data.error || "Refresh failed");
    }
  } catch (e) { toast("Error: " + e); }
}

// ── Helpers ───────────────────────────────────────────────────────────────
function copyName(name) {
  navigator.clipboard.writeText(name).then(() => toast("Copied: " + name));
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

// ── Init ──────────────────────────────────────────────────────────────────
loadStatus();
setInterval(loadStatus, 5000);
</script>
</body>
</html>`;

