<#
.SYNOPSIS
  Removes the original WhatsApp Desktop and our old wrapper builds (WhatsApp 1.0.0,
  Aura, WaDesk), then installs Relay from the installer next to this script.

.DESCRIPTION
  Removes, for the signed-in Windows user only:
    - WhatsApp Desktop from the Microsoft Store (5319275A.WhatsAppDesktop)
    - the older Win32 WhatsApp Desktop (Squirrel, %LOCALAPPDATA%\WhatsApp)
    - our first wrapper ("WhatsApp" 1.0.0) and the Aura / WaDesk builds that followed
    - their shortcuts, startup entries, protocol handlers, caches and saved data
  It never touches Relay's own data (%APPDATA%\Relay), so re-running it is safe.
  Then it verifies and runs RelayInstaller*.exe silently and checks the result.

  Nothing is sent anywhere. A log is written to %TEMP%\Relay-Setup-<time>.log

.PARAMETER Installer   Path to RelayInstaller*.exe (default: newest one next to this script).
.PARAMETER DryRun      Only report what would be removed/installed; change nothing.
.PARAMETER Yes         Do not ask for confirmation.
.PARAMETER KeepData    Keep saved data folders of the removed apps.
.PARAMETER RemoveOnly  Remove the old apps but do not install Relay.
.PARAMETER Launch      Start Relay when finished (otherwise you are asked).
.PARAMETER NoPause     Do not wait for Enter at the end.
.PARAMETER SkipHashCheck  Install even if the installer does not match latest.yml.
.PARAMETER InstallDir  Install Relay somewhere other than the default.
#>
[CmdletBinding()]
param(
  [string]$Installer,
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$KeepData,
  [switch]$RemoveOnly,
  [switch]$Launch,
  [switch]$NoPause,
  [switch]$SkipHashCheck,
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ----------------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------------
$RelayGuid     = '099132e6-698a-529a-8ca5-f329e663c4f1'     # uninstall key of Relay (appId com.nikhlgoel.relay)
$RelayName     = 'Relay'
$StoreNames    = '5319275A.WhatsApp*'                         # Microsoft Store WhatsApp (and Beta)

# Our earlier wrapper builds. Guid = the uninstall key electron-builder derived from the appId.
$OurApps = @(
  @{ Name = 'WhatsApp'; Label = 'Our first WhatsApp wrapper (1.0.0)'; AppId = 'com.whitedev.whatsapppc'; Guid = '26039023-e087-5a08-b001-f2d0be55849e'; Data = @('WhatsApp', 'whatsapp-pc'); Updater = @('whatsapp-pc-updater') },
  @{ Name = 'Aura';     Label = 'Aura (earlier build of ours)';   AppId = 'com.nikhlgoel.aura';      Guid = 'c746b6bd-a5a2-5beb-90bb-44d8937ee1ce'; Data = @('Aura');                  Updater = @('aura-updater') },
  @{ Name = 'WaDesk';   Label = 'WaDesk (earlier build of ours)'; AppId = 'com.nikhlgoel.wadesk';    Guid = '4b354317-6097-5758-a3bb-eae33a6f0e0e'; Data = @('WaDesk');                Updater = @('wadesk-updater') }
)

$LocalAppData = $env:LOCALAPPDATA
$AppData      = $env:APPDATA
$UserProfile  = $env:USERPROFILE
$ProgramFiles = $env:ProgramFiles
$PF86         = ${env:ProgramFiles(x86)}
$ProgramsDir  = Join-Path $LocalAppData 'Programs'

$script:LogFile = Join-Path $env:TEMP ('Relay-Setup-{0}.log' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$script:Issues  = New-Object System.Collections.ArrayList
$script:RemovedDirs  = New-Object System.Collections.ArrayList
$script:RemovedFiles = New-Object System.Collections.ArrayList

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
function Write-Log {
  param([string]$Msg, [string]$Level = 'INFO')
  $line = '[{0}] {1,-5} {2}' -f (Get-Date -Format 'HH:mm:ss'), $Level, $Msg
  try { Add-Content -LiteralPath $script:LogFile -Value $line -Encoding UTF8 } catch { }
  $color = 'Gray'
  switch ($Level) { 'OK' { $color = 'Green' } 'WARN' { $color = 'Yellow' } 'ERROR' { $color = 'Red' } 'STEP' { $color = 'Cyan' } 'DRY' { $color = 'Magenta' } }
  Write-Host $line -ForegroundColor $color
}

function Add-Issue([string]$Text) { [void]$script:Issues.Add($Text); Write-Log $Text 'ERROR' }

function Invoke-Action {
  param([string]$Desc, [scriptblock]$Do)
  if ($DryRun) { Write-Log "would: $Desc" 'DRY'; return $true }
  Write-Log $Desc 'STEP'
  try { $null = & $Do; return $true }
  catch { Add-Issue ("{0} -> {1}" -f $Desc, $_.Exception.Message); return $false }
}

function Get-NormPath([string]$p) {
  if ([string]::IsNullOrWhiteSpace($p)) { return '' }
  $p = $p.Trim().Trim('"')
  try { return [IO.Path]::GetFullPath($p).TrimEnd('\') } catch { return $p.TrimEnd('\') }
}

function Test-StartsWithPath([string]$Path, [string]$Dir) {
  if ([string]::IsNullOrWhiteSpace($Path) -or [string]::IsNullOrWhiteSpace($Dir)) { return $false }
  $a = Get-NormPath $Path
  $b = Get-NormPath $Dir
  if ($a.Length -le $b.Length) { return ($a -ieq $b) }
  return $a.StartsWith($b + '\', [StringComparison]::OrdinalIgnoreCase)
}

# Refuse to delete anything that is not clearly inside the user's own program/data folders.
function Test-SafeToDelete([string]$Path) {
  $p = Get-NormPath $Path
  if ($p.Length -lt 10) { return $false }
  if ($p -match '^[A-Za-z]:$') { return $false }
  $roots = @($LocalAppData, $AppData, $UserProfile, $ProgramFiles, $PF86) | Where-Object { $_ }
  foreach ($r in $roots) {
    $rn = Get-NormPath $r
    if ($p.Length -gt $rn.Length -and (Test-StartsWithPath $p $rn) -and ($p -ine $rn)) {
      # never delete the roots themselves or the well-known container folders
      $containers = @($ProgramsDir, (Join-Path $UserProfile 'Desktop'), (Join-Path $UserProfile 'Downloads'), (Join-Path $UserProfile 'Documents'), $AppData, $LocalAppData, (Join-Path $LocalAppData 'Packages'))
      foreach ($c in $containers) { if ($p -ieq (Get-NormPath $c)) { return $false } }
      return $true
    }
  }
  return $false
}

function Remove-FolderRobust([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not (Test-SafeToDelete $Path)) { throw "refusing to delete unexpected location: $Path" }
  for ($i = 1; $i -le 6; $i++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    } catch {
      try { [IO.Directory]::Delete($Path, $true) } catch { }
    }
    if (-not (Test-Path -LiteralPath $Path)) { [void]$script:RemovedDirs.Add((Get-NormPath $Path)); return }
    Start-Sleep -Seconds 1
  }
  throw "could not delete $Path (something is still using it - restart the PC and run this again)"
}

function Remove-FileRobust([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  for ($i = 1; $i -le 4; $i++) {
    try { Remove-Item -LiteralPath $Path -Force -ErrorAction Stop } catch { }
    if (-not (Test-Path -LiteralPath $Path)) { [void]$script:RemovedFiles.Add((Get-NormPath $Path)); return }
    Start-Sleep -Milliseconds 700
  }
  throw "could not delete $Path"
}

function Get-FileSha512Base64([string]$Path) {
  $sha = [Security.Cryptography.SHA512]::Create()
  $fs = [IO.File]::OpenRead($Path)
  try { return [Convert]::ToBase64String($sha.ComputeHash($fs)) } finally { $fs.Dispose(); $sha.Dispose() }
}

function Get-UninstallEntries {
  $list = New-Object System.Collections.ArrayList
  $seen = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $root = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if (-not $root) { continue }
        foreach ($n in $root.GetSubKeyNames()) {
          $k = $null
          try {
            $k = $root.OpenSubKey($n)
            if (-not $k) { continue }
            # HKCU can show the same key through both registry views; list it once
            if (-not $seen.Add(('{0}|{1}|{2}' -f $hive, $n, [string]$k.GetValue('UninstallString')))) { continue }
            [void]$list.Add([pscustomobject]@{
              Hive = $hive; View = $view; KeyName = $n
              DisplayName = [string]$k.GetValue('DisplayName')
              DisplayVersion = [string]$k.GetValue('DisplayVersion')
              InstallLocation = [string]$k.GetValue('InstallLocation')
              UninstallString = [string]$k.GetValue('UninstallString')
            })
          } catch { } finally { if ($k) { $k.Close() } }
        }
        $root.Close()
      } catch { } finally { if ($base) { $base.Close() } }
    }
  }
  return ,$list
}

function Remove-UninstallEntry($Entry) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Entry.Hive, $Entry.View)
  try {
    $parent = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $true)
    if ($parent) { $parent.DeleteSubKeyTree($Entry.KeyName, $false); $parent.Close() }
  } finally { $base.Close() }
}

