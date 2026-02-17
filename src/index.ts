import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pipeline, env } from "@xenova/transformers";
import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { randomUUID } from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, "../.tool-index.json");
const MODEL_CACHE = path.join(__dirname, "../.model-cache");

// Load .env file from project root into process.env.
// Values already in process.env take precedence (env vars > .env file).
function loadDotEnv(): void {
  try {
    const lines = readFileSync(path.join(__dirname, "../.env"), "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* no .env file — rely on process.env */ }
}
loadDotEnv();

const MCPR_TOKEN = process.env.MCPR_TOKEN ?? "";
if (!MCPR_TOKEN) {
  process.stderr.write(
    "[mcp-vector-proxy] Fatal: MCPR_TOKEN not set.\n" +
    "  Option 1: set the MCPR_TOKEN environment variable.\n" +
    "  Option 2: add MCPR_TOKEN=your-token to a .env file in the project root.\n"
  );
  process.exit(1);
}

const DISCOVER_LIMIT = parseInt(process.env.DISCOVER_LIMIT ?? "10");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000");
const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT) : null;
const HTTP_HOST = process.env.HTTP_HOST ?? "127.0.0.1";

env.cacheDir = MODEL_CACHE;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  embedding: number[];
}

interface ToolIndex {
  tools: ToolEntry[];
  indexedAt: string;
  fingerprint: string;
}

// ─── Shared state ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any;
let routerClient: Client | null = null;
let routerConnected = false;
let toolIndex: ToolIndex = { tools: [], indexedAt: "", fingerprint: "" };
let reindexing = false;
let reconnecting = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let routerTransport: StdioClientTransport | null = null;

// Graceful shutdown
process.on("SIGTERM", () => { shutdown(); });
process.on("SIGINT",  () => { shutdown(); });

