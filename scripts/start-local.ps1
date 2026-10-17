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
$processArguments = @(('"' + $entrypoint + '"'))
$child = Start-Process -FilePath $nodeExecutable -ArgumentList $processArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDirectory 'observer.stdout.log') -RedirectStandardError (Join-Path $dataDirectory 'observer.stderr.log') -PassThru
@{ pid = $child.Id; startedAt = [DateTime]::UtcNow.ToString('o'); entrypoint = $entrypoint } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
Write-Output "Local MVP started, PID $($child.Id). Open http://127.0.0.1:4317 . Logs: data\observer.stdout.log and data\observer.stderr.log."
