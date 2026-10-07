$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')
$ErrorActionPreference = 'Stop'
$taskName = 'Codex-InformationCenter'
$taskInstallationRoot = (Get-PublicPath '$system/信息中心')
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting) {
    if (($taskExisting.Actions | Select-Object -First 1).Arguments -notlike ('*' + $taskInstallationRoot + '*')) { throw '同名任务目标不对应，未调整。' }
    Disable-ScheduledTask -TaskName $taskName | Out-Null
    '信息中心定时任务已暂停；资料和配置完整保留。'
}
