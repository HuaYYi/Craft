@echo off
rem Craft ?? one-click launcher
rem Keeps this window open as the server window; close it to stop.
rem Pure ASCII on purpose: avoids cmd code-page / escaping problems.
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"

echo.
echo Service stopped. Press any key to close.
pause >nul