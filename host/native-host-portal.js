#!/usr/bin/env node

// PORTAL FORK of host/native-host.js. One behavioral difference from upstream,
// in getPort() below: an ORELLIUS_HUB_PORT env-var override, exactly like
// hub.js and mcp-server.js already honour (they just never wired native-host.js
// into that convention). The wrapper .cmd that Chrome launches this as sets
// that var to 18787 before exec'ing node, so the port lives in the wrapper -
// same reasoning kmbot's own kmbot-ziv-browser-mcp.sh gives for pinning ports
// in a wrapper rather than trusting inherited/config-file state. Its own audit
// log directory (~/.portal-browser-bridge/logs) so this instance's window-close
// forensics never interleave with Ziv's real ~/.orellius-browser-bridge/logs.
// Everything else in this file is unchanged from upstream.

// Native Messaging Host for the KM BOT Portal Bridge extension (forked from
// Orellius Browser Bridge). Launched by Chrome when the extension calls
// connectNative(). Bridges between Chrome native messaging (stdin/stdout,
// 4-byte LE length prefix + JSON) and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PORT = 18765;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[native-host ${ts}] ${msg}\n`);
}

// --- Audit log on behalf of the extension -----------------------------------
// The extension's own log() only reaches the service-worker console, which is
// wiped every time MV3 idles the worker out. That made window closes forensically
// invisible: on 2026-09-02 Chrome exited repeatedly and the only actor who knew
// which window it had closed, and why, was a console nobody could read after the
// fact. The extension now ships those lines here via {type:"orellius_log"} and we
// append them to a real file. These messages are handled locally and NEVER
// forwarded to the hub.
const AUDIT_DIR = path.join(os.homedir(), ".portal-browser-bridge", "logs");
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;
try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

function auditAppend(channel, line) {
  const safe = /^[a-z0-9_-]{1,32}$/i.test(String(channel || "")) ? channel : "misc";
  const file = path.join(AUDIT_DIR, `${safe}.log`);
  try {
    if (fs.statSync(file).size > AUDIT_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {}
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
  } catch (err) {
    log(`audit append failed (${safe}): ${err.message}`);
  }
}

function getPort() {
  // PORTAL FORK: env override first, matching hub.js's own getPort() and
  // mcp-server.js's getPort() - both already honour ORELLIUS_HUB_PORT; this
  // file was the one holdout. Chrome launches this file's wrapper .cmd, which
  // sets the env var before exec'ing node, so this never depends on which
  // Windows user's ~/.config file happens to exist.
  if (process.env.ORELLIUS_HUB_PORT) {
    const p = Number(process.env.ORELLIUS_HUB_PORT);
    if (Number.isFinite(p)) return p;
  }
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

  // Small request/response lines, latency over throughput. See hub.js.
  tcpSocket.setNoDelay(true);

  // Detect a half-open socket (hub killed hard, no FIN delivered) instead of
  // sitting on a dead connection forever.
  tcpSocket.setKeepAlive(true, 15000);

  tcpSocket.connect(TCP_PORT, "127.0.0.1", () => {
    log(`Connected to hub on port ${TCP_PORT}`);
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }
    if (!registered) {
      if (detectedBrowser) {
        // RECONNECT path. The extension sends `init` only once, when it first
        // calls connectNative - it will never send another one. So on any
        // reconnect we must re-register ourselves using the browser we already
        // learned. Without this the socket reconnects but no
        // `register_native_host` is ever sent: the hub shows nativeHosts: []
        // and every browser tool fails, while this process looks perfectly
        // healthy. That made any hub restart silently kill the browser link
        // until Chrome itself was restarted (found 2026-08-02, right after the
        // hub was put under pm2 - which restarts it, so the bug would have
        // fired routinely).
        log(`Reconnected; re-registering as browser=${detectedBrowser}`);
        registerWithHub(detectedBrowser);
      } else {
        // FIRST connect. Wait for the extension to identify its browser via
        // init. Fall back to "chromium" if it doesn't (covers
        // pre-multi-browser extension builds).
        initTimer = setTimeout(() => {
          if (!registered) {
            log(`No init message after ${INIT_TIMEOUT_MS}ms; registering as default browser=chromium`);
            registerWithHub("chromium");
          }
        }, INIT_TIMEOUT_MS);
      }
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
    // Registration lives on the SOCKET, not on this process. Dropping this
    // flag is what lets the reconnect path re-register (see connect handler).
    registered = false;
    if (initTimer) { clearTimeout(initTimer); initTimer = null; }
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

    // Audit lines from the extension: host-only, never forwarded to the hub.
    // Handled before the `registered` gate below so a close that happens while
    // the hub connection is down still lands on disk - that is exactly the
    // moment worth having a record of.
    if (msg.type === "orellius_log") {
      auditAppend(msg.channel, String(msg.line || ""));
      continue;
    }

    // PORTAL FORK: the entire vrec_* video-recording control plane (and its
    // ~700 lines of downstream ffmpeg/savePath disk-write machinery -
    // handleVrecMessage, vrecFfStart/vrecMrExport/vrecFinalize/etc.) is
    // DELETED, not merely unreachable. The extension side already deletes
    // the record_video/gif_creator TOOL handlers that would ever construct
    // these messages (extension-portal/background.js), so nothing sends
    // vrec_* here today - but a security review (30-Sep-2026) flagged that
    // carrying the handler forward anyway, even provably unreachable, left a
    // disk-write-anywhere primitive one careless future merge from the real
    // native-host.js away from coming back to life. Refuse by name instead.
    if (typeof msg.type === "string" && msg.type.startsWith("vrec_")) {
      writeNativeMessage({
        type: "vrec_error",
        requestId: msg.requestId,
        recordingId: msg.recordingId,
        error: "video recording is not available in the portal build",
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


process.stdin.on("end", () => {
  log("Extension disconnected (stdin ended). Exiting.");
  if (tcpSocket) tcpSocket.destroy();
  process.exit(0);
});

// Start
log(`Native host started (PID ${process.pid}), connecting to hub on port ${TCP_PORT}`);
connectTcp();
