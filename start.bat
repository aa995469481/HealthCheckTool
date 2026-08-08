@echo off
setlocal EnableDelayedExpansion
title Service Inspection System - Start
cd /d "%~dp0"

rem npm registries to try in order
set "REG1=https://registry.npmmirror.com"
set "REG2=https://mirrors.cloud.tencent.com/npm"
set "REG3=https://registry.npmjs.org"

echo ============================================
echo    Service Inspection System - One-Click Start
echo ============================================
echo.

rem ---------- 1. Check / auto-install Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
    echo [1/4] Node.js not found. Installing portable Node.js...
    echo.
    call :install_node
    if errorlevel 1 (
        echo.
        echo [ERROR] Node.js auto-install failed. Check network and retry.
        pause
        exit /b 1
    )
) else (
    echo [1/4] Node.js ready
)

for /f "delims=" %%v in ('node -v') do set "NODE_V=%%v"
for /f "delims=" %%v in ('npm -v') do set "NPM_V=%%v"
for /f "delims=.v tokens=1" %%m in ('node -v') do set "NODE_MAJOR=%%m"
echo         Node: %NODE_V%  /  npm: %NPM_V%

rem Vite 5 requires Node 18 or higher
if %NODE_MAJOR% LSS 18 (
    echo.
    echo [ERROR] Node is too old, 18 or higher is required. Please upgrade.
    pause
    exit /b 1
)
echo.

rem ---------- 2. Install dependencies, skip if already installed ----------
if exist "server\node_modules" goto :web_deps
echo [2/4] Installing server dependencies...
call :npm_install server
if errorlevel 1 (
    echo [ERROR] Server dependencies install failed. Check network and retry.
    pause
    exit /b 1
)

:web_deps
if exist "web\node_modules" goto :start_servers
echo [2/4] Installing web dependencies...
call :npm_install web
if errorlevel 1 (
    echo [ERROR] Web dependencies install failed. Check network and retry.
    pause
    exit /b 1
)

rem ---------- 3. Start backend and frontend ----------
:start_servers
echo.
echo [3/4] Starting services...
echo.
echo     Backend:  http://localhost:3000
echo     Frontend: http://localhost:8080
echo     Open the frontend URL in your browser once it is ready.
echo.
start "Server-3000" cmd /k "cd /d %~dp0server && npm start"
start "Web-8080" cmd /k "cd /d %~dp0web && npm run dev"
echo.
echo [4/4] Services are starting. You may close this window now.
echo Note: do not run this script twice. Close the two black windows to stop.
echo.
pause
exit /b

rem ---------- install dependencies, trying multiple registries ----------
:npm_install
rem %~1 = directory containing package.json
pushd "%~1"
set "INSTALLED="
set "CUR_REG="
for /f "delims=" %%r in ('npm config get registry') do set "CUR_REG=%%r"
for %%r in ("!CUR_REG!" "%REG1%" "%REG2%" "%REG3%") do (
    if not defined INSTALLED (
        if not "%%~r"=="" (
            echo.
            echo     Trying registry: %%~r
            call npm install --registry=%%~r --fetch-retries=1 --fetch-timeout=30000
            if not errorlevel 1 set "INSTALLED=1"
        )
    )
)
popd
if defined INSTALLED exit /b 0
exit /b 1

rem ---------- download and install portable Node.js ----------
:install_node
set "NODE_VER=22.23.2"
set "DEST=%LOCALAPPDATA%\nodejs"
set "ZIP=%TEMP%\node-v%NODE_VER%-win-x64.zip"
set "URL=https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"

echo     Download URL: %URL%
echo     Install dir: %DEST%
echo.
echo     Downloading Node.js, about 36MB, please wait...
curl -L --retry 2 --connect-timeout 30 -o "%ZIP%" "%URL%"
if errorlevel 1 (
    echo     Official source failed, trying CN mirror...
    curl -L --retry 2 --connect-timeout 30 -o "%ZIP%" "https://npmmirror.com/mirrors/node/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip"
    if errorlevel 1 (
        echo     [ERROR] Download failed. Check your network.
        exit /b 1
    )
)

echo     Extracting, this may take a minute, please wait...
rmdir /s /q "%LOCALAPPDATA%\node-tmp" 2>nul
mkdir "%LOCALAPPDATA%\node-tmp" 2>nul
tar -xf "%ZIP%" -C "%LOCALAPPDATA%\node-tmp" >nul 2>&1
if errorlevel 1 (
    echo     tar unavailable, using PowerShell fallback...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%LOCALAPPDATA%\node-tmp' -Force"
)
if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%" 2>nul
rem move contents up from the extracted folder into DEST
for /d %%d in ("%LOCALAPPDATA%\node-tmp\*") do (
    move "%%d\*" "%DEST%\" >nul 2>&1
    rmdir /s /q "%%d" 2>nul
)
rem handle flat layout, move remaining files up
if not exist "%DEST%\node.exe" (
    move "%LOCALAPPDATA%\node-tmp\*" "%DEST%\" >nul 2>&1
)
rmdir /s /q "%LOCALAPPDATA%\node-tmp" 2>nul
if not exist "%DEST%\node.exe" (
    echo     [ERROR] Extract failed.
    exit /b 1
)

echo     Updating user PATH...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%DEST%'; $u=[Environment]::GetEnvironmentVariable('Path','User'); if($u){ if($u -notlike '*nodejs*'){ [Environment]::SetEnvironmentVariable('Path',$d+';'+$u,'User') } } else { [Environment]::SetEnvironmentVariable('Path',$d,'User') }"

set "PATH=%DEST%;%PATH%"
echo     Node.js installed.
exit /b 0
