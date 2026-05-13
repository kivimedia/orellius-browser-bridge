#!/usr/bin/env node

// Native Messaging Host for Orellius Browser Bridge extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_PORT = 18765;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[native-host ${ts}] ${msg}\n`);
}

function getPort() {
  const configPath = path.join(
    os.homedir(),
    ".config",
    "orellius-browser-bridge",
    "config.json"
  );
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

// --- Native messaging protocol (Chrome <-> this process) ---

function readNativeMessage(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const len = buffer.readUInt32LE(offset);
    if (offset + 4 + len > buffer.length) break;
    const json = buffer.subarray(offset + 4, offset + 4 + len).toString("utf-8");
    try {
      messages.push(JSON.parse(json));
    } catch (e) {
      // skip malformed
    }
    offset += 4 + len;
  }
  return { messages, remainder: buffer.subarray(offset) };
}

function writeNativeMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

// --- TCP connection to MCP server ---

let tcpSocket = null;
let tcpBuffer = Buffer.alloc(0);
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 60; // 30 seconds at 500ms intervals
const TCP_PORT = getPort();

// Multi-browser routing: the extension sends a `{type:"init", browser:"..."}`
// message immediately after connectNative(). We hold registration until we
// know which browser this native_host belongs to so the hub can route per
// browser. If the extension never sends init (legacy version), we time out
// after INIT_TIMEOUT_MS and register as "chromium" for backward compat.
let detectedBrowser = null;
let registered = false;
let pendingMessages = [];  // messages from extension before init arrives
let initTimer = null;
const INIT_TIMEOUT_MS = 2000;

