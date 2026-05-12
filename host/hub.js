#!/usr/bin/env node

// Hub process for Orellius Browser Bridge.
// Multiplexes multiple MCP server sessions through a single native host connection.
// Auto-spawned by mcp-server.js if not running. Stays alive with an idle timeout.

import net from "node:net";
import http from "node:http";
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
  // CLI override (--port=NN) wins for tests / multi-hub setups.
  for (const arg of process.argv.slice(2)) {
    const m = /^--port=(\d+)$/.exec(arg);
    if (m) return Number(m[1]);
  }
  // Env override (ORELLIUS_HUB_PORT) is next.
  if (process.env.ORELLIUS_HUB_PORT) {
    const p = Number(process.env.ORELLIUS_HUB_PORT);
    if (Number.isFinite(p)) return p;
  }
  const configPath = path.join(os.homedir(), ".config", "orellius-browser-bridge", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const TCP_PORT = getPort();
const ADMIN_HTTP_PORT = TCP_PORT + 1; // 18766 by default
const pidfilePath = path.join(os.tmpdir(), `orellius-browser-bridge-hub-${TCP_PORT}.pid`);

// --- State ---
//
// Multi-browser routing: the hub holds one native_host socket PER browser
// ("chromium" or "firefox"), so a Chrome extension and a Firefox extension
// can both stay connected at the same time without kicking each other out.
// MCP clients tag each tool_request with `browser` to indicate which one
// should serve it; if absent, the hub defaults to "chromium" (legacy).

/** @type {Map<string, net.Socket>} browser -> native host socket */
const nativeHostSockets = new Map();

/** @type {Map<string, net.Socket>} sessionId -> MCP server socket */
const mcpClients = new Map();

/** @type {Map<string, {sessionId: string, browser: string}>} requestId -> routing info */
const requestRouting = new Map();

const DEFAULT_BROWSER = "chromium";

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
  const browser = msg.browser || DEFAULT_BROWSER;
  const socket = nativeHostSockets.get(browser);

  if (!socket || socket.destroyed) {
    // Send error back to the MCP client
    const sessionId = msg.sessionId;
    const client = sessionId ? mcpClients.get(sessionId) : null;
    if (client && !client.destroyed) {
      const known = [...nativeHostSockets.keys()].join(", ") || "none";
      const errMsg = JSON.stringify({
        id: msg.id,
        sessionId,
        type: "tool_error",
        error: `No ${browser} browser extension connected to hub (registered: ${known}). Open a ${browser} browser with the Orellius extension loaded.`,
      }) + "\n";
      client.write(errMsg);
    }
    return;
  }

  // Track which session AND which browser this request belongs to so we can
  // route the eventual response back to the right MCP client even if the
  // response message itself loses its sessionId.
  if (msg.id && msg.sessionId) {
    requestRouting.set(msg.id, { sessionId: msg.sessionId, browser });
  }

  socket.write(JSON.stringify(msg) + "\n");
}

