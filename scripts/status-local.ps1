$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectRoot 'data'
$stateFile = Join-Path $dataDirectory 'local-process.json'
if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)"
    $running = $existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains([string]$state.entrypoint)
    Write-Output "Running: $([bool]$running), recorded PID: $($state.pid). UI: http://127.0.0.1:4317"
} else { Write-Output 'No background observer process recorded.' }
$healthFile = Join-Path $dataDirectory 'health-latest.json'
if (Test-Path -LiteralPath $healthFile) {
    $health = Get-Content -LiteralPath $healthFile -Raw | ConvertFrom-Json
    $health | Select-Object at,pid,ready,phase,cycles,discoveredPairs,watchedPairs,rejected,researchPositive,researchNegative,memoryRssMb | Format-List
} else { Write-Output 'No health report yet; initial discovery can take about a minute.' }