function Get-ExeFromCommand([string]$Cmd) {
  if ([string]::IsNullOrWhiteSpace($Cmd)) { return '' }
  if ($Cmd -match '^\s*"([^"]+)"') { return $Matches[1] }
  if ($Cmd -match '^\s*(.+?\.exe)') { return $Matches[1] }
  return ''
}

function Get-DirFromEntry($Entry) {
  $d = (Get-NormPath $Entry.InstallLocation)
  if ($d) { return $d }
  $exe = Get-ExeFromCommand $Entry.UninstallString
  if ($exe) { return (Get-NormPath (Split-Path -Parent $exe)) }
  return ''
}

# Is this folder really one of OUR electron-builder installs of that app (and not something else named the same)?
function Test-OurInstallDir([string]$Dir, $App) {
  if ([string]::IsNullOrWhiteSpace($Dir) -or -not (Test-Path -LiteralPath $Dir -PathType Container)) { return $false }
  $yml = Join-Path $Dir 'resources\app-update.yml'
  if (Test-Path -LiteralPath $yml) {
    try { if ((Get-Content -LiteralPath $yml -Raw) -match '(?im)^\s*repo:\s*whatsapp-pc\s*$') { return $true } } catch { }
  }
  $unin = Join-Path $Dir ('Uninstall {0}.exe' -f $App.Name)
  $asar = Join-Path $Dir 'resources\app.asar'
  if ((Test-Path -LiteralPath $unin) -and (Test-Path -LiteralPath $asar)) { return $true }
  return $false
}

