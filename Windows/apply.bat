@echo off
setlocal
chcp 65001 >nul
echo Agent Terminal Notifier - Install or Update Latest Release
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1" -SourceRoot "%~dp0." %*
set "pipelineExit=%ERRORLEVEL%"
echo.
if "%pipelineExit%"=="0" (
    echo Pipeline completed. Reload VSCode and restart Codex / Claude sessions.
) else (
    echo Pipeline failed with exit code %pipelineExit%. Check the output above.
)
echo.
pause
exit /b %pipelineExit%
