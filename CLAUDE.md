# Orellius Browser Bridge

The Chrome extension + hub that lets Claude drive a real browser (MCP `orellius-browser-bridge`).
Two installs: Ziv's PC (his Chrome, private-window default, extension reload over
`POST http://127.0.0.1:18766/admin/reload-extension`) and the VPS (the agents' browser).
Policy: REMOTE-FIRST - browse on the VPS unless the task is genuinely Ziv's own session.
Memory: `orellius-routing-policy.md`, `orellius-never-hand-back-a-connection-failure.md`,
`orellius-view-creds.md`, `vps-and-orellius-index.md`. Rule 15 governs anything on his screen.

## VPS footprint (Linode 104.200.30.37, user ziv)
- Path `/home/ziv/orellius-browser-bridge` (vendored into kmbot's browser sandbox by `install/browser-sandbox-setup.sh`, not carried in kmbot's git).
- pm2: `orellius-hub` (`host/hub.js`, TCP :18765), `orellius-chrome` (real Chrome + extension on Xvfb `:99`, profile `~/.chrome-orellius`, launched by `~/orellius-chrome-launch.sh` - NEVER the stock `start-chrome-*.sh`, they `killall chrome` and take the 17hats/linkedin/instagram browsers down), `courseiq-bridge` :18800. Start order: hub, chrome, bridge.
- Watch it live at https://104-200-30-37.sslip.io/orellius-view/ (TLS + basic auth; :5900 is localhost-only). `/show-me` skill.
- If no extension is registered: launch/reload it yourself, never hand the failure back.
