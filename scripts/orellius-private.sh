#!/usr/bin/env bash
# Force every Orellius browser session into private mode and lock it.
# See orellius-private.cmd for the same command on Windows.
set -e
curl -s -X POST http://127.0.0.1:18766/admin/force-private
echo
