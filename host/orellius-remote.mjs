#!/usr/bin/env node

// orellius-remote - self-healing SSH tunnel to the VPS Orellius hub.
//
// WHY THIS EXISTS
// Agent browsing should happen on the VPS Chrome by default so Ziv's own
// Chrome stays his. The hub binds 127.0.0.1 with no auth, so the only safe way
// to reach it is an SSH tunnel - which also keeps the hub's "localhost only"
// security assumption true.
//
// USAGE
//   node orellius-remote.mjs                 # tunnel on 127.0.0.1:18775, stays up
//   node orellius-remote.mjs --port=18780    # different local port
//   node orellius-remote.mjs --check         # probe only, exit 0 if hub answers
//   node orellius-remote.mjs --print-env     # print the env a session needs
//
// Then point a Claude Code session at it (per-project .mcp.json):
//   {
//     "mcpServers": {
//       "orellius-remote": {
//         "command": "node",
//         "args": ["E:/FromC/projects/orellius-browser-bridge/host/mcp-server.js"],
//         "env": {
//           "ORELLIUS_HUB_HOST": "127.0.0.1",
//           "ORELLIUS_HUB_PORT": "18775",
//           "ORELLIUS_HUB_REMOTE": "1"
//         }
//       }
//     }
//   }
//
// ORELLIUS_HUB_REMOTE=1 is REQUIRED. Without it, a dead tunnel makes
// mcp-server.js auto-spawn a LOCAL hub and quietly drive Ziv's own Chrome.
//
// autossh is not available on Windows, so the retry loop is implemented here:
// plain `ssh -N`, respawned with exponential backoff, plus ServerAlive probes
// so a silently dead TCP connection is detected rather than hanging forever.

import { spawn } from "node:child_process";
import net from "node:net";

const DEFAULTS = {
  localPort: 18775,
  remoteHost: "104.200.30.37",
  remoteUser: "ziv",
  remoteHubPort: 18765,
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const has = (name) => args.includes(`--${name}`);

const LOCAL_PORT = Number(flag("port", process.env.ORELLIUS_HUB_PORT || DEFAULTS.localPort));
const REMOTE_HOST = flag("host", process.env.ORELLIUS_VPS_HOST || DEFAULTS.remoteHost);
const REMOTE_USER = flag("user", process.env.ORELLIUS_VPS_USER || DEFAULTS.remoteUser);
const REMOTE_HUB_PORT = Number(flag("remote-port", DEFAULTS.remoteHubPort));

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[orellius-remote ${ts}] ${msg}\n`);
}

/** Resolve true if something is listening on 127.0.0.1:port. */
function portAnswers(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
    s.connect(port, "127.0.0.1");
  });
}

/**
 * Ask the tunnelled hub for its status. Proves the tunnel reaches a REAL hub,
 * not just that some local process grabbed the port.
 */
function probeHub(port) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let buf = "";
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(4000);
    s.once("timeout", () => done(null));
    s.once("error", () => done(null));
    s.connect(port, "127.0.0.1", () => {
      // Registering as an MCP client is the only handshake the hub answers on
      // the TCP port. Use a throwaway sessionId and disconnect immediately.
      s.write(JSON.stringify({ type: "register_mcp_client", sessionId: "probe0000" }) + "\n");
    });
    s.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const line = buf.split("\n").find((l) => l.trim());
      if (!line) return;
      try {
        const msg = JSON.parse(line);
        done(msg.type === "registered" ? msg : null);
      } catch { done(null); }
    });
  });
}

if (has("print-env")) {
  console.log(`ORELLIUS_HUB_HOST=127.0.0.1`);
  console.log(`ORELLIUS_HUB_PORT=${LOCAL_PORT}`);
  console.log(`ORELLIUS_HUB_REMOTE=1`);
  process.exit(0);
}

if (has("check")) {
  const up = await portAnswers(LOCAL_PORT);
  if (!up) {
    log(`Nothing listening on 127.0.0.1:${LOCAL_PORT}. Tunnel is DOWN.`);
    process.exit(1);
  }
  const hub = await probeHub(LOCAL_PORT);
  if (!hub) {
    log(`Port ${LOCAL_PORT} is open but did not answer the hub handshake. Something else owns it.`);
    process.exit(2);
  }
  log(`Tunnel UP: 127.0.0.1:${LOCAL_PORT} -> ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_HUB_PORT} (hub responded)`);
  process.exit(0);
}

// --- Singleton guard -------------------------------------------------------
// Starting a second tunnel on the same port would fail noisily in ssh; catch it
// here so repeated invocations are harmless.
if (await portAnswers(LOCAL_PORT)) {
  const hub = await probeHub(LOCAL_PORT);
  if (hub) {
    log(`Tunnel already up on 127.0.0.1:${LOCAL_PORT}. Nothing to do.`);
    process.exit(0);
  }
  log(`Port ${LOCAL_PORT} is already in use by something that is NOT an Orellius hub. Refusing to start.`);
  process.exit(2);
}

// --- Supervised tunnel -----------------------------------------------------

const SSH_ARGS = [
  "-N",                                   // no remote command, forwarding only
  "-o", "ExitOnForwardFailure=yes",       // fail loudly if the bind is refused
  "-o", "ServerAliveInterval=15",         // detect a silently dead link
  "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "BatchMode=yes",                  // never sit at an interactive prompt
  "-L", `127.0.0.1:${LOCAL_PORT}:127.0.0.1:${REMOTE_HUB_PORT}`,
  `${REMOTE_USER}@${REMOTE_HOST}`,
];

let child = null;
let stopping = false;
let backoffMs = 1000;
const BACKOFF_MAX_MS = 30000;

function start() {
  if (stopping) return;
  log(`Connecting: ssh ${SSH_ARGS.join(" ")}`);
  child = spawn("ssh", SSH_ARGS, { stdio: ["ignore", "pipe", "pipe"] });

  child.stdout.on("data", (d) => log(`ssh: ${String(d).trim()}`));
  child.stderr.on("data", (d) => {
    const t = String(d).trim();
    if (t) log(`ssh: ${t}`);
  });

  // Once the forward is actually serving, treat the connection as healthy and
  // reset the backoff so a long-lived tunnel that eventually drops reconnects
  // fast rather than at the last (possibly maxed-out) delay.
  setTimeout(async () => {
    if (child && !child.killed && (await portAnswers(LOCAL_PORT))) {
      backoffMs = 1000;
      log(`Tunnel UP on 127.0.0.1:${LOCAL_PORT} -> ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_HUB_PORT}`);
      log(`Point a session at it with: ORELLIUS_HUB_HOST=127.0.0.1 ORELLIUS_HUB_PORT=${LOCAL_PORT} ORELLIUS_HUB_REMOTE=1`);
    }
  }, 2500);

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    log(`ssh exited (code=${code} signal=${signal}). Reconnecting in ${backoffMs}ms.`);
    setTimeout(start, backoffMs);
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  });

  child.on("error", (err) => {
    log(`Failed to spawn ssh: ${err.message}`);
  });
}

function stop() {
  stopping = true;
  log("Shutting down tunnel.");
  if (child && !child.killed) child.kill();
  process.exit(0);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);

start();
