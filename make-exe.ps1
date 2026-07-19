# make-exe.ps1 - Compile MCP-Proxy.exe using .NET built into Windows.
# No Go, no external tools. Just PowerShell + .NET (always available on Win 10/11).
# Result: a double-clickable MCP-Proxy.exe that starts the tray silently.
#
# The compiled exe reads .node-path (written by setup.ps1) at runtime so it
# keeps working after Node upgrades - no PATH dependency at double-click time.

$scriptDir = $PSScriptRoot
$outExe    = Join-Path $scriptDir "MCP-Proxy.exe"

$src = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

class Launcher {
    [STAThread]
    static void Main() {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string js  = Path.Combine(dir, "dist", "tray.js");

        if (!File.Exists(js)) {
            System.Windows.Forms.MessageBox.Show(
                "dist\\tray.js not found.\nRun: npm run build",
                "MCP Proxy",
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            return;
        }

        // Prefer baked absolute path (survives PATH stripping at cold boot).
        string nodePath = null;
        string nodePathFile = Path.Combine(dir, ".node-path");
        if (File.Exists(nodePathFile)) {
            nodePath = File.ReadAllText(nodePathFile).Trim();
            if (!File.Exists(nodePath)) nodePath = null;
        }
        if (nodePath == null) nodePath = "node"; // fall back to PATH

        Process.Start(new ProcessStartInfo {
            FileName         = nodePath,
            Arguments        = "\"" + js + "\"",
            WorkingDirectory = dir,
            UseShellExecute  = false,
            CreateNoWindow   = true
        });
    }
}
"@

Add-Type `
    -TypeDefinition  $src `
    -OutputAssembly  $outExe `
    -OutputType      WindowsApplication `
    -ReferencedAssemblies "System.Windows.Forms"

Write-Host "Created: $outExe" -ForegroundColor Green
Write-Host "Double-click MCP-Proxy.exe to start the tray." -ForegroundColor Cyan
