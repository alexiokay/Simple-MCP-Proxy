/**
 * Cross-platform system tray for MCP Vector Proxy.
 * Manages the proxy process and shows health status.
 * Works on Windows, macOS, Linux via systray2 (prebuilt native binaries).
 *
 * Start: node dist/tray.js
 * Auto-start: run setup.ps1 (Windows) or setup.sh (macOS/Linux)
 */
import _SysTray from "systray2";
// systray2 is CJS (exports.default = class). In ESM, default import = whole exports object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SysTray = ((_SysTray as any).default ?? _SysTray) as typeof _SysTray;
import { spawn, execFileSync, ChildProcess } from "child_process";
import { deflateSync } from "zlib";
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
  // Prepend so child spawn("node", ...) and spawn("npx", ...) both resolve.
  const sep = IS_WIN ? ";" : ":";
  process.env.PATH = `${NODE_BIN.dir}${sep}${process.env.PATH ?? ""}`;
}

// ── Proxy log file ────────────────────────────────────────────────────────────
// Tray pipes proxy child stdout/stderr here so boot failures can be diagnosed.
// Located at ~/.mcp-proxy/proxy.log (rotated manually; capped below in code).
const LOG_DIR = path.join(homedir(), ".mcp-proxy");
const LOG_FILE = path.join(LOG_DIR, "proxy.log");
mkdirSync(LOG_DIR, { recursive: true });

function openLog(): WriteStream {
  try {
    return createWriteStream(LOG_FILE, { flags: "a" });
  } catch {
    // If we can't open the log (permissions, etc.), fall back to /dev/null sink.
    return createWriteStream(IS_WIN ? "\\\\.\\NUL" : "/dev/null", { flags: "a" });
  }
}

function logToBoth(stream: WriteStream, msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  stream.write(line);
}

// ── PNG / ICO icon generation (zero deps, pure Node.js) ───────────────────────

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const t = Buffer.from(type);
  const l = Buffer.allocUnsafe(4); l.writeUInt32BE(data.length);
  const c = Buffer.allocUnsafe(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([l, t, data, c]);
}

