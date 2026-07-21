# setup.ps1 - one-time setup. No admin needed.
# Pre-installs the MCP Router CLI, bakes the absolute node path, registers a
# Task Scheduler entry for auto-start on login (with retry-on-failure), and
# launches the tray now.

$scriptDir  = $PSScriptRoot
$trayScript = Join-Path $scriptDir "dist\tray.js"
$taskName   = "MCPVectorProxyTray"
$ErrorActionPreference = "Stop"

# -- node.exe path ------------------------------------------------------------
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (-not $nodePath) { throw "node.exe not found on PATH. Install Node.js 18+ first." }

# -- 1. Pre-install MCP Router CLI locally so boot doesn't hit the npm registry
$cliDir = Join-Path $scriptDir "node_modules\@mcp_router\cli"
if (-not (Test-Path $cliDir)) {
    Write-Host "Installing @mcp_router/cli locally (one-time)..." -ForegroundColor Cyan
    npm install --no-save "@mcp_router/cli@latest" | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "MCP Router CLI cached locally - boot is now offline." -ForegroundColor Green
    } else {
        Write-Host "Warning: could not pre-install @mcp_router/cli. Boot will use the network." -ForegroundColor Yellow
    }
}

# -- 2. Bake absolute node.exe path -------------------------------------------
# Windows Run-key/Task-Scheduler processes start with a stripped PATH that
# doesn't include nvm/volta/fnm shims - bake the resolved path here so tray
# can launch node and propagate to launch-router.ts (which needs npx).
$nodePathFile = Join-Path $scriptDir ".node-path"
Set-Content -Path $nodePathFile -Value $nodePath -Encoding ascii -NoNewline
Write-Host "Baked node path -> $nodePath" -ForegroundColor Green

# -- 3. Migrate HKCU Run key to Task Scheduler --------------------------------
# Task Scheduler is more reliable than the Run key: supports delay, retry on
# failure, and runs even after PIN/biometric resume (the Run key is flaky there).

# Remove any previous Run-key entry (legacy from older setup.ps1 versions).
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
if (Get-ItemProperty -Path $runKey -Name $taskName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $runKey -Name $taskName -ErrorAction SilentlyContinue
    Write-Host "Removed legacy HKCU Run entry." -ForegroundColor DarkGray
}

# Build the scheduled task. Runs as current user, only when logged on - no UAC.
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$trayScript`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trigger.Delay = "PT30S"  # wait 30s after logon so the network/profile is ready
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

# Register (overwrite if it already exists).
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null
Write-Host "Task Scheduler entry registered (AtLogon + 30s delay, retry on failure)." -ForegroundColor Green

# -- 4. Kill any old tray instance --------------------------------------------
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist*tray.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 1

# -- 5. Launch now (don't wait for the 30s logon trigger) ---------------------
Start-Process $nodePath -ArgumentList "`"$trayScript`"" -WindowStyle Hidden
Write-Host "Tray launched." -ForegroundColor Green
Start-Sleep 4

# -- 6. Pin to taskbar (not hidden in overflow) -------------------------------
# Windows 11 hides tray icons by default. Two strategies:
#   a) Set IsPromoted=1 in NotifyIconSettings registry (auto, requires icon to exist)
#   b) User drags the icon out of the overflow manually (instant, always works)
# Try (a) for both node-spawned (legacy) and mcp-tray-rs paths.
$pinned = $false
Get-ChildItem "HKCU:\Control Panel\NotifyIconSettings" -ErrorAction SilentlyContinue | ForEach-Object {
    $v = Get-ItemProperty $_.PSPath
    if ($v.ExecutablePath -like "*node*" -or $v.ExecutablePath -like "*mcp-tray*") {
        Set-ItemProperty $_.PSPath -Name "IsPromoted" -Value 1
        $pinned = $true
    }
}
if ($pinned) {
    Write-Host "Icon pinned to taskbar (registry)." -ForegroundColor Green
} else {
    Write-Host "Tip: click the ^ in your taskbar, drag the MCP Proxy icon to the taskbar to pin it." -ForegroundColor Yellow
}

# -- 7. Compile MCP-Proxy.exe launcher ----------------------------------------
$makeExe = Join-Path $scriptDir "make-exe.ps1"
if (Test-Path $makeExe) {
    & $makeExe
}

Write-Host "" -ForegroundColor Cyan
Write-Host "Done! Tray auto-starts 30s after each login via Task Scheduler." -ForegroundColor Cyan
Write-Host "Manual: double-click MCP-Proxy.exe, or run:" -ForegroundColor Cyan
Write-Host "  Start-ScheduledTask -TaskName '$taskName'" -ForegroundColor DarkGray
Write-Host "Uninstall:" -ForegroundColor Cyan
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false" -ForegroundColor DarkGray
