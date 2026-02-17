# restart-tray.ps1 — kills and restarts the Node.js tray process
$scriptDir = $PSScriptRoot
$trayScript = Join-Path $scriptDir "dist\tray.js"
$nodePath = (Get-Command node -ErrorAction Stop).Source

# Kill existing tray instance
Get-WmiObject Win32_Process | Where-Object {
    $_.CommandLine -like "*dist*tray.js*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

# Relaunch
Start-Process $nodePath -ArgumentList "`"$trayScript`"" -WindowStyle Hidden
Write-Host "Tray restarted." -ForegroundColor Green
