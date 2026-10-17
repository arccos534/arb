$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$entrypoint = Join-Path $projectRoot 'dist\server.js'
$dataDirectory = Join-Path $projectRoot 'data'
$stateFile = Join-Path $dataDirectory 'local-process.json'
if (-not (Test-Path -LiteralPath $entrypoint)) { throw 'Run npm.cmd ci and npm.cmd run build first.' }
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
& (Join-Path $PSScriptRoot 'start-diagnostics-sync.ps1')
if (Test-Path -LiteralPath $stateFile) {
    $previous = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($previous.pid)"
    if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains($entrypoint)) {
        Write-Output "MVP already running, PID $($previous.pid). Open http://127.0.0.1:4317"
        exit 0
    }
}
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodeExecutable --version
if ($nodeVersion -notmatch '^v24\.') { throw "Node.js 24 is required. Found $nodeVersion" }
try {
    $other = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 2
    if ($other) { throw 'PORT_ALREADY_IN_USE' }
} catch {
    if ($_.Exception.Message -eq 'PORT_ALREADY_IN_USE') { throw 'Port 4317 is already serving an application. Keep that process running; check its project folder before starting another copy.' }
}
$processArguments = @(('"' + $entrypoint + '"'))
$oldProfiling = $env:EXECUTION_PROFILE
try {
    if (-not $env:EXECUTION_PROFILE) { $env:EXECUTION_PROFILE = 'true' }
    $child = Start-Process -FilePath $nodeExecutable -ArgumentList $processArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'observer.stdout.log') -RedirectStandardError (Join-Path $dataDirectory 'observer.stderr.log') -PassThru
} finally { $env:EXECUTION_PROFILE = $oldProfiling }
@{ pid = $child.Id; startedAt = [DateTime]::UtcNow.ToString('o'); entrypoint = $entrypoint } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if ($child.HasExited) { throw "Server exited with code $($child.ExitCode). Check data\observer.stderr.log." }
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/health' -TimeoutSec 1
        if ($health.ok -and $health.pid -eq $child.Id) {
            @{ pid = $child.Id; startedAt = [DateTime]::UtcNow.ToString('o'); entrypoint = $entrypoint; dataDirectory = $health.dataDir } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
            Write-Output "Local MVP started, PID $($child.Id). Open http://127.0.0.1:4317 . Quotes collect in background; virtual entries remain paused."
            exit 0
        }
    } catch { }
    Start-Sleep -Milliseconds 200
}
throw 'Server did not report healthy startup. Check data\observer.stderr.log and status-local.ps1.'
