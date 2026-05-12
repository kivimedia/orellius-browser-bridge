# Orellius Isolated Mode

Each Claude Code (VS Code) session that opts into this mode launches its **own
Chrome process** with its own `--user-data-dir` and `--remote-debugging-port`.
Sessions cannot interfere with each other because they're different OS
processes — no shared extension service worker, no shared native host, no
shared session-window claim.

This solves three problems with the regular extension-mode bridge:

1. **Multi-VSCode crosstalk.** Two VS Code Claude sessions sharing one Chrome
   were stepping on each other's tabs, debugger attachments, and window claims.
2. **`record_video` regression in v1.7.3.** The 6-second alarm tick that
   re-foregrounded the recording window could race with `assertTabInOwnedWindow`
   and silently drop the session's window claim, killing capture mid-flight.
3. **Blurry video.** Screenshots from the user's Chrome window came out at
   small dimensions and got padded into 1280×720, wasting most of the frame
   on whitespace.

In isolated mode, you own the browser. None of the above can happen.

## Trade-off

The isolated Chrome starts with a **fresh profile** — no logged-in cookies, no
extensions, no bookmarks. For automation against the user's existing logged-in
sessions, keep using the regular `mcp-server.js` (extension-mode). Isolated
mode is for: capture, recording, automated walkthroughs, demos, public-page
work.

## Opt-in (Claude Code MCP config)

Add an MCP server entry pointing at `mcp-server-iso.js`. On Windows that
file lives at:

```
E:/FromC/projects/orellius-browser-bridge/host/mcp-server-iso.js
```

Example `~/.claude/mcp_settings.json` snippet:

```json
{
  "mcpServers": {
    "orellius-iso": {
      "command": "node",
      "args": ["E:/FromC/projects/orellius-browser-bridge/host/mcp-server-iso.js"]
    }
  }
}
```

After restart, the new tools are available namespaced as
`mcp__orellius-iso__*`:

- `tabs_context_mcp(createIfEmpty: true)` — boot Chrome and return the tabId
- `tabs_create_mcp` / `tabs_close_mcp`
- `navigate({ url, tabId })`
- `computer({ action, tabId, ... })` — full mouse/keyboard/screenshot surface
- `javascript_tool({ action: "javascript_exec", tabId, text })`
- `record_video({ tabId, durationSec, savePath })` — single-step capture
- `session_end()`

You can run **both** the extension-mode `orellius` and the `orellius-iso`
servers at the same time and pick per task — they don't share state.

## Env vars

| Var | Default | Effect |
|---|---|---|
| `CHROME_PATH` | autodetect | Override Chrome/Edge binary path. |
| `ORELLIUS_ISO_WIDTH` | 1280 | Initial window width. |
| `ORELLIUS_ISO_HEIGHT` | 720 | Initial window height. |
| `ORELLIUS_ISO_EPHEMERAL` | (unset) | When `=1`, wipe the user-data-dir on session_end. |

## Smoke test

```bash
cd E:/FromC/projects/orellius-browser-bridge/host
node test-iso-smoke.js
```

Should print 10 PASS lines: launch chrome → connect CDP → create page session
→ navigate → screenshot → evaluate → click → type → record 5s video →
teardown. Output goes to a fresh `%TEMP%/orellius-iso-smoke-*` dir.

## Architecture

```
Claude Code  ──stdio──▶  mcp-server-iso.js
                              │
                              │ launches Chrome with --user-data-dir, --remote-debugging-port
                              ▼
                          chrome.exe ──ws──▶  CDP /devtools/browser/<id>
                              │
                              ▼
                          screencast frames, screenshots, input events
                              │
                              ▼
                          ffmpeg (for record_video)
```

There is **no extension** in isolated mode. There is **no native host**.
There is **no hub**. Just an MCP server that owns one Chrome process.

## What's not implemented (yet)

- `find` / `read_page` (accessibility tree) — intentionally skipped for v0.1;
  use `javascript_tool` to query the DOM if needed.
- `browser_lock` / `browser_show` / `browser_mode` / `browser_hide` — not
  needed (no contention to lock against; window visibility is controlled by
  the launcher).
- `upload_image`, `read_console_messages`, `read_network_requests` — can be
  added easily by routing through `Page.fileChooserOpened`, `Runtime.consoleAPICalled`,
  and `Network.responseReceived` events respectively.
- Session save/restore — fresh-profile mode means there's nothing to save.
