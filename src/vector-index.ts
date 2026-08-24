/**
 * VectorIndex — owns the embedding model, SQLite + sqlite-vec store, and
 * in-memory tool metadata.
 *
 * Storage layout (single vec0 virtual table with auxiliary columns):
 *   CREATE VIRTUAL TABLE tools USING vec0(
 *     embedding float[MODEL_DIM],
 *     +name TEXT, +description TEXT, +input_schema TEXT, +cache_key TEXT
 *   );
 *
 * Vector search uses sqlite-vec KNN (sublinear via HNSW-ish scan).
 * BM25 keyword search runs in-memory over the metadata list.
 * Reciprocal Rank Fusion combines both.
 *
 * Migrating from LanceDB: on first run with this code, the .lancedb/ directory
 * is ignored (LanceDB is no longer a dep). All tools are re-embedded from
 * scratch — one-time cost of ~5-25s depending on tool count.
 */
import { pipeline, env as hfEnv } from "@huggingface/transformers";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";

import { DB_PATH, MODEL_DIM, META_FILE, MODEL_CACHE, log } from "./config.js";
import { bm25Score, rrfFuse, fingerprint } from "./search.js";
import { isToolAllowed } from "./filter.js";
import type {
    ToolEntry, IndexResult, IndexMeta, DiscoverResult, LiveTool,
} from "./types.js";
import type { Client } from "@modelcontextprotocol/client";

// Point HuggingFace Transformers at our local model cache
hfEnv.cacheDir = MODEL_CACHE;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- embedder pipeline has no public type
type Embedder = any;

/** Row shape from the tools table. embedding is read separately when needed. */
interface ToolRow {
    rowid: number;
    name: string;
    description: string;
    input_schema: string;
    cache_key: string;
}

export class VectorIndex {
    private embedder: Embedder = null;
    private db: Database.Database | null = null;
    /** Metadata only — no vectors. Used for BM25, dashboard, fingerprint. */
    private tools: ToolEntry[] = [];
    private _indexedAt = "";
    private _fingerprint = "";
    private reindexing = false;
    // LRU cache for query embeddings. Hot queries (e.g. "send email") hit cache
    // instead of re-running the embedding pipeline (~5-20ms per call).
    private queryCache = new Map<string, number[]>();
    private readonly QUERY_CACHE_SIZE = 100;

    /** Current tool count (for health endpoint). */
    get toolCount(): number { return this.tools.length; }

    /** Read-only snapshot of indexed tools (for dashboard). */
    get indexTools(): ReadonlyArray<{ name: string; description: string; inputSchema: unknown }> {
        return this.tools.filter((t) => isToolAllowed(t.name));
    }

    /** ISO timestamp of last successful index build. */
    get indexedAt(): string { return this._indexedAt; }

    /** Current fingerprint for change detection. */
    get currentFingerprint(): string { return this._fingerprint; }

    /** True once the embedding model is loaded and ready. */
    get isReady(): boolean { return this.embedder !== null; }

    // ─── Initialization ───────────────────────────────────────────────────────

    /** Open SQLite DB + load embedding model (~5-30s first time). */
    async init(): Promise<void> {
        this.openDb();

        // Migration notice (informational only — we don't read .lancedb)
        if (existsSync(path.join(DB_PATH, "../../.lancedb"))) {
            log("Notice: legacy .lancedb/ directory detected. It's no longer used — safe to delete after first successful run.");
        }

        log("Loading embedding model (mxbai-embed-xsmall-v1, ~23MB)...");
        this.embedder = await pipeline(
            "feature-extraction",
            "mixedbread-ai/mxbai-embed-xsmall-v1",
            { dtype: "q8", device: "cpu" },
        );
        log("Model ready.");

        // Load metadata into memory
        this.loadMetadataFromDb();
    }

