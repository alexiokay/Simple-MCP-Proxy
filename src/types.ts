/**
 * Shared type definitions for the MCP Vector Proxy.
 */

/**
 * A tool with its metadata. The `vector` field is kept for type compatibility
 * but is unused in the SQLite-backed VectorIndex (vectors live in vec0).
 * Kept here so the in-memory metadata list has a stable shape.
 */
export interface ToolEntry {
    name: string;
    description: string;
    inputSchema: unknown;
    /** Unused in SQLite backend — vectors are stored in vec0 and fetched on search. */
    vector: number[];
}

/** Result summary from a buildIndex operation. */
export interface IndexResult {
    added: number;
    removed: number;
    unchanged: number;
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
