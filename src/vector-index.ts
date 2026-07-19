/**
 * VectorIndex — owns the embedding model, LanceDB table, and in-memory tool index.
 * Encapsulates all vector search, caching, and re-indexing logic.
 */
import { pipeline, env as hfEnv } from "@huggingface/transformers";
import * as lancedb from "@lancedb/lancedb";
import { readFileSync, writeFileSync, existsSync } from "fs";

import { LANCE_DIR, META_FILE, MODEL_CACHE, log } from "./config.js";
import { cosine, bm25Score, rrfFuse, fingerprint } from "./search.js";
import { isToolAllowed } from "./filter.js";
import type {
    ToolEntry, ToolIndex, IndexResult, IndexMeta,
    LanceToolRecord, DiscoverResult, LiveTool,
} from "./types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// Point HuggingFace Transformers at our local model cache
hfEnv.cacheDir = MODEL_CACHE;

export class VectorIndex {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- embedder pipeline has no public type
    private embedder: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanceDB connection has no generic
    private db: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private table: any = null;
    private index: ToolIndex = { tools: [], indexedAt: "", fingerprint: "" };
    private reindexing = false;
    // LRU cache for query embeddings. Hot queries (e.g. "send email") hit cache
    // instead of re-running the embedding pipeline (~5-20ms per call).
    private queryCache = new Map<string, number[]>();
    private readonly QUERY_CACHE_SIZE = 100;

    /** Current tool count (for health endpoint). */
    get toolCount(): number { return this.index.tools.length; }

    /** Read-only snapshot of indexed tools (for dashboard). */
    get indexTools(): ReadonlyArray<{ name: string; description: string; inputSchema: unknown }> {
        return this.index.tools.filter((t) => isToolAllowed(t.name));
    }

    /** ISO timestamp of last successful index build. */
    get indexedAt(): string { return this.index.indexedAt; }

    /** Current fingerprint for change detection. */
    get currentFingerprint(): string { return this.index.fingerprint; }

    /** True once the embedding model is loaded and ready. */
    get isReady(): boolean { return this.embedder !== null; }

    // ─── Initialization ───────────────────────────────────────────────────────

    /** Load LanceDB cache (instant) + embedding model (~5-30s first time). */
    async init(): Promise<void> {
        await this.loadCache();

        log("Loading embedding model (mxbai-embed-xsmall-v1, ~23MB)...");
        this.embedder = await pipeline(
            "feature-extraction",
            "mixedbread-ai/mxbai-embed-xsmall-v1",
            { dtype: "q8", device: "cpu" },
        );
        log("Model ready.");
    }

    /** Restore index from LanceDB on disk so proxy can serve immediately. */
    private async loadCache(): Promise<void> {
        this.db = await lancedb.connect(LANCE_DIR);
        try {
            this.table = await this.db.openTable("tools");
            const rows: LanceToolRecord[] = await this.table.toArray();

            let meta: IndexMeta = { fingerprint: "", indexedAt: "" };
            if (existsSync(META_FILE)) {
                try { meta = JSON.parse(readFileSync(META_FILE, "utf-8")); } catch { /* ignore */ }
            }

            this.index = {
                tools: rows.map((r) => ({
                    name: r.name,
                    description: r.description,
                    inputSchema: JSON.parse(r.inputSchema ?? "{}"),
                    vector: Array.from(r.vector),
                })),
                indexedAt: meta.indexedAt,
                fingerprint: meta.fingerprint,
            };
            log(`Loaded ${rows.length} tools from LanceDB cache.`);
        } catch {
            log("No LanceDB cache — will build index on first MCP Router connection.");
        }
    }

    // ─── Index building ───────────────────────────────────────────────────────

    /**
     * Rebuild the index from the live MCP Router tool list.
     * Reuses cached embeddings for unchanged tools to minimize compute.
     */
    async buildIndex(client: Client, reason = "startup"): Promise<IndexResult> {
        if (this.reindexing) {
            log("Re-index already in progress, skipping.");
            return { added: 0, removed: 0, unchanged: 0 };
        }

        this.reindexing = true;
        try {
            const { tools: allLiveTools } = await client.listTools();
            // Apply allow/deny filter before fingerprinting so changes to filtered-out
            // tools don't trigger re-index churn.
            const liveTools = (allLiveTools as LiveTool[]).filter((t) => isToolAllowed(t.name));
            const filteredOut = allLiveTools.length - liveTools.length;
            if (filteredOut > 0) {
                log(`Filter excluded ${filteredOut} tool(s) (${liveTools.length} remain).`);
            }
            const newFp = fingerprint(liveTools);

            if (newFp === this.index.fingerprint && this.index.tools.length > 0) {
                log(`No changes detected (${liveTools.length} tools).`);
                return { added: 0, removed: 0, unchanged: liveTools.length };
            }

            // Load existing embeddings to avoid re-embedding unchanged tools
            const cache = await this.loadEmbeddingCache();
            const liveNames = new Set(liveTools.map((t) => t.name));
            const removed = this.index.tools.map((t) => t.name).filter((n) => !liveNames.has(n));

            // Identify tools that need a new embedding
            const toEmbed: Array<{ text: string; cacheKey: string }> = [];
            for (const tool of liveTools) {
                const desc = tool.description ?? "";
                const cacheKey = `${tool.name}|||${desc}`;
                if (!cache[cacheKey]) {
                    toEmbed.push({ text: `${tool.name}: ${desc}`, cacheKey });
                }
            }

            // Batch-embed in chunks of 64 — 12x faster than one-at-a-time
            await this.batchEmbed(toEmbed, cache);
            const added = toEmbed.length;

            // Build LanceDB records + in-memory entries
            const records: LanceToolRecord[] = [];
            const entries: ToolEntry[] = [];

            for (const tool of liveTools) {
                const desc = tool.description ?? "";
                const cacheKey = `${tool.name}|||${desc}`;
                const vector = cache[cacheKey];
                records.push({ name: tool.name, description: desc, inputSchema: JSON.stringify(tool.inputSchema ?? {}), cacheKey, vector });
                entries.push({ name: tool.name, description: desc, inputSchema: tool.inputSchema, vector });
            }

            // Overwrite LanceDB table atomically
            this.table = await this.db.createTable("tools", records, { mode: "overwrite" });

            const indexedAt = new Date().toISOString();
            this.index = { tools: entries, indexedAt, fingerprint: newFp };

            // Persist fingerprint for fast startup
            writeFileSync(META_FILE, JSON.stringify({ fingerprint: newFp, indexedAt } satisfies IndexMeta));

            const unchanged = entries.length - added;
            log(`[${reason}] +${added} new, -${removed.length} removed, ${unchanged} unchanged. Total: ${entries.length}.`);
            return { added, removed: removed.length, unchanged };
        } finally {
            this.reindexing = false;
        }
    }

