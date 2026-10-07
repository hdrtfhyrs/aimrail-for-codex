$publicSystemDefault = $PSScriptRoot
$publicRepositoryDefault = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$publicDataDefault = $env:AI_WORK_DATA_HOME
if (-not $publicDataDefault) { $publicDataDefault = $env:AI_WORK_HOME }
if (-not $publicDataDefault) { $publicDataDefault = Join-Path $publicRepositoryDefault 'workspace' }
function Get-PublicPath([string]$Value) {
    if ($Value -notmatch '^\$(\w+)(?:/(.*))?$') { return $Value }
    $publicKey = $Matches[1]; $publicTail = $Matches[2]
    $publicDefaults = @{
        system = $publicSystemDefault
        codex = (Join-Path $publicRepositoryDefault 'integrations')
        projects = (Join-Path $publicDataDefault 'projects')
        data = $publicDataDefault
        user = (Join-Path $publicDataDefault 'user')
        runtime = (Join-Path $publicDataDefault 'runtime')
        plugins = (Join-Path $publicRepositoryDefault 'plugins')
        models = (Join-Path $publicRepositoryDefault 'tools/model-clients')
    }
    $publicVariables = @{ system='AI_WORK_SYSTEM_HOME'; codex='AI_CODEX_HOME'; projects='AI_PROJECTS_HOME'; data='AI_WORK_DATA_HOME'; user='AI_USER_HOME'; runtime='AI_RUNTIME_HOME'; plugins='AI_PLUGINS_HOME'; models='AI_MODEL_CLIENTS_HOME' }
    if (-not $publicDefaults.ContainsKey($publicKey)) { throw 'Unknown public root' }
    $publicBase = [Environment]::GetEnvironmentVariable($publicVariables[$publicKey])
    if (-not $publicBase -and $publicKey -eq 'data') { $publicBase = $env:AI_WORK_HOME }
    if (-not $publicBase) { $publicBase = $publicDefaults[$publicKey] }
    if ($publicKey -in @('codex','system') -and ($publicTail -match '\.(json|sqlite|db|lock|jsonl)$' -or $publicTail -match '(^|/)(bindings|failure-inbox|archive|sessions)(/|$)')) {
        $publicBase = Join-Path $publicDataDefault $(if ($publicKey -eq 'codex') { 'integrations' } else { 'system' })
    }
    if ($publicTail) { return Join-Path $publicBase $publicTail }
    return $publicBase
}
