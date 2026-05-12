# Release the global "force private" lock - sessions can switch into public
# mode again via the browser_mode tool.

$ErrorActionPreference = "Stop"
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:18766/admin/unlock" -Method POST -ErrorAction Stop
    Write-Host ""
    Write-Host "Orellius:" -ForegroundColor Cyan -NoNewline
    Write-Host " $($resp.message)"
} catch {
    Write-Host "Could not reach the Orellius hub admin endpoint at http://127.0.0.1:18766/admin/unlock" -ForegroundColor Red
    Write-Host "Underlying error: $($_.Exception.Message)" -ForegroundColor DarkGray
}
