param([string]$PythonExe = 'python')
$ErrorActionPreference = 'Stop'
$toolRoot = $PSScriptRoot
& npm.cmd ci --prefix (Join-Path $toolRoot 'npm') --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
$toolPython = Join-Path $toolRoot 'bilibili-venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $toolPython)) {
    if (-not (Get-Command $PythonExe -ErrorAction SilentlyContinue)) { throw 'Supply -PythonExe with a complete Python >=3.10 installation' }
    & $PythonExe -m venv (Join-Path $toolRoot 'bilibili-venv')
    if ($LASTEXITCODE -ne 0) { throw 'venv creation failed' }
}
& $toolPython -m pip install -r (Join-Path $toolRoot 'bilibili-requirements.lock.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }
Write-Output 'Restored pinned dependencies. Existing credentials retained. No login, browser installation or daemon start performed.'
