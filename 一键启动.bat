@echo off
rem ============================================================
rem  Yuketang Helper - one-click launcher
rem  1) find a usable Python 3.8+  (py / python / python3)
rem  2) ensure Edge or Chrome with remote-debugging-port 9222
rem  3) install python deps + rebuild inject.js
rem  4) start watchdog (auto re-injects the HUD into course tabs)
rem ============================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

rem ---------- [1/4] locate a usable Python ----------
echo [1/4] Looking for Python 3.8+ ...
set "PYEXE="
for %%c in ("py -3" "py" "python" "python3") do (
    if not defined PYEXE (
        %%~c -c "import sys;exit(0 if sys.version_info>=(3,8) else 1)" >nul 2>&1
        if not errorlevel 1 set "PYEXE=%%~c"
    )
)
if not defined PYEXE (
    echo.
    echo [ERROR] No usable Python found.
    echo     This launcher needs Python 3.8 or newer.
    echo     Install from https://www.python.org/downloads/
    echo     IMPORTANT: tick "Add python.exe to PATH" during install
    echo     ^(the "py" launcher is included by default^).
    echo     After installing, run this file again.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('%PYEXE% -c "import platform;print(platform.python_version())"') do echo       Found Python %%v   ^(%PYEXE%^)

rem ---------- [2/4] browser debug port ----------
echo [2/4] Checking browser debug port 9222 ...
set "PORTUP=0"
curl -s --max-time 3 http://localhost:9222/json/version >nul 2>&1
if errorlevel 9009 (
    rem curl missing (pre-Win10) - probe via PowerShell instead
    powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -UseBasicParsing -TimeoutSec 3)|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
    if not errorlevel 1 set "PORTUP=1"
) else if not errorlevel 1 (
    set "PORTUP=1"
)
if "!PORTUP!"=="0" (
    echo       Port not open. Looking for a browser to start ...
    set "BROWSER="
    if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
    if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
    if not defined BROWSER (
        echo.
        echo [ERROR] Edge / Chrome not found in standard paths.
        echo     Start your browser manually with this flag, then rerun:
        echo         --remote-debugging-port=9222
        echo     Example:  chrome.exe --remote-debugging-port=9222
        echo.
        pause
        exit /b 1
    )
    echo       Starting browser with remote debugging ...
    start "" "!BROWSER!" --remote-debugging-port=9222
    timeout /t 5 /nobreak >nul
    set "PORTUP=0"
    curl -s --max-time 3 http://localhost:9222/json/version >nul 2>&1
    if errorlevel 9009 (
        powershell -NoProfile -Command "try{(Invoke-WebRequest -Uri 'http://localhost:9222/json/version' -UseBasicParsing -TimeoutSec 3)|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
        if not errorlevel 1 set "PORTUP=1"
    ) else if not errorlevel 1 (
        set "PORTUP=1"
    )
    if "!PORTUP!"=="0" (
        echo [ERROR] Debug port still not reachable.
        echo     Close ALL windows of that browser first, then rerun
        echo     ^(a running browser without the flag hijacks new launches^).
        pause
        exit /b 1
    )
) else (
    echo       OK - debug port already up.
)

rem ---------- [3/4] deps + inject.js ----------
echo [3/4] Checking python deps + rebuilding inject.js ...
%PYEXE% -c "import websockets" >nul 2>&1
if errorlevel 1 (
    echo       Installing websockets ...
    %PYEXE% -m pip install -q websockets
    if errorlevel 1 (
        echo [ERROR] pip install failed - likely no network.
        echo     Run this manually in a terminal, then rerun:
        echo         %PYEXE% -m pip install websockets
        pause
        exit /b 1
    )
)
%PYEXE% "%~dp0tools\make_inject.py" >nul 2>&1
if errorlevel 1 echo       [warn] make_inject failed, using existing inject.js
if not exist "%~dp0tools\inject.js" (
    echo [ERROR] tools\inject.js missing and rebuild failed.
    pause
    exit /b 1
)

rem ---------- [4/4] watchdog ----------
echo [4/4] Starting watchdog in background ...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''python.exe''' | Where-Object { $_.CommandLine -like '*watchdog*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "ykt-watchdog" /min %PYEXE% "%~dp0tools\watchdog.py"

echo.
echo ============================================================
echo  All set. In the debug browser window, open:
echo.
echo      https://yjsy-fjnu.yuketang.cn/pro/courselist
echo.
echo  The HUD panel injects automatically. Keep the watchdog
echo  console running while brushing; close it to stop.
echo ============================================================
pause
