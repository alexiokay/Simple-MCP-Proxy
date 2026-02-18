# setup.ps1 — one-time setup. No admin needed.
# Registers the Node.js tray to auto-start on login and launches it now.

$scriptDir = $PSScriptRoot
$trayScript = Join-Path $scriptDir "dist\tray.js"

# Find node.exe
$nodePath = (Get-Command node -ErrorAction Stop).Source

# 1. Registry Run key — most reliable auto-start on login
$runValue = "`"$nodePath`" `"$trayScript`""
Set-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
    -Name "MCPVectorProxyTray" -Value $runValue
Write-Host "Auto-start registered." -ForegroundColor Green

# 2. Kill any old tray instance
Get-WmiObject Win32_Process | Where-Object {
    $_.CommandLine -like "*dist*tray.js*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

# 3. Launch now (detached, no window)
Start-Process $nodePath -ArgumentList "`"$trayScript`"" -WindowStyle Hidden
Write-Host "Tray launched." -ForegroundColor Green
Start-Sleep 4

# 4. Pin to taskbar (not hidden in overflow)
$pinned = $false
Get-ChildItem "HKCU:\Control Panel\NotifyIconSettings" -ErrorAction SilentlyContinue | ForEach-Object {
    $v = Get-ItemProperty $_.PSPath
    if ($v.ExecutablePath -like "*node*") {
        Set-ItemProperty $_.PSPath -Name "IsPromoted" -Value 1
        $pinned = $true
    }
}
if ($pinned) {
    Write-Host "Icon pinned to taskbar." -ForegroundColor Green
} else {
    Write-Host "Tip: click the ^ in your taskbar, find MCP Proxy, right-click -> 'Always show'." -ForegroundColor Yellow
}

# 5. Compile MCP-Proxy.exe launcher
$makeExe = Join-Path $scriptDir "make-exe.ps1"
if (Test-Path $makeExe) {
    & $makeExe
}

Write-Host ""
Write-Host "Done! The tray will auto-start on every login." -ForegroundColor Cyan
Write-Host "You can also double-click MCP-Proxy.exe to start it manually." -ForegroundColor Cyan
