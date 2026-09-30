@echo off
setlocal
chcp 65001 >nul
echo Agent Terminal Notifier - Install or Update from Repository
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" -SourceRoot "%~dp0." %*
set "pipelineExit=%ERRORLEVEL%"
echo.
if not "%pipelineExit%"=="0" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "Write-Host 'Pipeline failed with exit code %pipelineExit%. Check the output above.' -ForegroundColor Red"
echo.
pause
exit /b %pipelineExit%
