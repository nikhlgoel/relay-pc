@echo off
rem Double-click launcher for Install-Relay.ps1 (runs with a one-time policy bypass; changes no system setting).
setlocal
cd /d "%~dp0"
if not exist "%~dp0Install-Relay.ps1" (
  echo Install-Relay.ps1 is missing. Extract ALL files from the zip first, then run this again.
  pause
  exit /b 2
)
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo Windows PowerShell was not found on this PC.
  pause
  exit /b 2
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Relay.ps1" %*
exit /b %ERRORLEVEL%