function Get-StorePackages {
  $found = @()
  try {
    if ($PSVersionTable.PSVersion.Major -ge 6) { Import-Module Appx -UseWindowsPowerShell -ErrorAction SilentlyContinue 2>$null }
    $found = @(Get-AppxPackage -Name $StoreNames -ErrorAction Stop)
  } catch {
    Write-Log ("Could not list Store apps: {0}" -f $_.Exception.Message) 'WARN'
  }
  return $found
}

function Stop-ProcessesFor {
  param([string[]]$Dirs, [string[]]$NamePatterns, [string[]]$Files)
  $procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  foreach ($p in $procs) {
    if ($p.ProcessId -eq $PID) { continue }
    $hit = $false
    $exe = [string]$p.ExecutablePath
    if ($exe) {
      foreach ($d in $Dirs)  { if ($d -and (Test-StartsWithPath $exe $d)) { $hit = $true; break } }
      if (-not $hit) { foreach ($f in $Files) { if ($f -and ($exe -ieq $f)) { $hit = $true; break } } }
    }
    if (-not $hit) { foreach ($n in $NamePatterns) { if ($n -and ($p.Name -like $n)) { $hit = $true; break } } }
    if ($hit) {
      Write-Log ("Closing {0} (pid {1})" -f $p.Name, $p.ProcessId)
      try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
    }
  }
  Start-Sleep -Milliseconds 900
}

# Keep the window open so a double-click user can read the result.
function Wait-Close {
  if (-not $NoPause -and -not $Yes) { try { [void](Read-Host 'Press Enter to close') } catch { } }
}

function Wait-ProcessExit($Proc, [int]$Seconds) {
  if (-not $Proc.WaitForExit($Seconds * 1000)) {
    try { $Proc.Kill() } catch { }
    throw "timed out after $Seconds s"
  }
}

# ----------------------------------------------------------------------------
# Banner and preflight
# ----------------------------------------------------------------------------
Write-Host ''
Write-Host '  Relay setup' -ForegroundColor Cyan
Write-Host '  Removes old WhatsApp Desktop / earlier builds and installs Relay.' -ForegroundColor DarkGray
Write-Host ''
Write-Log ("Log file: {0}" -f $script:LogFile)
Write-Log ("User: {0}\{1}   Profile: {2}" -f $env:USERDOMAIN, $env:USERNAME, $UserProfile)
if ($DryRun) { Write-Log 'DRY RUN - nothing will be changed.' 'DRY' }

function Test-Admin {
  try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { return $false }
}
$isAdmin = Test-Admin
if ($isAdmin) { Write-Log 'Running as administrator. Relay will be installed for THIS account only.' 'WARN' }

$preflightOk = $true
if (-not [Environment]::Is64BitOperatingSystem) { Add-Issue 'Relay needs 64-bit Windows.'; $preflightOk = $false }
if ([Environment]::OSVersion.Version.Major -lt 10) { Add-Issue 'Relay needs Windows 10 or newer.'; $preflightOk = $false }
if ([string]::IsNullOrWhiteSpace($LocalAppData) -or [string]::IsNullOrWhiteSpace($AppData) -or [string]::IsNullOrWhiteSpace($env:TEMP)) {
  Add-Issue 'Windows user folders are not set - cannot continue.'; $preflightOk = $false
}

