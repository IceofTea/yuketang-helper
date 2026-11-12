@echo off
rem YuKeTang helper launcher - plain-text wrapper, needs Python (py launcher) on PATH
cd /d "%~dp0"

py -c "import websockets" 2>nul
if errorlevel 1 (
    echo [setup] installing dependency: websockets ...
    py -m pip install websockets
)

py launcher.py
if errorlevel 1 (
    echo.
    echo [ERROR] launcher exited abnormally. Make sure "py" is installed and on PATH.
    pause
)
