# make-exe.ps1 - Compile MCP-Proxy.exe using csc.exe (C# compiler).
# Works in both Windows PowerShell 5.1 and PowerShell 7+.
# Result: a double-clickable MCP-Proxy.exe that starts the tray silently.
#
# The compiled exe reads .node-path (written by setup.ps1) at runtime so it
# keeps working after Node upgrades - no PATH dependency at double-click time.

$scriptDir = $PSScriptRoot
$outExe    = Join-Path $scriptDir "MCP-Proxy.exe"
$srcFile   = Join-Path $env:TEMP "mcp-proxy-launcher.cs"

$src = @"
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

internal static class Launcher {
    [STAThread]
    private static int Main() {
        string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string js  = Path.Combine(dir, "dist", "tray.js");

        if (!File.Exists(js)) {
            MessageBox.Show(
                "dist\\tray.js not found.\nRun: npm run build",
                "MCP Proxy",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        string nodePath = null;
        string nodePathFile = Path.Combine(dir, ".node-path");
        if (File.Exists(nodePathFile)) {
            nodePath = File.ReadAllText(nodePathFile).Trim();
            if (!File.Exists(nodePath)) nodePath = null;
        }
        if (nodePath == null) nodePath = "node";

        var psi = new ProcessStartInfo {
            FileName         = nodePath,
            Arguments        = "\"" + js + "\"",
            WorkingDirectory = dir,
            UseShellExecute  = false,
            CreateNoWindow   = true
        };
        Process.Start(psi);
        return 0;
    }
}
"@

# Write the C# source to a temp file
$src | Out-File -FilePath $srcFile -Encoding UTF8 -Force

# Find csc.exe - prefer .NET Framework (always available on Win10/11)
function Find-Csc {
    # 1. .NET Framework 64-bit
    $fwk = Get-ChildItem "C:\Windows\Microsoft.NET\Framework64" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($fwk) {
        $csc = Join-Path $fwk.FullName "csc.exe"
        if (Test-Path $csc) { return $csc }
    }
    # 2. .NET Framework 32-bit
    $fwk32 = Get-ChildItem "C:\Windows\Microsoft.NET\Framework" -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        Select-Object -First 1
    if ($fwk32) {
        $csc = Join-Path $fwk32.FullName "csc.exe"
        if (Test-Path $csc) { return $csc }
    }
    # 3. Roslyn via dotnet (if installed)
    $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($dotnet) { return $null }  # fall back to Add-Type below
    return $null
}

$csc = Find-Csc
if ($csc) {
    # Find System.Windows.Forms.dll for referencing
    $winFormsDll = Join-Path (Split-Path $csc -Parent) "System.Windows.Forms.dll"
    $refs = if (Test-Path $winFormsDll) { "/reference:$winFormsDll" } else { "" }
    # Compile to a Windows app (no console window on launch)
    & $csc /nologo /target:winexe /out:"$outExe" $refs "$srcFile"
    if ($LASTEXITCODE -ne 0) { throw "csc.exe failed with exit code $LASTEXITCODE" }
} else {
    # Fallback: Add-Type (works in PS 5.1, may fail in PS 7+)
    Add-Type `
        -TypeDefinition  $src `
        -OutputAssembly  $outExe `
        -OutputType      WindowsApplication `
        -ReferencedAssemblies "System.Windows.Forms"
}

Remove-Item $srcFile -ErrorAction SilentlyContinue
Write-Host "Created: $outExe" -ForegroundColor Green
Write-Host "Double-click MCP-Proxy.exe to start the tray." -ForegroundColor Cyan