# installer
$resolvedInstaller = $null
if ($preflightOk -and -not $RemoveOnly) {
  if ($Installer) {
    $resolvedInstaller = $Installer
  } else {
    $here = $PSScriptRoot
    if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
    $cand = @(Get-ChildItem -LiteralPath $here -Filter 'RelayInstaller*.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    if ($cand.Count -gt 0) { $resolvedInstaller = $cand[0].FullName }
  }
  if (-not $resolvedInstaller -or -not (Test-Path -LiteralPath $resolvedInstaller -PathType Leaf)) {
    Add-Issue 'RelayInstaller*.exe was not found next to this script. Extract the whole zip first, then run again.'
    $preflightOk = $false
  } else {
    $resolvedInstaller = (Resolve-Path -LiteralPath $resolvedInstaller).Path
    $fi = Get-Item -LiteralPath $resolvedInstaller
    Write-Log ("Installer: {0} ({1:N1} MB)" -f $fi.Name, ($fi.Length / 1MB))
    $head = New-Object byte[] 2
    $fs = [IO.File]::OpenRead($resolvedInstaller); try { [void]$fs.Read($head, 0, 2) } finally { $fs.Dispose() }
    if ($fi.Length -lt 50MB -or $head[0] -ne 0x4D -or $head[1] -ne 0x5A) {
      Add-Issue 'The installer file looks incomplete or damaged. Download/copy it again.'; $preflightOk = $false
    }
    $yml = Join-Path (Split-Path -Parent $resolvedInstaller) 'latest.yml'
    if ($preflightOk -and (Test-Path -LiteralPath $yml)) {
      $ymlText = Get-Content -LiteralPath $yml -Raw
      $wantPath = ''; $wantHash = ''
      if ($ymlText -match '(?m)^path:\s*(\S+)\s*$') { $wantPath = $Matches[1] }
      if ($ymlText -match '(?m)^sha512:\s*(\S+)\s*$') { $wantHash = $Matches[1] }
      if ($wantHash -and ($wantPath -ieq $fi.Name)) {
        Write-Log 'Checking the installer against latest.yml ...'
        $got = Get-FileSha512Base64 $resolvedInstaller
        if ($got -ceq $wantHash) { Write-Log 'Installer checksum matches.' 'OK' }
        elseif ($SkipHashCheck) { Write-Log 'Checksum does NOT match (ignored: -SkipHashCheck).' 'WARN' }
        else { Add-Issue 'Installer checksum does not match latest.yml - the file is corrupted or was changed. Copy it again.'; $preflightOk = $false }
      } else {
        Write-Log 'latest.yml does not describe this installer - checksum not verified.' 'WARN'
      }
    } elseif ($preflightOk) {
      Write-Log 'No latest.yml next to the installer - checksum not verified.' 'WARN'
    }
    if ($preflightOk -and -not $DryRun) { try { Unblock-File -LiteralPath $resolvedInstaller -ErrorAction SilentlyContinue } catch { } }
  }
  # disk space (installer ~110 MB, installed ~350 MB)
  try {
    $drive = New-Object IO.DriveInfo ((Split-Path -Qualifier $LocalAppData))
    if ($drive.AvailableFreeSpace -lt 1GB) { Add-Issue ("Less than 1 GB free on {0} - free some space first." -f $drive.Name); $preflightOk = $false }
  } catch { }
  # can we write where Relay installs?
  if (-not $DryRun) {
    try {
      if (-not (Test-Path -LiteralPath $ProgramsDir)) { New-Item -ItemType Directory -Path $ProgramsDir -Force | Out-Null }
      $probe = Join-Path $ProgramsDir ('.write-test-{0}' -f ([guid]::NewGuid().ToString('N')))
      Set-Content -LiteralPath $probe -Value 'x'; Remove-Item -LiteralPath $probe -Force
    } catch { Add-Issue ("Cannot write to {0}: {1}" -f $ProgramsDir, $_.Exception.Message); $preflightOk = $false }
  }
}

if (-not $preflightOk) {
  Write-Log 'Stopped before changing anything.' 'ERROR'
  Write-Log ("Log: {0}" -f $script:LogFile)
  Wait-Close
  exit 2
}

# ----------------------------------------------------------------------------
# Discovery (read-only)
# ----------------------------------------------------------------------------
Write-Log 'Looking for old installations ...' 'STEP'

$storePkgs = @(Get-StorePackages)

$squirrelDir = Join-Path $LocalAppData 'WhatsApp'
$squirrelUpdate = Join-Path $squirrelDir 'Update.exe'
$hasSquirrel = Test-Path -LiteralPath $squirrelUpdate

$entries = Get-UninstallEntries
$ours = New-Object System.Collections.ArrayList     # each: @{ App; Dirs (list); Keys (list) }
foreach ($app in $OurApps) {
  $rec = @{ App = $app; Dirs = (New-Object System.Collections.ArrayList); Keys = (New-Object System.Collections.ArrayList) }
  foreach ($e in $entries) {
    $keyMatch = ($e.KeyName -like ('*' + $app.Guid + '*'))
    $nameMatch = ($e.DisplayName -eq $app.Name)
    if (-not ($keyMatch -or $nameMatch)) { continue }
    $dir = Get-DirFromEntry $e
    if ($keyMatch) {
      [void]$rec.Keys.Add($e)
      if ($dir -and (Test-OurInstallDir $dir $app) -and -not ($rec.Dirs -contains $dir)) { [void]$rec.Dirs.Add($dir) }
    } elseif ($nameMatch -and $dir -and (Test-OurInstallDir $dir $app)) {
      [void]$rec.Keys.Add($e)
      if (-not ($rec.Dirs -contains $dir)) { [void]$rec.Dirs.Add($dir) }
    }
  }
  foreach ($root in @($ProgramsDir, $ProgramFiles, $PF86)) {
    if (-not $root) { continue }
    $d = Get-NormPath (Join-Path $root $app.Name)
    if ((Test-OurInstallDir $d $app) -and -not ($rec.Dirs -contains $d)) { [void]$rec.Dirs.Add($d) }
  }
  if ($rec.Dirs.Count -gt 0 -or $rec.Keys.Count -gt 0) { [void]$ours.Add($rec) }
}

# installer / portable files of our old builds left in the usual places
$looseFiles = New-Object System.Collections.ArrayList
$searchDirs = @((Join-Path $UserProfile 'Desktop'), (Join-Path $UserProfile 'Downloads'), (Join-Path $UserProfile 'Documents'))
try { $od = [Environment]::GetFolderPath('Desktop'); if ($od) { $searchDirs += $od } } catch { }
if ($env:OneDrive) { $searchDirs += (Join-Path $env:OneDrive 'Desktop'); $searchDirs += (Join-Path $env:OneDrive 'Downloads') }
$filePatterns = @('WhatsApp-portable-*.exe', 'WhatsApp Setup [0-9]*.exe', 'Aura-portable*.exe', 'Aura Setup*.exe', 'WaDesk-portable-*.exe', 'WaDesk Setup*.exe')
foreach ($d in ($searchDirs | Where-Object { $_ } | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $d -PathType Container)) { continue }
  foreach ($pat in $filePatterns) {
    foreach ($f in @(Get-ChildItem -LiteralPath $d -Filter $pat -File -ErrorAction SilentlyContinue)) {
      # ours are ~80 MB; the real WhatsApp installer stub is tiny
      if ($f.Length -gt 50MB -and -not (@($looseFiles | ForEach-Object { $_.FullName }) -contains $f.FullName)) { [void]$looseFiles.Add($f) }
    }
  }
}

