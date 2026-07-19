# restart-tray.ps1 - kills and restarts the Node.js tray process.
# Uses the baked .node-path if present (so PATH stripping at cold boot
# doesn't break the restart).

$scriptDir  = $PSScriptRoot
$trayScript = Join-Path $scriptDir "dist\tray.js"

# Resolve node.exe: prefer baked path, fall back to PATH.
$nodePathFile = Join-Path $scriptDir ".node-path"
$nodePath = $null
if (Test-Path $nodePathFile) {
    $candidate = (Get-Content $nodePathFile -Raw).Trim()
    if ($candidate -and (Test-Path $candidate)) { $nodePath = $candidate }
}
if (-not $nodePath) { $nodePath = (Get-Command node -ErrorAction Stop).Source }

# Kill existing tray instance (use CIM - works on managed work machines).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist*tray.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

# Relaunch
Start-Process $nodePath -ArgumentList "`"$trayScript`"" -WindowStyle Hidden
Write-Host "Tray restarted via $nodePath" -ForegroundColor Green
