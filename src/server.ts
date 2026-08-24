/**
 * MCP Server factory.
 * Creates an MCP Server instance with discover/execute/batch/refresh tool handlers.
 * All state is injected via VectorIndex and RouterConnection — no globals.
 */
import { Server } from "@modelcontextprotocol/server";

import { DISCOVER_LIMIT } from "./config.js";
import type { VectorIndex } from "./vector-index.js";
import type { RouterConnection } from "./router-connection.js";
import type { ActivityLog } from "./activity.js";
import type { ToolStats } from "./stats.js";
import { isToolAllowed } from "./filter.js";

/** Create a new MCP Server wired to the given index, router, and activity log. */
export function createMCPServer(
    vectorIndex: VectorIndex,
    router: RouterConnection,
    activity: ActivityLog,
    stats: ToolStats,
): Server {
    const server = new Server(
        { name: "mcp-vector-proxy", version: "1.0.0" },
        { capabilities: { tools: {} } },
    );

    // ─── Tool definitions ───────────────────────────────────────────────────

    server.setRequestHandler("tools/list", async () => ({
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
                    type: "object" as const,
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
                    type: "object" as const,
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
                    type: "object" as const,
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
                inputSchema: { type: "object" as const, properties: {} },
            },
        ] as any,
    }));

    // ─── Tool handlers ──────────────────────────────────────────────────────

    server.setRequestHandler("tools/call", async (request) => {
        const { name, arguments: args } = request.params;

        switch (name) {

            case "discover_tools": {
                const t0 = Date.now();
                const query = args?.query;
                if (typeof query !== "string" || !query.trim()) {
                    return { content: [{ type: "text", text: "query is required and must be a non-empty string." }], isError: true };
                }
                if (vectorIndex.toolCount === 0) {
                    activity.record({ ts: new Date().toISOString(), type: "discover", detail: query, latencyMs: Date.now() - t0, success: false, error: "no tools indexed" });
                    return {
                        content: [{ type: "text", text: "No tools indexed yet. MCP Router may still be connecting — try again in a few seconds." }],
                        isError: true,
                    };
                }
                try {
                    const limit = (args?.limit as number) ?? DISCOVER_LIMIT;
                    const results = await vectorIndex.search(query, limit);
                    // Serve from cache even when router is down — discover is read-only.
                    // Flag staleness so the caller knows execute may fail until reconnection.
                    const warning = router.isConnected
                        ? null
                        : `NOTE: MCP Router is currently disconnected. Results come from the cache (indexed ${vectorIndex.indexedAt || "unknown"}). execute_tool will fail until the router reconnects.`;
                    const payload = warning ? { warning, results } : results;
                    activity.record({ ts: new Date().toISOString(), type: "discover", detail: query, latencyMs: Date.now() - t0, success: true });
                    return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
                } catch (e) {
                    activity.record({ ts: new Date().toISOString(), type: "discover", detail: query, latencyMs: Date.now() - t0, success: false, error: String(e) });
                    throw e;
                }
            }

            case "execute_tool": {
                const t0 = Date.now();
                const client = router.activeClient;
                const toolName = args?.tool_name;
                if (typeof toolName !== "string" || !toolName.trim()) {
                    return { content: [{ type: "text", text: "tool_name is required and must be a non-empty string." }], isError: true };
                }
                // Security boundary: refuse tools removed by the allow/deny filter,
                // even if the agent somehow learned the name out-of-band.
                if (!isToolAllowed(toolName)) {
                    activity.record({ ts: new Date().toISOString(), type: "execute", detail: toolName, latencyMs: Date.now() - t0, success: false, error: "blocked by filter" });
                    stats.recordExecute(toolName, Date.now() - t0, false, "blocked by allow/deny filter");
                    return {
                        content: [{ type: "text", text: `Tool "${toolName}" is blocked by the proxy's allow/deny filter. Choose a different tool or ask the proxy operator to adjust ALLOW_TOOLS / DENY_TOOLS.` }],
                        isError: true,
                    };
                }
                if (!client || !router.isConnected) {
                    const lat = Date.now() - t0;
                    activity.record({ ts: new Date().toISOString(), type: "execute", detail: toolName, latencyMs: lat, success: false, error: "router not connected" });
                    stats.recordExecute(toolName, lat, false, "router not connected");
                    return { content: [{ type: "text", text: "MCP Router is not connected. Please wait for reconnection." }], isError: true };
                }
                try {
                    const r = await client.callTool({ name: toolName, arguments: (args?.arguments ?? {}) as Record<string, unknown> });
                    const lat = Date.now() - t0;
                    const ok = !r.isError;
                    activity.record({ ts: new Date().toISOString(), type: "execute", detail: toolName, latencyMs: lat, success: ok });
                    stats.recordExecute(toolName, lat, ok, ok ? undefined : "tool returned isError");
                    return r;
                } catch (e) {
                    const lat = Date.now() - t0;
                    const msg = String(e);
                    activity.record({ ts: new Date().toISOString(), type: "execute", detail: toolName, latencyMs: lat, success: false, error: msg });
                    stats.recordExecute(toolName, lat, false, msg);
                    throw e;
                }
            }

            case "batch_execute": {
                const t0 = Date.now();
                const client = router.activeClient;
                const calls = args?.calls as Array<{ tool_name?: unknown; arguments?: unknown }> | undefined;
                if (!Array.isArray(calls) || calls.length === 0) {
                    return { content: [{ type: "text", text: "calls must be a non-empty array of {tool_name, arguments} objects." }], isError: true };
                }
                for (const call of calls) {
                    if (typeof call.tool_name !== "string" || !call.tool_name.trim()) {
                        return { content: [{ type: "text", text: "Each call must have a non-empty tool_name string." }], isError: true };
                    }
                    if (!isToolAllowed(call.tool_name)) {
                        return {
                            content: [{ type: "text", text: `Tool "${call.tool_name}" is blocked by the proxy's allow/deny filter. Refusing the entire batch. Adjust ALLOW_TOOLS / DENY_TOOLS or remove this call.` }],
                            isError: true,
                        };
                    }
                }
                if (!client || !router.isConnected) {
                    activity.record({ ts: new Date().toISOString(), type: "batch", detail: `${calls.length} tools`, latencyMs: Date.now() - t0, success: false, error: "router not connected" });
                    return { content: [{ type: "text", text: "MCP Router is not connected. Please wait for reconnection." }], isError: true };
                }
                const results = await Promise.all(
                    calls.map(async (call) => {
                        const tn = call.tool_name as string;
                        const t1 = Date.now();
                        try {
                            const result = await client.callTool({
                                name: tn,
                                arguments: (call.arguments ?? {}) as Record<string, unknown>,
                            });
                            const lat = Date.now() - t1;
                            const ok = !result.isError;
                            stats.recordExecute(tn, lat, ok, ok ? undefined : "tool returned isError");
                            return { tool_name: tn, success: ok, result };
                        } catch (e) {
                            const lat = Date.now() - t1;
                            const msg = String(e);
                            stats.recordExecute(tn, lat, false, msg);
                            return { tool_name: tn, success: false, error: msg };
                        }
                    }),
                );
                const allOk = results.every((r) => r.success);
                activity.record({ ts: new Date().toISOString(), type: "batch", detail: `${calls.length} tools`, latencyMs: Date.now() - t0, success: allOk });
                return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
            }

            case "refresh_tools": {
                const t0 = Date.now();
                const client = router.activeClient;
                if (!client || !router.isConnected) {
                    activity.record({ ts: new Date().toISOString(), type: "refresh", detail: "manual", latencyMs: Date.now() - t0, success: false, error: "router not connected" });
                    return { content: [{ type: "text", text: "MCP Router not connected — cannot refresh." }], isError: true };
                }
                try {
                    const result = await vectorIndex.buildIndex(client, "manual");
                    activity.record({ ts: new Date().toISOString(), type: "refresh", detail: `+${result.added} -${result.removed}`, latencyMs: Date.now() - t0, success: true });
                    return {
                        content: [{
                            type: "text",
                            text: `Re-indexed: ${vectorIndex.toolCount} tools (+${result.added} new, -${result.removed} removed). Updated: ${vectorIndex.indexedAt}`,
                        }],
                    };
                } catch (e) {
                    activity.record({ ts: new Date().toISOString(), type: "refresh", detail: "manual", latencyMs: Date.now() - t0, success: false, error: String(e) });
                    throw e;
                }
            }

            default:
                return {
                    content: [{ type: "text", text: `Unknown tool: ${name}. Available tools: discover_tools, execute_tool, batch_execute, refresh_tools.` }],
                    isError: true,
                };
        }
    });

    return server;
}
