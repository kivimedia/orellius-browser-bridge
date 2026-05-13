# Orellius MediaRecorder engine - the real-video upgrade

## Goal

Add a second recording engine to `record_video` that produces real Loom/Camtasia-quality video (continuous 15-30 fps, MediaRecorder-encoded webm) instead of the current paint-driven CDP screencast (slideshow at ~0.7 fps on static pages).

## Why

Current `record_video` uses `Page.startScreencast` (CDP). It only emits a frame when the page repaints. On the JG-CRM Copilot demo (long "Thinking..." waits between query reveals) we captured 302 frames over 414 seconds = 0.73 fps. Unusable for a sales demo.

MarizAI's `dashboard/app/TrainingRecorder.tsx` already proves the right pattern works locally: `getDisplayMedia()` + `MediaRecorder` with VP9/Opus + 1.5Mbps = real frame-paced video.

In Orellius we substitute `chrome.tabCapture.getMediaStreamId()` for `getDisplayMedia()` so the extension can capture the owned tab silently (no user share-picker prompt). The MediaRecorder lifecycle is identical to MarizAI's.

## Approach

Keep the existing CDP engine as `engine: "cdp-legacy"`. Add a new `engine: "media-recorder"` (the new default).

The MediaRecorder API isn't available inside MV3 service workers - it needs a DOM. So the new engine uses an offscreen document.

Flow:
1. `record_video(action="start_recording", engine="media-recorder")` MCP call hits the host, gets routed to background.js
2. background.js calls `chrome.tabCapture.getMediaStreamId({targetTabId})` to mint a stream ID for the owned tab
3. background.js creates an offscreen document (`offscreen.html`) if not present, posts the streamId + recording params via `chrome.runtime.sendMessage`
4. Offscreen runs `navigator.mediaDevices.getUserMedia({video: {mandatory: {chromeMediaSource: "tab", chromeMediaSourceId: streamId}}})` then `new MediaRecorder(stream, {mimeType: "video/webm;codecs=vp9", videoBitsPerSecond: 2_500_000})`. `recorder.start(2000)` chunks every 2s.
5. Each `ondataavailable` blob is converted to base64 and posted back to background.js
6. background.js forwards chunks to the native host via WebSocket as `vrec_mr_chunk` messages
7. Native host appends bytes to a single `.webm` file on disk as they arrive (no temp dir / manifest needed - webm is the final format)
8. `stop_recording` posts STOP to offscreen, drains the final chunk, returns frame/duration stats
9. `export` is a fast no-op rename in the new engine (file is already done). Optional: ffmpeg pass to repack as mp4 if `format: "mp4"`.

## Files to modify / add

### Modify

- `extension/manifest.json` - add `"tabCapture"` and `"offscreen"` to permissions
- `extension/background.js`
  - Add new functions: `vrecStartRecordingMR`, `vrecStopRecordingMR`, `vrecClearMR`
  - Add offscreen-doc lifecycle helpers: `ensureOffscreenDoc`, `sendToOffscreen`
  - Add `chrome.runtime.onMessage` handler for offscreen chunks
  - Route through `engine` param in the existing record_video action dispatcher
- `host/mcp-server.js`
  - Add `engine: z.enum(["media-recorder", "cdp-legacy"]).default("media-recorder").optional()` to the start_recording options schema
  - Update tool description to mention the two engines
- `host/native-host.js`
  - Add handler for `vrec_mr_begin` / `vrec_mr_chunk` / `vrec_mr_finalize` message types
  - Stream bytes to a single `.webm` file per recording
  - Optional ffmpeg pass on finalize if `format === "mp4"`

### Add

- `extension/offscreen.html` - minimal HTML host for offscreen.js
- `extension/offscreen.js` - MediaRecorder lifecycle, chunk forwarding

## Backwards compatibility

- `engine: "cdp-legacy"` keeps the entire existing path untouched - all old code stays where it is
- Default flips to `engine: "media-recorder"` so new callers get the smooth path automatically
- Tool surface (`start_recording` / `stop_recording` / `export` / `clear` actions) stays identical
- Output savePath behavior identical (defaults to `~/Downloads/orellius-<ts>.<format>`)

## Things the CDP engine does that the MR engine won't (initially)

- Synthetic cursor overlay - MediaRecorder captures whatever the user / agent sees, which under tab-capture is the real rendered tab. CDP `Input.dispatchMouseEvent` clicks don't move the OS cursor so they won't appear. Acceptable trade-off for v1 - typing + answer reveals are the demo's value, not cursor motion. Can add Canvas overlay in offscreen as v2.
- Click ripples - same situation, deferred to v2
- Progress bar / watermark composited into frames - can render via Canvas overlay in offscreen, but deferred to v2. Default to none.

## Verification

Acceptance test for v1: re-run the JG-CRM Copilot demo (3 queries with 30s thinking waits each) and confirm the exported webm has:
- duration matches wall-clock recording time (no stretching)
- file size at least 5 MB for a 2-minute recording (vs the 550 KB we got with CDP)
- visual smoothness on playback: typing is animated, answer reveals appear at natural speed
- no dropped frames during the static "Thinking..." periods

## Risks

- `chrome.tabCapture.getMediaStreamId` requires `activeTab` permission and an explicit user gesture in some contexts. In an extension service worker triggered by MCP, the call may need to be initiated from a content-script context or the active tab. If this is the case, fall back to having the popup or content-script make the call.
- Offscreen documents have a per-extension singleton limit. Multi-tab recording needs to multiplex through one offscreen doc (already designed for that via the chunk message routing).
- VP9 encoding is CPU-heavy; on weaker machines fall back to VP8 (already in the mimeType candidate list).

## Open questions

- Default fps: 15 (smaller files, plenty for the visual content) or 30 (smoother but 2x file size)?
- Tab audio capture: include by default or opt-in? Decision: opt-in via `options.captureAudio` (default false). Most sales demos have no in-tab audio anyway.

## After this ships

Phase 2: prep the Shlomo demo using the new engine. Re-record the 3-query JG-CRM walkthrough, polish in HyperFrames with Hava Nagila + captions, deliver MP4.

Phase 3: decide whether Electron is needed for non-browser captures.
