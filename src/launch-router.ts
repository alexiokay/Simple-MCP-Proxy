/**
 * Spawns the MCP Router CLI with windowsHide:true (no cmd flash on Windows).
 * Used by StdioClientTransport as: command="node", args=["dist/launch-router.js"]
 */
import { spawn } from "child_process";

const isWindows = process.platform === "win32";

// On Windows, npx is a .cmd batch file which requires cmd.exe to run.
// shell:true is safe here because all arguments are hardcoded constants.
// On Unix, shell:false is fine and avoids any shell overhead.
const npxCmd = isWindows ? "npx" : "npx";

const proc = spawn(npxCmd, ["--yes", "@mcp_router/cli@latest", "connect"], {
  stdio: "inherit",
  shell: isWindows,
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
