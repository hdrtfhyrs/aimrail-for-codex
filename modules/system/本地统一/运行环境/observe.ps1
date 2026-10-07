$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$names=@('python','python3','py','conda','uv','node','npm','pnpm','git','rg','pwsh','powershell','ollama','gh','gemini','claude','codex','docker','ffmpeg','ssh')
$commands=@(foreach($name in $names){
  foreach($item in @(Get-Command $name -All -ErrorAction SilentlyContinue)){
    if($item.Source -and (Test-Path -LiteralPath $item.Source -PathType Leaf)){
      [pscustomobject]@{name=$name;path=$item.Source;type=[string]$item.CommandType}
    }
  }
})
$errors=@()
$processes=@()
try{$processes=@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='name';e={$_.Name}},@{n='executable';e={$_.ExecutablePath}})}catch{$errors+='process_observation_failed'}
$tcp=@()
try{$tcp=@(Get-NetTCPConnection -State Listen | Select-Object @{n='address';e={$_.LocalAddress}},@{n='port';e={$_.LocalPort}},@{n='pid';e={$_.OwningProcess}})}catch{$errors+='tcp_observation_failed'}
$udp=@()
try{$udp=@(Get-NetUDPEndpoint | Select-Object @{n='address';e={$_.LocalAddress}},@{n='port';e={$_.LocalPort}},@{n='pid';e={$_.OwningProcess}})}catch{$errors+='udp_observation_failed'}
[ordered]@{at=[DateTimeOffset]::UtcNow.ToString('o');commands=$commands;requestedCommands=$names;processes=$processes;tcp=$tcp;udp=$udp;errors=$errors;scope='Only PID/name/executable and local socket metadata; no command lines or environment variable dumps.'} | ConvertTo-Json -Depth 8
