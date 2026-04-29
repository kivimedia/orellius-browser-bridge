#!/usr/bin/env node

// Native Messaging Host for Orellius Browser Bridge extension.
// Launched by Chrome when the extension calls connectNative().
// Bridges between Chrome native messaging (stdin/stdout, 4-byte LE length prefix + JSON)
// and the MCP server (TCP on localhost).

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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
