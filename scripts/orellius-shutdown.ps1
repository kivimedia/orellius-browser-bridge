# Close EVERY Orellius window. Connected MCP clients stay - their next
# browser call auto-creates a fresh window.
$ErrorActionPreference = "Stop"
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:18766/admin/shutdown" -Method POST -ErrorAction Stop
    Write-Host ""
    Write-Host "Orellius:" -ForegroundColor Cyan -NoNewline
    Write-Host " $($resp.message)"
} catch {
    Write-Host "Could not reach the Orellius hub at http://127.0.0.1:18766/admin/shutdown" -ForegroundColor Red
    Write-Host "Underlying error: $($_.Exception.Message)" -ForegroundColor DarkGray
}
