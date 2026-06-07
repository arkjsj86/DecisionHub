@echo off
setlocal
cd /d "%~dp0"

REM ============================================================
REM  Project Decision Hub launcher
REM  - If the server is already running: just open the browser.
REM  - Otherwise: start the server in its own window, then open.
REM ============================================================

set "PORT=8787"
set "URL=http://localhost:%PORT%"

REM --- Already listening on the port? Just open the browser. ---
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [Decision Hub] Already running -- opening %URL%
    start "" "%URL%"
    goto :end
)

REM --- Not running: launch the server in a separate window. ---
echo [Decision Hub] Starting server on %URL% ...
start "Decision Hub Server" cmd /c node server.js

REM Give node ~2s to bind the port before opening the browser.
timeout /t 2 /nobreak >nul
start "" "%URL%"

echo [Decision Hub] Launched. Closing the last browser tab will stop the server.

:end
endlocal
