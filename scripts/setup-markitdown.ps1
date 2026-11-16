[CmdletBinding()]
param(
    [string] $Python
)

$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$venv = Join-Path $appRoot '.venv'
$venvPython = Join-Path $venv 'Scripts\python.exe'
$lockfile = Join-Path $appRoot 'converter\requirements-windows-x64.txt'

$pythonArgs = @()
if (Test-Path -LiteralPath $venvPython -PathType Leaf) {
    $Python = $venvPython
} elseif (-not $Python) {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        $Python = $launcher.Source
        $pythonArgs = @('-3.13')
    } else {
        $command = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $command) {
            throw 'Install CPython 3.13 x64 from python.org, or pass -Python with the path to python.exe.'
        }
        $Python = $command.Source
    }
}

$platform = & $Python @pythonArgs -I -c 'import sys, sysconfig; print(sys.implementation.name, sys.version_info.major, sys.version_info.minor, sysconfig.get_platform())'
if ($LASTEXITCODE -ne 0 -or $platform -ne 'cpython 3 13 win-amd64') {
    throw 'MarkItDown needs CPython 3.13 x64 for Windows. Pass -Python with the path to that installation.'
}

if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    & $Python @pythonArgs -I -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the MarkItDown environment.' }
}

& $venvPython -I -m pip --isolated --disable-pip-version-check --no-input install --index-url https://pypi.org/simple --no-cache-dir --only-binary=:all: --require-hashes --requirement $lockfile
if ($LASTEXITCODE -ne 0) { throw 'Could not install the pinned MarkItDown dependencies.' }

& $venvPython -I -m pip --isolated --disable-pip-version-check check
if ($LASTEXITCODE -ne 0) { throw 'The MarkItDown environment has inconsistent dependencies.' }

$version = & $venvPython -I -c 'from markitdown.__about__ import __version__; print(__version__)'
if ($LASTEXITCODE -ne 0) { throw 'Installed MarkItDown could not be loaded.' }
Write-Output "MarkItDown $version ready."
