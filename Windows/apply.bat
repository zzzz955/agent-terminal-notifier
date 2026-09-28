@echo off
setlocal
echo Agent Terminal Notifier - Build, Verify and Install
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pipeline.ps1" -Install %*
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
