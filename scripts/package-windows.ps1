param(
    [string]$Executable,
    [string]$WebViewLoader,
    [string]$ThirdPartyNotices,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Executable) { $Executable = Join-Path $root 'target\release\research-line-local.exe' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist' }
$Executable = (Resolve-Path -LiteralPath $Executable).Path

$stage = Join-Path $root ('dist\stage-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
foreach ($folder in @('docs', 'scripts', 'converter')) {
    New-Item -ItemType Directory -Path (Join-Path $stage $folder) | Out-Null
}

Copy-Item -LiteralPath $Executable -Destination (Join-Path $stage 'research-line-local.exe')
if ($WebViewLoader) {
    Copy-Item -LiteralPath $WebViewLoader -Destination (Join-Path $stage 'WebView2Loader.dll')
}
if ($ThirdPartyNotices) {
    Copy-Item -LiteralPath $ThirdPartyNotices -Destination (Join-Path $stage 'THIRD-PARTY-LICENSES.txt')
}

$packageFiles = @(
    'README.md',
    'docs/amd-windows.md',
    'docs/third-party.md',
    'scripts/setup-markitdown.ps1',
    'converter/convert.py',
    'converter/requirements-windows-x64.txt'
)
foreach ($relative in $packageFiles) {
    Copy-Item -LiteralPath (Join-Path $root $relative) -Destination (Join-Path $stage $relative)
}

$version = (Select-String -LiteralPath (Join-Path $root 'Cargo.toml') -Pattern '^version = "(.+)"$').Matches[0].Groups[1].Value
$archive = Join-Path $OutputDirectory "research-line-local-$version-windows-x64.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
(Get-Item -LiteralPath $archive).FullName
