/**
 * Lightweight stdio ↔ HTTP bridge for Claude Desktop.
 * Claude Desktop spawns this via stdio; it forwards everything to the
 * shared mcp-vector-proxy HTTP server (no model loading, ~30MB RAM).
 *
 * Claude Desktop config:
 *   "command": "node",
 *   "args": ["...dist/stdio-bridge.js"]
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PROXY_URL = process.env.PROXY_URL ?? "http://127.0.0.1:3456/mcp";
const MAX_CONNECT_ATTEMPTS = 20;
const log = (m: string) => process.stderr.write(`[stdio-bridge] ${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── HTTP client with retry ────────────────────────────────────────────────────

let httpClient: Client | null = null;

/**
 * Connect to the proxy with exponential backoff.
 * Handles the race condition where Claude Desktop launches the bridge
 * before the proxy has finished loading the embedding model (~5–30s).
 */
async function connectWithRetry(): Promise<Client> {
  for (let attempt = 0; attempt < MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      const client = new Client(
        { name: "stdio-bridge", version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(PROXY_URL)));
      log("Connected to HTTP proxy.");
      return client;
    } catch (e) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
      log(`Proxy not ready (attempt ${attempt + 1}/${MAX_CONNECT_ATTEMPTS}): ${e}. Retrying in ${delay / 1000}s...`);
      await sleep(delay);
    }
  }
  throw new Error(`Could not connect to proxy at ${PROXY_URL} after ${MAX_CONNECT_ATTEMPTS} attempts`);
}

/** Get the live client, reconnecting if the proxy crashed and restarted. */
async function getClient(): Promise<Client> {
  if (!httpClient) {
    httpClient = await connectWithRetry();
  }
  return httpClient;
}

/**
 * Call fn with the current client. If the call fails (dead connection),
 * clear the client reference and retry once with a fresh connection.
 */
async function callWithReconnect<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(await getClient());
  } catch (e) {
    log(`Request failed, reconnecting: ${e}`);
    httpClient = null;
    return await fn(await getClient());
  }
}

// ── MCP stdio server ──────────────────────────────────────────────────────────

async function main() {
  log(`Connecting to ${PROXY_URL}...`);

  // Eagerly connect so the first tool call isn't delayed
  httpClient = await connectWithRetry();

  const server = new Server(
    { name: "mcp-vector-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // Forward tools/list — reconnects transparently if proxy restarted
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    callWithReconnect((c) => c.listTools())
  );

  // Forward tools/call — reconnects transparently if proxy restarted
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return callWithReconnect((c) => c.callTool({ name, arguments: args ?? {} }));
  });

  await server.connect(new StdioServerTransport());
  log("Stdio bridge ready.");
}

main().catch((e) => {
  process.stderr.write(`[stdio-bridge] Fatal: ${e}\n`);
  process.exit(1);
});
