/**
 * Spawns the MCP Router CLI with windowsHide:true (no cmd flash on Windows).
 * Used by StdioClientTransport as: command="node", args=["dist/launch-router.js"]
 */
import { spawn } from "child_process";

const isWindows = process.platform === "win32";

// Use shell:false to avoid shell injection via env vars.
// On Windows, npx is a .cmd file and needs the explicit .cmd extension without a shell.
const npxCmd = isWindows ? "npx.cmd" : "npx";

const proc = spawn(npxCmd, ["--yes", "@mcp_router/cli@latest", "connect"], {
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});

// On Windows: taskkill /F /T kills the entire subtree
// On Unix: kill the process group so all children die with the parent
function killTree() {
  if (!proc.pid) return;
  if (isWindows) {
    spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
      shell: false, stdio: "ignore",
    });
  } else {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill(); }
  }
}

process.on("SIGTERM", () => { killTree(); process.exit(0); });
process.on("SIGINT",  () => { killTree(); process.exit(0); });
process.on("exit",    ()  => { killTree(); });

proc.on("exit",  (code) => process.exit(code ?? 0));
proc.on("error", (e)    => { process.stderr.write(`launch-router error: ${e}\n`); process.exit(1); });