# saved data / caches
$dataDirs = New-Object System.Collections.ArrayList
if (-not $KeepData) {
  foreach ($app in $OurApps) {
    foreach ($n in $app.Data) {
      foreach ($root in @($AppData, $LocalAppData)) {
        # %LOCALAPPDATA%\WhatsApp is the old Squirrel install, handled above
        if ($n -eq 'WhatsApp' -and $root -eq $LocalAppData) { continue }
        $p = Join-Path $root $n
        if ((Test-Path -LiteralPath $p) -and -not ($dataDirs -contains $p)) { [void]$dataDirs.Add($p) }
      }
    }
    foreach ($n in $app.Updater) {
      $p = Join-Path $LocalAppData $n
      if ((Test-Path -LiteralPath $p) -and -not ($dataDirs -contains $p)) { [void]$dataDirs.Add($p) }
    }
  }
  $pk = Join-Path $LocalAppData 'Packages'
  if (Test-Path -LiteralPath $pk) {
    foreach ($d in @(Get-ChildItem -LiteralPath $pk -Directory -Filter '5319275A.WhatsApp*' -ErrorAction SilentlyContinue)) { [void]$dataDirs.Add($d.FullName) }
  }
}

# Relay already there?
$relayEntry = $null
foreach ($e in $entries) { if ($e.KeyName -like ('*' + $RelayGuid + '*')) { $relayEntry = $e; break } }

# ----------------------------------------------------------------------------
# Report + confirm
# ----------------------------------------------------------------------------
Write-Host ''
Write-Host '  Found:' -ForegroundColor White
$anything = $false
foreach ($p in $storePkgs) { Write-Host ("   - WhatsApp from the Microsoft Store  ({0} {1})" -f $p.Name, $p.Version); $anything = $true }
if ($hasSquirrel)          { Write-Host ("   - Older WhatsApp Desktop  ({0})" -f $squirrelDir); $anything = $true }
foreach ($r in $ours) {
  $where = 'registry entry only'
  if ($r.Dirs.Count -gt 0) { $where = ($r.Dirs -join ', ') }
  Write-Host ("   - {0}  ({1})" -f $r.App.Label, $where); $anything = $true
}
foreach ($f in $looseFiles) { Write-Host ("   - Old installer file  ({0})" -f $f.FullName); $anything = $true }
foreach ($d in $dataDirs)   { Write-Host ("   - Saved data  ({0})" -f $d); $anything = $true }
if (-not $anything)         { Write-Host '   (no old WhatsApp / wrapper installs found)' -ForegroundColor DarkGray }
if ($relayEntry)            { Write-Host ("   - Relay {0} is already installed - it will be updated, your Relay data is kept." -f $relayEntry.DisplayVersion) -ForegroundColor DarkGray }
Write-Host ''
Write-Host '  Your chats live on your phone and in your WhatsApp account; removing the' -ForegroundColor DarkGray
Write-Host '  desktop apps only signs this PC out. You will scan a QR code again in Relay.' -ForegroundColor DarkGray
Write-Host ''
foreach ($p in $storePkgs)  { Write-Log ('found store: ' + $p.PackageFullName) }
foreach ($r in $ours)       { Write-Log ('found ours: ' + $r.App.Name + ' dirs=' + ($r.Dirs -join ';') + ' keys=' + (($r.Keys | ForEach-Object { $_.KeyName }) -join ';')) }
foreach ($f in $looseFiles) { Write-Log ('found file: ' + $f.FullName) }
foreach ($d in $dataDirs)   { Write-Log ('found data: ' + $d) }

if (-not $DryRun -and -not $Yes) {
  $prompt = 'Remove the items above and install Relay? [Y/N]'
  if ($RemoveOnly) { $prompt = 'Remove the items above? [Y/N]' }
  $ans = ''
  try { $ans = Read-Host $prompt } catch { $ans = '' }
  if ($ans -notmatch '^\s*(y|yes)\s*$') {
    Write-Log 'Cancelled - nothing was changed.' 'WARN'
    Wait-Close
    exit 3
  }
}

