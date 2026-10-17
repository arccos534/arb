param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\')
$dataDirectory = Join-Path $projectRoot 'data'
$entrypoint = Join-Path $projectRoot 'dist\server.js'
$exampleFile = Join-Path $projectRoot '.env.example'
$environmentFile = Join-Path $projectRoot '.env'
$archiveRoot = Join-Path $projectRoot 'archives'
$archiveDirectory = Join-Path $archiveRoot ('reset-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))

foreach ($targetPath in @($dataDirectory, $archiveDirectory)) {
    $resolvedTarget = [System.IO.Path]::GetFullPath($targetPath)
    if (-not $resolvedTarget.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Reset path is outside the project.' }
}
if (-not (Test-Path -LiteralPath $exampleFile)) { throw 'Missing .env.example; nothing was reset.' }
if ((Test-Path -LiteralPath $dataDirectory) -and (Get-Item -LiteralPath $dataDirectory).LinkType) { throw 'Reset refuses linked data directories.' }

# Build before stopping or moving any state. A failed build leaves the session intact.
Push-Location -LiteralPath $projectRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed; nothing was reset.' }
} finally { Pop-Location }

$processFile = Join-Path $dataDirectory 'local-process.json'
if (Test-Path -LiteralPath $processFile) {
    $record = Get-Content -LiteralPath $processFile -Raw | ConvertFrom-Json
    $instance = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
    if ($instance -and $instance.Name -eq 'node.exe' -and $instance.CommandLine.Contains($entrypoint)) {
        [System.IO.File]::WriteAllText((Join-Path $dataDirectory 'stop-request.txt'), [string]$record.pid)
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        do {
            Start-Sleep -Milliseconds 250
            $instance = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$record.pid)"
        } while ($instance -and [DateTime]::UtcNow -lt $deadline)
        if ($instance) { throw 'App has not stopped. Nothing was archived or reset. Retry after it exits.' }
    }
}
# A manually launched instance also owns this lock; never move its active files.
foreach ($lockName in @('mvp-process.json')) {
    $candidateLock = Join-Path $dataDirectory $lockName
    if (Test-Path -LiteralPath $candidateLock) {
        $lockState = Get-Content -LiteralPath $candidateLock -Raw | ConvertFrom-Json
        if (Get-Process -Id ([int]$lockState.pid) -ErrorAction SilentlyContinue) { throw 'An app still owns the data directory. Stop it before resetting.' }
    }
}
$otherInstances = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entrypoint) }
if ($otherInstances) { throw 'A manually started project instance is still running. Stop it before resetting.' }

New-Item -ItemType Directory -Path $archiveDirectory -Force | Out-Null
if (Test-Path -LiteralPath $environmentFile) { Copy-Item -LiteralPath $environmentFile -Destination (Join-Path $archiveDirectory '.env.previous') }
if (Test-Path -LiteralPath $dataDirectory) { Move-Item -LiteralPath $dataDirectory -Destination (Join-Path $archiveDirectory 'data') }
Copy-Item -LiteralPath $exampleFile -Destination $environmentFile -Force
$resetMetadata = @{ at = [DateTime]::UtcNow.ToString('o'); kind = 'full-local-paper-reset'; previousData = 'data'; previousEnvironment = '.env.previous'; defaults = '.env.example + paperSettingsSchema'; paperOnly = $true } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $archiveDirectory 'reset-info.json'), $resetMetadata, [System.Text.UTF8Encoding]::new($false))
Write-Output "Previous sessions, settings and logs archived: $archiveDirectory"
Write-Output 'Defaults restored. A fresh session starts with USD 100 per venue and trading paused.'
if (-not $NoStart) { & (Join-Path $PSScriptRoot 'start-local.ps1') }