function registerWithHub(browser) {
  if (registered) return;
  registered = true;
  detectedBrowser = browser;
  if (initTimer) { clearTimeout(initTimer); initTimer = null; }
  if (tcpSocket && !tcpSocket.destroyed) {
    log(`Registering with hub as native_host (browser=${browser})`);
    tcpSocket.write(JSON.stringify({ type: "register_native_host", browser }) + "\n");
    // Drain anything we held while waiting for init
    for (const msg of pendingMessages) {
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
    pendingMessages = [];
  }
}

function connectTcp() {
  if (tcpSocket) return;

  log(`Connecting to MCP server at 127.0.0.1:${TCP_PORT}...`);
  tcpSocket = new net.Socket();

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    log(`Connected to hub on port ${TCP_PORT}`);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    // Wait for the extension to identify its browser via init. Fall back to
    // "chromium" if it doesn't (covers pre-multi-browser extension builds).
    if (!registered) {
      initTimer = setTimeout(() => {
        if (!registered) {
          log(`No init message after ${INIT_TIMEOUT_MS}ms; registering as default browser=chromium`);
          registerWithHub("chromium");
        }
      }, INIT_TIMEOUT_MS);
    }
  });

  tcpSocket.on("data", (chunk) => {
    tcpBuffer = Buffer.concat([tcpBuffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = tcpBuffer.indexOf(10)) !== -1) {
      const line = tcpBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      tcpBuffer = tcpBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        writeNativeMessage(msg);
      } catch {
        // skip malformed
      }
    }
  });

  tcpSocket.on("error", (err) => {
    if (reconnectAttempts === 0) {
      log(`Hub connection error: ${err.message}`);
    }
    tcpSocket = null;
  });

  tcpSocket.on("close", () => {
    log(`Hub connection closed`);
    tcpSocket = null;
    if (!reconnectTimer) {
      reconnectTimer = setInterval(() => {
        reconnectAttempts++;
        if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          log(`Hub unreachable after ${MAX_RECONNECT_ATTEMPTS} attempts (${MAX_RECONNECT_ATTEMPTS / 2}s). Exiting.`);
          clearInterval(reconnectTimer);
          process.exit(0);
        }
        if (reconnectAttempts % 10 === 0) {
          log(`Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
        }
        if (!tcpSocket) connectTcp();
      }, 500);
    }
  });
}

// --- Main: bridge stdin (from extension) <-> TCP (to MCP server) ---

let stdinBuffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  const { messages, remainder } = readNativeMessage(stdinBuffer);
  stdinBuffer = remainder;

  for (const msg of messages) {
    // Multi-browser handshake: the extension's first message identifies
    // which browser it lives in. We register with the hub once and then
    // strip the init out of the regular message stream.
    if (msg.type === "init" && msg.browser) {
      registerWithHub(String(msg.browser).toLowerCase());
      continue;
    }

    // Video-recording control plane: extension <-> host only, never
    // forwarded to the MCP server. Each message has a `requestId` the
    // extension uses to correlate replies.
    if (typeof msg.type === "string" && msg.type.startsWith("vrec_")) {
      handleVrecMessage(msg).catch((err) => {
        log(`vrec error: ${err.message}`);
        writeNativeMessage({
          type: "vrec_error",
          requestId: msg.requestId,
          recordingId: msg.recordingId,
          error: String(err && err.message ? err.message : err),
        });
      });
      continue;
    }

    // Buffer if we have not yet registered (extension may send tool
    // responses before init in some races) so the hub doesn't see a
    // stranded message before our register_native_host.
    if (!registered) {
      pendingMessages.push(msg);
      continue;
    }

    // Forward to MCP server via TCP
    if (tcpSocket && !tcpSocket.destroyed) {
      tcpSocket.write(JSON.stringify(msg) + "\n");
    }
  }
});

// ---------------------------------------------------------------------------
// Video recording (vrec_*): out-of-band control plane between the extension
// and this native host. The extension streams composited JPEG frames to disk
// (tempDir/frame_NNNNN.jpg + concat manifest) so we can hand the result to
// ffmpeg's concat demuxer with per-frame durations - matches Playwright's
// variable-frame-rate output and is robust to idle pages where screencast
// frames are sparse.
// ---------------------------------------------------------------------------

const recordings = new Map(); // recordingId -> { tempDir, manifestPath, manifestFd, frameIndex, savePath, format, fps, startedAt }

function vrecTempRoot() {
  return path.join(os.tmpdir(), "orellius-vrec");
}

function findFfmpeg() {
  // Trust PATH first (works on all 3 OSes when ffmpeg is installed
  // normally). Fall back to a small list of common Windows install paths
  // because Chrome's native-messaging child env is the user env at launch
  // time, but WinGet-shimmed ffmpeg sometimes lives outside that PATH.
  const candidates = [
    "ffmpeg",
    process.env.FFMPEG_PATH,
    path.join(os.homedir(), "AppData", "Local", "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
    "C:/Program Files/ffmpeg/bin/ffmpeg.exe",
    "C:/ffmpeg/bin/ffmpeg.exe",
    "/usr/local/bin/ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ].filter(Boolean);
  return candidates;
}

async function handleVrecMessage(msg) {
  switch (msg.type) {
    case "vrec_begin":        return vrecBegin(msg);
    case "vrec_frame":        return vrecFrame(msg);
    case "vrec_end":          return vrecEnd(msg);          // legacy: pre-B1 export-time pipeline
    case "vrec_finalize":     return vrecFinalize(msg);     // B1: stream-during-capture closer
    case "vrec_abort":        return vrecAbort(msg);
    // MediaRecorder engine (real-video path) - frame-paced webm chunks
    case "vrec_mr_begin":     return vrecMrBegin(msg);
    case "vrec_mr_chunk":     return vrecMrChunk(msg);
    case "vrec_mr_finalize":  return vrecMrFinalize(msg);
    case "vrec_mr_export":    return vrecMrExport(msg);
    case "vrec_mr_abort":     return vrecMrAbort(msg);
    default:
      throw new Error(`Unknown vrec message: ${msg.type}`);
  }
}

// ===========================================================================
// MediaRecorder engine handlers.
//
// The extension streams webm chunks (each ~1-2 seconds of encoded video) over
// the native messaging channel. We append the bytes to a single .webm file
// as they arrive. On finalize the file is closed and ready to use. If the
// caller wants mp4, vrec_mr_export runs ffmpeg to repack (no re-encode needed,
// just container swap most of the time).
// ===========================================================================

const mrRecordings = new Map(); // recordingId -> { tempPath, fd, format, mimeType, bytesWritten, chunkCount, startedAt, finalizedAt, durationMs }

function mrTempPath(recordingId) {
  return path.join(vrecTempRoot(), `${recordingId}.webm`);
}

async function vrecMrBegin(msg) {
  const { requestId, recordingId, format, mimeTypeHint } = msg;
  if (!recordingId) throw new Error("vrec_mr_begin: recordingId required");
  if (mrRecordings.has(recordingId)) throw new Error(`MR recordingId ${recordingId} already active`);
  const root = vrecTempRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const tempPath = mrTempPath(recordingId);
  // Open for append+create; we'll write chunks as they arrive
  const fd = await fs.promises.open(tempPath, "w");
  mrRecordings.set(recordingId, {
    tempPath,
    fd,
    format: format || "webm",
    mimeType: mimeTypeHint || "video/webm",
    bytesWritten: 0,
    chunkCount: 0,
    startedAt: Date.now(),
    finalizedAt: null,
    durationMs: null,
  });
  log(`vrec_mr_begin ${recordingId} -> ${tempPath}`);
  writeNativeMessage({ type: "vrec_mr_begin_ok", requestId, recordingId, tempPath });
}

async function vrecMrChunk(msg) {
  const { requestId, recordingId, base64, seq, size, mimeType } = msg;
  const rec = mrRecordings.get(recordingId);
  if (!rec) throw new Error(`vrec_mr_chunk: unknown recordingId ${recordingId}`);
  if (!base64) throw new Error("vrec_mr_chunk: base64 required");
  const buf = Buffer.from(base64, "base64");
  await rec.fd.write(buf);
  rec.bytesWritten += buf.length;
  rec.chunkCount = Math.max(rec.chunkCount, seq || 0);
  if (mimeType) rec.mimeType = mimeType;
  // Don't echo every chunk back - the extension fires-and-forgets ~1/sec.
  // Just ack so the request promise resolves.
  writeNativeMessage({ type: "vrec_mr_chunk_ok", requestId, recordingId, seq, bytesWritten: rec.bytesWritten });
}

async function vrecMrFinalize(msg) {
  const { requestId, recordingId, durationMs, chunkCount, bytesSent, mimeType } = msg;
  const rec = mrRecordings.get(recordingId);
  if (!rec) throw new Error(`vrec_mr_finalize: unknown recordingId ${recordingId}`);
  try { await rec.fd.close(); } catch {}
  rec.fd = null;
  rec.finalizedAt = Date.now();
  rec.durationMs = durationMs || (rec.finalizedAt - rec.startedAt);
  if (chunkCount) rec.chunkCount = chunkCount;
  if (mimeType) rec.mimeType = mimeType;
  let stat;
  try {
    stat = await fs.promises.stat(rec.tempPath);
  } catch (e) {
    throw new Error(`vrec_mr_finalize: stat failed on ${rec.tempPath}: ${e.message}`);
  }
  if (stat.size === 0) {
    throw new Error("vrec_mr_finalize: webm file is 0 bytes - no chunks reached the host");
  }
  log(`vrec_mr_finalize ${recordingId}: ${stat.size}b, chunks=${rec.chunkCount}, dur=${rec.durationMs}ms`);
  writeNativeMessage({
    type: "vrec_mr_finalize_ok",
    requestId,
    recordingId,
    savePath: rec.tempPath,
    fileSize: stat.size,
    chunkCount: rec.chunkCount,
    durationSec: rec.durationMs / 1000,
    mimeType: rec.mimeType,
  });
}

async function vrecMrExport(msg) {
  const { requestId, recordingId, format, filename, savePath } = msg;
  const rec = mrRecordings.get(recordingId);
  if (!rec) throw new Error(`vrec_mr_export: unknown recordingId ${recordingId}`);
  if (rec.fd) {
    try { await rec.fd.close(); } catch {}
    rec.fd = null;
  }
  const targetFormat = (format || rec.format || "webm").toLowerCase();
  const defaultName = filename || `orellius-${Date.now()}.${targetFormat}`;
  const finalPath = savePath || path.join(os.homedir(), "Downloads", defaultName);
  await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });

  if (targetFormat === "webm") {
    // Same container - just move/rename
    await fs.promises.copyFile(rec.tempPath, finalPath);
    try { await fs.promises.unlink(rec.tempPath); } catch {}
  } else if (targetFormat === "mp4") {
    // Repack: webm (VP9/VP8) -> mp4 (H.264). Re-encode is needed because mp4
    // doesn't support VP9 in most players. Use libx264 veryfast for speed.
    const args = [
      "-y",
      "-i", rec.tempPath,
      "-c:v", "libx264",
      "-crf", "23",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-c:a", "aac",
      "-b:a", "128k",
      finalPath,
    ];
    await runFfmpegAttempt(args, { savePath: finalPath, format: "mp4" });
    try { await fs.promises.unlink(rec.tempPath); } catch {}
  } else if (targetFormat === "gif") {
    // Two-pass palette gif for decent quality
    const palette = finalPath + ".palette.png";
    const gen = ["-y", "-i", rec.tempPath, "-vf", "fps=10,scale=720:-1:flags=lanczos,palettegen", palette];
    await runFfmpegAttempt(gen, { savePath: palette, format: "png" });
    const use = ["-y", "-i", rec.tempPath, "-i", palette, "-lavfi", "fps=10,scale=720:-1:flags=lanczos [x]; [x][1:v] paletteuse", finalPath];
    await runFfmpegAttempt(use, { savePath: finalPath, format: "gif" });
    try { await fs.promises.unlink(palette); } catch {}
    try { await fs.promises.unlink(rec.tempPath); } catch {}
  } else {
    throw new Error(`vrec_mr_export: unsupported format ${targetFormat}`);
  }

  const stat = await fs.promises.stat(finalPath);
  mrRecordings.delete(recordingId);
  log(`vrec_mr_export ${recordingId} -> ${finalPath} (${stat.size}b, ${targetFormat})`);
  writeNativeMessage({
    type: "vrec_mr_export_ok",
    requestId,
    recordingId,
    savePath: finalPath,
    fileSize: stat.size,
    durationSec: rec.durationMs ? rec.durationMs / 1000 : null,
    format: targetFormat,
  });
}

async function vrecMrAbort(msg) {
  const { requestId, recordingId } = msg;
  const rec = mrRecordings.get(recordingId);
  if (!rec) {
    writeNativeMessage({ type: "vrec_mr_abort_ok", requestId, recordingId });
    return;
  }
  if (rec.fd) {
    try { await rec.fd.close(); } catch {}
  }
  try { await fs.promises.unlink(rec.tempPath); } catch {}
  mrRecordings.delete(recordingId);
  writeNativeMessage({ type: "vrec_mr_abort_ok", requestId, recordingId });
}

// vrec_finalize is the B1 streaming-pipeline closer. Frames have already been
// streamed in via per-frame vrec_frame messages during capture. The extension
// calls this with the real savePath/format/fps once recording stops; we
// override what was guessed at vrec_begin time, finalize the manifest, and
// run ffmpeg.
async function vrecFinalize(msg) {
  const { requestId, recordingId, fps, savePath, format } = msg;
  const rec = recordings.get(recordingId);
  if (!rec) throw new Error(`vrec_finalize: unknown recordingId ${recordingId}`);

  if (fps) rec.fps = fps;
  if (savePath) rec.savePath = savePath;
  if (format) rec.format = format;

  // Recompute extension from new format if savePath was generic
  if (!savePath && format) {
    rec.savePath = rec.savePath.replace(/\.[a-z0-9]+$/i, "." + format);
  }

  log(`vrec_finalize ${recordingId}: ${rec.frameIndex} frames, fps=${rec.fps}, format=${rec.format}, savePath=${rec.savePath}`);

  // Reuse vrec_end's path - same finalize logic, just emit a different reply
  // type so the extension's correlation knows which message resolved.
  const tailDur = (1 / Math.max(1, rec.fps)).toFixed(4);
  if (rec.frameIndex === 0) {
    recordings.delete(recordingId);
    cleanupTempDir(rec.tempDir);
    throw new Error("No frames received during capture - the extension never sent vrec_frame messages");
  }
  const lastFname = `frame_${String(rec.frameIndex - 1).padStart(6, "0")}.jpg`;
  await rec.manifestFd.write(`duration ${tailDur}\n`);
  await rec.manifestFd.write(`file '${lastFname}'\n`);
  await rec.manifestFd.close();

  await fs.promises.mkdir(path.dirname(rec.savePath), { recursive: true });

  const args = buildFfmpegArgs(rec);
  const ffPath = await runFfmpegAttempt(args, rec);

  const stat = await fs.promises.stat(rec.savePath);
  if (stat.size === 0) throw new Error("ffmpeg produced empty file");

  recordings.delete(recordingId);
  cleanupTempDir(rec.tempDir);

  log(`vrec_finalize ${recordingId} OK: ${rec.frameIndex} frames -> ${rec.savePath} (${stat.size}b) via ${ffPath}`);
  writeNativeMessage({
    type: "vrec_finalize_ok",
    requestId,
    recordingId,
    savePath: rec.savePath,
    fileSize: stat.size,
    frameCount: rec.frameIndex,
    durationSec: rec.lastFrameRelTs != null ? rec.lastFrameRelTs / 1000 : null,
    ffmpegPath: ffPath,
  });
}

async function vrecBegin(msg) {
  const { requestId, recordingId, fps, savePath, format } = msg;
  if (!recordingId) throw new Error("vrec_begin: recordingId required");
  if (recordings.has(recordingId)) throw new Error(`recordingId ${recordingId} already active`);

  const root = vrecTempRoot();
  await fs.promises.mkdir(root, { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join(root, `${recordingId}-`));
  const manifestPath = path.join(tempDir, "manifest.txt");
  const manifestFd = await fs.promises.open(manifestPath, "w");
  // ffconcat v1.0 header allows variable per-entry duration
  await manifestFd.write("ffconcat version 1.0\n");

  recordings.set(recordingId, {
    tempDir,
    manifestPath,
    manifestFd,
    frameIndex: 0,
    lastFrameRelTs: null,
    savePath: savePath || path.join(os.homedir(), "Downloads", `orellius-${Date.now()}.webm`),
    format: format || "webm",
    fps: fps || 15,
    startedAt: Date.now(),
  });

  log(`vrec_begin ${recordingId} -> ${tempDir} (savePath=${savePath})`);
  writeNativeMessage({ type: "vrec_begin_ok", requestId, recordingId, tempDir });
}

async function vrecFrame(msg) {
  const { requestId, recordingId, base64, relTs } = msg;
  const rec = recordings.get(recordingId);
  if (!rec) throw new Error(`vrec_frame: unknown recordingId ${recordingId}`);
  if (!base64) throw new Error("vrec_frame: base64 required");

  const idx = rec.frameIndex++;
  const fname = `frame_${String(idx).padStart(6, "0")}.jpg`;
  const fpath = path.join(rec.tempDir, fname);
  const buf = Buffer.from(base64, "base64");
  await fs.promises.writeFile(fpath, buf);

  // Variable-frame-rate manifest: each entry's duration is the gap to the
  // next frame. We only know the gap once the next frame arrives, so we
  // patch the previous entry's duration on each new frame, and finalize
  // the last entry's duration on vrec_end.
  if (rec.lastFrameRelTs != null) {
    const dur = Math.max(0.01, (relTs - rec.lastFrameRelTs) / 1000);
    await rec.manifestFd.write(`duration ${dur.toFixed(4)}\n`);
  }
  await rec.manifestFd.write(`file '${fname.replace(/'/g, "'\\''")}'\n`);
  rec.lastFrameRelTs = relTs;

  writeNativeMessage({ type: "vrec_frame_ok", requestId, recordingId, frameIndex: idx });
}

async function vrecEnd(msg) {
  const { requestId, recordingId } = msg;
  const rec = recordings.get(recordingId);
  if (!rec) throw new Error(`vrec_end: unknown recordingId ${recordingId}`);

  // Finalize manifest: give the last frame a final 1/fps duration, then
  // re-state the last filename (concat demuxer requires duration to be
  // followed by a file entry to take effect).
  const tailDur = (1 / Math.max(1, rec.fps)).toFixed(4);
  const lastFname = `frame_${String(rec.frameIndex - 1).padStart(6, "0")}.jpg`;
  await rec.manifestFd.write(`duration ${tailDur}\n`);
  await rec.manifestFd.write(`file '${lastFname}'\n`);
  await rec.manifestFd.close();

  if (rec.frameIndex === 0) {
    recordings.delete(recordingId);
    cleanupTempDir(rec.tempDir);
    throw new Error("No frames captured");
  }

  await fs.promises.mkdir(path.dirname(rec.savePath), { recursive: true });

  const args = buildFfmpegArgs(rec);
  const ffPath = await runFfmpegAttempt(args, rec);

  // Verify output exists and has bytes
  const stat = await fs.promises.stat(rec.savePath);
  if (stat.size === 0) throw new Error("ffmpeg produced empty file");

  recordings.delete(recordingId);
  cleanupTempDir(rec.tempDir);

  log(`vrec_end ${recordingId}: ${rec.frameIndex} frames -> ${rec.savePath} (${stat.size}b) via ${ffPath}`);
  writeNativeMessage({
    type: "vrec_end_ok",
    requestId,
    recordingId,
    savePath: rec.savePath,
    fileSize: stat.size,
    frameCount: rec.frameIndex,
    durationSec: rec.lastFrameRelTs != null ? rec.lastFrameRelTs / 1000 : null,
    ffmpegPath: ffPath,
  });
}

async function vrecAbort(msg) {
  const { requestId, recordingId } = msg;
  const rec = recordings.get(recordingId);
  if (!rec) {
    writeNativeMessage({ type: "vrec_abort_ok", requestId, recordingId });
    return;
  }
  try { await rec.manifestFd.close(); } catch {}
  cleanupTempDir(rec.tempDir);
  recordings.delete(recordingId);
  writeNativeMessage({ type: "vrec_abort_ok", requestId, recordingId });
}

function buildFfmpegArgs(rec) {
  const isWebm = rec.format === "webm";
  const isMp4 = rec.format === "mp4";
  const codec = isWebm
    ? ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1"]
    : isMp4
      ? ["-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-movflags", "+faststart"]
      : ["-c:v", "gif"]; // gif fallback (rec.format === 'gif')

  return [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", rec.manifestPath,
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    ...codec,
    "-pix_fmt", "yuv420p",
    rec.savePath,
  ];
}

function runFfmpegAttempt(args, rec) {
  const candidates = findFfmpeg();
  return new Promise(async (resolve, reject) => {
    let lastErr = null;
    for (const ff of candidates) {
      try {
        await new Promise((res, rej) => {
          const proc = spawn(ff, args, { stdio: ["ignore", "pipe", "pipe"] });
          let stderr = "";
          proc.stderr.on("data", (d) => { stderr += d.toString(); });
          proc.on("error", (err) => rej(err));
          proc.on("close", (code) => {
            if (code === 0) res();
            else rej(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
          });
        });
        resolve(ff);
        return;
      } catch (err) {
        lastErr = err;
        // ENOENT means this candidate doesn't exist; try the next.
        if (err.code !== "ENOENT") {
          // Real ffmpeg error (bad args, missing codec, etc.) - don't keep trying random binaries
          return reject(err);
        }
      }
    }
    reject(lastErr || new Error("ffmpeg not found in PATH or known locations"));
  });
}

function cleanupTempDir(dir) {
  fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}

process.stdin.on("end", () => {
  log("Extension disconnected (stdin ended). Exiting.");
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start
log(`Native host started (PID ${process.pid}), connecting to hub on port ${TCP_PORT}`);
connectTcp();
