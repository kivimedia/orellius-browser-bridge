@echo off
REM Close EVERY Orellius window. Connected MCP clients stay - their next
REM browser call (tabs_context_mcp with createIfEmpty:true) auto-creates
REM a fresh window.
curl -s -X POST http://127.0.0.1:18766/admin/shutdown
echo.