# ----------------------------------------------------------------------------
# Removal
# ----------------------------------------------------------------------------
$allDirs = New-Object System.Collections.ArrayList
foreach ($p in $storePkgs) { if ($p.InstallLocation) { [void]$allDirs.Add($p.InstallLocation) } }
if ($hasSquirrel) { [void]$allDirs.Add($squirrelDir) }
foreach ($r in $ours) { foreach ($d in $r.Dirs) { [void]$allDirs.Add($d) } }
$allFiles = @($looseFiles | ForEach-Object { $_.FullName })
$relayDir = $null
if ($relayEntry) { $relayDir = Get-DirFromEntry $relayEntry }
if (-not $relayDir) { $relayDir = Join-Path $ProgramsDir $RelayName }

if ($anything -or $relayEntry) {
  Invoke-Action 'Close running WhatsApp / Relay windows' {
    Stop-ProcessesFor -Dirs (@($allDirs) + @($relayDir)) -NamePatterns @('WhatsApp*') -Files $allFiles
  } | Out-Null
}

# 1. Microsoft Store WhatsApp
foreach ($p in $storePkgs) {
  $full = $p.PackageFullName
  $loc = $p.InstallLocation
  Invoke-Action ("Remove Store app $full") {
    $done = $false
    for ($i = 1; $i -le 3 -and -not $done; $i++) {
      try { Remove-AppxPackage -Package $full -ErrorAction Stop; $done = $true }
      catch {
        if ($i -eq 3) { throw }
        Start-Sleep -Seconds 3
        Stop-ProcessesFor -Dirs @($loc) -NamePatterns @('WhatsApp*') -Files @()
      }
    }
  } | Out-Null
}
if ($isAdmin -and $storePkgs.Count -gt 0) {
  Invoke-Action 'Remove the Store app for all users and the preinstalled copy' {
    try { Get-AppxPackage -AllUsers -Name $StoreNames | ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName -AllUsers -ErrorAction SilentlyContinue } } catch { }
    try { Get-AppxProvisionedPackage -Online | Where-Object { $_.DisplayName -like $StoreNames } | ForEach-Object { Remove-AppxProvisionedPackage -Online -PackageName $_.PackageName -ErrorAction SilentlyContinue | Out-Null } } catch { }
  } | Out-Null
}
$storeStillThere = $false
if (-not $DryRun -and $storePkgs.Count -gt 0) {
  $before = @($storePkgs | ForEach-Object { $_.PackageFullName })
  $left = @(Get-StorePackages | Where-Object { $before -contains $_.PackageFullName })
  if ($left.Count -gt 0) { $storeStillThere = $true }
  if ($left.Count -gt 0) { Add-Issue 'The Store version of WhatsApp is still installed (Windows refused to remove it). Remove it in Settings > Apps > Installed apps, then run this again.' }
  else { Write-Log 'Store WhatsApp removed.' 'OK' }
}

# 2. Older Win32 (Squirrel) WhatsApp
if ($hasSquirrel) {
  Invoke-Action 'Uninstall the older WhatsApp Desktop' {
    $proc = Start-Process -FilePath $squirrelUpdate -ArgumentList '--uninstall -s' -PassThru -WindowStyle Hidden
    Wait-ProcessExit $proc 120
    Start-Sleep -Seconds 2
  } | Out-Null
  Invoke-Action ("Delete $squirrelDir") { Stop-ProcessesFor -Dirs @($squirrelDir) -NamePatterns @() -Files @(); Remove-FolderRobust $squirrelDir } | Out-Null
  foreach ($e in $entries) {
    if ($e.Hive -eq [Microsoft.Win32.RegistryHive]::CurrentUser -and $e.KeyName -eq 'WhatsApp' -and (Test-StartsWithPath (Get-ExeFromCommand $e.UninstallString) $squirrelDir)) {
      Invoke-Action 'Remove leftover uninstall entry "WhatsApp"' { Remove-UninstallEntry $e } | Out-Null
    }
  }
}

# 3. Our earlier wrapper builds
foreach ($r in $ours) {
  $app = $r.App
  foreach ($dir in $r.Dirs) {
    $unin = Join-Path $dir ('Uninstall {0}.exe' -f $app.Name)
    if (Test-Path -LiteralPath $unin) {
      Invoke-Action ("Run the uninstaller of " + $app.Label) {
        $proc = Start-Process -FilePath $unin -ArgumentList ('/S _?=' + $dir) -PassThru -WindowStyle Hidden
        Wait-ProcessExit $proc 180
        if ($proc.ExitCode -ne 0) { Write-Log ("Uninstaller exit code {0}; cleaning up by hand." -f $proc.ExitCode) 'WARN' }
      } | Out-Null
    }
    Invoke-Action ("Delete $dir") { Stop-ProcessesFor -Dirs @($dir) -NamePatterns @() -Files @(); Remove-FolderRobust $dir } | Out-Null
  }
  foreach ($e in $r.Keys) {
    Invoke-Action ("Remove registry entry '{0}'" -f $e.KeyName) { Remove-UninstallEntry $e } | Out-Null
  }
  # the install-info keys electron-builder writes under HKCU\Software\<guid>, and the toast identity
  Invoke-Action ("Remove install info of " + $app.Name) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $b = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
      try {
        $sw = $b.OpenSubKey('Software', $true)
        if ($sw) {
          foreach ($n in @($app.Guid, ('{' + $app.Guid + '}'), $app.AppId)) { $sw.DeleteSubKeyTree($n, $false) }
          $sw.Close()
        }
      } finally { $b.Close() }
    }
    $aum = 'HKCU:\Software\Classes\AppUserModelId\' + $app.AppId
    if (Test-Path -LiteralPath $aum) { Remove-Item -LiteralPath $aum -Recurse -Force }
  } | Out-Null
}