function shutdown() {
  log("Shutting down...");
  if (pollTimer) clearInterval(pollTimer);
  if (routerTransport) {
    try { routerTransport.close(); } catch { /* ignore */ }
  }
  process.exit(0);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg: string) {
  process.stderr.write(`[mcp-vector-proxy] ${msg}\n`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Includes inputSchema so schema changes (new params) trigger re-indexing
function fingerprint(tools: Array<{ name: string; description?: string | null; inputSchema?: unknown }>): string {
  return tools
    .map((t) => `${t.name}|${t.description ?? ""}|${JSON.stringify(t.inputSchema ?? {})}`)
    .sort()
    .join("\n");
}

// Guard against zero-magnitude vectors to prevent NaN in sort
function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function embed(text: string): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (embedder as any)(text, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

// ─── MCP Router connection with auto-reconnect ────────────────────────────────

async function connectToRouterWithRetry(): Promise<void> {
  let attempt = 0;

  while (true) {
    try {
      log(`Connecting to MCP Router${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}...`);

      // Use launch-router.js wrapper so windowsHide:true suppresses the cmd window
      const transport = new StdioClientTransport({
        command: "node",
        args: [path.join(__dirname, "launch-router.js")],
        env: { ...(process.env as Record<string, string>), MCPR_TOKEN },
      });
      routerTransport = transport;

      const client = new Client(
        { name: "mcp-vector-proxy", version: "1.0.0" },
        { capabilities: {} }
      );

      // When connection drops — clear state and reconnect.
      // Guard prevents two simultaneous reconnect loops.
      transport.onclose = () => {
        routerConnected = false;
        routerClient = null;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        if (reconnecting) return;
        reconnecting = true;
        log("MCP Router disconnected — reconnecting in 5s...");
        sleep(5000).then(() =>
          connectToRouterWithRetry().finally(() => { reconnecting = false; })
        );
      };

      transport.onerror = (e) => log(`Transport error: ${e}`);

      await client.connect(transport);
      routerClient = client;
      routerConnected = true;
      attempt = 0;
      log("MCP Router connected.");

      // Real-time tool change notifications
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log("Notification: tools changed — re-indexing...");
        await buildIndex("notification");
      });

      await buildIndex("startup");
      startPolling();
      return; // success

    } catch (e) {
      attempt++;
      // Exponential backoff: 2s, 4s, 8s … capped at 30s
      const delay = Math.min(2000 * Math.pow(2, attempt - 1), 30000);
      log(`MCP Router unavailable: ${e}. Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
}

// ─── Vector index ─────────────────────────────────────────────────────────────

async function buildIndex(reason = "startup"): Promise<{ added: number; removed: number; unchanged: number }> {
  if (!routerClient || !routerConnected) {
    log("Skipping index build — MCP Router not connected.");
    return { added: 0, removed: 0, unchanged: 0 };
  }
  if (reindexing) {
    log("Re-index already in progress, skipping.");
    return { added: 0, removed: 0, unchanged: 0 };
  }
  reindexing = true;
  try {
    const { tools: liveTools } = await routerClient.listTools();
    const newFingerprint = fingerprint(liveTools);

    if (newFingerprint === toolIndex.fingerprint && toolIndex.tools.length > 0) {
      log(`No changes detected (${liveTools.length} tools).`);
      return { added: 0, removed: 0, unchanged: liveTools.length };
    }

    const embeddingCache: Record<string, number[]> = {};
    for (const t of toolIndex.tools) {
      embeddingCache[`${t.name}|||${t.description}`] = t.embedding;
    }
    if (existsSync(CACHE_FILE) && toolIndex.tools.length === 0) {
      try {
        const cached = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as ToolIndex;
        for (const t of cached.tools) {
          embeddingCache[`${t.name}|||${t.description}`] = t.embedding;
        }
      } catch { /* ignore */ }
    }

    const liveNames = new Set(liveTools.map((t) => t.name));
    const removed = toolIndex.tools.map((t) => t.name).filter((n) => !liveNames.has(n));

    let added = 0;
    const entries: ToolEntry[] = [];
    for (const tool of liveTools) {
      const desc = tool.description ?? "";
      const key = `${tool.name}|||${desc}`;
      let embedding = embeddingCache[key];
      if (!embedding) {
        embedding = await embed(`${tool.name}: ${desc}`);
        added++;
      }
      entries.push({ name: tool.name, description: desc, inputSchema: tool.inputSchema, embedding });
    }

    const unchanged = entries.length - added;
    toolIndex = { tools: entries, indexedAt: new Date().toISOString(), fingerprint: newFingerprint };

    // Atomic write: write to .tmp then rename — prevents partial-write corruption
    const tmp = CACHE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(toolIndex));
    renameSync(tmp, CACHE_FILE);

    log(`[${reason}] +${added} new, -${removed.length} removed, ${unchanged} unchanged. Total: ${entries.length}.`);
    return { added, removed: removed.length, unchanged };
  } finally {
    reindexing = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!routerClient || !routerConnected) return;
    try {
      const { tools: liveTools } = await routerClient.listTools();
      if (fingerprint(liveTools) !== toolIndex.fingerprint) {
        log("Poll: changes detected — re-indexing...");
        await buildIndex("poll");
      }
    } catch (e) {
      log(`Poll error: ${e}`);
    }
  }, POLL_INTERVAL_MS);
  log(`Polling every ${POLL_INTERVAL_MS / 1000}s.`);
}

// ─── MCP Server factory ───────────────────────────────────────────────────────

function createMCPServer(): Server {
  const server = new Server(
    { name: "mcp-vector-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "discover_tools",
        description:
          "Semantic search over all available MCP tools. Returns tools ranked by relevance, each with its exact name, " +
          "description, relevance score (0–1), and inputSchema showing the required arguments. " +
          "ALWAYS call this before execute_tool or batch_execute — it gives you the exact tool name and the argument " +
          "schema you need to call it correctly. " +
          "Tips: (1) use specific queries ('create a GitHub issue', 'list files in directory') not broad ones " +
          "('do something with GitHub'); (2) call multiple times with different queries if your task spans multiple " +
          "domains; (3) relevance above 0.7 is a strong match — below 0.5 the tool is likely unrelated.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Specific natural language description of the operation you want to perform" },
            limit: { type: "number", description: `Max results to return (default: ${DISCOVER_LIMIT}). Increase if results seem incomplete.` },
          },
          required: ["query"],
        },
      },
      {
        name: "execute_tool",
        description:
          "Execute a single MCP tool by its exact name with arguments matching its inputSchema. " +
          "Always discover the tool first with discover_tools to get the exact name and required arguments. " +
          "For multiple independent operations, call this tool in parallel rather than sequentially. " +
          "For compound tasks that need several tools, prefer batch_execute to run them all in one call.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string", description: "Exact tool name as returned by discover_tools" },
            arguments: { type: "object", description: "Arguments matching the tool's inputSchema (from discover_tools results)" },
          },
          required: ["tool_name", "arguments"],
        },
      },
      {
        name: "batch_execute",
        description:
          "Execute multiple MCP tools in parallel in a single call. " +
          "Each entry needs a tool_name (exact, from discover_tools) and its arguments. " +
          "Results are returned in the same order as the calls array, each with success status. " +
          "Use this for compound tasks where several tools can run independently " +
          "(e.g. create a GitHub issue + add a label + post a Slack notification). " +
          "Much faster than sequential execute_tool calls.",
        inputSchema: {
          type: "object",
          properties: {
            calls: {
              type: "array",
              description: "Tools to execute in parallel",
              items: {
                type: "object",
                properties: {
                  tool_name: { type: "string", description: "Exact tool name from discover_tools" },
                  arguments: { type: "object", description: "Arguments matching the tool's inputSchema" },
                },
                required: ["tool_name"],
              },
            },
          },
          required: ["calls"],
        },
      },
      {
        name: "refresh_tools",
        description:
          "Force an immediate re-index of all tools from MCP Router. " +
          "Use this if discover_tools is not returning tools you know should be available, " +
          "or after adding a new MCP server to your router.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "discover_tools") {
      if (!routerConnected || toolIndex.tools.length === 0) {
        return {
          content: [{ type: "text", text: "MCP Router is not connected yet. Tools will be available shortly — try again in a few seconds." }],
          isError: true,
        };
      }
      const query = args?.query;
      if (typeof query !== "string" || !query.trim()) {
        return { content: [{ type: "text", text: "query is required and must be a non-empty string." }], isError: true };
      }
      const limit = (args?.limit as number) ?? DISCOVER_LIMIT;
      const queryEmbedding = await embed(query);
      const results = toolIndex.tools
        .map((t) => ({ tool: t, score: cosine(queryEmbedding, t.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            results.map((r) => ({
              name: r.tool.name,
              description: r.tool.description,
              relevance: parseFloat(r.score.toFixed(4)),
              inputSchema: r.tool.inputSchema,
            })),
            null, 2
          ),
        }],
      };
    }

    if (name === "execute_tool") {
      if (!routerClient || !routerConnected) {
        return {
          content: [{ type: "text", text: "MCP Router is not connected. Please wait for reconnection." }],
          isError: true,
        };
      }
      const toolName = args?.tool_name;
      if (typeof toolName !== "string" || !toolName.trim()) {
        return { content: [{ type: "text", text: "tool_name is required and must be a non-empty string." }], isError: true };
      }
      const toolArgs = (args?.arguments ?? {}) as Record<string, unknown>;
      return await routerClient.callTool({ name: toolName, arguments: toolArgs });
    }

    if (name === "batch_execute") {
      if (!routerClient || !routerConnected) {
        return {
          content: [{ type: "text", text: "MCP Router is not connected. Please wait for reconnection." }],
          isError: true,
        };
      }
      const calls = args?.calls as Array<{ tool_name?: unknown; arguments?: unknown }> | undefined;
      if (!Array.isArray(calls) || calls.length === 0) {
        return { content: [{ type: "text", text: "calls must be a non-empty array of {tool_name, arguments} objects." }], isError: true };
      }
      for (const call of calls) {
        if (typeof call.tool_name !== "string" || !call.tool_name.trim()) {
          return { content: [{ type: "text", text: "Each call must have a non-empty tool_name string." }], isError: true };
        }
      }
      // Run all tools in parallel
      const results = await Promise.all(
        calls.map(async (call) => {
          const toolName = call.tool_name as string;
          const toolArgs = (call.arguments ?? {}) as Record<string, unknown>;
          try {
            const result = await routerClient!.callTool({ name: toolName, arguments: toolArgs });
            return { tool_name: toolName, success: true, result };
          } catch (e) {
            return { tool_name: toolName, success: false, error: String(e) };
          }
        })
      );
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }

    if (name === "refresh_tools") {
      const result = await buildIndex("manual");
      return {
        content: [{
          type: "text",
          text: routerConnected
            ? `Re-indexed: ${toolIndex.tools.length} tools (+${result.added} new, -${result.removed} removed). Updated: ${toolIndex.indexedAt}`
            : "MCP Router not connected — cannot refresh.",
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}

// ─── HTTP mode ────────────────────────────────────────────────────────────────

async function runHttp(port: number, host: string) {
  const app = createMcpExpressApp({ host });
  app.use(express.json());

  const streamableSessions = new Map<string, StreamableHTTPServerTransport>();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId) {
      const transport = streamableSessions.get(sessionId);
      if (!transport) { res.status(404).json({ error: "Session not found." }); return; }
      await transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== "POST") { res.status(400).json({ error: "POST to /mcp to start a session." }); return; }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { streamableSessions.set(sid, transport); log(`Session: ${sid}`); },
      onsessionclosed: (sid) => { streamableSessions.delete(sid); },
    });
    const server = createMCPServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const sseSessions = new Map<string, SSEServerTransport>();

  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const server = createMCPServer();
    await server.connect(transport);
    sseSessions.set(transport.sessionId, transport);
    transport.onclose = () => sseSessions.delete(transport.sessionId);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query["sessionId"] as string;
    const transport = sseSessions.get(sessionId);
    if (!transport) { res.status(404).json({ error: "Session not found." }); return; }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: routerConnected ? "ok" : "disconnected",
      routerConnected,
      tools: toolIndex.tools.length,
      indexedAt: toolIndex.indexedAt || null,
      sessions: { streamable: streamableSessions.size, sse: sseSessions.size },
    });
  });

  app.listen(port, host, () => {
    log(`HTTP on http://${host}:${port}`);
    log(`  Streamable HTTP : POST/GET/DELETE /mcp`);
    log(`  SSE (legacy)    : GET /sse`);
    log(`  Health          : GET /health`);
  });
}

// ─── Stdio mode ───────────────────────────────────────────────────────────────

async function runStdio() {
  const server = createMCPServer();
  await server.connect(new StdioServerTransport());
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  log("Loading embedding model (downloads ~25MB on first run)...");
  embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  log("Model ready.");

  // Start serving immediately — MCP Router connects in background
  if (HTTP_PORT) {
    await runHttp(HTTP_PORT, HTTP_HOST);
  } else {
    await runStdio();
  }

  // Connect to MCP Router with auto-reconnect (non-blocking for HTTP mode)
  connectToRouterWithRetry().catch((e) => log(`Router connect error: ${e}`));
}

main().catch((e) => {
  process.stderr.write(`[mcp-vector-proxy] Fatal: ${e}\n`);
  process.exit(1);
});
