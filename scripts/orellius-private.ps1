# Force every Orellius browser session into private mode and lock it.
#
# Private mode: input ops only activate the target tab inside each session's
# owned Chrome window. The OS window is NEVER brought to the foreground -
# your active Chrome window stays in front, no focus theft.
#
# Lock: while engaged, no Claude session can switch back to public mode and
# `browser_show` only flashes the taskbar (no raise). Run orellius-unlock.ps1
# (or POST /admin/unlock) to re-enable public mode.

$ErrorActionPreference = "Stop"
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:18766/admin/force-private" -Method POST -ErrorAction Stop
    Write-Host ""
    Write-Host "Orellius:" -ForegroundColor Cyan -NoNewline
    Write-Host " $($resp.message)"
    if ($resp.delivered -eq 0) {
        Write-Host "Note: extension is not currently connected; the lock will apply once Chrome with the Orellius extension launches." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Could not reach the Orellius hub admin endpoint at http://127.0.0.1:18766/admin/force-private" -ForegroundColor Red
    Write-Host "Is the hub running? Open any Claude Code session that uses Orellius once - the hub auto-spawns." -ForegroundColor Yellow
    Write-Host "Underlying error: $($_.Exception.Message)" -ForegroundColor DarkGray
}