# 4. Loose installer / portable files
foreach ($f in $looseFiles) {
  $fp = $f.FullName
  Invoke-Action ("Delete old file " + $fp) { Stop-ProcessesFor -Dirs @() -NamePatterns @() -Files @($fp); Remove-FileRobust $fp } | Out-Null
}

# 5. Saved data and caches
foreach ($d in $dataDirs) {
  if ($storeStillThere -and ($d -like '*\Packages\5319275A.WhatsApp*')) { Write-Log ("Keeping {0} because the Store app is still installed." -f $d) 'WARN'; continue }
  Invoke-Action ("Delete saved data " + $d) { Remove-FolderRobust $d } | Out-Null
}

# 6. Shortcuts, startup entries and link handlers that pointed at what we removed
if (-not $DryRun -and ($allDirs.Count -gt 0 -or $allFiles.Count -gt 0)) {
  Write-Log 'Cleaning shortcuts and startup entries ...' 'STEP'
  $gone = @(@($allDirs) + @($script:RemovedDirs)) | Where-Object { $_ } | Select-Object -Unique
  $goneFiles = @(@($allFiles) + @($script:RemovedFiles))
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcutRoots = @()
    foreach ($sf in @('Desktop', 'CommonDesktopDirectory', 'Programs', 'CommonPrograms', 'Startup', 'CommonStartup')) {
      try { $p = [Environment]::GetFolderPath($sf); if ($p -and (Test-Path -LiteralPath $p)) { $shortcutRoots += $p } } catch { }
    }
    # also the standard locations built from the profile folders, in case Windows returned nothing for one of them
    $smPrograms = Join-Path $AppData 'Microsoft\Windows\Start Menu\Programs'
    foreach ($p in @($smPrograms, (Join-Path $smPrograms 'Startup'), (Join-Path $UserProfile 'Desktop'))) {
      if ($p -and (Test-Path -LiteralPath $p)) { $shortcutRoots += $p }
    }
    foreach ($root in ($shortcutRoots | Select-Object -Unique)) {
      foreach ($lnk in @(Get-ChildItem -LiteralPath $root -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
        $target = ''
        try { $target = [string]$wsh.CreateShortcut($lnk.FullName).TargetPath } catch { continue }
        if (-not $target) { continue }
        $hit = $false
        foreach ($g in $gone) { if (Test-StartsWithPath $target $g) { $hit = $true; break } }
        if (-not $hit) { foreach ($gf in $goneFiles) { if ($target -ieq $gf) { $hit = $true; break } } }
        if ($hit) {
          Write-Log ("Removing shortcut {0}" -f $lnk.FullName)
          try { Remove-Item -LiteralPath $lnk.FullName -Force -ErrorAction Stop } catch { Write-Log ("Could not remove shortcut {0}: {1}" -f $lnk.FullName, $_.Exception.Message) 'WARN' }
          $parent = $lnk.DirectoryName
          if ($parent -and ((Get-NormPath $parent) -ine (Get-NormPath $root))) {
            if (@(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue).Count -eq 0) { try { Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue } catch { } }
          }
        }
      }
    }
  } catch { Write-Log ("Shortcut cleanup skipped: {0}" -f $_.Exception.Message) 'WARN' }

  foreach ($runKey in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce')) {
    try {
      if (-not (Test-Path -LiteralPath $runKey)) { continue }
      $item = Get-ItemProperty -LiteralPath $runKey
      foreach ($prop in $item.PSObject.Properties) {
        if ($prop.Name -like 'PS*') { continue }
        $val = [string]$prop.Value
        $exe = Get-ExeFromCommand $val
        if (-not $exe) { $exe = $val.Trim('"') }
        $hit = $false
        foreach ($g in $gone) { if (Test-StartsWithPath $exe $g) { $hit = $true; break } }
        if ($hit) { Write-Log ("Removing startup entry '{0}'" -f $prop.Name); Remove-ItemProperty -LiteralPath $runKey -Name $prop.Name -ErrorAction SilentlyContinue }
      }
    } catch { Write-Log ("Startup cleanup skipped: {0}" -f $_.Exception.Message) 'WARN' }
  }

  try {
    $proto = 'HKCU:\Software\Classes\whatsapp'
    $cmdKey = Join-Path $proto 'shell\open\command'
    if (Test-Path -LiteralPath $cmdKey) {
      $cmd = [string](Get-ItemProperty -LiteralPath $cmdKey).'(default)'
      $exe = Get-ExeFromCommand $cmd
      $hit = $false
      foreach ($g in $gone) { if ($exe -and (Test-StartsWithPath $exe $g)) { $hit = $true; break } }
      if ($hit) { Write-Log 'Removing the whatsapp:// link handler of the removed app'; Remove-Item -LiteralPath $proto -Recurse -Force }
    }
  } catch { Write-Log ("Link handler cleanup skipped: {0}" -f $_.Exception.Message) 'WARN' }
}

