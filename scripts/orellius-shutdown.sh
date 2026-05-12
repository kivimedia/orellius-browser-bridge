#!/usr/bin/env bash
# Close EVERY Orellius window. Connected MCP clients stay.
set -e
curl -s -X POST http://127.0.0.1:18766/admin/shutdown
echo
