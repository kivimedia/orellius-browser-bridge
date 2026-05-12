@echo off
REM Release the global "force private" lock - sessions can switch into public
REM mode again via the browser_mode tool.

set ADMIN_URL=http://127.0.0.1:18766/admin/unlock
curl -s -X POST %ADMIN_URL%
echo.