function forwardToMcpClient(msg) {
  // Route response to the correct MCP client via sessionId
  let sessionId = msg.sessionId;

  // Fallback: look up sessionId by request ID
  if (!sessionId && msg.id) {
    const route = requestRouting.get(msg.id);
    if (route) sessionId = route.sessionId;
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
  let socketBrowser = null; // for native_host sockets only
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
            socketBrowser = msg.browser || DEFAULT_BROWSER;
            // Only replace the same-browser socket; do not kick out other
            // browsers' native_hosts (the original bug that prevented Chrome
            // and Firefox from coexisting).
            const prev = nativeHostSockets.get(socketBrowser);
            if (prev && !prev.destroyed) {
              log(`Replacing previous ${socketBrowser} native host with ${remote}`);
              prev.destroy();
            }
            nativeHostSockets.set(socketBrowser, socket);
            log(`Native host registered from ${remote} (browser=${socketBrowser}, total=${nativeHostSockets.size})`);
            socket.write(JSON.stringify({ type: "registered", role: "native_host", browser: socketBrowser }) + "\n");
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
            // Legacy: treat as native host with default browser (back-compat
            // with pre-multi-browser native-host.js that omits the browser
            // field on register).
            socketType = "native_host";
            socketBrowser = DEFAULT_BROWSER;
            const prev = nativeHostSockets.get(socketBrowser);
            if (prev && !prev.destroyed) {
              log(`Replacing previous ${socketBrowser} native host (legacy connect) with ${remote}`);
              prev.destroy();
            }
            nativeHostSockets.set(socketBrowser, socket);
            log(`Native host connected (legacy, browser=${socketBrowser}) from ${remote}`);
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
    if (socketType === "native_host" && socketBrowser && nativeHostSockets.get(socketBrowser) === socket) {
      log(`Native host disconnected (browser=${socketBrowser}, ${remote})`);
      nativeHostSockets.delete(socketBrowser);
    } else if (socketType === "mcp_client" && socketSessionId) {
      log(`MCP client disconnected: session=${socketSessionId} (${remote})`);
      mcpClients.delete(socketSessionId);
      // Clean up pending request routing for this session
      for (const [reqId, route] of requestRouting) {
        if (route.sessionId === socketSessionId) requestRouting.delete(reqId);
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
  for (const [, sock] of nativeHostSockets) {
    if (!sock.destroyed) sock.destroy();
  }
  nativeHostSockets.clear();
  server.close();
  try { adminServer.close(); } catch {}
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Admin HTTP server (localhost only).
//
// Exposes a small REST surface so the user can flip global Orellius state from
// any shell without going through a Claude session - the primary use case is
// "force every Orellius instance to private mode RIGHT NOW and lock it there"
// when the user notices a session running in public mode and stealing window
// focus from their other Chrome work.
//
// Endpoints (all 127.0.0.1 only, no auth - localhost-only by virtue of the
// bind address):
//   POST /admin/force-private  -> broadcast admin_set_mode(mode=private, lock=on)
//   POST /admin/unlock         -> broadcast admin_set_mode(lock=off)
//   GET  /admin/status         -> return hub state JSON
//
// The native host forwards admin_set_mode payloads to the extension via the
// existing native messaging channel; background.js handles the message and
// updates chrome.storage.local accordingly.
// ---------------------------------------------------------------------------

function broadcastAdminMessage(adminMsg) {
  let delivered = 0;
  for (const [browser, sock] of nativeHostSockets) {
    if (sock && !sock.destroyed) {
      try {
        sock.write(JSON.stringify({ ...adminMsg, browser }) + "\n");
        delivered++;
      } catch (err) {
        log(`broadcast to ${browser} failed: ${err.message}`);
      }
    }
  }
  return delivered;
}

const adminServer = http.createServer((req, res) => {
  const cors = () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  };
  cors();
  const url = new URL(req.url, `http://127.0.0.1:${ADMIN_HTTP_PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/status") {
    const body = {
      ok: true,
      tcpPort: TCP_PORT,
      adminPort: ADMIN_HTTP_PORT,
      pid: process.pid,
      nativeHosts: [...nativeHostSockets.keys()],
      mcpClientCount: mcpClients.size,
      mcpSessions: [...mcpClients.keys()],
      uptimeSec: Math.round(process.uptime()),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/force-private") {
    const delivered = broadcastAdminMessage({
      type: "admin_set_mode",
      mode: "private",
      lock: true,
      reason: "force-private CLI",
    });
    log(`/admin/force-private broadcast delivered to ${delivered} native_host(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      message: delivered > 0
        ? `Sent force-private + lock to ${delivered} browser native_host(s). All Orellius sessions are now in private mode and cannot switch to public until /admin/unlock.`
        : "No browser extensions are currently connected to the hub. Open Chrome with the Orellius extension to take effect; the lock will apply once the extension connects (lock state persists in extension storage).",
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/admin/unlock") {
    const delivered = broadcastAdminMessage({
      type: "admin_set_mode",
      lock: false,
      reason: "unlock CLI",
    });
    log(`/admin/unlock broadcast delivered to ${delivered} native_host(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      message: delivered > 0
        ? `Unlocked. ${delivered} browser native_host(s) notified. Sessions can switch to public mode again via the browser_mode tool.`
        : "No browser extensions are currently connected to the hub. Unlock will take effect when the extension reconnects.",
    }));
    return;
  }

  // POST /admin/close-unused
  //
  // Close every Orellius-owned window whose sessionId is NOT in the hub's
  // active mcpClients map. Currently-active Claude sessions keep their tabs;
  // orphan sessions get reaped. Useful when you've accumulated multiple
  // Orellius windows over several Claude conversations and only one is still
  // wired up.
  if (req.method === "POST" && url.pathname === "/admin/close-unused") {
    const activeSessionIds = [...mcpClients.keys()];
    const delivered = broadcastAdminMessage({
      type: "admin_close_tabs",
      mode: "unused",
      activeSessionIds,
      reason: "close-unused CLI",
    });
    log(`/admin/close-unused broadcast delivered to ${delivered} native_host(s) (preserving ${activeSessionIds.length} active session(s))`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      activeSessionCount: activeSessionIds.length,
      message: delivered > 0
        ? `Sent close-unused to ${delivered} browser native_host(s). ${activeSessionIds.length} active Claude session(s) keep their tabs; orphan sessions are being closed.`
        : "No browser extensions are currently connected to the hub. No-op.",
    }));
    return;
  }

  // POST /admin/shutdown
  //
  // Close EVERY Orellius-owned window. MCP clients stay connected to the hub;
  // their next tabs_context_mcp({createIfEmpty:true}) auto-recreates a fresh
  // window. Useful when you want a clean slate without restarting any Claude
  // conversation.
  if (req.method === "POST" && url.pathname === "/admin/shutdown") {
    const delivered = broadcastAdminMessage({
      type: "admin_close_tabs",
      mode: "all",
      reason: "shutdown CLI",
    });
    log(`/admin/shutdown broadcast delivered to ${delivered} native_host(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      mcpClientCount: mcpClients.size,
      message: delivered > 0
        ? `Sent shutdown to ${delivered} browser native_host(s). All Orellius windows are being closed. ${mcpClients.size} MCP client(s) remain connected to the hub; the next tabs_context_mcp({createIfEmpty:true}) call will spawn a fresh window.`
        : "No browser extensions are currently connected to the hub. No-op.",
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: false,
    error: "Unknown admin endpoint",
    available: [
      "GET /admin/status",
      "POST /admin/force-private",
      "POST /admin/unlock",
      "POST /admin/close-unused",
      "POST /admin/shutdown",
    ],
  }));
});

adminServer.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`Admin HTTP port ${ADMIN_HTTP_PORT} already in use - skipping admin server (another hub may own it).`);
  } else {
    log(`Admin server error: ${err.message}`);
  }
});

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

adminServer.listen(ADMIN_HTTP_PORT, "127.0.0.1", () => {
  log(`Admin HTTP listening on 127.0.0.1:${ADMIN_HTTP_PORT} (POST /admin/{force-private,unlock,close-unused,shutdown}, GET /admin/status)`);
});
