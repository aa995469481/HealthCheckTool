@echo off
setlocal EnableDelayedExpansion
title Quick Push to GitHub
cd /d "%~dp0"

echo ============================================
echo    Quick Push to GitHub
echo ============================================
echo.

rem ---------- 1. Checks ----------
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Git not found. Install Git for Windows first.
    pause
    exit /b 1
)
if not exist ".git" (
    echo [ERROR] This folder is not a git repository yet.
    echo         Run push-github.bat once first.
    pause
    exit /b 1
)
set "REMOTE="
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set "REMOTE=%%r"
if "!REMOTE!"=="" (
    echo [ERROR] No remote "origin" found. Run push-github.bat once first.
    pause
    exit /b 1
)

rem ---------- 2. Commit all changes ----------
git add -A
set "MSG="
if not "%~1"=="" set "MSG=%~1"
if "!MSG!"=="" set "MSG=update !DATE! !TIME!"
git commit -m "!MSG!" >nul 2>&1
if errorlevel 1 (
    echo     No changes to commit.
) else (
    echo     Committed: !MSG!
)

rem ---------- 3. Push, auto-merge if rejected ----------
set "PUSH_TRIES=0"
:do_push
git push -u origin main > "%TEMP%\git-push.log" 2>&1
set "PUSH_EC=!errorlevel!"
type "%TEMP%\git-push.log"
if "!PUSH_EC!"=="0" goto :push_ok
findstr /i /c:"rejected" /c:"error:" /c:"failed" /c:"denied" /c:"fatal" "%TEMP%\git-push.log" >nul 2>&1
if errorlevel 1 goto :push_ok
set /a PUSH_TRIES+=1
if !PUSH_TRIES! gtr 1 goto :fail_push
echo.
echo     Remote has newer commits, merging first...
git pull --rebase origin main
if errorlevel 1 goto :fail_pull
goto :do_push

:push_ok
echo.
echo [DONE] Pushed to GitHub.
echo         Repo: !REMOTE!
timeout /t 3 >nul
exit /b 0

:fail_pull
echo.
echo [ERROR] Merge failed. Resolve conflicts or check network.
pause
exit /b 1

:fail_push
echo.
echo [ERROR] Push failed. See the messages above.
pause
exit /b 1
