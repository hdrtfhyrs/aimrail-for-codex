param(
    [ValidateSet('status','start','recover')][string]$Mode = 'status',
    [ValidateRange(0,8)][int]$Batches = 1,
    [ValidateRange(0,6)][int]$Research = 1
)
$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')

$ErrorActionPreference = 'Stop'
# Native Python JSON uses UTF-8. Background pwsh can inherit code page 936;
# its native-pipe decoder and stdout encoder must agree with Python and Node.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'
$informationRoot = $PSScriptRoot
$informationSettings = Get-Content -Raw -LiteralPath (Get-PublicPath '$data/system/信息中心/config/settings.json') -Encoding UTF8 | ConvertFrom-Json
$informationPython = $informationSettings.python_path
$informationOperations = Join-Path $informationRoot 'app/operations.py'
$informationTaskName = 'Codex-InformationCenter'
$informationTask = Get-ScheduledTask -TaskName $informationTaskName -ErrorAction SilentlyContinue
if ($informationTask -and ($informationTask.Actions | Select-Object -First 1).Arguments -notlike ('*' + $informationRoot + '*')) {
    throw '同名任务指向其他目录，未操作。'
}
if ($Mode -eq 'start') {
    if (-not $informationTask) { & (Join-Path $informationRoot 'install-schedule.ps1') | Out-Null }
    Enable-ScheduledTask -TaskName $informationTaskName | Out-Null
    Start-ScheduledTask -TaskName $informationTaskName
} elseif ($Mode -eq 'recover') {
    & $informationPython $informationOperations recover --batches $Batches --research $Research
    exit $LASTEXITCODE
}
$informationRuntimeRaw = & $informationPython $informationOperations status
if ($LASTEXITCODE -ne 0) { throw '信息中心状态读取失败。' }
$informationRuntime = ($informationRuntimeRaw -join "`n") | ConvertFrom-Json
$informationTask = Get-ScheduledTask -TaskName $informationTaskName -ErrorAction SilentlyContinue
$informationTaskInfo = if ($informationTask) { Get-ScheduledTaskInfo -TaskName $informationTaskName }
[PSCustomObject]@{
    checkedAt = $informationRuntime.checked_at
    enabled = [bool]($informationTask -and $informationTask.Settings.Enabled)
    running = [bool]($informationRuntime.running -or ($informationTask -and [string]$informationTask.State -eq 'Running'))
    taskState = if ($informationTask) { [string]$informationTask.State } else { 'missing' }
    lastExit = if ($informationTaskInfo) { $informationTaskInfo.LastTaskResult } else { $null }
    lastRun = if ($informationTaskInfo) { $informationTaskInfo.LastRunTime.ToString('o') } else { $null }
    nextRun = if ($informationTaskInfo) { $informationTaskInfo.NextRunTime.ToString('o') } else { $null }
    startWhenAvailable = [bool]($informationTask -and $informationTask.Settings.StartWhenAvailable)
    dailyRunDate = $informationRuntime.daily_run_date
    pipeline = $informationRuntime.last_pipeline
    recovery = $informationRuntime.last_recovery
    queue = $informationRuntime.queue
    sourcesEnabled = $informationRuntime.sources_enabled
    failedSources = $informationRuntime.failed_sources
    models = $informationRuntime.models
    reports = $informationRuntime.reports
} | ConvertTo-Json -Depth 14
