/**
 * ToolStats — incremental per-tool usage statistics.
 *
 * Lives alongside ActivityLog (which is a ring buffer of recent entries).
 * ToolStats accumulates counters from the start of the process so the
 * dashboard can show aggregate analytics: call count, success rate, latency
 * percentiles, last error per tool.
 *
 * No persistence — resets when the proxy restarts. Persistence is a future
 * concern once the value is proven.
 */
export interface ToolStat {
    name: string;
    callCount: number;
    successCount: number;
    failureCount: number;
    latencySamples: number[];   // capped at MAX_SAMPLES, oldest dropped first
    firstCalledAt: string;
    lastCalledAt: string;
    lastError: string | null;
    lastErrorAt: string | null;
}

export interface ToolStatSummary extends Omit<ToolStat, "latencySamples"> {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    avg: number | null;
    successRate: number; // 0..1
}

export class ToolStats {
    private stats = new Map<string, ToolStat>();
    private readonly MAX_SAMPLES = 100;

    /** Record one execute attempt (success or failure). */
    recordExecute(name: string, latencyMs: number, success: boolean, error?: string): void {
        let s = this.stats.get(name);
        const now = new Date().toISOString();
        if (!s) {
            s = {
                name,
                callCount: 0,
                successCount: 0,
                failureCount: 0,
                latencySamples: [],
                firstCalledAt: now,
                lastCalledAt: now,
                lastError: null,
                lastErrorAt: null,
            };
            this.stats.set(name, s);
        }
        s.callCount++;
        if (success) s.successCount++;
        else s.failureCount++;
        s.latencySamples.push(latencyMs);
        if (s.latencySamples.length > this.MAX_SAMPLES) s.latencySamples.shift();
        s.lastCalledAt = now;
        if (error) {
            const trimmed = error.length > 200 ? error.slice(0, 200) + "…" : error;
            s.lastError = trimmed;
            s.lastErrorAt = now;
        }
    }

    /** All stats sorted by call count (desc). Includes computed percentiles. */
    snapshot(sortBy: "calls" | "name" | "latency" | "failures" = "calls"): ToolStatSummary[] {
        const list = [...this.stats.values()].map((s) => {
            const sorted = [...s.latencySamples].sort((a, b) => a - b);
            const n = sorted.length;
            const pct = (p: number): number | null =>
                n === 0 ? null : sorted[Math.min(n - 1, Math.floor(n * p))];
            const avg = n === 0 ? null : Math.round(sorted.reduce((x, y) => x + y, 0) / n);
            const rate = s.callCount === 0 ? 0 : s.successCount / s.callCount;
            const { latencySamples, ...rest } = s;
            void latencySamples;
            return {
                ...rest,
                p50: pct(0.5),
                p95: pct(0.95),
                p99: pct(0.99),
                avg,
                successRate: rate,
            };
        });
        const sorters: Record<typeof sortBy, (a: ToolStatSummary, b: ToolStatSummary) => number> = {
            calls: (a, b) => b.callCount - a.callCount,
            name: (a, b) => a.name.localeCompare(b.name),
            latency: (a, b) => (b.avg ?? 0) - (a.avg ?? 0),
            failures: (a, b) => b.failureCount - a.failureCount,
        };
        return list.sort(sorters[sortBy]);
    }

    /** Total calls across all tools. */
    get totalCalls(): number {
        let n = 0;
        for (const s of this.stats.values()) n += s.callCount;
        return n;
    }
}
