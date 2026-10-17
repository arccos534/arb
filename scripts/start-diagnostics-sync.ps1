$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$syncScript = Join-Path $PSScriptRoot 'sync-diagnostics.mjs'
$syncDirectory = Join-Path $projectRoot 'data\diagnostics'
$syncConfig = Join-Path $syncDirectory 'sync-config.json'
$syncState = Join-Path $syncDirectory 'sync-process.json'
if (-not (Test-Path -LiteralPath $syncConfig)) { return }
if (Test-Path -LiteralPath $syncState) {
    $previous = Get-Content -LiteralPath $syncState -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$previous.pid)"
    if ($existing -and $existing.Name -eq 'node.exe' -and $existing.CommandLine.Contains($syncScript)) { return }
}
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$arguments = @(('"' + $syncScript + '"'), ('"' + $syncConfig + '"'))
$child = Start-Process -FilePath $nodeExecutable -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $syncDirectory 'sync.stdout.log') -RedirectStandardError (Join-Path $syncDirectory 'sync.stderr.log') -PassThru
@{pid=$child.Id;startedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $syncState -Encoding UTF8
