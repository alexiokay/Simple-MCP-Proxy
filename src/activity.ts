/**
 * ActivityLog — small in-memory ring buffer of recent tool calls.
 *
 * Records discover / execute / batch events with timing and outcome so the
 * dashboard can show observability without instrumenting the MCP protocol.
 *
 * No persistence, no locking — single-process, synchronous pushes only.
 */
export interface ActivityEntry {
    ts: string;          // ISO timestamp
    type: "discover" | "execute" | "batch" | "refresh";
    detail: string;      // query, tool_name, or count
    latencyMs: number;
    success: boolean;
    error?: string;
}

export class ActivityLog {
    private entries: ActivityEntry[] = [];
    private readonly capacity: number;

    constructor(capacity = 50) {
        this.capacity = capacity;
    }

    record(entry: ActivityEntry): void {
        this.entries.push(entry);
        if (this.entries.length > this.capacity) {
            this.entries.splice(0, this.entries.length - this.capacity);
        }
    }

    /** Most-recent-first snapshot. */
    snapshot(): ActivityEntry[] {
        return [...this.entries].reverse();
    }
}
