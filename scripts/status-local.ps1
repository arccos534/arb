$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectRoot 'data'
$stateFile = Join-Path $dataDirectory 'local-process.json'
if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)"
    $running = $existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains([string]$state.entrypoint)
    Write-Output "Running: $([bool]$running), recorded PID: $($state.pid). UI: http://127.0.0.1:4317"
    if ($state.dataDirectory) { $dataDirectory = [string]$state.dataDirectory }
} else { Write-Output 'No background observer process recorded.' }
try {
    $live = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 3
    Write-Output "HTTP healthy: $($live.ok). Paper only: $($live.paperOnly). PID: $($live.pid)"
    Write-Output "Live entries running: $($live.sessions.live.running). Catalogue ready: $($live.feed.ready). Pairs: $($live.feed.discoveredPairs)."
    Write-Output "WS connected: Polymarket=$($live.feed.streams.polymarket.connected), Limitless=$($live.feed.streams.limitless.connected)"
    if ($live.observerError -or $live.auditError) { Write-Output "Observer error: $($live.observerError). Audit error: $($live.auditError)" }
} catch { Write-Output 'HTTP is not available on port 4317.' }
$healthFile = Join-Path $dataDirectory 'health-latest.json'
if (Test-Path -LiteralPath $healthFile) {
    $health = Get-Content -LiteralPath $healthFile -Raw | ConvertFrom-Json
    $health | Select-Object at,pid,ready,phase,cycles,discoveredPairs,watchedPairs,rejected,researchPositive,researchNegative,memoryRssMb | Format-List
} else { Write-Output 'No health report yet; initial discovery can take about a minute.' }
