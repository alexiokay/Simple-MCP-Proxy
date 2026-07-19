/**
 * Configuration, environment loading, and utility helpers.
 * All env-var parsing lives here so the rest of the codebase uses typed constants.
 */
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── .env loader ──────────────────────────────────────────────────────────────
// Values already in process.env take precedence (env vars > .env file).

function loadDotEnv(): void {
    try {
        const lines = readFileSync(path.join(__dirname, "../.env"), "utf-8").split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;
            const eq = trimmed.indexOf("=");
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
            if (key && !(key in process.env)) process.env[key] = val;
        }
    } catch {
        /* no .env file — rely on process.env */
    }
}
loadDotEnv();

// ─── Validated constants ──────────────────────────────────────────────────────

export const MCPR_TOKEN = process.env.MCPR_TOKEN ?? "";
if (!MCPR_TOKEN) {
    process.stderr.write(
        "[mcp-vector-proxy] Fatal: MCPR_TOKEN not set.\n" +
        "  Option 1: set the MCPR_TOKEN environment variable.\n" +
        "  Option 2: add MCPR_TOKEN=your-token to a .env file in the project root.\n"
    );
    process.exit(1);
}

export const DISCOVER_LIMIT = parseInt(process.env.DISCOVER_LIMIT ?? "10", 10);
export const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);

/** Default port used when the tray spawns the proxy in HTTP mode. */
export const DEFAULT_HTTP_PORT = 3456;

/** Parsed HTTP port, or null when not set (proxy runs in stdio mode). */
export const HTTP_PORT = process.env.HTTP_PORT ? parseInt(process.env.HTTP_PORT, 10) : null;
export const HTTP_HOST = process.env.HTTP_HOST ?? "127.0.0.1";
export const ALLOW_REMOTE = process.env.ALLOW_REMOTE === "1" || process.env.ALLOW_REMOTE === "true";
export const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";

// Tool allow/deny lists. Comma-separated regex patterns matched against tool names.
// ALLOW_TOOLS: if non-empty, only matching tools are indexed and callable.
// DENY_TOOLS: matching tools are hidden and refused at execute time.
// If both are set, ALLOW acts as a scope and DENY acts as a secondary exclusion.
// Patterns use JavaScript RegExp syntax. Examples:
//   ALLOW_TOOLS=^github_.*,^slack_.*
//   DENY_TOOLS=.*_delete_.*,admin_.*
export const ALLOW_TOOLS: string[] = (process.env.ALLOW_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
export const DENY_TOOLS: string[] = (process.env.DENY_TOOLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ─── Paths ────────────────────────────────────────────────────────────────────

export const DIST_DIR = __dirname;
export const LANCE_DIR = path.join(__dirname, "../.lancedb");
export const META_FILE = path.join(__dirname, "../.tool-meta.json");
export const MODEL_CACHE = path.join(__dirname, "../.model-cache");

// ─── Utilities ────────────────────────────────────────────────────────────────

const LOG_PREFIX = "[mcp-vector-proxy]";

export function log(msg: string): void {
    process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
