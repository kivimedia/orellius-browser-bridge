#!/usr/bin/env bash
# R34-HUB-SESSION-TAKEOVER: a local socket owned by a DIFFERENT uid must not be
# able to register under a live session id (and read that session's pages), nor
# replace the live native host (and receive every session's tool_requests).
#
# Linux only, needs `sudo -n -u nobody`, because the property under test IS the
# real peer uid - faking it would test the fake. Uses a throwaway hub on a random
# port with its own HOME, and only session ids this script invents.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HUB="$HERE/host/hub.js"
if [ "$(uname -s)" != "Linux" ] || ! sudo -n -u nobody true 2>/dev/null; then
  echo "SKIP: needs Linux + sudo -n -u nobody"; exit 0
fi
PORT=$(( 29000 + RANDOM % 900 ))
WORK="$(mktemp -d)"; chmod 755 "$WORK"
cleanup() { kill "$HUBPID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT
HOME="$WORK" ORELLIUS_IDLE_TIMEOUT_MS=0 node "$HUB" --port=$PORT >"$WORK/hub.out" 2>&1 &
HUBPID=$!
for _ in $(seq 50); do (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.1; done

# client.cjs <port> <json-register-line> <hold-ms> : prints "REG <json>" then "CLOSED" when the hub drops it.
cat >"$WORK/client.cjs" <<'JS'
const net = require("net");
const [port, line, hold] = process.argv.slice(2);
const s = net.connect(Number(port), "127.0.0.1", () => s.write(line + "\n"));
let buf = "";
s.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { console.log("REG " + buf.slice(0, i)); buf = buf.slice(i + 1); } });
s.on("close", () => { console.log("CLOSED"); process.exit(0); });
s.on("error", () => {});
setTimeout(() => { console.log("ALIVE"); process.exit(0); }, Number(hold));
JS
chmod 644 "$WORK/client.cjs"
SID="t$$takeover"
fail=0
check() { if eval "$2"; then echo "PASS: $1"; else echo "FAIL: $1"; fail=1; fi; }

# 1. incumbent (this uid) holds SID; foreign uid tries to take it.
node "$WORK/client.cjs" $PORT "{\"type\":\"register_mcp_client\",\"sessionId\":\"$SID\"}" 3000 >"$WORK/inc.out" &
INC=$!; sleep 0.5
sudo -n -u nobody node "$WORK/client.cjs" $PORT "{\"type\":\"register_mcp_client\",\"sessionId\":\"$SID\"}" 800 >"$WORK/atk.out"
wait $INC
check "foreign uid cannot take over a live session" "grep -q ALIVE '$WORK/inc.out' && ! grep -q '\"role\":\"mcp_client\"' '$WORK/atk.out'"

# 2. same uid reconnecting under its own id still replaces the stale socket.
node "$WORK/client.cjs" $PORT "{\"type\":\"register_mcp_client\",\"sessionId\":\"${SID}2\"}" 3000 >"$WORK/old.out" &
OLD=$!; sleep 0.5
node "$WORK/client.cjs" $PORT "{\"type\":\"register_mcp_client\",\"sessionId\":\"${SID}2\"}" 800 >"$WORK/new.out"
wait $OLD
check "same uid can still replace its own session" "grep -q CLOSED '$WORK/old.out' && grep -q '\"role\":\"mcp_client\"' '$WORK/new.out'"

# 3. foreign uid cannot register as (or replace) the native host.
node "$WORK/client.cjs" $PORT '{"type":"register_native_host","browser":"testbrowser"}' 3000 >"$WORK/nh.out" &
NH=$!; sleep 0.5
sudo -n -u nobody node "$WORK/client.cjs" $PORT '{"type":"register_native_host","browser":"testbrowser"}' 800 >"$WORK/nhatk.out"
wait $NH
check "foreign uid cannot replace the native host" "grep -q ALIVE '$WORK/nh.out' && ! grep -q '\"role\":\"native_host\"' '$WORK/nhatk.out'"

exit $fail
