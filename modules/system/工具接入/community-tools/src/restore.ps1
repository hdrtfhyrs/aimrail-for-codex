param([string]$PythonExe = (Get-PublicPath '$runtime/python/python.exe'))
$publicPathRoot = $PSScriptRoot
while (-not (Test-Path -LiteralPath (Join-Path $publicPathRoot 'public-paths.ps1'))) { $publicPathRoot = Split-Path -Parent $publicPathRoot; if (-not $publicPathRoot) { throw 'Public path helper missing' } }
. (Join-Path $publicPathRoot 'public-paths.ps1')

$ErrorActionPreference = 'Stop'
$toolRoot = Get-PublicPath '$plugins/community-tools'
& npm.cmd install --prefix (Join-Path $toolRoot 'npm') --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
$toolPython = Join-Path $toolRoot 'bilibili-venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $toolPython)) {
    if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'Supply -PythonExe with a complete Python >=3.10 installation' }
    & $PythonExe -m venv (Join-Path $toolRoot 'bilibili-venv')
    if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
}
& $toolPython -m pip install -r (Join-Path $toolRoot 'bilibili-requirements.lock.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
Write-Output 'Restored pinned dependencies. Existing credentials retained. No login, browser installation or daemon start performed.'
