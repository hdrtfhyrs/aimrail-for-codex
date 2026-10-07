param(
    [ValidateSet('startup','pulse','dashboard','recover')][string]$Mode='startup',
    [string]$RuntimeRoot=$PSScriptRoot,
    [string]$NodePath,
    [ValidateRange(1024,65535)][int]$DashboardPort=8765,
    [ValidateRange(0,10)][int]$DashboardRetries=3,
    [switch]$SkipCodexLaunch,
    [switch]$Quiet
)
$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')

$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'boot-recovery.ps1')
Set-RuntimeEncoding
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$runtimeProject=Split-Path -Parent $RuntimeRoot
$runtimeSystem=Join-Path $RuntimeRoot 'system.mjs'
$receiptFile=Join-Path (Get-PublicPath '$data/system/运行中心') ('boot-recovery-'+$Mode+'.json')
$purpose=if($Mode -eq 'dashboard'){'dashboard'}else{'startup-and-snapshot'}
$mutex=Get-RuntimeMutex $RuntimeRoot $purpose
$acquired=$false; $exitCode=0
$receipt=[ordered]@{mode=$Mode;startedAt=[datetimeoffset]::Now.ToString('o');status='starting';pid=$PID;runtimeRoot=$RuntimeRoot;steps=[ordered]@{};errors=@()}
try {
    try{$acquired=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$acquired=$true}
    if(-not $acquired){if(-not $Quiet){[pscustomobject]@{mode=$Mode;status='already_running'} | ConvertTo-Json};exit 0}
    $runtimeNode=Resolve-RuntimeNode $NodePath
    if($Mode -eq 'dashboard') {
        $probe=Get-RuntimeDashboard $RuntimeRoot $DashboardPort
        $receipt.steps.existing=$probe
        if($probe.healthy){$receipt.status='already_running'}
        elseif($probe.status -ne 'missing'){throw ('Dashboard port is occupied/unhealthy; existing process preserved: '+$probe.status)}
        else {
            $receipt.steps.childFailures=@()
            for($attempt=0;$attempt -le $DashboardRetries;$attempt++){
                # A blocking wait reacts to child exit; no heartbeat/polling/model.
                $receipt.status='running';$receipt.steps.attempt=$attempt+1;Write-RuntimeJson $receiptFile $receipt
                & $runtimeNode $runtimeSystem serve
                $exitCode=$LASTEXITCODE
                if($exitCode -eq 0){$exitCode=1}
                $receipt.steps.childFailures+=@{attempt=$attempt+1;exitCode=$exitCode;at=[datetimeoffset]::Now.ToString('o')}
                if($attempt -ge $DashboardRetries){break}
                $delay=[int][Math]::Min(30,5*[Math]::Pow(2,$attempt))
                $receipt.status='retrying';$receipt.steps.retryDelaySeconds=$delay;Write-RuntimeJson $receiptFile $receipt
                Start-Sleep -Seconds $delay
                $probe=Get-RuntimeDashboard $RuntimeRoot $DashboardPort
                if($probe.healthy){$receipt.status='already_running';$exitCode=0;break}
                if($probe.status -ne 'missing'){throw ('Dashboard retry found an occupied/unhealthy listener; preserved: '+$probe.status)}
            }
            if($exitCode -ne 0){throw ('Dashboard child exhausted retries; last code '+$exitCode)}
        }
    } else {
        if($Mode -in @('startup','recover')) {
            $probe=Get-RuntimeDashboard $RuntimeRoot $DashboardPort
            if(-not $probe.healthy) {
                if($probe.status -ne 'missing'){throw ('Existing dashboard listener is unhealthy or foreign; preserved: '+$probe.status)}
                $dashboardTask=Get-ScheduledTask -TaskName 'Codex-AISystem-Dashboard' -ErrorAction SilentlyContinue
                if(-not (Test-RuntimeTaskOwnership $dashboardTask $RuntimeRoot 'dashboard')){throw 'Dashboard task missing or not owned; run install-startup.ps1.'}
                if(-not $dashboardTask.Settings.Enabled){throw 'Dashboard task is disabled; preserved explicit disabled state.'}
                if([string]$dashboardTask.State -ne 'Running'){Start-ScheduledTask -TaskName $dashboardTask.TaskName}
                for($attempt=0;$attempt -lt 12;$attempt++){Start-Sleep -Milliseconds 500;$probe=Get-RuntimeDashboard $RuntimeRoot $DashboardPort;if($probe.healthy){break}}
                if(-not $probe.healthy){throw ('Dashboard did not become ready: '+$probe.status)}
            }
            $receipt.steps.dashboard=$probe
            if($Mode -eq 'startup' -and -not $SkipCodexLaunch) {
                $apps=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" | Where-Object {$_.ExecutablePath -like '*WindowsApps*OpenAI.Codex*'})
                if($apps.Count){$receipt.steps.codexApp='already_running'}
                else {
                    $package=Get-AppxPackage 'OpenAI.Codex' | Select-Object -First 1
                    if($package){Start-Process -FilePath explorer.exe -ArgumentList ('shell:AppsFolder\'+$package.PackageFamilyName+'!App') -WindowStyle Hidden;$receipt.steps.codexApp='launch_requested'}
                    else{$receipt.steps.codexApp='package_missing';$receipt.errors+= 'Codex package missing; app launch unavailable.'}
                }
            }else{$receipt.steps.codexApp='launch_skipped'}
        }
        $evidenceDirectory=Join-Path $RuntimeRoot 'boot-recovery-locks'
        $receipt.steps.locks=@(
            Repair-RuntimeLock (Join-Path $RuntimeRoot 'pulse.lock') $runtimeSystem $evidenceDirectory
            Repair-RuntimeLock (Join-Path $runtimeProject '存储接入/snapshot.lock') (Join-Path $runtimeProject '存储接入/storage.py') $evidenceDirectory
        )
        $busy=@($receipt.steps.locks | Where-Object {$_.status -notin @('absent','stale_archived')})
        $command='pulse'
        if($Mode -eq 'startup'){
            $informationTask=Get-ScheduledTask -TaskName 'Codex-InformationCenter' -ErrorAction SilentlyContinue
            if($informationTask -and $informationTask.Settings.Enabled){$command='start';$receipt.steps.information='existing_daily_gate'}
            else{$receipt.steps.information='missing_or_disabled_preserved'}
        }
        if($busy.Count){
            $receipt.steps.snapshotDeferred='Existing lock preserved; snapshot is left to its owner or the next pulse.'
            if(@($busy|Where-Object {$_.status -ne 'active_preserved'}).Count){$receipt.errors+='Snapshot lock is ambiguous or invalid; inspect its exact path.'}
            # An existing snapshot writer does not block event recovery or the daily gate.
            if($command -eq 'start'){
                $runtimePwsh=(Get-Process -Id $PID).Path
                $receipt.steps.informationStart=Invoke-RuntimeNative $runtimePwsh @('-NoProfile','-NonInteractive','-File',(Join-Path $runtimeProject '信息中心/control.ps1'),'-Mode','start') $RuntimeRoot 30
                if($receipt.steps.informationStart.exitCode -ne 0){$receipt.errors+='Information daily start failed.'}
            }
        }else{
            $receipt.steps.runtime=Invoke-RuntimeNative $runtimeNode @($runtimeSystem,$command) $RuntimeRoot 240
            if($receipt.steps.runtime.exitCode -ne 0){$receipt.errors+=('Runtime '+$command+' failed with code '+$receipt.steps.runtime.exitCode)}
        }
        if($Mode -in @('startup','recover')) {
            $receipt.steps.events=Invoke-RuntimeNative $runtimeNode @((Join-Path $PSScriptRoot 'boot-recovery.mjs'),'resume','--runtime-root',$RuntimeRoot) $RuntimeRoot 1800
            if($receipt.steps.events.exitCode -ne 0){$receipt.errors+=('Persisted event recovery failed with code '+$receipt.steps.events.exitCode)}
        }
        $receipt.steps.inventory=Invoke-RuntimeNative $runtimeNode @((Join-Path $PSScriptRoot 'boot-recovery.mjs'),'inventory','--runtime-root',$RuntimeRoot) $RuntimeRoot 30
        if($receipt.steps.inventory.exitCode -ne 0){$receipt.errors+='Recovery inventory read failed.'}
        $receipt.status=if($receipt.errors.Count){'partial'}else{'completed'}
        if($receipt.errors.Count){$exitCode=2}
    }
} catch {
    $receipt.status='failed';$receipt.errors+=$_.Exception.Message
    if($exitCode -eq 0){$exitCode=1}
} finally {
    if($acquired){$receipt.endedAt=[datetimeoffset]::Now.ToString('o');$receipt.exitCode=$exitCode;Write-RuntimeJson $receiptFile $receipt;$mutex.ReleaseMutex()}
    $mutex.Dispose()
}
if(-not $Quiet){$receipt | ConvertTo-Json -Depth 30}
exit $exitCode
