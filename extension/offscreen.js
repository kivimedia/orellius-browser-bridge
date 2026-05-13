// Orellius offscreen recorder
//
// MediaRecorder lives here (offscreen documents have a full DOM context, which
// MV3 service workers do not). The background service worker mints a tab
// MediaStream ID via chrome.tabCapture.getMediaStreamId and posts it here
// with start params. We open the stream via getUserMedia({chromeMediaSourceId}),
// pipe it into a MediaRecorder, and post each blob chunk back to the SW as
// base64 (chrome.runtime.sendMessage cannot transfer ArrayBuffers cleanly).
//
// Multiple recordings (one per tab) can be active in parallel - we key by
// recordingId, not by tab.

const sessions = new Map(); // recordingId -> { recorder, stream, chunks, mimeType, startedAt }

const MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp8",
  "video/webm",
];

function pickMimeType() {
  for (const t of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

async function blobToBase64(blob) {
  // FileReader is available in offscreen docs; base64 keeps the chunk safe
  // through chrome.runtime.sendMessage (which strips non-serializable types).
  const reader = new FileReader();
  return new Promise((resolve, reject) => {
    reader.onload = () => {
      const dataUrl = reader.result;
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.substring(comma + 1) : "");
    };
    reader.onerror = () => reject(reader.error || new Error("blob read failed"));
    reader.readAsDataURL(blob);
  });
}

async function startSession(msg) {
  const { recordingId, streamId, frameRate = 30, videoBitsPerSecond = 2_500_000, captureAudio = false, chunkMs = 1000 } = msg;
  if (!recordingId || !streamId) throw new Error("recordingId and streamId required");
  if (sessions.has(recordingId)) throw new Error(`recordingId ${recordingId} already active`);

  const constraints = {
    audio: captureAudio
      ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: frameRate,
        minFrameRate: Math.max(1, Math.floor(frameRate / 2)),
        maxWidth: 1920,
        maxHeight: 1080,
      },
    },
  };

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    throw new Error(`getUserMedia failed: ${e.message}`);
  }

  // Important: if we got an audio track but the user wanted no audio, drop it.
  // (Some tabCapture implementations silently route audio even when asked not to.)
  if (!captureAudio) {
    stream.getAudioTracks().forEach((t) => t.stop());
  }

  // Crucially: when the tab finishes recording, we want the captured tab to
  // KEEP playing audio to the user. chrome.tabCapture mutes the originating
  // tab by default. The recommended workaround is to pipe the stream's audio
  // through a new AudioContext destination so the tab audio is still audible.
  // We skip this for now since captureAudio defaults to false in v1.

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond } : { videoBitsPerSecond });
  const session = {
    recorder,
    stream,
    chunkSeq: 0,
    bytesSent: 0,
    mimeType: recorder.mimeType || mimeType || "video/webm",
    startedAt: Date.now(),
    finishedResolve: null,
    finishedPromise: null,
  };
  session.finishedPromise = new Promise((resolve) => { session.finishedResolve = resolve; });
  sessions.set(recordingId, session);

  recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;
    try {
      const base64 = await blobToBase64(event.data);
      session.chunkSeq += 1;
      session.bytesSent += event.data.size;
      chrome.runtime.sendMessage({
        type: "orellius_mr_chunk",
        recordingId,
        seq: session.chunkSeq,
        size: event.data.size,
        mimeType: session.mimeType,
        base64,
        ts: Date.now() - session.startedAt,
      });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: "orellius_mr_error",
        recordingId,
        error: `chunk handler: ${e.message}`,
      });
    }
  };

  recorder.onerror = (e) => {
    chrome.runtime.sendMessage({
      type: "orellius_mr_error",
      recordingId,
      error: `MediaRecorder error: ${e.error?.message || e.message || String(e)}`,
    });
  };

  recorder.onstop = () => {
    chrome.runtime.sendMessage({
      type: "orellius_mr_stopped",
      recordingId,
      chunkCount: session.chunkSeq,
      bytesSent: session.bytesSent,
      durationMs: Date.now() - session.startedAt,
      mimeType: session.mimeType,
    });
    try {
      session.stream.getTracks().forEach((t) => t.stop());
    } catch {}
    if (session.finishedResolve) session.finishedResolve();
    sessions.delete(recordingId);
  };

  // When the user closes the captured tab, the video track ends. Stop cleanly.
  stream.getVideoTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (recorder.state === "recording") {
        try { recorder.stop(); } catch {}
      }
    });
  });

  recorder.start(chunkMs);
  return {
    ok: true,
    recordingId,
    mimeType: session.mimeType,
    startedAt: session.startedAt,
  };
}

async function stopSession(msg) {
  const { recordingId } = msg;
  const session = sessions.get(recordingId);
  if (!session) return { ok: false, error: `no active session for ${recordingId}` };
  if (session.recorder.state === "recording") {
    session.recorder.stop();
  }
  // Wait for the stopped event handler to run so the SW knows when bytes are flushed
  await session.finishedPromise;
  return {
    ok: true,
    recordingId,
    chunkCount: session.chunkSeq,
    bytesSent: session.bytesSent,
    durationMs: Date.now() - session.startedAt,
    mimeType: session.mimeType,
  };
}

async function cancelSession(msg) {
  const { recordingId } = msg;
  const session = sessions.get(recordingId);
  if (!session) return { ok: false, error: `no active session for ${recordingId}` };
  try {
    session.recorder.ondataavailable = null;
    session.recorder.stop();
  } catch {}
  try { session.stream.getTracks().forEach((t) => t.stop()); } catch {}
  sessions.delete(recordingId);
  return { ok: true, recordingId, cancelled: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    try {
      let result;
      switch (msg.cmd) {
        case "start": result = await startSession(msg); break;
        case "stop":  result = await stopSession(msg); break;
        case "cancel": result = await cancelSession(msg); break;
        case "ping": result = { ok: true, sessions: Array.from(sessions.keys()) }; break;
        default: result = { ok: false, error: `unknown cmd: ${msg.cmd}` };
      }
      sendResponse(result);
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // async response
});
