#!/usr/bin/env bash
# Close every Orellius window whose Claude session is no longer connected.
set -e
curl -s -X POST http://127.0.0.1:18766/admin/close-unused
echo
