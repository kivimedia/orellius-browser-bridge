@echo off
REM Launch Firefox with WebDriver BiDi enabled, profile = "orellius".
REM Required before using Orellius for Firefox so host/bidi-driver.js can
REM connect to the Firefox Remote Agent at 127.0.0.1:9222.

setlocal

REM Resolve Firefox install path. Override with FIREFOX_PATH env var if needed.
if defined FIREFOX_PATH (
    set "FF=%FIREFOX_PATH%"
) else if exist "%ProgramFiles%\Mozilla Firefox\firefox.exe" (
    set "FF=%ProgramFiles%\Mozilla Firefox\firefox.exe"
) else if exist "%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe" (
    set "FF=%ProgramFiles(x86)%\Mozilla Firefox\firefox.exe"
) else (
    echo Firefox not found. Set FIREFOX_PATH env var or install Firefox.
    exit /b 1
)

set "PROFILE=%~1"
if "%PROFILE%"=="" set "PROFILE=orellius"

set "PORT=%~2"
if "%PORT%"=="" set "PORT=9222"

echo Launching Firefox profile "%PROFILE%" with --remote-debugging-port=%PORT%
echo (Profile must already exist. Run: "%FF%" -P  to create it the first time.)
echo.

start "" "%FF%" -P "%PROFILE%" --remote-debugging-port=%PORT%

endlocal