    /** Check if live tools have changed vs. current fingerprint. */
    hasChanged(liveTools: LiveTool[]): boolean {
        return fingerprint(liveTools) !== this.index.fingerprint;
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    /** Hybrid vector+keyword search with Reciprocal Rank Fusion. */
    async search(query: string, limit: number): Promise<DiscoverResult[]> {
        const queryEmbedding = await this.embedQueryCached(query);

        // Defensive filter — should already be enforced at index time, but
        // guards against stale in-memory entries after a filter config change.
        const tools = this.index.tools.filter((t) => isToolAllowed(t.name));
        if (tools.length === 0) return [];

        // 1. Dense vector search — in-memory cosine scan (<1ms for ≤10K tools)
        const vectorHits = tools
            .map((t) => ({ name: t.name, score: cosine(queryEmbedding, t.vector) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit * 3);

        // 2. BM25 keyword search
        const queryTerms = query.toLowerCase().match(/\w+/g) ?? [];
        const avgDocLen = tools.reduce(
            (s, t) => s + `${t.name} ${t.description}`.split(/\W+/).length, 0,
        ) / Math.max(tools.length, 1);

        const bm25Hits = tools
            .map((t) => ({ name: t.name, score: bm25Score(queryTerms, `${t.name} ${t.description}`, avgDocLen) }))
            .filter((r) => r.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit * 3);

        // 3. Reciprocal Rank Fusion
        const fusedNames = rrfFuse(
            [vectorHits.map((r) => r.name), bm25Hits.map((r) => r.name)],
            limit,
        );

        // 4. Build final results with cosine relevance score
        const scoreMap = new Map(vectorHits.map((r) => [r.name, r.score]));
        const toolMap = new Map(tools.map((t) => [t.name, t]));

        return fusedNames
            .map((n) => {
                const tool = toolMap.get(n);
                if (!tool) return null;
                return {
                    name: tool.name,
                    description: tool.description,
                    relevance: parseFloat((scoreMap.get(n) ?? 0).toFixed(4)),
                    inputSchema: tool.inputSchema,
                };
            })
            .filter((r): r is DiscoverResult => r !== null);
    }

    // ─── Private helpers ──────────────────────────────────────────────────────

    private async embed(text: string): Promise<number[]> {
        const out = await this.embedder(text, { pooling: "mean", normalize: true });
        return Array.from(out.data as Float32Array);
    }

    /**
     * LRU-cached query embedding. Same query → same vector, no re-compute.
     * Map iterates in insertion order, so we delete+re-set on hit to move
     * the entry to the back (most-recently-used). Eviction is from the front.
     */
    private async embedQueryCached(query: string): Promise<number[]> {
        const hit = this.queryCache.get(query);
        if (hit) {
            this.queryCache.delete(query);
            this.queryCache.set(query, hit);
            return hit;
        }
        const v = await this.embed(query);
        if (this.queryCache.size >= this.QUERY_CACHE_SIZE) {
            const oldest = this.queryCache.keys().next().value;
            if (oldest !== undefined) this.queryCache.delete(oldest);
        }
        this.queryCache.set(query, v);
        return v;
    }

    private async loadEmbeddingCache(): Promise<Record<string, number[]>> {
        const cache: Record<string, number[]> = {};
        if (!this.table) return cache;
        try {
            const rows: LanceToolRecord[] = await this.table.toArray();
            for (const row of rows) {
                if (row.cacheKey && row.vector) cache[row.cacheKey] = Array.from(row.vector);
            }
        } catch { /* empty or corrupt — start fresh */ }
        return cache;
    }

    private async batchEmbed(
        items: Array<{ text: string; cacheKey: string }>,
        cache: Record<string, number[]>,
    ): Promise<void> {
        const BATCH_SIZE = 64;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const chunk = items.slice(i, i + BATCH_SIZE);
            const texts = chunk.map((x) => x.text);
            const out = await this.embedder(texts, { pooling: "mean", normalize: true });
            const dim: number = out.dims[out.dims.length - 1];
            for (let j = 0; j < chunk.length; j++) {
                cache[chunk[j].cacheKey] = Array.from(
                    (out.data as Float32Array).slice(j * dim, (j + 1) * dim),
                );
            }
        }
    }
}