function makePng(r: number, g: number, b: number): Buffer {
  const S = 16, cx = 7.5, cy = 7.5, radius = 6;
  const raw: number[] = [];
  for (let y = 0; y < S; y++) {
    raw.push(0); // filter: none
    for (let x = 0; x < S; x++) {
      const inside = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) <= radius;
      raw.push(r, g, b, inside ? 255 : 0); // RGBA
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from(raw))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIco(r: number, g: number, b: number): Buffer {
  // ICO container with embedded PNG (supported since Windows Vista)
  const png = makePng(r, g, b);
  const hdr = Buffer.alloc(6);
  hdr.writeUInt16LE(0, 0); hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(1, 4);
  const dir = Buffer.alloc(16);
  dir[0] = 16; dir[1] = 16;          // width, height
  dir.writeUInt16LE(0, 4);           // planes
  dir.writeUInt16LE(32, 6);           // bit depth
  dir.writeUInt32LE(png.length, 8);   // size of PNG
  dir.writeUInt32LE(22, 12);          // offset (6 hdr + 16 dir)
  return Buffer.concat([hdr, dir, png]);
}

function icon(r: number, g: number, b: number): string {
  return (IS_WIN ? makeIco(r, g, b) : makePng(r, g, b)).toString("base64");
}

const ICON_GREEN = icon(34, 197, 94);   // #22c55e
const ICON_YELLOW = icon(234, 179, 8);    // #eab308
const ICON_RED = icon(239, 68, 68);   // #ef4444

// ── Proxy process management ───────────────────────────────────────────────────

let proxyProc: ChildProcess | null = null;

// Declare at module top so the onClick closure can reference it safely (no TDZ risk)
let pollTimer: ReturnType<typeof setInterval> | null = null;

// Proxy inherits environment. Tray always runs the proxy in HTTP mode,
// so inject HTTP_PORT/HTTP_HOST defaults here if the user hasn't set them.
// process.env already has .env values loaded above, so user values win.
const ENV: NodeJS.ProcessEnv = {
  HTTP_PORT: HTTP_PORT,
  HTTP_HOST: HTTP_HOST,
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
  // Guard: pid is undefined if spawn itself failed
  const pid = proxyProc.pid;
  if (!pid) { proxyProc = null; return; }
  try {
    if (proxyProc.exitCode === null) {
      if (IS_WIN) {
        // execFileSync so the kill completes before we proceed (prevents orphans)
        execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)],
          { stdio: "ignore" });
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
  // Open the proxy log in the OS default editor for .log files.
  if (IS_WIN) {
    spawn("cmd", ["/c", "start", "", LOG_FILE], { shell: true, stdio: "ignore", detached: true }).unref();
  } else {
    openUrl(LOG_FILE);
  }
}

// ── Menu ─────────────────────────────────────────────────────────────────────
// Item positions: 0=status, 1=separator, 2=dashboard, 3=log, 4=restart, 5=separator, 6=exit
const SEQ_STATUS = 0;
const SEQ_DASHBOARD = 2;
const SEQ_LOG = 3;
const SEQ_RESTART = 4;
const SEQ_EXIT = 6;

startProxy();

const tray = new SysTray({
  menu: {
    icon: ICON_YELLOW,
    title: "",
    tooltip: "MCP Proxy - starting...",
    items: [
      { title: "Starting...", tooltip: "", checked: false, enabled: false },
      SysTray.separator,
      { title: "Open Dashboard", tooltip: "", checked: false, enabled: true },
      { title: "Open Log File", tooltip: "", checked: false, enabled: true },
      { title: "Restart Proxy", tooltip: "", checked: false, enabled: true },
      SysTray.separator,
      { title: "Exit", tooltip: "", checked: false, enabled: true },
    ],
  },
  debug: false,
  copyDir: true,
});

// ── Click handler ─────────────────────────────────────────────────────────────

tray.onClick(action => {
  switch (action.seq_id) {
    case SEQ_DASHBOARD:
      openUrl(DASHBOARD);
      break;

    case SEQ_LOG:
      openLogFile();
      break;

    case SEQ_RESTART:
      updateTray(ICON_YELLOW, "Restarting...", "MCP Proxy - restarting...");
      killProxy();
      setTimeout(startProxy, 1500);
      break;

    case SEQ_EXIT:
      exitCleanly();
  }
});

/** Centralized exit: stop polling, kill proxy tree, kill tray, then exit. */
function exitCleanly(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  killProxy();
  try { tray.kill(); } catch { /* tray already dead */ }
  // Small delay so taskkill /T completes before we vanish
  setTimeout(() => process.exit(0), 500);
}

// Ensure cleanup if the tray process is killed externally (e.g. Task Manager)
process.on("SIGTERM", exitCleanly);
process.on("SIGINT", exitCleanly);
process.on("exit", () => { killProxy(); });

// ── Status updates ────────────────────────────────────────────────────────────

function updateTray(ico: string, status: string, tooltip: string): void {
  tray.sendAction({
    type: "update-menu", menu: {
      icon: ico, title: "", tooltip,
      items: [
        { title: status, tooltip: "", checked: false, enabled: false },
        SysTray.separator,
        { title: "Open Dashboard", tooltip: "", checked: false, enabled: true },
        { title: "Open Log File", tooltip: "", checked: false, enabled: true },
        { title: "Restart Proxy", tooltip: "", checked: false, enabled: true },
        SysTray.separator,
        { title: "Exit", tooltip: "", checked: false, enabled: true },
      ],
    }
  });
}

// ── Health polling + crash detection ─────────────────────────────────────────

async function poll(): Promise<void> {
  if (proxyProc && (proxyProc as any).exitCode !== null) {
    updateTray(ICON_YELLOW, "Crashed - restarting...", "MCP Proxy - restarting...");
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
      updateTray(ICON_GREEN,
        `Connected - ${data.tools} tools`,
        `MCP Proxy | ${data.tools} tools | OK${idx}`);
    } else {
      const errLine = data.lastError ? `\nLast error: ${data.lastError}` : "";
      const errAt = data.lastErrorAt ? ` (${new Date(data.lastErrorAt).toLocaleString()})` : "";
      updateTray(ICON_YELLOW,
        `Router reconnecting (${data.tools} cached)`,
        `MCP Proxy - router reconnecting${idx}${errLine}${errAt}`);
    }
  } catch {
    updateTray(ICON_RED, "Proxy starting up...", "MCP Proxy - starting...");
  }
}

// Assign (not declare) — declared at top of module to avoid TDZ in onClick closure
pollTimer = setInterval(poll, 5000);
// onReady() requires _rl to be set (which happens async inside init()).
// Use tray.ready() instead so we wait for the binary to fully start.
tray.ready().then(() => poll());

// Suppress unused variable warning for SEQ_STATUS (reserved for future use)
void SEQ_STATUS;
