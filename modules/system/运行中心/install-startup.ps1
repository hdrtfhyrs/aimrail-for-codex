param([string]$NodePath,[switch]$NoStart,[switch]$Plan,[switch]$EnableLogon)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'boot-recovery.ps1')
Set-RuntimeEncoding
$runtimeRoot=$PSScriptRoot
$runtimeNode=Resolve-RuntimeNode $NodePath
$runtimePwsh=(Get-Process -Id $PID).Path
if([IO.Path]::GetFileName($runtimePwsh) -ne 'pwsh.exe'){throw 'Run installation in PowerShell 7 (pwsh.exe); boot uses ProcessStartInfo.ArgumentList.'}
$runtimeUser=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$login=New-ScheduledTaskTrigger -AtLogOn -User $runtimeUser
$login.Delay='PT40S'
$bootLogin=New-ScheduledTaskTrigger -AtLogOn -User $runtimeUser
$bootLogin.Delay='PT3M'
$daily=New-ScheduledTaskTrigger -Daily -At '08:25'
$principal=New-ScheduledTaskPrincipal -UserId $runtimeUser -LogonType Interactive -RunLevel Limited
$jobs=@(
    @{name='Codex-AISystem-Dashboard';mode='dashboard';triggers=$(if($EnableLogon){@($login)}else{@()})},
    @{name='Codex-AISystem-Startup';mode='startup';triggers=$(if($EnableLogon){@($bootLogin)}else{@()})},
    @{name='Codex-AISystem-Pulse';mode='pulse';triggers=@($daily)}
)
# Check all names before any mutation. Existing unrelated or disabled jobs stay so.
foreach($job in $jobs){
    $job.old=Get-ScheduledTask -TaskName $job.name -ErrorAction SilentlyContinue
    if($job.old -and -not (Test-RuntimeTaskOwnership $job.old $runtimeRoot $job.mode)){throw ('Task name belongs to a different action; preserved: '+$job.name)}
    $job.action=New-ScheduledTaskAction -Execute $runtimePwsh -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -File "'+(Join-Path $runtimeRoot 'boot.ps1')+'" -Mode '+$job.mode+' -NodePath "'+$runtimeNode+'" -Quiet') -WorkingDirectory $runtimeRoot
}
if($Plan){$jobs|ForEach-Object{[pscustomobject]@{name=$_.name;mode=$_.mode;exists=[bool]$_.old;execute=$_.action.Execute;arguments=$_.action.Arguments;preserveRunning=$true}}|ConvertTo-Json -Depth 5;exit 0}
$backupDir=Join-Path $runtimeRoot 'backups'
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$changes=@()
foreach($job in $jobs){
    if($job.old){Export-ScheduledTask -TaskName $job.name | Set-Content -LiteralPath (Join-Path $backupDir ($job.name+'-'+(Get-Date -Format 'yyyyMMddHHmmssfff')+'.xml')) -Encoding UTF8}
    $jobSettings=if($job.old -and -not $job.old.Settings.Enabled){New-ScheduledTaskSettingsSet -Disable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)}else{$settings}
    $registration=@{TaskName=$job.name;Action=$job.action;Settings=$jobSettings;Principal=$principal;Force=$true}
    if(@($job.triggers).Count){$registration.Trigger=$job.triggers}
    Register-ScheduledTask @registration | Out-Null
    $changes+=[pscustomobject]@{name=$job.name;mode=$job.mode;enabled=$jobSettings.Enabled;previouslyRunning=([string]$job.old.State -eq 'Running')}
}
if($EnableLogon -and -not $NoStart){
    $probe=Get-RuntimeDashboard $runtimeRoot
    if($probe.status -eq 'missing'){
        $task=Get-ScheduledTask -TaskName 'Codex-AISystem-Dashboard'
        if($task.Settings.Enabled -and [string]$task.State -ne 'Running'){Start-ScheduledTask -TaskName $task.TaskName}
    }
}
[pscustomobject]@{status='registered';tasks=$changes;runningProcessesPreserved=$true;startupTriggered=$false;note='Default is on-demand; logon triggers require explicit EnableLogon. Existing dashboard retained until exit or next logon; installation does not replay information/models.'}|ConvertTo-Json -Depth 6
