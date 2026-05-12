@echo off
REM Close every Orellius window whose Claude session is no longer connected.
REM Currently-active sessions keep their tabs.
curl -s -X POST http://127.0.0.1:18766/admin/close-unused
echo.
