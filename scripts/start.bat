@echo off
setlocal
title Control Panel Launcher
echo =======================================================
echo          Starting Control Panel HUD Server...
echo =======================================================

cd /d "%~dp0\.."

where node.exe >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Windows Node.js is not on PATH. Install Node.js for Windows and run npm install in a Windows terminal.
    pause
    exit /b 1
)

for /f "delims=" %%N in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%N"
if not defined NPM_CMD (
    echo [ERROR] Windows npm is not on PATH. Install Node.js for Windows and run npm install in a Windows terminal.
    pause
    exit /b 1
)

echo [OK] Using Windows Node.js runtime...
start "Control Panel Server" cmd /k call "%NPM_CMD%" start

:: Wait 3 seconds for server to start
timeout /t 3 /nobreak >nul

:: Open settings on primary screen
start http://localhost:3888/settings

:: Launch HUD onto the secondary screen
powershell.exe -ExecutionPolicy Bypass -File scripts\launch-hud.ps1

echo Control Panel is up and running!
