# Playwright-grade video recording for Orellius

## Goal
Replace the `gif_creator` stub with a real video-recording pipeline that matches Playwright's `recordVideo` capability: live frame capture from the active tab, synthetic cursor + click overlay composited per frame, encoded to WebM via ffmpeg, written to disk through the native host.

## Why
Right now `gif_creator` returns "GIF recording is not yet implemented in this extension." (extension/background.js:1513). Schema and tool registration already exist (host/mcp-server.js:534-552). Real-mouse CDP events ship but are page-synthetic, so a normal screen recorder wouldn't see a cursor anyway - we have to draw it ourselves from the dispatched x/y log.

## Approach (V1)

### Capture (extension)
- On `start_recording`: ensure `chrome.debugger` attached -> `Page.startScreencast({ format:'jpeg', quality:80, maxWidth:1280, maxHeight:720, everyNthFrame:2 })` (~15 fps).
- Listen on existing `chrome.debugger.onEvent` for `Page.screencastFrame` -> push `{t, base64}` to a per-tab buffer, ack via `Page.screencastFrameAck`.
- Instrument `dispatchMouse` (background.js:865) to push `{t, type, x, y, button}` into a parallel mouse-event log when recording is active.
- Also log keystrokes from the `type` action so we can render text labels later (V2).

### Overlay compositing (extension)
- On `export`: walk frames in order; for each, decode JPEG into an OffscreenCanvas, draw the most-recent cursor position (small filled circle + outline), draw a click ripple if a `mousePressed` event happened within the last ~400ms of that frame's timestamp, draw a drag stroke if mouse is currently in a drag.
- Re-encode each frame as JPEG (Q90) and forward to native host.

### Encode (native host)
- Receive `gif_creator_export_begin { exportId, fps, width, height, savePath, format }` -> spawn `ffmpeg -f image2pipe -framerate <fps> -i - -c:v libvpx-vp9 -crf 30 -b:v 0 -pix_fmt yuv420p <savePath>`.
- Receive a stream of `gif_creator_export_frame { exportId, base64 }` -> write decoded bytes to ffmpeg stdin.
- Receive `gif_creator_export_end { exportId }` -> close stdin, await ffmpeg exit, reply with `{ savePath, fileSize }`.

### MCP surface
- Keep tool name `gif_creator` (already registered).
- Extend schema with `format: 'webm' | 'gif'` (default `webm`) and `savePath: string` (absolute path; default to `~/Downloads/recording-<ts>.webm`).
- Action `export` returns `{ savePath, fileSize, durationSec, frameCount }`.

## Files to modify
- `host/mcp-server.js` - add `format`, `savePath` to gif_creator schema, accept new return shape.
- `host/native-host.js` - add `gif_creator_export_*` message handlers, ffmpeg child-process management.
- `extension/background.js` - replace stub at line 1513-1514 with real impl; add screencast listener branch in `chrome.debugger.onEvent` listener (line 661); instrument `dispatchMouse` (865) and key handlers; add export pipeline that streams composited frames to host.
- `host/bidi-driver.js` - leave stub for now (Firefox parity is V2; out of MVP scope).

## Verification
1. Extension reloaded in Chrome (chrome://extensions).
2. `gif_creator { action:'start_recording' }` from MCP -> non-error response with `recordingId`.
3. Click around on a real page through Orellius for ~10s.
4. `gif_creator { action:'stop_recording' }` -> `{ frameCount, durationSec }`.
5. `gif_creator { action:'export', savePath:'C:/Users/raviv/Downloads/orellius-test.webm' }` -> WebM written to disk.
6. Open in VLC: cursor visible, clicks visible as ripples, smooth ~15fps playback.

## Out of scope (V2)
- Drag-path rendering, action-text labels, progress bar, watermark.
- Firefox/BiDi backend.
- GIF output (skip; WebM is the headliner). Add gifenc later if requested.
- Multi-tab simultaneous recordings (single active tab for V1).

## Open questions
- ffmpeg binary location: `C:\Users\raviv\AppData\Local\Microsoft\WinGet\Links\ffmpeg.exe` (verified via `where ffmpeg`). Need cross-platform fallback for Linux/Mac native-host installs - resolve via `which/where` in `install.js` and bake the resolved path into the host config, or spawn with PATH lookup. V1: spawn with `'ffmpeg'` and rely on PATH (works on all 3 OSes when ffmpeg is installed).
