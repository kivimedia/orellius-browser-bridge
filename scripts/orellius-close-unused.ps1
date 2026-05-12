# Close every Orellius window whose Claude session is no longer connected.
# Currently-active Claude sessions keep their tabs.
$ErrorActionPreference = "Stop"
try {
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:18766/admin/close-unused" -Method POST -ErrorAction Stop
    Write-Host ""
    Write-Host "Orellius:" -ForegroundColor Cyan -NoNewline
    Write-Host " $($resp.message)"
} catch {
    Write-Host "Could not reach the Orellius hub at http://127.0.0.1:18766/admin/close-unused" -ForegroundColor Red
    Write-Host "Underlying error: $($_.Exception.Message)" -ForegroundColor DarkGray
}
