@echo off
title Unlock PowerShell execution policy

echo ============================================
echo       Unlock PowerShell Execution Policy
echo ============================================
echo.
echo This fixes the error: ".ps1 cannot be loaded because
echo running scripts is disabled on this system".
echo It sets the CurrentUser execution policy to RemoteSigned.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force"

if errorlevel 1 (
    echo.
    echo [FAILED] Could not unlock. It may be restricted by Group Policy.
    echo         start.bat still works, batch files are not affected.
) else (
    echo.
    echo [OK] Unlocked. You can now run node / npm commands.
)
echo.
pause
