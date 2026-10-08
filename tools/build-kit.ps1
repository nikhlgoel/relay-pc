<#
  Builds the shareable setup kit from the newest installer in dist\:
    dist\RelaySetupKit-<version>.zip       installer + Install-Relay.cmd/.ps1 + README + latest.yml (+ models\ if given)
    dist\RelaySpeechModels.zip             only the offline speech model(s), to extract into the kit's "models" folder
  Usage:  powershell -File tools\build-kit.ps1 [-Models <folder with ggml-base-q5_1.bin>]
  The version comes from package.json; README.txt gets the version filled in.
#>
param([string]$Models = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$ver = $pkg.version
$installer = Join-Path $dist ("RelayInstaller{0}.exe" -f $ver)
if (-not (Test-Path -LiteralPath $installer)) { throw "Build the installer first (npm run dist): $installer is missing" }

$kit = Join-Path $dist ("RelaySetupKit-{0}" -f $ver)
if (Test-Path -LiteralPath $kit) { Remove-Item -LiteralPath $kit -Recurse -Force }
New-Item -ItemType Directory -Path $kit | Out-Null

$src = Join-Path $PSScriptRoot 'setup-kit'
foreach ($f in 'Install-Relay.cmd', 'Install-Relay.ps1') { Copy-Item -LiteralPath (Join-Path $src $f) -Destination $kit }
$readme = (Get-Content -LiteralPath (Join-Path $src 'README.txt') -Raw -Encoding UTF8).Replace('{{VERSION}}', $ver)
[System.IO.File]::WriteAllText((Join-Path $kit 'README.txt'), $readme, (New-Object System.Text.UTF8Encoding($true)))
Copy-Item -LiteralPath $installer -Destination $kit
Copy-Item -LiteralPath (Join-Path $dist 'latest.yml') -Destination $kit

$pinned = @{ 'ggml-base-q5_1.bin' = 59707625 }
$modelFiles = @()
if ($Models) {
  foreach ($name in $pinned.Keys) {
    $f = Join-Path $Models $name
    if ((Test-Path -LiteralPath $f) -and ((Get-Item -LiteralPath $f).Length -eq $pinned[$name])) { $modelFiles += $f }
    else { Write-Warning "$name not found (or wrong size) in $Models - not included" }
  }
}

$zip = Join-Path $dist ("RelaySetupKit-{0}.zip" -f $ver)
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $kit '*') -DestinationPath $zip -CompressionLevel Optimal
Write-Host "kit:    $zip ($([int]((Get-Item $zip).Length / 1MB)) MB)"

if ($modelFiles.Count) {
  $stage = Join-Path $dist 'models-stage'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path (Join-Path $stage 'models') | Out-Null
  foreach ($f in $modelFiles) { Copy-Item -LiteralPath $f -Destination (Join-Path $stage 'models') }
  $mz = Join-Path $dist 'RelaySpeechModels.zip'
  if (Test-Path -LiteralPath $mz) { Remove-Item -LiteralPath $mz -Force }
  Compress-Archive -Path (Join-Path $stage 'models') -DestinationPath $mz -CompressionLevel NoCompression
  Remove-Item -LiteralPath $stage -Recurse -Force
  Write-Host "models: $mz ($([int]((Get-Item $mz).Length / 1MB)) MB) - extract it INTO the kit folder so that 'models' sits next to Install-Relay.cmd"
}

$h = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Host "SHA-256 of $(Split-Path -Leaf $installer): $h"
