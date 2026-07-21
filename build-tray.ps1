# build-tray.ps1 - Build the Rust tray binary for the current Windows arch
# and copy it to dist/tray/.
#
# For cross-compile to other targets (ARM64, macOS, Linux), see the README
# or use `cargo build --target <target>` manually.

$ErrorActionPreference = "Stop"
$scriptDir = $PSScriptRoot
$cargoProj = Join-Path $scriptDir "tray-rs"
$outDir = Join-Path $scriptDir "dist\tray"

if (-not (Test-Path (Join-Path $cargoProj "Cargo.toml"))) {
    Write-Host "No tray-rs/ directory found - skipping Rust tray build." -ForegroundColor Yellow
    exit 0
}

Write-Host "Building Rust tray (release)..." -ForegroundColor Cyan
Push-Location $cargoProj
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
} finally {
    Pop-Location
}

# Detect arch from the built target directory
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") {
    "arm64"
} else {
    "x64"
}

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$dest = Join-Path $outDir "mcp-tray-win-$arch.exe"
$src = Join-Path $cargoProj "target\release\mcp-tray.exe"
Copy-Item -Path $src -Destination $dest -Force
Write-Host "Tray binary: $dest" -ForegroundColor Green
