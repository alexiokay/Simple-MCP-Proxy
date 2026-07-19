/**
 * Pure search/scoring functions — no side effects, no shared state.
 * Used by VectorIndex for hybrid (vector + keyword) tool discovery.
 */

import type { LiveTool } from "./types.js";

/**
 * Cosine similarity via dot product.
 * Vectors are L2-normalized by the embedding pipeline, so cosine = dot.
 * For ≤10K tools this is <1ms — no approximate-NN needed.
 */
export function cosine(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

/**
 * BM25 keyword score for a single document.
 * No IDF (single-pass, in-memory — IDF would require two passes).
 * Still effective for short tool name+description text.
 */
export function bm25Score(queryTerms: string[], docText: string, avgDocLen: number): number {
    const k1 = 1.5, b = 0.75;
    const words = docText.toLowerCase().match(/\w+/g) ?? [];
    const docLen = words.length;
    if (docLen === 0) return 0;

    const tf = new Map<string, number>();
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);

    let score = 0;
    for (const term of queryTerms) {
        const freq = tf.get(term) ?? 0;
        if (freq === 0) continue;
        score += (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLen / avgDocLen)));
    }
    return score;
}

/**
 * Reciprocal Rank Fusion — merges multiple ranked lists into one.
 * k=60 is the standard constant from the original RRF paper.
 */
export function rrfFuse(rankedLists: string[][], topK: number, k = 60): string[] {
    const scores = new Map<string, number>();
    for (const list of rankedLists) {
        list.forEach((name, rank) => {
            scores.set(name, (scores.get(name) ?? 0) + 1 / (k + rank + 1));
        });
    }
    return [...scores.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK)
        .map(([name]) => name);
}

/**
 * Deterministic fingerprint for a tool list.
 * Includes inputSchema so schema-only changes trigger re-indexing.
 */
export function fingerprint(tools: LiveTool[]): string {
    return tools
        .map((t) => `${t.name}|${t.description ?? ""}|${JSON.stringify(t.inputSchema ?? {})}`)
        .sort()
        .join("\n");
}
