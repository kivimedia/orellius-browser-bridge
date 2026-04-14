#!/usr/bin/env node

// Hub process for Orellius Browser Bridge.
// Multiplexes multiple MCP server sessions through a single native host connection.
// Auto-spawned by mcp-server.js if not running. Stays alive with an idle timeout.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PORT = 18765;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes with no MCP clients -> exit

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[hub ${ts}] ${msg}\n`);
}

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "orellius-browser-bridge", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const TCP_PORT = getPort();
const pidfilePath = path.join(os.tmpdir(), `orellius-browser-bridge-hub-${TCP_PORT}.pid`);

// --- State ---

/** @type {net.Socket | null} */
let nativeHostSocket = null;

/** @type {Map<string, net.Socket>} sessionId -> MCP server socket */
const mcpClients = new Map();

/** @type {Map<string, string>} requestId -> sessionId (for routing responses) */
const requestRouting = new Map();

let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (mcpClients.size === 0) {
    idleTimer = setTimeout(() => {
      if (mcpClients.size === 0) {
        log("No MCP clients for 5 minutes. Shutting down.");
        shutdown();
      }
    }, IDLE_TIMEOUT_MS);
  }
}

// --- Pidfile ---

function writePidfile() {
  try { fs.writeFileSync(pidfilePath, String(process.pid)); } catch {}
}

function cleanupPidfile() {
  try {
    const content = fs.readFileSync(pidfilePath, "utf-8").trim();
    if (content === String(process.pid)) fs.unlinkSync(pidfilePath);
  } catch {}
}

// --- Message routing ---

function forwardToNativeHost(msg) {
  if (!nativeHostSocket || nativeHostSocket.destroyed) {
    // Send error back to the MCP client
    const sessionId = msg.sessionId;
    const client = sessionId ? mcpClients.get(sessionId) : null;
    if (client && !client.destroyed) {
      const errMsg = JSON.stringify({
        id: msg.id,
        sessionId,
        type: "tool_error",
        error: "Browser extension is not connected. Make sure a supported Chromium browser is running with the Orellius Browser Bridge extension installed and enabled.",
      }) + "\n";
      client.write(errMsg);
    }
    return;
  }

  // Track which session this request belongs to
  if (msg.id && msg.sessionId) {
    requestRouting.set(msg.id, msg.sessionId);
  }

  nativeHostSocket.write(JSON.stringify(msg) + "\n");
}

function forwardToMcpClient(msg) {
  // Route response to the correct MCP client via sessionId
  let sessionId = msg.sessionId;

  // Fallback: look up sessionId by request ID
  if (!sessionId && msg.id) {
    sessionId = requestRouting.get(msg.id);
  }

  if (msg.id) {
    requestRouting.delete(msg.id);
  }

  if (!sessionId) {
    log(`Response with no sessionId and unknown request ID ${msg.id} - dropping`);
    return;
  }

  const client = mcpClients.get(sessionId);
  if (!client || client.destroyed) {
    log(`Response for disconnected session ${sessionId} - dropping`);
    return;
  }

  // Ensure sessionId is in the response
  msg.sessionId = sessionId;
  client.write(JSON.stringify(msg) + "\n");
}

// --- TCP Server ---

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  let socketType = null; // "native_host" or "mcp_client"
  let socketSessionId = null;
  let buffer = Buffer.alloc(0);

  // First message determines socket type
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    let newlineIdx;
    while ((newlineIdx = buffer.indexOf(10)) !== -1) {
      const line = buffer.subarray(0, newlineIdx).toString("utf-8").trim();
      buffer = buffer.subarray(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);

        // Identify socket type from first message
        if (!socketType) {
          if (msg.type === "register_native_host") {
            socketType = "native_host";
            if (nativeHostSocket && !nativeHostSocket.destroyed) {
              log(`Replacing previous native host connection with ${remote}`);
              nativeHostSocket.destroy();
            }
            nativeHostSocket = socket;
            log(`Native host registered from ${remote}`);
            socket.write(JSON.stringify({ type: "registered", role: "native_host" }) + "\n");
            continue;
          } else if (msg.type === "register_mcp_client" && msg.sessionId) {
            socketType = "mcp_client";
            socketSessionId = msg.sessionId;

            // If an old client with same sessionId exists, replace it
            const old = mcpClients.get(socketSessionId);
            if (old && !old.destroyed) {
              log(`Replacing stale MCP client session ${socketSessionId}`);
              old.destroy();
            }

            mcpClients.set(socketSessionId, socket);
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            log(`MCP client registered: session=${socketSessionId} from ${remote} (total: ${mcpClients.size})`);
            socket.write(JSON.stringify({ type: "registered", role: "mcp_client", sessionId: socketSessionId }) + "\n");
            continue;
          } else {
            // Legacy: treat as native host (backward compat with old native-host.js)
            socketType = "native_host";
            if (nativeHostSocket && !nativeHostSocket.destroyed) {
              log(`Replacing previous native host (legacy connect) with ${remote}`);
              nativeHostSocket.destroy();
            }
            nativeHostSocket = socket;
            log(`Native host connected (legacy) from ${remote}`);
            // Fall through to process this message
          }
        }

        // Route messages based on socket type
        if (msg.type === "heartbeat") continue;

        if (socketType === "mcp_client") {
          // MCP client sending a tool request -> forward to native host
          msg.sessionId = socketSessionId;
          forwardToNativeHost(msg);
        } else if (socketType === "native_host") {
          // Native host sending a response -> route to correct MCP client
          forwardToMcpClient(msg);
        }
      } catch {
        // skip malformed
      }
    }
  });

  socket.on("error", (err) => {
    log(`Socket error (${socketType || "unknown"} ${remote}): ${err.message}`);
  });

  socket.on("close", () => {
    if (socketType === "native_host" && nativeHostSocket === socket) {
      log(`Native host disconnected (${remote})`);
      nativeHostSocket = null;
    } else if (socketType === "mcp_client" && socketSessionId) {
      log(`MCP client disconnected: session=${socketSessionId} (${remote})`);
      mcpClients.delete(socketSessionId);
      // Clean up pending request routing for this session
      for (const [reqId, sid] of requestRouting) {
        if (sid === socketSessionId) requestRouting.delete(reqId);
      }
      resetIdleTimer();
    }
  });
});

function shutdown() {
  log("Shutting down hub...");
  cleanupPidfile();
  for (const [sid, sock] of mcpClients) {
    if (!sock.destroyed) sock.destroy();
  }
  mcpClients.clear();
  if (nativeHostSocket && !nativeHostSocket.destroyed) nativeHostSocket.destroy();
  server.close();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// --- Start ---

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`Port ${TCP_PORT} already in use - another hub is running. Exiting.`);
    process.exit(0);
  } else {
    log(`Server error: ${err.message}`);
  }
});

server.listen(TCP_PORT, "127.0.0.1", () => {
  log(`Hub listening on 127.0.0.1:${TCP_PORT} (PID ${process.pid})`);
  writePidfile();
  resetIdleTimer();
});
