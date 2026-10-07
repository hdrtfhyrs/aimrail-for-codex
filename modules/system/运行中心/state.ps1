param([string]$RuntimeRoot=$PSScriptRoot,[string]$NodePath,[switch]$Brief)
$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')

$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'boot-recovery.ps1')
Set-RuntimeEncoding
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$names=@('Codex-InformationCenter','Codex-AISystem-Dashboard','Codex-AISystem-Startup','Codex-AISystem-Pulse')
$errors=@()
$rows=foreach($name in $names){
    $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if(-not $task){[pscustomobject]@{name=$name;enabled=$false;state='missing';resultMeaning='missing'};continue}
    $info=Get-ScheduledTaskInfo -TaskName $name
    $raw=[long]$info.LastTaskResult
    $meaning=switch($raw){0{'completed_success'}267008{'ready'}267009{'running'}267010{'disabled'}267011{'never_run'}267014{'terminated'}default{'nonzero_result'}}
    $owned=if($name -eq 'Codex-InformationCenter'){
        ([string]($task.Actions|Select-Object -First 1).Arguments).Replace('/','\').Contains((Join-Path (Split-Path -Parent $RuntimeRoot) '信息中心'))
    }else{Test-RuntimeTaskOwnership $task $RuntimeRoot ($name.Replace('Codex-AISystem-','').ToLowerInvariant())}
    [pscustomobject]@{name=$name;enabled=$task.Settings.Enabled;state=[string]$task.State;owned=$owned;
        lastExit=$(if($meaning -eq 'completed_success' -or $meaning -eq 'nonzero_result'){$raw}else{$null});
        lastTaskResult=$raw;resultHex=('0x{0:X8}' -f $raw);resultMeaning=$meaning;
        lastRun=$(if($info.LastRunTime.Year -gt 1900){$info.LastRunTime.ToString('o')});nextRun=$(if($info.NextRunTime -and $info.NextRunTime.Year -gt 1900){$info.NextRunTime.ToString('o')});
        startWhenAvailable=$task.Settings.StartWhenAvailable;multipleInstances=[string]$task.Settings.MultipleInstances;
        restartCount=$task.Settings.RestartCount;restartInterval=$task.Settings.RestartInterval}
}
$app=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {$_.ExecutablePath -like '*WindowsApps*OpenAI.Codex*'})
$dashboard=Get-RuntimeDashboard $RuntimeRoot
$receipts=[ordered]@{}
foreach($mode in @('startup','pulse','recover','dashboard')){
    try{$value=Read-RuntimeJson (Join-Path (Get-PublicPath '$data/system/运行中心') ('boot-recovery-'+$mode+'.json'));if($value){$receipts[$mode]=[pscustomobject]@{mode=$value.mode;status=$value.status;startedAt=$value.startedAt;endedAt=$value.endedAt;exitCode=$value.exitCode;errors=$value.errors}}}
    catch{$errors+=('Invalid '+$mode+' receipt: '+$_.Exception.Message)}
}
$inventory=$null
try{
    $native=Invoke-RuntimeNative (Resolve-RuntimeNode $NodePath) @((Join-Path $PSScriptRoot 'boot-recovery.mjs'),'inventory','--runtime-root',$RuntimeRoot) $RuntimeRoot 30
    if($native.exitCode -ne 0 -or -not $native.data){$errors+='Recovery inventory unavailable.'}
    $inventory=$native.data
}catch{$errors+=$_.Exception.Message}
$lastRecovery=@($receipts.Values | Where-Object {$_.mode -in @('startup','recover')} | Sort-Object startedAt -Descending | Select-Object -First 1)
$lastPulse=@($receipts.Values | Where-Object {$_.mode -eq 'pulse'} | Sort-Object startedAt -Descending | Select-Object -First 1)
$failedReceipts=@(@($lastRecovery)+@($lastPulse)|Where-Object {$_.status -in @('failed','partial')})
$health=if($errors.Count -or -not $dashboard.healthy -or $inventory.errors.Count -or ($inventory.storage.latest -and -not $inventory.storage.latest.archiveExists) -or $failedReceipts.Count -or $inventory.dispatch.counts.failed -or @($rows|Where-Object {-not $_.enabled -or -not $_.owned -or $_.state -eq 'missing' -or $_.resultMeaning -eq 'nonzero_result'}).Count){'needs_attention'}else{'ready'}
$result=[ordered]@{checkedAt=[datetimeoffset]::Now.ToString('o');health=$health;tasks=@($rows);codexAppRunning=($app.Count -gt 0);dashboard=$dashboard;recoveryReceipts=$receipts;recovery=$inventory;errors=$errors;
    boundaries=@('True login/logoff and powered-off cloud execution require their own evidence.','Active native chats remain with their owners; Windows inventory does not wake them.','Pending backlog is preserved; no model heartbeat or repeated historical replay.')}
if($Brief){$result.recovery=[pscustomobject]@{taskWindowsUnfinished=@($inventory.bridge.unfinished).Count;dispatchUnfinished=@($inventory.dispatch.unfinished).Count;dispatchDue=$inventory.dispatch.due;reportsPending=$inventory.dispatch.reportsPending;modelPending=$inventory.information.modelPending;pendingUploads=@($inventory.storage.pendingUploads).Count;archiveExists=$inventory.storage.latest.archiveExists;startupSnapshotCurrent=$inventory.storage.startupCoverage.current}}
$result | ConvertTo-Json -Depth 25
