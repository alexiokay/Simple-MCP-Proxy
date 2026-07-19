/**
 * Tool allow/deny filter.
 *
 * Compiles ALLOW_TOOLS and DENY_TOOLS env vars (comma-separated regex patterns)
 * into RegExp arrays at startup. Used by:
 *   - VectorIndex.buildIndex to filter what gets embedded/searchable
 *   - server.ts execute handlers to enforce the boundary at call time
 *   - dashboard to display active filters
 *
 * If ALLOW_TOOLS is non-empty, a tool must match at least one allow pattern.
 * DENY_TOOLS always excludes. Both together = ALLOW scope minus DENY carve-outs.
 *
 * Changes to these env vars require a restart (read once at module load).
 */
import { ALLOW_TOOLS, DENY_TOOLS, log } from "./config.js";

function compile(patterns: string[]): RegExp[] {
    const compiled: RegExp[] = [];
    for (const p of patterns) {
        try {
            compiled.push(new RegExp(p));
        } catch (e) {
            log(`Invalid regex in tool filter, skipping: ${p} (${e instanceof Error ? e.message : String(e)})`);
        }
    }
    return compiled;
}

const allowPatterns = compile(ALLOW_TOOLS);
const denyPatterns = compile(DENY_TOOLS);

if (allowPatterns.length || denyPatterns.length) {
    log(`Tool filter active: ${allowPatterns.length} allow / ${denyPatterns.length} deny pattern(s)`);
    if (allowPatterns.length) log(`  ALLOW_TOOLS: ${ALLOW_TOOLS.join(", ")}`);
    if (denyPatterns.length) log(`  DENY_TOOLS: ${DENY_TOOLS.join(", ")}`);
}

/** True if the tool name passes the active filter. */
export function isToolAllowed(name: string): boolean {
    if (allowPatterns.length > 0 && !allowPatterns.some((p) => p.test(name))) return false;
    if (denyPatterns.some((p) => p.test(name))) return false;
    return true;
}

/** Snapshot of the active configuration (for dashboard display). */
export function getFilterSummary(): { allowed: string[]; denied: string[]; active: boolean } {
    return {
        allowed: ALLOW_TOOLS,
        denied: DENY_TOOLS,
        active: allowPatterns.length > 0 || denyPatterns.length > 0,
    };
}