# ----------------------------------------------------------------------------
# Install Relay
# ----------------------------------------------------------------------------
$installed = $false
$exePath = $null
if (-not $RemoveOnly) {
  if ($DryRun) {
    Write-Log ("would: install {0} silently" -f $resolvedInstaller) 'DRY'
  } else {
    Write-Log 'Installing Relay (this takes about a minute) ...' 'STEP'
    $argLine = '/S /currentuser'
    if ($InstallDir) { $argLine += ' /D=' + $InstallDir }           # /D= must be last and unquoted
    try {
      $proc = Start-Process -FilePath $resolvedInstaller -ArgumentList $argLine -PassThru -WindowStyle Hidden
      Wait-ProcessExit $proc 600
      Write-Log ("Installer exit code: {0}" -f $proc.ExitCode)
      if ($proc.ExitCode -ne 0) { Add-Issue ("The Relay installer reported exit code {0}." -f $proc.ExitCode) }
    } catch { Add-Issue ("The Relay installer failed: {0}" -f $_.Exception.Message) }

    # verify instead of trusting the exit code
    $deadline = (Get-Date).AddSeconds(30)
    do {
      $reg = $null
      foreach ($e in (Get-UninstallEntries)) { if ($e.KeyName -like ('*' + $RelayGuid + '*')) { $reg = $e; break } }
      $dir = $null
      if ($InstallDir) { $dir = $InstallDir } elseif ($reg) { $dir = Get-DirFromEntry $reg }
      if (-not $dir) { $dir = Join-Path $ProgramsDir $RelayName }
      $candidate = Join-Path $dir 'Relay.exe'
      if ($reg -and (Test-Path -LiteralPath $candidate)) { $exePath = $candidate; break }
      Start-Sleep -Milliseconds 800
    } while ((Get-Date) -lt $deadline)

    if ($exePath) {
      $ver = (Get-Item -LiteralPath $exePath).VersionInfo.ProductVersion
      Write-Log ("Relay {0} is installed at {1}" -f $ver, (Split-Path -Parent $exePath)) 'OK'
      $installed = $true
    } else {
      Add-Issue 'Relay did not finish installing (Relay.exe or its uninstall entry is missing).'
    }
  }
}

# ----------------------------------------------------------------------------
# Offline speech models (optional). For PCs that cannot reach huggingface.co (mainland China, some networks),
# put the .bin files from the kit's "models" folder next to this script; they are checked and copied for Relay's captions.
# ----------------------------------------------------------------------------
if ($installed -and -not $DryRun) {
  try {
    $modelSrc = Join-Path $(if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }) 'models'
    if (Test-Path -LiteralPath $modelSrc) {
      $pinned = @{
        'ggml-base-q5_1.bin'  = @{ Bytes = 59707625;  Sha = '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' }
        'ggml-small-q5_1.bin' = @{ Bytes = 190085487; Sha = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' }
      }
      $modelDst = Join-Path (Join-Path $AppData 'Relay') 'models'
      foreach ($name in $pinned.Keys) {
        $f = Join-Path $modelSrc $name
        if (-not (Test-Path -LiteralPath $f)) { continue }
        $info = Get-Item -LiteralPath $f
        $sha = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($info.Length -ne $pinned[$name].Bytes -or $sha -ne $pinned[$name].Sha) {
          Write-Log ("Speech model {0} is damaged or not the expected file - skipped (Relay will download it when needed)." -f $name) 'WARN'
          continue
        }
        New-Item -ItemType Directory -Force -Path $modelDst | Out-Null
        Copy-Item -LiteralPath $f -Destination (Join-Path $modelDst $name) -Force
        Write-Log ("Speech model {0} installed for offline captions." -f $name) 'OK'
      }
    }
  } catch { Write-Log ("Offline speech models skipped: {0}" -f $_.Exception.Message) 'WARN' }
}

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
Write-Host ''
if ($script:Issues.Count -eq 0) {
  if ($DryRun)         { Write-Log 'Dry run finished. Nothing was changed.' 'OK' }
  elseif ($RemoveOnly) { Write-Log 'Old apps removed.' 'OK' }
  else                 { Write-Log 'All done. Open Relay from the Start menu or the desktop shortcut and scan the QR code with your phone.' 'OK' }
} else {
  Write-Log ('Finished with {0} problem(s):' -f $script:Issues.Count) 'WARN'
  foreach ($i in $script:Issues) { Write-Log (' - ' + $i) 'WARN' }
  Write-Log ('Send this log file if you need help: {0}' -f $script:LogFile) 'WARN'
}

if ($installed -and -not $DryRun) {
  $go = $Launch.IsPresent
  if (-not $go -and -not $NoPause -and -not $Yes) {
    try { $a = Read-Host 'Start Relay now? [Y/N]'; $go = ($a -match '^\s*(y|yes)\s*$') } catch { }
  }
  if ($go) { try { Start-Process -FilePath $exePath } catch { Write-Log ("Could not start Relay: {0}" -f $_.Exception.Message) 'WARN' } }
}

Wait-Close
if ($script:Issues.Count -gt 0) { exit 1 }
exit 0
