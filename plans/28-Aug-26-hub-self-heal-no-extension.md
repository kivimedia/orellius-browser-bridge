# Hub self-heal when no extension is connected (28-Aug-26)

## Goal
Stop Claude sessions from handing Ziv an Orellius "extension not connected" outage. Twice on
2026-08-27 a session ended with "reconnect the extension and say the word" when the only
missing action was launching Chrome (case 1) or waiting ~60s for the extension's own keepalive
(case 2). Ziv: "couldn't it manage to solve this by himself? All I did was run a new chrome."

## Root causes found
1. `hub.js` failed a tool call INSTANTLY when no native host was registered, with text addressed
   to a human ("Open a chromium browser with the Orellius extension loaded"). The model forwarded
   it to the human as an instruction.
2. The 404 `available` list on the admin server omitted `/admin/reload-extension` and
   `/admin/set-pin`. A session read the list and concluded "this build has no reload-extension".
3. `mcp-server.js` had a second human-addressed message ("Make sure a supported browser is
   running...").
4. No rule or memory said "launch Chrome yourself when there is none", and rule 15's caution made
   sessions treat a Chrome launch as desktop control.

## Approach (done)
- `host/hub.js` "Native-host recovery": park the call (up to `ORELLIUS_RECOVERY_WAIT_MS`, 50s);
  count browser processes; if none, launch Chrome via WMI `Win32_Process.Create` (parent
  `WmiPrvSE.exe`, survives the hub; `--profile-directory=Default`, the profile holding the
  unpacked extension); if running, wait for the extension keepalive; flush parked calls when a
  host registers; on deadline, fail with a model-directed message (what the hub did + retry /
  reload-extension / desktop-MCP reload). `/admin/status` gains `parkedRequests`, `recovery`,
  `recoveryInFlight`. 404 list completed. Linux (VPS) never launches - pm2 owns that Chrome.
- `host/mcp-server.js`: "Hub is not connected" text rewritten for the model.
- `scripts/test-hub-recovery.mjs`: 4 cases on spare ports, no real browser (wscript marker file
  stands in for Chrome).
- Rule 15 table: Chrome launch when none is running = free; desktop-MCP reload of the extension
  when the HTTP reload delivers to nobody = pre-authorized (Ziv 2026-08-27).
- Memory: `orellius-never-hand-back-a-connection-failure.md` (full ladder), scope note on
  `feedback_dont_pre_launch_chrome_for_orellius.md`, index lines, CLAUDE.md desktop bullet.
- Hookify stop-gate `orellius-no-handback` fires on the hand-back phrasing itself.

## Rejected
- Chrome's `--native-messaging-connect-host` launch (wakes the service worker with no window):
  behind `features::kOnConnectNative`, DISABLED by default in Chrome 151. Cannot be enabled on a
  running Chrome. Dropped.
- `--no-startup-window` cold launch: Chrome exits immediately with nothing holding a keep-alive
  (verified with a throwaway profile). Dropped; a normal launch is what Ziv does by hand anyway.

## Found on the way: the VPS hub.js had 3 days of uncommitted edits
Both VPS checkouts (`~/.openclaw/workspace/orellius-browser-bridge`, which pm2 runs, and
`~/orellius-browser-bridge`) carried the same uncommitted 2026-08-25 hardening: the legacy
native-host registration is gated behind `ORELLIUS_ALLOW_LEGACY_NATIVE_HOST=1`, and the admin
port refuses any request carrying an `Origin` header. Ported upstream in this change, with the
extension's own origin (from the native-host manifest) allowed explicitly and refusals logged.

Suspected, then DISPROVED: that the blanket Origin refusal 403'd the extension's own keepalive
probe and disabled the half-open self-heal. `curl -H "Origin: chrome-extension://<vps id>"`
did get 403, but a 40s `tcpdump -i lo` on the VPS caught two real probes from Chrome 152 and
neither carried an Origin header at all. Extension fetches to a host-permitted URL send no
Origin. The allowance stays as future-proofing; it was not the cause of anything.

## Verification
- `node --check` on hub.js and mcp-server.js.
- `node scripts/test-hub-recovery.mjs` -> all cases pass (see commit).
- A hub started before this change keeps the old behaviour until respawned; the live local hub
  (pid 5052) was busy with two active sessions at 00:18 IST and was left alone.

## Open questions
- Whether a crashed (not merely dormant) MV3 service worker is woken by anything short of a
  reload. Untested; rung 5 (desktop-MCP reload) covers it.
