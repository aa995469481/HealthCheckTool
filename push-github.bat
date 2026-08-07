@echo off
setlocal EnableDelayedExpansion
title Push code to GitHub
cd /d "%~dp0"

echo ============================================
echo    Push project to GitHub (SSH)
echo ============================================
echo.

rem Default: start from step 4, steps 1-3 are already done.
rem Run with argument "full" to redo steps 1-3 from scratch.
if /i not "%~1"=="full" goto :step4

rem ---------- 1. Check Git ----------
where git >nul 2>nul
if errorlevel 1 (
    echo [1/5] Git not found.
    echo.
    echo     Please install Git for Windows first:
    echo       1. Download from https://git-scm.com/download/win
    echo       2. Run the installer and keep default options
    echo       3. Close and reopen this window, then run this script again
    echo.
    pause
    exit /b 1
)
echo [1/5] Git ready
git --version
echo.

rem ---------- 2. Init repo and configure commit identity ----------
echo [2/5] Init repo and configure commit identity...
if not exist ".git" git init -b main >nul
set /p GIT_NAME=  GitHub username: 
set /p GIT_EMAIL=  GitHub email: 
if "!GIT_NAME!"=="" set "GIT_NAME=github-user"
if "!GIT_EMAIL!"=="" set "GIT_EMAIL=user@example.com"
git config user.name "!GIT_NAME!"
git config user.email "!GIT_EMAIL!"
echo.

rem ---------- 3. SSH key ----------
echo [3/5] Check SSH key...
if not exist "%USERPROFILE%\.ssh\id_ed25519.pub" (
    echo     No key found. Generating ed25519 key...
    set "SSHG="
    where ssh-keygen >nul 2>nul && set "SSHG=ssh-keygen"
    if not defined SSHG for /f "delims=" %%i in ('where git') do set "SSHG=%%~dpi..\usr\bin\ssh-keygen.exe"
    if not defined SSHG if exist "%ProgramFiles%\Git\usr\bin\ssh-keygen.exe" set "SSHG=%ProgramFiles%\Git\usr\bin\ssh-keygen.exe"
    if not defined SSHG if exist "%ProgramFiles(x86)%\Git\usr\bin\ssh-keygen.exe" set "SSHG=%ProgramFiles(x86)%\Git\usr\bin\ssh-keygen.exe"
    if not defined SSHG if exist "%LOCALAPPDATA%\Programs\Git\usr\bin\ssh-keygen.exe" set "SSHG=%LOCALAPPDATA%\Programs\Git\usr\bin\ssh-keygen.exe"
    if not defined SSHG (
        echo     [ERROR] ssh-keygen not found. Install Git for Windows and retry.
        pause
        exit /b 1
    )
    if not exist "%USERPROFILE%\.ssh" mkdir "%USERPROFILE%\.ssh"
    "!SSHG!" -t ed25519 -C "!GIT_EMAIL!" -N "" -f "%USERPROFILE%\.ssh\id_ed25519"
    if errorlevel 1 (
        echo     [ERROR] SSH key generation failed.
        pause
        exit /b 1
    )
)
echo.
echo     Copy the PUBLIC KEY below and add it to GitHub:
echo     https://github.com/settings/ssh/new
echo.
type "%USERPROFILE%\.ssh\id_ed25519.pub"
echo.
echo.
set /p DUMMY=  Press Enter after adding the key...
echo.

:step4
rem ---------- 4. Commit code ----------
echo [4/5] Commit code...
git add -A
git commit -m "init: service inspection system Vue3 + Express"
echo.

rem ---------- 5. Add remote and push ----------
echo [5/5] Add remote and push...
set /p GIT_REPO=  Enter repo SSH URL, e.g. git@github.com:user/repo.git: 
if "!GIT_REPO!"=="" (
    echo     [ERROR] No repo URL entered.
    pause
    exit /b 1
)
git remote remove origin >nul 2>nul
git remote add origin "!GIT_REPO!"

rem Auto-accept host key on first connect to avoid hanging
set "SSHCMD="
where ssh >nul 2>nul && set "SSHCMD=ssh -o StrictHostKeyChecking=accept-new"
if not defined SSHCMD for /f "delims=" %%i in ('where git') do set "SSHCMD=%%~dpi..\usr\bin\ssh.exe -o StrictHostKeyChecking=accept-new"
if not defined SSHCMD if exist "%ProgramFiles%\Git\usr\bin\ssh.exe" set "SSHCMD=%ProgramFiles%\Git\usr\bin\ssh.exe -o StrictHostKeyChecking=accept-new"
if not defined SSHCMD if exist "%ProgramFiles(x86)%\Git\usr\bin\ssh.exe" set "SSHCMD=%ProgramFiles(x86)%\Git\usr\bin\ssh.exe -o StrictHostKeyChecking=accept-new"
if not defined SSHCMD if exist "%LOCALAPPDATA%\Programs\Git\usr\bin\ssh.exe" set "SSHCMD=%LOCALAPPDATA%\Programs\Git\usr\bin\ssh.exe -o StrictHostKeyChecking=accept-new"
set "GIT_SSH_COMMAND=!SSHCMD!"
git push -u origin main
if errorlevel 1 (
    echo.
    echo [ERROR] Push failed. Common causes:
    echo   1. Public key not added or not active, rerun this script
    echo   2. Wrong SSH repo URL
    echo   3. Repo is not empty, run: git pull --rebase origin main
    echo      then rerun this script.
    echo.
    echo   Check SSH: ssh -T git@github.com
    pause
    exit /b 1
)
echo.
echo [DONE] Code pushed to GitHub!
echo         Repo: !GIT_REPO!
echo.
pause
endlocal
exit /b
