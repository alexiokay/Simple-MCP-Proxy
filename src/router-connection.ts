/**
 * RouterConnection — manages the MCP Router child process lifecycle.
 * Handles connection, reconnection with backoff, polling, and clean shutdown.
 *
 * Key fix: closes the previous StdioClientTransport before spawning a new one,
 * preventing orphan node processes from accumulating on each reconnect.
 */
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "path";

import { MCPR_TOKEN, POLL_INTERVAL_MS, DIST_DIR, log, sleep } from "./config.js";
import type { VectorIndex } from "./vector-index.js";
import type { LiveTool } from "./types.js";

const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Minimal env passed to the router-cli child. Whitelisting avoids leaking
 * unrelated secrets (cloud tokens, API keys, etc.) that may live in process.env.
 */
const ROUTER_CHILD_ENV: Record<string, string> = {
    MCPR_TOKEN,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    USERPROFILE: process.env.USERPROFILE ?? "",
    APPDATA: process.env.APPDATA ?? "",
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
    SystemRoot: process.env.SystemRoot ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    ...(process.env.HOMEDRIVE ? { HOMEDRIVE: process.env.HOMEDRIVE, HOMEPATH: process.env.HOMEPATH } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
};

export class RouterConnection {
    private client: Client | null = null;
    private transport: StdioClientTransport | null = null;
    private connected = false;
    private reconnecting = false;
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private shuttingDown = false;
    private lastErr: string | null = null;
    private lastErrAt: string | null = null;

    constructor(private readonly vectorIndex: VectorIndex) { }

    /** Whether the router is connected and ready for tool calls. */
    get isConnected(): boolean { return this.connected; }

    /** The active MCP Router client, or null if disconnected. */
    get activeClient(): Client | null { return this.client; }

    /** Last error message (or null if none). Used by tray tooltip + /health. */
    get lastError(): string | null { return this.lastErr; }

    /** ISO timestamp of the last error, or null. */
    get lastErrorAt(): string | null { return this.lastErrAt; }

    // ─── Connection lifecycle ─────────────────────────────────────────────────

    /**
     * Connect to the MCP Router with exponential backoff.
     * Automatically reconnects on disconnection.
     */
    async connect(): Promise<void> {
        let attempt = 0;

        while (!this.shuttingDown) {
            // Clean up any previous transport to prevent orphan processes
            this.closeTransport();

            try {
                log(`Connecting to MCP Router${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}...`);

                const transport = new StdioClientTransport({
                    command: "node",
                    args: [path.join(DIST_DIR, "launch-router.js")],
                    env: ROUTER_CHILD_ENV,
                    stderr: "pipe",  // capture stderr for diagnostics
                });
                this.transport = transport;

                // Log stderr from the child process for diagnostics
                transport.stderr?.on("data", (chunk: Buffer) => {
                    const msg = chunk.toString().trim();
                    if (msg) log(`[router-cli] ${msg}`);
                });

                const client = new Client(
                    { name: "mcp-vector-proxy", version: "1.0.0" },
                    { capabilities: {}, versionNegotiation: { mode: "auto" } },
                );

                // Only trigger reconnect if we were fully connected
                // (avoids duplicate reconnects when buildIndex fails during setup)
                transport.onclose = () => {
                    if (this.connected) {
                        this.handleDisconnect();
                    }
                };
                transport.onerror = (e) => {
                    const msg = String(e);
                    this.lastErr = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
                    this.lastErrAt = new Date().toISOString();
                    log(`Transport error: ${e}`);
                };

                await client.connect(transport);

                this.client = client;
                this.connected = true;
                attempt = 0;
                this.lastErr = null;
                this.lastErrAt = null;
                log("MCP Router connected.");

                // Listen for tool list changes from the router
                client.setNotificationHandler("notifications/tools/list_changed", async () => {
                    log("Notification: tools changed — re-indexing...");
                    await this.vectorIndex.buildIndex(client, "notification");
                });

                // Initial index build — if it fails, keep the connection alive
                try {
                    await this.vectorIndex.buildIndex(client, "startup");
                } catch (indexErr) {
                    log(`Initial index build failed (will retry via polling): ${indexErr}`);
                }
                this.startPolling();
                return;

            } catch (e) {
                attempt++;
                const delay = Math.min(2000 * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY_MS);
                const msg = String(e);
                this.lastErr = msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
                this.lastErrAt = new Date().toISOString();
                log(`MCP Router unavailable: ${e}. Retrying in ${delay / 1000}s...`);
                await sleep(delay);
            }
        }
    }

    /** Graceful shutdown — stops polling and kills the child process. */
    disconnect(): void {
        this.shuttingDown = true;
        this.stopPolling();
        this.closeTransport();
        this.client = null;
        this.connected = false;
    }

    // ─── Private ──────────────────────────────────────────────────────────────

    private handleDisconnect(): void {
        const wasConnected = this.connected;
        this.connected = false;
        this.client = null;
        this.stopPolling();

        if (wasConnected) {
            this.lastErr = "MCP Router disconnected — reconnecting";
            this.lastErrAt = new Date().toISOString();
        }

        if (this.shuttingDown || this.reconnecting) return;
        if (!wasConnected) return; // never fully established — let connect() retry loop handle it

        this.reconnecting = true;
        log("MCP Router disconnected — reconnecting in 5s...");
        sleep(5000).then(() =>
            this.connect().finally(() => { this.reconnecting = false; }),
        );
    }

    /** Close the current transport, which terminates the child process tree. */
    private closeTransport(): void {
        if (!this.transport) return;
        try { this.transport.close(); } catch { /* already dead */ }
        this.transport = null;
    }

    private startPolling(): void {
        this.stopPolling();

        this.pollTimer = setInterval(async () => {
            if (!this.client || !this.connected) return;
            try {
                const { tools: liveTools } = await this.client.listTools();
                if (this.vectorIndex.hasChanged(liveTools as LiveTool[])) {
                    log("Poll: changes detected — re-indexing...");
                    await this.vectorIndex.buildIndex(this.client, "poll");
                }
            } catch (e) {
                log(`Poll error: ${e}`);
            }
        }, POLL_INTERVAL_MS);

        log(`Polling every ${POLL_INTERVAL_MS / 1000}s.`);
    }

    private stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }
}
