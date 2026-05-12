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
    case "vrec_begin":    return vrecBegin(msg);
    case "vrec_frame":    return vrecFrame(msg);
    case "vrec_end":      return vrecEnd(msg);       // legacy: pre-B1 export-time pipeline
    case "vrec_finalize": return vrecFinalize(msg);  // B1: stream-during-capture closer
    case "vrec_abort":    return vrecAbort(msg);
    default:
      throw new Error(`Unknown vrec message: ${msg.type}`);
  }
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
