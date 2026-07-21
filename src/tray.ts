/**
 * Cross-platform system tray for MCP Vector Proxy.
 * Manages the proxy process and shows health status.
 *
 * Tray UI is provided by a Rust binary (tray-rs/) using the `tray-icon` crate.
 * Node spawns the binary and communicates via JSON-lines over stdin/stdout:
 *   parent -> tray:  {"type":"menu","icon":"green","tooltip":"...","items":[...]}
 *   tray  -> parent: {"type":"click","seq_id":2}
 *
 * Start: node dist/tray.js
 * Auto-start: run setup.ps1 (Windows) or setup.sh (macOS/Linux)
 */
import { spawn, execFileSync, ChildProcess } from "child_process";
import { readFileSync, mkdirSync, createWriteStream, WriteStream } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

// Importing config.ts runs its top-level .env loader as a side effect, so
// process.env is populated before we read HTTP_PORT/HTTP_HOST below.
// Single source of truth for env parsing and the default port.
import { HTTP_PORT as CONFIG_PORT, HTTP_HOST, DEFAULT_HTTP_PORT } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "index.js");
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// Tray always runs the proxy in HTTP mode — fall back to DEFAULT_HTTP_PORT
// when the user hasn't set one. CONFIG_PORT is null in that case (stdio mode),
// which doesn't apply to the tray-launched proxy.
const HTTP_PORT = String(CONFIG_PORT ?? DEFAULT_HTTP_PORT);
const HEALTH = `http://${HTTP_HOST}:${HTTP_PORT}/health`;
const DASHBOARD = `http://${HTTP_HOST}:${HTTP_PORT}/`;

// ── Absolute node path ────────────────────────────────────────────────────────
// Cold-boot processes (Run key / Task Scheduler) inherit a stripped PATH that
// often doesn't include nvm/volta/fnm shims. setup.ps1 bakes the absolute node
// path to .node-path; we use it for spawning the proxy and prepend its dir to
// PATH so launch-router.ts can still find npx.
function resolveNodeBinary(): { bin: string; dir: string } {
  const fallback = { bin: "node", dir: "" };
  try {
    const baked = readFileSync(path.join(__dirname, "../.node-path"), "utf-8").trim();
    if (baked) {
      return { bin: baked, dir: path.dirname(baked) };
    }
  } catch { /* no .node-path file — rely on PATH */ }
  return fallback;
}
const NODE_BIN = resolveNodeBinary();
if (NODE_BIN.dir) {
  const sep = IS_WIN ? ";" : ":";
  process.env.PATH = `${NODE_BIN.dir}${sep}${process.env.PATH ?? ""}`;
}

// ── Proxy log file ────────────────────────────────────────────────────────────
const LOG_DIR = path.join(homedir(), ".mcp-proxy");
const LOG_FILE = path.join(LOG_DIR, "proxy.log");
mkdirSync(LOG_DIR, { recursive: true });

function openLog(): WriteStream {
  try {
    return createWriteStream(LOG_FILE, { flags: "a" });
  } catch {
    return createWriteStream(IS_WIN ? "\\\\.\\NUL" : "/dev/null", { flags: "a" });
  }
}

function logToBoth(stream: WriteStream, msg: string): void {
  stream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Rust tray binary path ─────────────────────────────────────────────────────
// dist/tray/mcp-tray-{platform}-{arch}[.exe]
function trayBinaryPath(): string {
  const platformMap: Record<string, string> = {
    win32: "win",
    darwin: "macos",
    linux: "linux",
  };
  const p = platformMap[process.platform] ?? process.platform;
  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
    aarch64: "arm64",
  };
  const a = archMap[process.arch] ?? process.arch;
  const ext = IS_WIN ? ".exe" : "";
  return path.join(__dirname, "tray", `mcp-tray-${p}-${a}${ext}`);
}

// ── Rust tray process ─────────────────────────────────────────────────────────

let trayProc: ChildProcess | null = null;

/** Items spec sent to the Rust binary. Separators included. */
interface ItemSpec { title?: string; tooltip?: string; enabled?: boolean; separator?: boolean; }

/** Send a menu update to the Rust tray. */
function sendMenu(icon: string, tooltip: string, items: ItemSpec[]): void {
  if (!trayProc || !trayProc.stdin) return;
  const msg = JSON.stringify({ type: "menu", icon, tooltip, items }) + "\n";
  try { trayProc.stdin.write(msg); } catch { /* tray died */ }
}

function spawnTray(): void {
  const bin = trayBinaryPath();
  try {
    trayProc = spawn(bin, [], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: false,
    });
  } catch (e) {
    process.stderr.write(`[tray] Failed to spawn ${bin}: ${e}\n`);
    return;
  }

  const stdout = trayProc.stdout;
  if (!stdout) return;
  let buf = "";
  stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "click" && typeof ev.seq_id === "number") {
          handleClick(ev.seq_id);
        }
      } catch { /* malformed */ }
    }
  });

  trayProc.on("exit", (code) => {
    process.stderr.write(`[tray] Rust tray exited (code=${code})\n`);
    trayProc = null;
  });
}

