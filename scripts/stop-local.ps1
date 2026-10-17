$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataDirectory = Join-Path $projectRoot 'data'
$stateFile = Join-Path $dataDirectory 'local-process.json'
if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output 'No local MVP process recorded.'; exit 0 }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($state.pid)"
if (-not $existing -or $existing.Name -ne 'node.exe' -or -not $existing.CommandLine.Contains([string]$state.entrypoint)) {
    Write-Output 'Recorded MVP is not running.'
    exit 0
}
if ($state.dataDirectory) { $dataDirectory = [string]$state.dataDirectory }
[System.IO.File]::WriteAllText((Join-Path $dataDirectory 'stop-request.txt'), [string]$state.pid)
Write-Output "Graceful stop requested for PID $($state.pid); it will finish the current request/cycle."
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue)) { Write-Output 'MVP stopped; sessions and history saved.'; exit 0 }
}
Write-Output 'Shutdown is still waiting for network operations. No forced termination was performed; run status-local.ps1 again.'
