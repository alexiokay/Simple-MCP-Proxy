/**
 * MCP Vector Proxy — entry point.
 *
 * Wires together the VectorIndex, RouterConnection, and MCP Server,
 * then starts in either HTTP or stdio mode based on config.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import express from "express";
import { randomUUID } from "crypto";

import { HTTP_PORT, HTTP_HOST, ALLOW_REMOTE, log } from "./config.js";
import { VectorIndex } from "./vector-index.js";
import { RouterConnection } from "./router-connection.js";
import { ActivityLog } from "./activity.js";
import { ToolStats } from "./stats.js";
import { createMCPServer } from "./server.js";
import { createDashboardRouter } from "./dashboard.js";

// ─── Singleton instances ──────────────────────────────────────────────────────

const vectorIndex = new VectorIndex();
const router = new RouterConnection(vectorIndex);
const activity = new ActivityLog(50);
const stats = new ToolStats();

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  log("Shutting down...");
  router.disconnect();
  // Give the transport a beat to actually close before we exit so we don't
  // orphan the router-cli child on Windows.
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// ─── HTTP mode ────────────────────────────────────────────────────────────────

function runHttp(port: number, host: string): void {
  // Refuse unsafe bind targets. execute_tool has no auth — binding 0.0.0.0
  // would let anyone on the LAN call any MCP tool. Opt in explicitly.
  const unsafe = host === "0.0.0.0" || host === "::";
  if (unsafe && !ALLOW_REMOTE) {
    process.stderr.write(
      `[mcp-vector-proxy] Fatal: HTTP_HOST=${host} would expose the proxy to your network with no auth.\n` +
      `  This is dangerous — execute_tool can call any of your MCP tools.\n` +
      `  If you really want this, set ALLOW_REMOTE=1 AND set an AUTH_TOKEN.\n`
    );
    process.exit(1);
  }
  if (unsafe) {
    log(`WARNING: binding to ${host} with ALLOW_REMOTE=1. Ensure AUTH_TOKEN is set.`);
  }

  const app = createMcpExpressApp({ host });
  app.use(express.json());

  // Dashboard (HTML) + read-only JSON helpers — mounted before session routes.
  app.use(createDashboardRouter(vectorIndex, router, activity, stats));

  // ── Streamable HTTP sessions ────────────────────────────────────────────

  const streamableSessions = new Map<string, NodeStreamableHTTPServerTransport>();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) {
      const transport = streamableSessions.get(sessionId);
      if (!transport) { res.status(404).json({ error: "Session not found." }); return; }
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== "POST") { res.status(400).json({ error: "POST to /mcp to start a session." }); return; }

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { streamableSessions.set(sid, transport); log(`Session: ${sid}`); },
      onsessionclosed: (sid) => { streamableSessions.delete(sid); },
    });
    const server = createMCPServer(vectorIndex, router, activity, stats);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ── Health endpoint ────────────────────────────────────────────────────

  app.get("/health", (_req, res) => {
    res.json({
      status: router.isConnected ? "ok" : "disconnected",
      routerConnected: router.isConnected,
      tools: vectorIndex.toolCount,
      indexedAt: vectorIndex.indexedAt || null,
      lastError: router.lastError || null,
      sessions: { streamable: streamableSessions.size },
    });
  });

  // Bind explicitly to the configured host. Leaving the host unspecified
  // makes Node listen on all interfaces, which would expose the proxy even
  // when HTTP_HOST is left at its local-only default.
  app.listen(port, host, () => {
    log(`HTTP on ${host}:${port}`);
    log(`  Streamable HTTP : POST/GET/DELETE /mcp`);
    log(`  Health          : GET /health`);
    log(`  Dashboard       : GET /`);
  });
}

// ─── Stdio mode ───────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const server = createMCPServer(vectorIndex, router, activity, stats);
  await server.connect(new StdioServerTransport());
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Init LanceDB cache + embedding model
  await vectorIndex.init();

  // Start transport
  if (HTTP_PORT) {
    runHttp(HTTP_PORT, HTTP_HOST);
  } else {
    await runStdio();
  }

  // Connect to MCP Router (runs in background with auto-reconnect)
  router.connect().catch((e) => log(`Router connect error: ${e}`));
}

main().catch((e) => {
  process.stderr.write(`[mcp-vector-proxy] Fatal: ${e}\n`);
  process.exit(1);
});
