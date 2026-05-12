@echo off
REM Force every Orellius browser session into private mode and lock it.
REM
REM Private mode: input ops only activate the target tab inside each session's
REM owned Chrome window. The OS window is NEVER brought to the foreground -
REM your active Chrome window stays in front, no focus theft.
REM
REM Lock: while engaged, no Claude session can switch back to public mode and
REM `browser_show` only flashes the taskbar (no raise). Run scripts\orellius-unlock.cmd
REM (or POST /admin/unlock) to re-enable public mode.

set ADMIN_URL=http://127.0.0.1:18766/admin/force-private
curl -s -X POST %ADMIN_URL%
echo.
echo Done. If you saw "delivered: 0" above, the Orellius extension is not
echo currently connected to the hub - the lock is still persisted in extension
echo storage and will take effect as soon as Chrome with the extension comes up.
