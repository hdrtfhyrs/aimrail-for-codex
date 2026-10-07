$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')
$ErrorActionPreference = 'Stop'
$taskInstallationRoot = (Get-PublicPath '$system/信息中心')
$taskPythonExecutable = (Get-PublicPath '$runtime/python/python.exe')
$taskLaunchPath = Join-Path $taskInstallationRoot 'app\launch.py'
$taskName = 'Codex-InformationCenter'
$taskUserName = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not (Test-Path -LiteralPath $taskPythonExecutable -PathType Leaf)) { throw '信息中心 Python 运行环境不可用。' }
if (-not (Test-Path -LiteralPath $taskLaunchPath -PathType Leaf)) { throw '信息中心入口文件不存在。' }
$taskExisting = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($taskExisting) {
    $taskExistingAction = $taskExisting.Actions | Select-Object -First 1
    if ($taskExistingAction.Arguments -notlike ('*' + $taskInstallationRoot + '*')) { throw '同名任务属于其他程序，未覆盖。' }
    $taskBackupPath = Join-Path $taskInstallationRoot ('data\backups\schedule-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.xml')
    Export-ScheduledTask -TaskName $taskName | Set-Content -LiteralPath $taskBackupPath -Encoding utf8
}
$taskAction = New-ScheduledTaskAction -Execute $taskPythonExecutable -Argument ('"' + $taskLaunchPath + '"') -WorkingDirectory $taskInstallationRoot
$taskPeriodicTrigger = New-ScheduledTaskTrigger -Daily -At '08:00'
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUserName -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger @($taskPeriodicTrigger) -Settings $taskSettings -Principal $taskPrincipal -Description '每天一次收集与处理；重点AI、计算机和系统自我更新，其他领域仅标题线索。' -Force | Out-Null
$taskRegistered = Get-ScheduledTask -TaskName $taskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
[PSCustomObject]@{ TaskName=$taskRegistered.TaskName; State=[string]$taskRegistered.State; User=$taskUserName; NextRunTime=$taskInfo.NextRunTime; Execute=$taskRegistered.Actions.Execute; Arguments=$taskRegistered.Actions.Arguments; StartWhenAvailable=$taskRegistered.Settings.StartWhenAvailable } | ConvertTo-Json -Depth 4
