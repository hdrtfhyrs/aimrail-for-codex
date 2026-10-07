$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')
# Functions shared by boot/state/install. No effects when dot-sourced.
function Set-RuntimeEncoding {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $script:OutputEncoding = [Console]::OutputEncoding
    $env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'
}
function Resolve-RuntimeNode([string]$NodePath) {
    if ($NodePath) { if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable missing: $NodePath" }; return [IO.Path]::GetFullPath($NodePath) }
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $fallback = (Get-PublicPath 'C:/Program Files/nodejs/node.exe')
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    throw 'Node executable unavailable. Run install-startup.ps1 with -NodePath ABS_EXE.'
}
function Write-RuntimeJson([string]$Path, $Value) {
    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temp = $Path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try { [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false)); [IO.File]::Move($temp, $Path, $true) }
    finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp } }
}
function Read-RuntimeJson([string]$Path) { if (Test-Path -LiteralPath $Path) { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } }
function Invoke-RuntimeNative([string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory, [int]$TimeoutSeconds=180) {
    $si = [Diagnostics.ProcessStartInfo]::new()
    $si.FileName=$Executable; $si.WorkingDirectory=$WorkingDirectory; $si.UseShellExecute=$false; $si.CreateNoWindow=$true
    $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true
    $si.StandardOutputEncoding=[Text.Encoding]::UTF8; $si.StandardErrorEncoding=[Text.Encoding]::UTF8
    foreach($argument in $Arguments) { $si.ArgumentList.Add($argument) }
    $si.Environment['PYTHONIOENCODING']='utf-8'; $si.Environment['PYTHONUTF8']='1'
    $proc=[Diagnostics.Process]::new(); $proc.StartInfo=$si
    try {
        if (-not $proc.Start()) { throw 'Failed to launch native child.' }
        $outTask=$proc.StandardOutput.ReadToEndAsync(); $errTask=$proc.StandardError.ReadToEndAsync()
        $timedOut=-not $proc.WaitForExit($TimeoutSeconds*1000)
        if($timedOut) { $proc.Kill($true); $proc.WaitForExit() }
        $stdout=$outTask.GetAwaiter().GetResult(); $stderr=$errTask.GetAwaiter().GetResult()
        $data=$null; try { $data=$stdout.Trim().TrimStart([char]0xFEFF) | ConvertFrom-Json -ErrorAction Stop } catch {}
        [pscustomobject]@{exitCode=$(if($timedOut){124}else{$proc.ExitCode});timedOut=$timedOut;data=$data;error=$stderr.Trim();raw=$(if($null -eq $data){$stdout}else{$null})}
    } finally { $proc.Dispose() }
}
function Get-RuntimeMutex([string]$Root,[string]$Purpose) {
    $bytes=[Text.Encoding]::UTF8.GetBytes(([IO.Path]::GetFullPath($Root).ToLowerInvariant())+'|'+$Purpose)
    $key=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).Substring(0,24)
    [Threading.Mutex]::new($false,('Local\CodexAIRuntime-'+$key))
}
function Test-RuntimeTaskOwnership($Task,[string]$Root,[string]$Mode) {
    if(-not $Task) { return $false }
    $actions=@($Task.Actions); if($actions.Count -ne 1){return $false}
    $action=$actions[0]; $argsText=([string]$action.Arguments).Replace('/','\').ToLowerInvariant()
    $rootFull=[IO.Path]::GetFullPath($Root).TrimEnd('\')
    $expected=(Join-Path $rootFull 'boot.ps1').ToLowerInvariant()
    $legacy=(Join-Path $rootFull 'system.mjs').ToLowerInvariant()
    $owned=($argsText.Contains('"'+$expected+'"') -and $argsText -match ('-mode\s+'+[regex]::Escape($Mode)+'(?:\s|$)'))
    if($Mode -eq 'dashboard'){$owned=$owned -or ($argsText.Contains('"'+$legacy+'"') -and $argsText -match '\sserve(?:\s|$)')}
    return $owned -and ([IO.Path]::GetFullPath([string]$action.WorkingDirectory).TrimEnd('\') -eq $rootFull)
}
function Get-RuntimeDashboard([string]$Root,[int]$Port=8765) {
    $expected=[IO.Path]::GetFullPath((Join-Path $Root 'system.mjs')).Replace('/','\').ToLowerInvariant()
    try {
        $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$Port+'/api/health') -TimeoutSec 2 -ErrorAction Stop
        if($health.service -ne 'ai-work-system-runtime-v1' -or -not $health.pid){return [pscustomobject]@{status='foreign_service';healthy=$false}}
        $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$health.pid) -ErrorAction Stop
        $cmd=([string]$owner.CommandLine).Replace('/','\').ToLowerInvariant()
        if(-not $owner -or $owner.Name -ne 'node.exe' -or $cmd -notmatch ('(?:^|\s|\")'+[regex]::Escape($expected)+'(?:\"|\s|$)') -or $cmd -notmatch '\sserve(?:\s|$)') {return [pscustomobject]@{status='foreign_process';healthy=$false;pid=$health.pid}}
        return [pscustomobject]@{status='healthy';healthy=$true;pid=[int]$health.pid;startedAt=$owner.CreationDate.ToString('o')}
    } catch {
        $listener=Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if($listener){return [pscustomobject]@{status='unhealthy_or_foreign_listener';healthy=$false;pid=$listener.OwningProcess}}
        return [pscustomobject]@{status='missing';healthy=$false}
    }
}
function Repair-RuntimeLock([string]$Path,[string]$ExpectedOwnerScript,[string]$EvidenceDirectory) {
    if(-not (Test-Path -LiteralPath $Path -PathType Leaf)){return [pscustomobject]@{path=$Path;status='absent'}}
    $handle=$null
    try {
        # Deny writes during inspection/move, but allow the atomic rename itself.
        $handle=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Delete)
        $reader=[IO.StreamReader]::new($handle,[Text.Encoding]::UTF8,$true,1024,$true)
        try{$record=$reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop}finally{$reader.Dispose()}
        if(-not $record.pid -or [int64]$record.pid -le 0){return [pscustomobject]@{path=$Path;status='unrecognized_preserved'}}
        $owner=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int64]$record.pid) -ErrorAction Stop
        $stamp=if($record.at){$record.at}elseif($record.started){$record.started}else{$null}
        $reused=$false
        if($owner -and $stamp){try{$reused=$owner.CreationDate.ToUniversalTime() -gt ([datetimeoffset]::Parse($stamp).UtcDateTime.AddSeconds(2))}catch{}}
        if($owner -and -not $reused){
            $ownerCmd=([string]$owner.CommandLine).Replace('/','\').ToLowerInvariant()
            $expected=[IO.Path]::GetFullPath($ExpectedOwnerScript).ToLowerInvariant()
            $status=if($ownerCmd.Contains($expected)){'active_preserved'}else{'ambiguous_pid_preserved'}
            return [pscustomobject]@{path=$Path;status=$status;pid=[int64]$record.pid}
        }
        [IO.Directory]::CreateDirectory($EvidenceDirectory) | Out-Null
        $destination=Join-Path $EvidenceDirectory ((Split-Path -Leaf $Path)+'.'+[guid]::NewGuid().ToString('N')+'.json')
        [IO.File]::Move([IO.Path]::GetFullPath($Path),[IO.Path]::GetFullPath($destination))
        return [pscustomobject]@{path=$Path;status='stale_archived';pid=[int64]$record.pid;reason=$(if($reused){'pid_reused'}else{'owner_exited'});evidence=$destination}
    } catch {return [pscustomobject]@{path=$Path;status='locked_or_invalid_preserved';error=$_.Exception.Message}}
    finally{if($handle){$handle.Dispose()}}
}
