param([switch]$Discover)
$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class OriginalAppToolProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateFile(string name,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint processId);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$taskExpected = Join-Path ((Get-AppxPackage 'OpenAI.Codex' | Select-Object -First 1).InstallLocation) 'app/ChatGPT.exe'
if ($Discover) {
 $taskPipe = $null
 foreach ($taskCandidate in @(Get-ChildItem -LiteralPath '\\.\pipe\' | Where-Object Name -Like 'codex-browser-use-*')) {
  $taskCandidatePath='\\.\pipe\'+$taskCandidate.Name
  $taskCandidateHandle=[OriginalAppToolProbe]::CreateFile($taskCandidatePath,0,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
  if($taskCandidateHandle -eq [IntPtr]::new(-1)){continue}
  try{[uint32]$taskCandidateId=0;if([OriginalAppToolProbe]::GetNamedPipeServerProcessId($taskCandidateHandle,[ref]$taskCandidateId)){$taskCandidateProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$taskCandidateId";if($taskCandidateProcess.ExecutablePath -eq $taskExpected){$taskPipe=$taskCandidatePath;break}}}finally{[void][OriginalAppToolProbe]::CloseHandle($taskCandidateHandle)}
 }
} else { $taskPipe = $env:CODEX_APP_TOOLS_PIPE_PATH }
if (-not $taskPipe) { throw 'Current original app tool pipe unavailable; no GUI start requested' }
$taskHandle = [OriginalAppToolProbe]::CreateFile($taskPipe,0,3,[IntPtr]::Zero,3,0,[IntPtr]::Zero)
if ($taskHandle -eq [IntPtr]::new(-1)) { throw 'Cannot inspect current app tool pipe' }
try {
 [uint32]$taskServerId = 0
 if (-not [OriginalAppToolProbe]::GetNamedPipeServerProcessId($taskHandle,[ref]$taskServerId)) { throw 'Cannot identify current app pipe owner' }
 $taskServer = Get-CimInstance Win32_Process -Filter "ProcessId=$taskServerId"
 $taskOriginal = $taskServer.ExecutablePath -eq $taskExpected
 $taskResult = [pscustomobject]@{ at=[DateTime]::UtcNow.ToString('o'); pipe=$taskPipe; pipeOwnerPid=$taskServerId; executablePath=$taskServer.ExecutablePath; parentPid=$taskServer.ParentProcessId; creationDate=$taskServer.CreationDate.ToUniversalTime().ToString('o'); originalPackage=$taskOriginal; method='Current official MCP pipe owner + installed original package executable; read only'; noGuiAction=$true }
 [IO.File]::WriteAllText((Get-PublicPath '$data/system/本地统一/对话记录/original-manager/current-original-process.json'),(ConvertTo-Json $taskResult -Depth 4))
 $taskResult | ConvertTo-Json -Depth 4
 if (-not $taskOriginal) { throw 'Current MCP pipe is not owned by verified original package' }
} finally { [void][OriginalAppToolProbe]::CloseHandle($taskHandle) }