    private openDb(): void {
        // Ensure parent dir exists
        mkdirSync(path.dirname(DB_PATH), { recursive: true });
        this.db = new Database(DB_PATH);
        sqliteVec.load(this.db);
        // vec0 virtual table with auxiliary columns. Note: vec0 tables don't
        // support CREATE INDEX — internal HNSW-like structure handles vector
        // lookups, auxiliary column scans are linear (only used at reindex time).
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS tools USING vec0(
                embedding float[${MODEL_DIM}],
                +name TEXT,
                +description TEXT,
                +input_schema TEXT,
                +cache_key TEXT
            );
        `);
    }

    /** Load all tool metadata (no vectors) into memory. */
    private loadMetadataFromDb(): void {
        if (!this.db) return;
        const rows = this.db.prepare(
            "SELECT rowid, name, description, input_schema, cache_key FROM tools",
        ).all() as ToolRow[];
        this.tools = rows.map((r) => ({
            name: r.name,
            description: r.description,
            inputSchema: JSON.parse(r.input_schema ?? "{}"),
            // vector intentionally not loaded — lives in SQLite, fetched on search
            vector: [],
        }));

        let meta: IndexMeta = { fingerprint: "", indexedAt: "" };
        if (existsSync(META_FILE)) {
            try { meta = JSON.parse(readFileSync(META_FILE, "utf-8")); } catch { /* ignore */ }
        }
        this._fingerprint = meta.fingerprint;
        this._indexedAt = meta.indexedAt;

        log(`Loaded ${this.tools.length} tools from SQLite cache.`);
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
        if (!this.db) throw new Error("VectorIndex not initialized");

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

            const isEmpty = this.tools.length === 0;
            // Force reindex if DB is empty (first run / migration) even if fingerprint matches.
            if (!isEmpty && newFp === this._fingerprint) {
                log(`No changes detected (${liveTools.length} tools).`);
                return { added: 0, removed: 0, unchanged: liveTools.length };
            }

            // Build map of existing tools by name for diff
            const existingByName = new Map(this.tools.map((t) => [t.name, t]));
            const liveNames = new Set(liveTools.map((t) => t.name));
            const removed: string[] = this.tools
                .map((t) => t.name)
                .filter((n) => !liveNames.has(n));

            // Load existing cache_keys to detect unchanged tools (skip re-embedding)
            const existingCacheKeys = new Map<string, string>();
            if (!isEmpty) {
                const rows = this.db.prepare(
                    "SELECT name, cache_key FROM tools",
                ).all() as Array<{ name: string; cache_key: string }>;
                for (const r of rows) existingCacheKeys.set(r.name, r.cache_key);
            }

            // Identify tools that need (re)embedding
            const toEmbed: Array<{ text: string; cacheKey: string; tool: LiveTool }> = [];
            for (const tool of liveTools) {
                const desc = tool.description ?? "";
                const cacheKey = `${tool.name}|||${desc}`;
                if (existingCacheKeys.get(tool.name) !== cacheKey) {
                    toEmbed.push({ text: `${tool.name}: ${desc}`, cacheKey, tool });
                }
            }

            // Batch-embed in chunks of 64
            const newEmbeddings = await this.batchEmbed(toEmbed);

            // Transaction: replace everything atomically
            // vec0 doesn't support bulk UPDATE of vectors, so we delete+reinsert
            // changed tools. Unchanged tools are left alone.
            const tx = this.db.transaction(() => {
                // 1. Delete removed tools (by name — vec0 supports it via aux column)
                const deleteStmt = this.db!.prepare("DELETE FROM tools WHERE name = ?");
                for (const name of removed) deleteStmt.run(name);

                // 2. Delete tools that need re-embedding (cache_key changed)
                const deleteForReinsert = this.db!.prepare("DELETE FROM tools WHERE name = ?");
                for (const item of toEmbed) deleteForReinsert.run(item.tool.name);

                // 3. Insert all live tools that we have embeddings for
                const insertStmt = this.db!.prepare(
                    "INSERT INTO tools (embedding, name, description, input_schema, cache_key) VALUES (?, ?, ?, ?, ?)",
                );
                for (const item of toEmbed) {
                    const emb = newEmbeddings.get(item.cacheKey);
                    if (!emb) continue;
                    const desc = item.tool.description ?? "";
                    insertStmt.run(
                        Buffer.from(emb.buffer),
                        item.tool.name,
                        desc,
                        JSON.stringify(item.tool.inputSchema ?? {}),
                        item.cacheKey,
                    );
                }
            });
            tx();

            // Reload metadata
            this.loadMetadataFromDb();

            const added = toEmbed.length;
            const unchanged = liveTools.length - added;
            this._fingerprint = newFp;
            this._indexedAt = new Date().toISOString();
            writeFileSync(META_FILE, JSON.stringify({
                fingerprint: newFp,
                indexedAt: this._indexedAt,
            } satisfies IndexMeta));

            log(`[${reason}] +${added} new/changed, -${removed.length} removed, ${unchanged} unchanged. Total: ${this.tools.length}.`);
            return { added, removed: removed.length, unchanged };
        } finally {
            this.reindexing = false;
        }
    }

    /** Check if live tools have changed vs. current fingerprint. */
    hasChanged(liveTools: LiveTool[]): boolean {
        return fingerprint(liveTools) !== this._fingerprint;
    }

    // ─── Search ───────────────────────────────────────────────────────────────

    /** Hybrid vector+keyword search with Reciprocal Rank Fusion. */
    async search(query: string, limit: number): Promise<DiscoverResult[]> {
        if (!this.db) throw new Error("VectorIndex not initialized");
        const queryEmbedding = await this.embedQueryCached(query);

        // Defensive filter — should already be enforced at index time, but
        // guards against stale in-memory entries after a filter config change.
        const tools = this.tools.filter((t) => isToolAllowed(t.name));
        if (tools.length === 0) return [];

        // 1. Dense vector search via sqlite-vec KNN
        // vec0 distance for normalized vectors = 1 - cosine_similarity.
        // Convert to similarity so higher = better (consistent with old code).
        const k = Math.min(limit * 3, tools.length);
        const vecRows = this.db.prepare(
            `SELECT name, distance FROM tools
             WHERE embedding MATCH ? AND k = ?
             ORDER BY distance`,
        ).all(Buffer.from(queryEmbedding.buffer), k) as Array<{ name: string; distance: number }>;

        const vectorHits = vecRows
            .map((r) => ({ name: r.name, score: 1 - r.distance }))
            .sort((a, b) => b.score - a.score);

        // 2. BM25 keyword search (in-memory over metadata)
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

    private async embed(text: string): Promise<Float32Array> {
        const out = await this.embedder(text, { pooling: "mean", normalize: true });
        return out.data as Float32Array;
    }

    /**
     * LRU-cached query embedding. Same query → same vector, no re-compute.
     * Map iterates in insertion order, so we delete+re-set on hit to move
     * the entry to the back (most-recently-used). Eviction is from the front.
     */
    private async embedQueryCached(query: string): Promise<Float32Array> {
        const hit = this.queryCache.get(query);
        if (hit) {
            this.queryCache.delete(query);
            this.queryCache.set(query, hit);
            return new Float32Array(hit);
        }
        const v = await this.embed(query);
        if (this.queryCache.size >= this.QUERY_CACHE_SIZE) {
            const oldest = this.queryCache.keys().next().value;
            if (oldest !== undefined) this.queryCache.delete(oldest);
        }
        this.queryCache.set(query, Array.from(v));
        return v;
    }

    /**
     * Batch-embed multiple texts at once. Returns map keyed by cacheKey.
     * Embeddings are L2-normalized by the pipeline so cosine = dot product.
     */
    private async batchEmbed(
        items: Array<{ text: string; cacheKey: string }>,
    ): Promise<Map<string, Float32Array>> {
        const out = new Map<string, Float32Array>();
        if (items.length === 0) return out;
        const BATCH_SIZE = 64;
        for (let i = 0; i < items.length; i += BATCH_SIZE) {
            const chunk = items.slice(i, i + BATCH_SIZE);
            const texts = chunk.map((x) => x.text);
            const result = await this.embedder(texts, { pooling: "mean", normalize: true });
            const dim: number = result.dims[result.dims.length - 1];
            const data = result.data as Float32Array;
            for (let j = 0; j < chunk.length; j++) {
                const emb = data.slice(j * dim, (j + 1) * dim);
                out.set(chunk[j].cacheKey, emb);
            }
        }
        return out;
    }
}
