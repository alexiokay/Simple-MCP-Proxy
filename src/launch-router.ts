/**
 * Spawns the MCP Router CLI with windowsHide:true (no cmd flash on Windows).
 * Used by StdioClientTransport as: command="node", args=["dist/launch-router.js"]
 *
 * Uses --offline after the first install so boot doesn't depend on the npm
 * registry being reachable. Pin CLI_VERSION for reproducibility — bump
 * intentionally via setup.ps1, not automatically.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === "win32";

// Pin the MCP Router CLI version. Update setup.ps1 when bumping.
const CLI_PKG = "@mcp_router/cli";
const CLI_VERSION = "latest"; // change to a specific version (e.g. "1.2.0") once known

// Detect whether the CLI is installed locally so we can skip the registry.
const localPkgDir = path.join(__dirname, "../node_modules", CLI_PKG);
const hasLocalInstall = existsSync(localPkgDir);

const args = hasLocalInstall
  ? ["--offline", "--yes", `${CLI_PKG}@${CLI_VERSION}`, "connect"]
  : ["--yes", `${CLI_PKG}@${CLI_VERSION}`, "connect"];

if (!hasLocalInstall) {
  process.stderr.write(
    `[launch-router] ${CLI_PKG} not in node_modules — falling back to npx with network. ` +
    `Run "npm install ${CLI_PKG}" to enable offline boot.\n`
  );
}

const proc = spawn("npx", args, {
  stdio: "inherit",
  shell: IS_WINDOWS,       // npx is a .cmd on Windows — needs cmd.exe
  windowsHide: true,
  detached: !IS_WINDOWS,   // Unix: create process group so kill(-pid) works
});

/**
 * Kill the entire process tree.
 * Windows: taskkill /F /T kills the subtree by PID.
 * Unix: kill the process group so all children die with the parent.
 */
function killTree(): void {
  if (!proc.pid) return;

  if (IS_WINDOWS) {
    spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], {
      shell: false,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill();
    }
  }
}

process.on("SIGTERM", () => { killTree(); process.exit(0); });
process.on("SIGINT", () => { killTree(); process.exit(0); });
process.on("exit", () => { killTree(); });

proc.on("exit", (code) => process.exit(code ?? 0));
proc.on("error", (e) => { process.stderr.write(`launch-router error: ${e}\n`); process.exit(1); });
