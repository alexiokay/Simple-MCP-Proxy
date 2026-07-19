/**
 * Shared type definitions for the MCP Vector Proxy.
 */

/** A tool with its precomputed embedding vector, kept in memory for sub-ms cosine search. */
export interface ToolEntry {
    name: string;
    description: string;
    inputSchema: unknown;
    vector: number[];
}

/** The full in-memory tool index with change-detection fingerprint. */
export interface ToolIndex {
    tools: ToolEntry[];
    indexedAt: string;
    fingerprint: string;
}

/** Result summary from a buildIndex operation. */
export interface IndexResult {
    added: number;
    removed: number;
    unchanged: number;
}

/** A single row stored in the LanceDB "tools" table. */
export interface LanceToolRecord {
    name: string;
    description: string;
    inputSchema: string; // JSON-serialized
    cacheKey: string;
    vector: number[];
}

/** Persisted metadata for fast startup (avoids full re-embed when nothing changed). */
export interface IndexMeta {
    fingerprint: string;
    indexedAt: string;
}

/** A tool as returned by MCP Router's listTools(). */
export interface LiveTool {
    name: string;
    description?: string | null;
    inputSchema?: unknown;
}

/** A discovered tool result returned to the caller. */
export interface DiscoverResult {
    name: string;
    description: string;
    relevance: number;
    inputSchema: unknown;
}
