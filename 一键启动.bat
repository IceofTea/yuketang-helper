@echo off
rem ============================================================
rem  Yuketang Helper - one-click launcher
rem  1) ensure Edge is running with remote-debugging-port 9222
rem  2) ensure python deps, rebuild inject.js
rem  3) start watchdog (auto re-injects the HUD into course tabs)
rem ============================================================
setlocal
cd /d "%~dp0"

echo [1/4] Checking browser debug port 9222 ...
curl -s --max-time 3 http://localhost:9222/json/version >nul 2>&1
if errorlevel 1 (
    echo       Port not open. Starting Edge with remote debugging ...
    set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
    if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
    if not exist "%EDGE%" (
        echo [ERROR] msedge.exe not found. Start your browser manually with:
        echo         --remote-debugging-port=9222
        pause
        exit /b 1
    )
    start "" "%EDGE%" --remote-debugging-port=9222
    timeout /t 5 /nobreak >nul
) else (
    echo       OK - debug port already up.
)

echo [2/4] Checking python and websockets ...
py -c "import websockets" >nul 2>&1
if errorlevel 1 (
    echo       Installing websockets ...
    py -m pip install -q websockets
    if errorlevel 1 ( echo [ERROR] pip install failed & pause & exit /b 1 )
)

echo [3/4] Rebuilding inject.js from latest userscript ...
py "%~dp0tools\make_inject.py" >nul 2>&1
if errorlevel 1 echo       [warn] make_inject failed, using existing inject.js

echo [4/4] Starting watchdog in background ...
rem Always (re)start watchdog so it loads the freshest inject.js
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'Name=''python.exe''' | Where-Object { $_.CommandLine -like '*watchdog*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "ykt-watchdog" /min py "%~dp0tools\watchdog.py"

echo.
echo ============================================================
echo  All set. Now open this page in the browser window that was
echo  just started (or any Edge window with debugging enabled):
echo.
echo      https://yjsy-fjnu.yuketang.cn/pro/courselist
echo.
echo  The HUD panel will inject automatically. Keep the watchdog
echo  console window running while brushing; close it to stop.
echo ============================================================
pause