// ── Menu structure ────────────────────────────────────────────────────────────
// Item positions (must match Rust seq_id semantics):
//   0=status, 1=separator, 2=dashboard, 3=log, 4=restart, 5=separator, 6=exit
const SEQ_DASHBOARD = 2;
const SEQ_LOG = 3;
const SEQ_RESTART = 4;
const SEQ_EXIT = 6;

function buildMenu(status: string): ItemSpec[] {
  return [
    { title: status, enabled: false },
    { separator: true },
    { title: "Open Dashboard", enabled: true },
    { title: "Open Log File", enabled: true },
    { title: "Restart Proxy", enabled: true },
    { separator: true },
    { title: "Exit", enabled: true },
  ];
}

// ── Proxy process management ──────────────────────────────────────────────────

let proxyProc: ChildProcess | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const ENV: NodeJS.ProcessEnv = {
  HTTP_PORT,
  HTTP_HOST,
  ...process.env,
};

function startProxy(): void {
  const logStream = openLog();
  logToBoth(logStream, `── proxy starting (pid pending) ──`);
  proxyProc = spawn(NODE_BIN.bin, [SCRIPT], {
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: false,
  });
  const writeOut = (buf: Buffer) => logStream.write(buf);
  proxyProc.stdout?.on("data", writeOut);
  proxyProc.stderr?.on("data", writeOut);
  proxyProc.on("exit", (code, signal) => {
    logToBoth(logStream, `── proxy exited (code=${code} signal=${signal}) ──`);
    logStream.end();
  });
}

function killProxy(): void {
  if (!proxyProc) return;
  const pid = proxyProc.pid;
  if (!pid) { proxyProc = null; return; }
  try {
    if (proxyProc.exitCode === null) {
      if (IS_WIN) {
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      } else {
        try { process.kill(-pid, "SIGKILL"); }
        catch { proxyProc.kill(); }
      }
    }
  } catch { /* already dead */ }
  proxyProc = null;
}

function openUrl(url: string): void {
  const cmd = IS_WIN ? "start" : IS_MAC ? "open" : "xdg-open";
  spawn(cmd, [url], { shell: IS_WIN, stdio: "ignore", detached: true }).unref();
}

function openLogFile(): void {
  if (IS_WIN) {
    spawn("cmd", ["/c", "start", "", LOG_FILE], { shell: true, stdio: "ignore", detached: true }).unref();
  } else {
    openUrl(LOG_FILE);
  }
}

// ── Click handler ─────────────────────────────────────────────────────────────

function handleClick(seqId: number): void {
  switch (seqId) {
    case SEQ_DASHBOARD:
      openUrl(DASHBOARD);
      break;
    case SEQ_LOG:
      openLogFile();
      break;
    case SEQ_RESTART:
      updateTray("yellow", "Restarting...", "MCP Proxy - restarting...");
      killProxy();
      setTimeout(startProxy, 1500);
      break;
    case SEQ_EXIT:
      exitCleanly();
      break;
  }
}

function exitCleanly(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  killProxy();
  if (trayProc) {
    try { trayProc.kill(); } catch { /* already dead */ }
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", exitCleanly);
process.on("SIGINT", exitCleanly);
process.on("exit", () => { killProxy(); });

// ── Status updates ────────────────────────────────────────────────────────────

function updateTray(icon: string, status: string, tooltip: string): void {
  sendMenu(icon, tooltip, buildMenu(status));
}

// ── Health polling + crash detection ─────────────────────────────────────────

async function poll(): Promise<void> {
  if (proxyProc && proxyProc.exitCode !== null) {
    updateTray("yellow", "Crashed - restarting...", "MCP Proxy - restarting...");
    proxyProc = null;
    startProxy();
    return;
  }

  try {
    const res = await fetch(HEALTH);
    const data = await res.json() as {
      status: string;
      tools: number;
      indexedAt?: string | null;
      lastError?: string | null;
      lastErrorAt?: string | null;
    };
    const idx = data.indexedAt ? ` | idx ${new Date(data.indexedAt).toLocaleString()}` : "";
    if (data.status === "ok") {
      updateTray("green",
        `Connected - ${data.tools} tools`,
        `MCP Proxy | ${data.tools} tools | OK${idx}`);
    } else {
      const errLine = data.lastError ? `\nLast error: ${data.lastError}` : "";
      const errAt = data.lastErrorAt ? ` (${new Date(data.lastErrorAt).toLocaleString()})` : "";
      updateTray("yellow",
        `Router reconnecting (${data.tools} cached)`,
        `MCP Proxy - router reconnecting${idx}${errLine}${errAt}`);
    }
  } catch {
    updateTray("red", "Proxy starting up...", "MCP Proxy - starting...");
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
startProxy();
spawnTray();
// Send initial menu so the tray isn't blank during the first 5s before first poll.
sendMenu("yellow", "MCP Proxy - starting...", buildMenu("Starting..."));
poll();
pollTimer = setInterval(poll, 5000);
