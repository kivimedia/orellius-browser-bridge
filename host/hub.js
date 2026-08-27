#!/usr/bin/env node

// Hub process for Orellius Browser Bridge.
// Multiplexes multiple MCP server sessions through a single native host connection.
// Auto-spawned by mcp-server.js if not running. Stays alive with an idle timeout.

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";

const DEFAULT_PORT = 18765;
// 5 minutes with no MCP clients -> exit. Set ORELLIUS_IDLE_TIMEOUT_MS=0 to stay
// up forever, which is what a SUPERVISOR wants.
//
// The default is right for the normal case: a hub is auto-spawned on demand by
// mcp-server.js and should not outlive the session that needed it. It is wrong
// for the reverse-tunnel case. When a KM BOT agent on the VPS reaches this PC
// through the tunnel, the thing that would respawn the hub - mcp-server.js -
// is on the OTHER side of it, so a hub that exits leaves the tunnel forwarding
// to a closed port. Doni read Ziv's WhatsApp at 09:21 on 27-Aug-2026 and, at
// 09:28, could not: same tunnel, same grant, hub gone. Its own status still
// said connected, because ssh was up.
const IDLE_TIMEOUT_MS = process.env.ORELLIUS_IDLE_TIMEOUT_MS !== undefined
  ? Number(process.env.ORELLIUS_IDLE_TIMEOUT_MS)
  : 5 * 60 * 1000;

// How long a registered MCP session may go WITHOUT making a browser tool call
// before the hub evicts it: its Chrome window is closed and its socket dropped.
// The session is not broken by this - mcp-server.js reconnects transparently on
// its next tool call.
//
// Before this existed, "registered" was forever: a Claude session that browsed
// once held a Chrome window until VS Code closed. With ~15 concurrent sessions
// that meant windows from two-day-old conversations were still pinned open, and
// /admin/close-unused could never reap anything because every session with a
// live process counted as active.
const SESSION_IDLE_TTL_MS = Number(process.env.ORELLIUS_SESSION_TTL_MS) || 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.ORELLIUS_SWEEP_INTERVAL_MS) || 60 * 1000;
// How long a freshly-registered session is protected from the sweeper before
// it has to show a real browser call. Short on purpose: registration is a
// connection event, not browsing, and treating it as browsing makes
// /admin/status unable to answer "who is driving the browser right now".
const REGISTER_GRACE_MS = 60 * 1000;

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

/**
 * sessionId -> epoch ms of the last BROWSER TOOL CALL from that session.
 *
 * This is the real definition of "active". A live MCP process is not activity -
 * that was the old bug. Only an actual tool_request counts.
 * @type {Map<string, number>}
 */
const sessionActivity = new Map();

const DEFAULT_BROWSER = "chromium";

let idleTimer = null;

function touchSession(sessionId) {
  if (sessionId) sessionActivity.set(sessionId, Date.now());
}

/**
 * Sessions that have made a browser tool call within SESSION_IDLE_TTL_MS.
 * This is what the extension must preserve when closing windows.
 */
function activeSessionIds() {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  const out = [];
  for (const sessionId of mcpClients.keys()) {
    const last = sessionActivity.get(sessionId);
    if (last !== undefined && last >= cutoff) out.push(sessionId);
  }
  return out;
}

/**
 * Evict sessions that have been idle past the TTL: close their browser windows
 * and drop their sockets. mcp-server.js re-registers on its next tool call, so
 * nothing the user does is broken by this.
 */
function sweepIdleSessions() {
  if (mcpClients.size === 0) return;
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  const idle = [];
  for (const sessionId of mcpClients.keys()) {
    const last = sessionActivity.get(sessionId);
    if (last === undefined || last < cutoff) idle.push(sessionId);
  }
  if (idle.length === 0) return;

  const stillActive = activeSessionIds();
  const delivered = broadcastAdminMessage({
    type: "admin_close_tabs",
    mode: "unused",
    activeSessionIds: stillActive,
    reason: `idle TTL sweep (${SESSION_IDLE_TTL_MS / 60000}min)`,
  });
  log(
    `Idle sweep: evicting ${idle.length} session(s) [${idle.join(", ")}], ` +
    `keeping ${stillActive.length} active. Window-close broadcast to ${delivered} native_host(s).`
  );

  for (const sessionId of idle) {
    const sock = mcpClients.get(sessionId);
    mcpClients.delete(sessionId);
    sessionActivity.delete(sessionId);
    for (const [reqId, route] of requestRouting) {
      if (route.sessionId === sessionId) requestRouting.delete(reqId);
    }
    if (sock && !sock.destroyed) sock.destroy();
  }
  resetIdleTimer();
}

const sweepTimer = setInterval(sweepIdleSessions, SWEEP_INTERVAL_MS);
// Never let the sweeper alone hold the process open.
if (sweepTimer.unref) sweepTimer.unref();

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (mcpClients.size === 0 && IDLE_TIMEOUT_MS > 0) {
    idleTimer = setTimeout(() => {
      if (mcpClients.size === 0) {
        log(`No MCP clients for ${IDLE_TIMEOUT_MS}ms. Shutting down.`);
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

// ---------------------------------------------------------------------------
// Native-host recovery: park the call, fix the cause, deliver late.
//
// Before 2026-08-28 a tool_request that arrived while no native host was
// connected failed INSTANTLY with "No chromium browser extension connected to
// hub (registered: none). Open a chromium browser with the Orellius extension
// loaded." That last sentence is addressed to a human, and the model on the
// other end of the MCP call read it as one. Twice on 2026-08-27 a Claude
// session stopped and asked Ziv to "reconnect the extension": once when Chrome
// had simply been closed (the extension re-registered by itself seconds after
// he relaunched Chrome - launching it was the ONLY missing action), and once
// when Chrome was running with 73 processes and only the registration had
// dropped (the extension's keepalive fixes that on its own inside a minute).
// Neither condition ever needed a person. Ziv: "couldn't it manage to solve
// this by himself? All I did was run a new chrome."
//
// So the hub now does what the person would have done:
//   1. park the request instead of failing it. mcp-server.js waits 60s per
//      call; we use RECOVERY_WAIT_MS of that budget;
//   2. if the browser process is not running at all, launch it. On Windows the
//      extension lives in ONE profile (Ziv's "Default"), so the launch names
//      that profile - a 13-profile Chrome launched bare may show the profile
//      picker and never start any extension. Launching Chrome when there is no
//      Chrome is not "controlling his desktop" (rule 15): it is the one click
//      he would have made himself, and he asked for it;
//   3. if the browser IS running, do nothing but wait: the extension's own
//      keepalive alarm probes /admin/status every 30s and reconnects a null or
//      half-open native port by itself (see background.js, HALF_OPEN_STRIKES);
//   4. the moment a native host registers, flush every parked request to it;
//   5. only when the deadline passes, fail - with a message written FOR THE
//      MODEL: what the hub already did, and the exact next steps, none of
//      which is "ask the human".
//
// Env overrides (all optional; scripts/test-hub-recovery.mjs uses them):
//   ORELLIUS_RECOVERY_WAIT_MS       how long a call may wait for a host (default 50s)
//   ORELLIUS_RECOVERY_REKICK_MS     min gap between two launch/probe cycles (default 20s)
//   ORELLIUS_BROWSER_PROCESS_NAME   what to count (default chrome.exe / Google Chrome / chrome)
//   ORELLIUS_BROWSER_EXE            what to launch (default: Chrome's standard install paths;
//                                   on Linux there is NO default - the VPS Chrome is pm2's)
//   ORELLIUS_BROWSER_ARGS           launch args, whitespace-separated (default --profile-directory=<P>)
//   ORELLIUS_BROWSER_PROFILE_DIR    the profile that holds the extension (default "Default")
// ---------------------------------------------------------------------------
const RECOVERY_WAIT_MS = Number(process.env.ORELLIUS_RECOVERY_WAIT_MS) || 50 * 1000;
const RECOVERY_REKICK_MS = Number(process.env.ORELLIUS_RECOVERY_REKICK_MS) || 20 * 1000;

/** @type {Array<{msg: object, browser: string, parkedAt: number, deadline: number}>} */
const parkedRequests = [];
/** The most recent recovery attempt - shown on /admin/status and quoted in the failure text. */
let lastRecovery = null;
let recoveryInFlight = null;
let parkTimer = null;

function browserProcessName(browser) {
  if (process.env.ORELLIUS_BROWSER_PROCESS_NAME) return process.env.ORELLIUS_BROWSER_PROCESS_NAME;
  if (browser === "firefox") return process.platform === "win32" ? "firefox.exe" : "firefox";
  if (process.platform === "win32") return "chrome.exe";
  if (process.platform === "darwin") return "Google Chrome";
  return "chrome";
}

function execFileP(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout));
    });
  });
}

/** How many processes of the browser exist right now. null = could not tell. */
async function countBrowserProcesses(browser) {
  const name = browserProcessName(browser);
  try {
    if (process.platform === "win32") {
      const out = await execFileP("tasklist", ["/FI", `IMAGENAME eq ${name}`, "/NH", "/FO", "CSV"], 10000);
      const needle = `"${name.toLowerCase()}"`;
      return out.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(needle)).length;
    }
    const out = await execFileP("pgrep", process.platform === "darwin" ? ["-x", name] : ["-f", name], 10000);
    return out.split(/\r?\n/).filter(Boolean).length;
  } catch (err) {
    // pgrep exits 1 when nothing matches - that is a real zero, not a failure.
    if (process.platform !== "win32" && err && err.code === 1) return 0;
    log(`Recovery: could not count ${name} processes: ${err.message}`);
    return null;
  }
}

function browserExecutable(browser) {
  if (process.env.ORELLIUS_BROWSER_EXE) return process.env.ORELLIUS_BROWSER_EXE;
  if (browser !== "chromium") return null;
  if (process.platform === "win32") {
    const candidates = [
      path.join(process.env["ProgramFiles"] || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
  }
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  // Linux: the VPS Chrome is supervised by pm2 (orellius-chrome) and carries its
  // own --user-data-dir; a bare launch here would start a second, unrelated
  // Chrome. Opt in explicitly with ORELLIUS_BROWSER_EXE if you want it.
  return null;
}

function browserLaunchArgs() {
  if (process.env.ORELLIUS_BROWSER_ARGS !== undefined) {
    return process.env.ORELLIUS_BROWSER_ARGS.split(/\s+/).filter(Boolean);
  }
  const profile = process.env.ORELLIUS_BROWSER_PROFILE_DIR || "Default";
  return [`--profile-directory=${profile}`];
}

/**
 * Start the browser. On Windows this goes through WMI (Win32_Process.Create):
 * the new process is a child of WmiPrvSE.exe in the caller's interactive
 * session, so it is never inside any job object the hub might be running in and
 * outlives the hub's own idle exit. Verified 2026-08-28 (parent WmiPrvSE.exe,
 * session 1). Falls back to a detached spawn if WMI is unavailable.
 */
async function launchBrowser(browser) {
  const exe = browserExecutable(browser);
  if (!exe) {
    return { ok: false, reason: `no ${browser} executable known on ${process.platform} (set ORELLIUS_BROWSER_EXE)` };
  }
  const args = browserLaunchArgs();
  const cmdline = [`"${exe}"`, ...args].join(" ");
  if (process.platform === "win32") {
    const ps = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdline.replace(/'/g, "''")}' }; "$($r.ReturnValue) $($r.ProcessId)"`;
    try {
      const out = (await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 20000)).trim();
      const [rv, pid] = out.split(/\s+/);
      if (rv === "0" && pid) return { ok: true, pid: Number(pid), via: "wmi", cmdline };
      log(`Recovery: WMI launch returned "${out}" - falling back to spawn`);
    } catch (err) {
      log(`Recovery: WMI launch failed (${err.message}) - falling back to spawn`);
    }
  }
  try {
    const child = spawn(exe, args, { detached: true, stdio: "ignore" });
    child.on("error", (err) => log(`Recovery: spawned browser errored: ${err.message}`));
    child.unref();
    return { ok: true, pid: child.pid, via: "spawn", cmdline };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function runRecovery(browser) {
  const rec = {
    browser,
    startedMs: Date.now(),
    startedAt: new Date().toISOString(),
    processName: browserProcessName(browser),
    processCount: null,
    browserRunning: null,
    launched: null,
    steps: [],
  };
  lastRecovery = rec;
  const count = await countBrowserProcesses(browser);
  rec.processCount = count;
  rec.browserRunning = count === null ? null : count > 0;
  if (count === null) {
    rec.steps.push(`could not tell whether ${rec.processName} is running; waiting for the extension to register`);
  } else if (count > 0) {
    rec.steps.push(`${rec.processName} is running (${count} processes); waiting for its Orellius extension to re-register on its own (keepalive every 30s)`);
  } else {
    rec.steps.push(`${rec.processName} is NOT running`);
    const launched = await launchBrowser(browser);
    rec.launched = launched;
    rec.steps.push(launched.ok
      ? `launched ${launched.cmdline} (pid ${launched.pid}, via ${launched.via}); waiting for its extension to register`
      : `could not launch it: ${launched.reason}`);
  }
  log(`Recovery: ${rec.steps.join("; ")}`);
  return rec;
}

function kickRecovery(browser) {
  if (recoveryInFlight) return;
  if (lastRecovery && Date.now() - lastRecovery.startedMs < RECOVERY_REKICK_MS) return;
  recoveryInFlight = runRecovery(browser)
    .catch((err) => log(`Recovery: attempt threw: ${err.message}`))
    .finally(() => { recoveryInFlight = null; });
}

function parkRequest(msg, browser) {
  const now = Date.now();
  parkedRequests.push({ msg, browser, parkedAt: now, deadline: now + RECOVERY_WAIT_MS });
  log(`No ${browser} native host - parked ${msg.tool || "request"} ${msg.id} from session ${msg.sessionId} (${parkedRequests.length} parked, up to ${Math.round(RECOVERY_WAIT_MS / 1000)}s)`);
  kickRecovery(browser);
  if (!parkTimer) {
    parkTimer = setInterval(expireParked, 1000);
    if (parkTimer.unref) parkTimer.unref();
  }
}

/** A native host for the browser just registered: deliver everything waiting for it. */
function flushParked(browser) {
  const socket = nativeHostSockets.get(browser);
  if (!socket || socket.destroyed) return;
  const mine = parkedRequests.filter((p) => p.browser === browser);
  if (mine.length === 0) return;
  for (const p of mine) parkedRequests.splice(parkedRequests.indexOf(p), 1);
  let delivered = 0;
  for (const p of mine) {
    const client = mcpClients.get(p.msg.sessionId);
    if (!client || client.destroyed) continue; // session left while waiting
    if (p.msg.id && p.msg.sessionId) requestRouting.set(p.msg.id, { sessionId: p.msg.sessionId, browser });
    socket.write(JSON.stringify(p.msg) + "\n");
    delivered++;
  }
  const waited = Math.round((Date.now() - Math.min(...mine.map((p) => p.parkedAt))) / 1000);
  log(`Native host back - delivered ${delivered} parked request(s) after up to ${waited}s`);
}

function recoveryFailureText(p) {
  const known = [...nativeHostSockets.keys()].join(", ") || "none";
  const waited = Math.round((Date.now() - p.parkedAt) / 1000);
  const rec = lastRecovery;
  const name = browserProcessName(p.browser);
  const lines = [
    `No ${p.browser} browser extension is connected to the Orellius hub (registered: ${known}) and none registered within ${waited}s.`,
    `What the hub already did: ${rec ? rec.steps.join("; ") : "no recovery attempt ran"}.`,
    `This is a known SELF-HEALING condition. Do the following yourself. Do NOT ask the human to open Chrome, reload or reconnect anything:`,
  ];
  if (rec && rec.browserRunning === false && rec.launched && rec.launched.ok) {
    lines.push(`1. ${name} was just launched by the hub (pid ${rec.launched.pid}); a cold start plus extension registration can outlast one wait. Retry this exact tool call now.`);
  } else if (rec && rec.browserRunning === false) {
    lines.push(`1. ${name} is not running and the hub could not launch it (${rec.launched ? rec.launched.reason : "unknown reason"}). Launch it yourself, then retry this call. Windows: Start-Process "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -ArgumentList "--profile-directory=Default" (the extension lives in the Default profile). VPS: pm2 restart orellius-chrome.`);
  } else {
    lines.push(`1. ${name} is running but its extension has not re-registered. The extension reconnects on its own within about 60s of noticing (30s keepalive, two strikes for a half-open port). Retry this exact tool call once.`);
  }
  lines.push(`2. On this hub's machine: curl -s http://127.0.0.1:${ADMIN_HTTP_PORT}/admin/status -> "nativeHosts" must list "${p.browser}". Then curl -s -X POST http://127.0.0.1:${ADMIN_HTTP_PORT}/admin/reload-extension (delivered:0 means no host is connected, i.e. the extension itself is not running).`);
  lines.push(`3. If it is still absent after that, the extension is crashed or disabled. Reload it: open chrome://extensions in the browser that holds it and click Reload on Orellius. On Ziv's PC do that through the windows-desktop MCP - he authorized exactly this on 2026-08-27 ("claude can control my desktop on orellius, even go into extension to reload it"), one bounded action, say what you are doing. On the VPS: pm2 restart orellius-chrome. Then retry.`);
  lines.push(`Never end your turn by asking the human to reconnect, reload or open the browser (memory: orellius-never-hand-back-a-connection-failure).`);
  return lines.join("\n");
}

function expireParked() {
  const now = Date.now();
  for (let i = 0; i < parkedRequests.length;) {
    const p = parkedRequests[i];
    if (p.deadline > now) { i++; continue; }
    parkedRequests.splice(i, 1);
    const client = mcpClients.get(p.msg.sessionId);
    if (client && !client.destroyed) {
      client.write(JSON.stringify({
        id: p.msg.id,
        sessionId: p.msg.sessionId,
        type: "tool_error",
        error: recoveryFailureText(p),
      }) + "\n");
    }
    log(`Recovery: gave up on parked ${p.msg.tool || "request"} ${p.msg.id} after ${Math.round((now - p.parkedAt) / 1000)}s - no ${p.browser} native host registered`);
  }
  if (parkedRequests.length === 0 && parkTimer) {
    clearInterval(parkTimer);
    parkTimer = null;
  }
}

// --- Message routing ---

function forwardToNativeHost(msg) {
  const browser = msg.browser || DEFAULT_BROWSER;
  const socket = nativeHostSockets.get(browser);

  if (!socket || socket.destroyed) {
    // No native host right now. Do NOT fail the call - park it and recover
    // (see "Native-host recovery" above for why the instant error was wrong).
    // Only requests that can be answered are parked: a known client and an id.
    const sessionId = msg.sessionId;
    const client = sessionId ? mcpClients.get(sessionId) : null;
    if (client && !client.destroyed && msg.id) {
      parkRequest(msg, browser);
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
  // Every message on this socket is a small, latency-critical, request/response
  // line. Nagle holds a small write back until previously sent data is ACKed,
  // which over the SSH tunnel to a remote session costs a whole extra network
  // round trip per call. Measured 2026-08-16 from Ziv's PC: raw RTT to the VPS
  // is 135ms and a bare echo through the same tunnel answers in 147ms, but a
  // hub round trip that the VPS itself serves in 1ms took 306ms - almost
  // exactly 2x RTT. There is no throughput to protect here; turn Nagle off.
  socket.setNoDelay(true);
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
            flushParked(socketBrowser);
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
            // Registration is NOT a browser call, and must not be recorded as
            // one: doing that made a session that had merely reconnected look
            // identical to one actively driving the browser, which produced a
            // wrong diagnosis on 2026-08-02 (sessions read as "3s since last
            // activity" when they had done nothing at all).
            //
            // It still needs a grace window, or the sweeper could evict a
            // session in the gap between registering and its first
            // tool_request landing. So backdate the stamp to give exactly
            // REGISTER_GRACE_MS of protection, no more.
            sessionActivity.set(socketSessionId, Date.now() - SESSION_IDLE_TTL_MS + REGISTER_GRACE_MS);
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            log(`MCP client registered: session=${socketSessionId} from ${remote} (total: ${mcpClients.size})`);
            socket.write(JSON.stringify({ type: "registered", role: "mcp_client", sessionId: socketSessionId }) + "\n");
            continue;
          } else {
            // Legacy: treat as native host with default browser (back-compat
            // with pre-multi-browser native-host.js that omits the browser
            // field on register).
            //
            // GATED 2026-08-25 (written on the VPS, committed upstream
            // 2026-08-28). An UNRECOGNISED first message was silently
            // accepted as a native-host registration, and the branch below
            // then DESTROYS the incumbent socket. So any local process could
            // evict the real browser and start receiving every other
            // session's tool_requests, including Ziv's own live sessions.
            //
            // It is dead code on both machines: native-host.js always sends
            // an explicit register_native_host, and this branch has never
            // fired in a hub log. Gated rather than deleted, in case an older
            // native host is ever pointed here.
            if (process.env.ORELLIUS_ALLOW_LEGACY_NATIVE_HOST !== "1") {
              log(`Refusing legacy native-host registration from ${remote}` +
                  ` (set ORELLIUS_ALLOW_LEGACY_NATIVE_HOST=1 to allow)`);
              socket.destroy();
              return;
            }
            socketType = "native_host";
            socketBrowser = DEFAULT_BROWSER;
            const prev = nativeHostSockets.get(socketBrowser);
            if (prev && !prev.destroyed) {
              log(`Replacing previous ${socketBrowser} native host (legacy connect) with ${remote}`);
              prev.destroy();
            }
            nativeHostSockets.set(socketBrowser, socket);
            log(`Native host connected (legacy, browser=${socketBrowser}) from ${remote}`);
            flushParked(socketBrowser);
            // Fall through to process this message
          }
        }

        // Route messages based on socket type
        if (msg.type === "heartbeat") continue;

        if (socketType === "mcp_client") {
          // MCP client sending a tool request -> forward to native host.
          // THIS is what "active" means - a real browser tool call.
          msg.sessionId = socketSessionId;
          touchSession(socketSessionId);
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
      sessionActivity.delete(socketSessionId);
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

// Origins allowed to call the admin port WITH an Origin header. Local CLI
// tooling and scripts send none and are always accepted. The extension's
// service worker probes /admin/status every 30s (probe-before-spawn gate and
// half-open self-heal in background.js). Chrome 152 sends NO Origin on that
// probe - verified with tcpdump on the VPS loopback, 2026-08-28 - so a blanket
// refusal of Origin-bearing requests did not break it. That is a Chrome
// implementation detail, though, so the extension's own origin is allowed
// explicitly: its id is already pinned in the native-host manifest's
// allowed_origins; read it from there. If no manifest can be read,
// any browser-extension origin is accepted (fail open for the bridge, web
// pages are still refused).
function readAllowedExtensionOrigins() {
  const home = os.homedir();
  const candidates = [
    path.join(home, ".orellius-browser-bridge", "com.orellius.browser_bridge.json"),
    path.join(home, ".config", "google-chrome", "NativeMessagingHosts", "com.orellius.browser_bridge.json"),
    path.join(home, ".config", "chromium", "NativeMessagingHosts", "com.orellius.browser_bridge.json"),
    path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.orellius.browser_bridge.json"),
  ];
  const out = new Set();
  for (const p of candidates) {
    try {
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const o of m.allowed_origins || []) out.add(String(o).replace(/\/$/, ""));
    } catch {}
  }
  return out;
}
const ALLOWED_EXTENSION_ORIGINS = readAllowedExtensionOrigins();

function originAllowed(origin) {
  if (!origin) return true; // CLI / scripts
  const isExt = /^(chrome|moz)-extension:\/\//.test(origin);
  if (!isExt) return false;
  if (ALLOWED_EXTENSION_ORIGINS.size === 0) return true;
  return ALLOWED_EXTENSION_ORIGINS.has(origin.replace(/\/$/, ""));
}

const adminServer = http.createServer((req, res) => {
  // A page loaded in ANY browser on this box could drive this port: the handler
  // set Access-Control-Allow-Origin:* and never checked who was calling, so a
  // site the agents or Ziv happened to visit could force-private every session,
  // reload the extension, or close windows. Web origins are refused outright
  // (VPS hardening 2026-08-25, committed upstream 2026-08-28). originAllowed()
  // additionally lets the extension's own origin through - see its comment.
  if (!originAllowed(req.headers.origin)) {
    log(`Admin: refused ${req.method} ${req.url} from origin ${req.headers.origin}`);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("cross-origin requests are not accepted on the admin port");
    return;
  }
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
      // Calls waiting for a native host to (re)appear, and what the hub did
      // about it - so "why is it slow / why did it fail" is answerable here.
      parkedRequests: parkedRequests.length,
      recovery: lastRecovery,
      recoveryInFlight: recoveryInFlight !== null,
      mcpClientCount: mcpClients.size,
      mcpSessions: [...mcpClients.keys()],
      // Registered != active. `activeSessions` are the ones that actually made
      // a browser call inside the TTL and therefore still hold a window.
      activeSessions: activeSessionIds(),
      idleTtlMinutes: SESSION_IDLE_TTL_MS / 60000,
      sessionIdleSeconds: Object.fromEntries(
        [...mcpClients.keys()].map((sid) => [
          sid,
          sessionActivity.has(sid)
            ? Math.round((Date.now() - sessionActivity.get(sid)) / 1000)
            : null,
        ])
      ),
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
    // Unlock requires the override PIN (?pin=XXXXXX). The extension validates
    // it and silently refuses a bad/missing pin - this keeps sibling Claude
    // sessions from removing the human's lock (which they did, 2026-07-11).
    // The human reads the PIN by clicking the Orellius extension icon.
    const pin = url.searchParams.get("pin") || "";
    const delivered = broadcastAdminMessage({
      type: "admin_set_mode",
      lock: false,
      pin,
      reason: "unlock CLI",
    });
    log(`/admin/unlock broadcast delivered to ${delivered} native_host(s) (pin ${pin ? "supplied" : "MISSING"})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      pinSupplied: !!pin,
      message: delivered > 0
        ? `Unlock request sent to ${delivered} native_host(s). The extension only honors it when the correct override PIN was supplied (?pin=XXXXXX - the human reads it from the Orellius extension popup). A bad or missing pin is silently refused.`
        : "No browser extensions are currently connected to the hub. Unlock will take effect when the extension reconnects (if the pin is correct).",
    }));
    return;
  }

  // POST /admin/set-pin?old=<current>&new=<new>
  //
  // passwd-style PIN rotation: the extension validates the CURRENT pin before
  // accepting the new one, so this endpoint adds no agent-exploitable surface
  // (an agent that knows the current pin could already unlock).
  if (req.method === "POST" && url.pathname === "/admin/set-pin") {
    const oldPin = url.searchParams.get("old") || "";
    const newPin = url.searchParams.get("new") || "";
    const delivered = broadcastAdminMessage({
      type: "admin_set_pin",
      oldPin,
      newPin,
      reason: "set-pin CLI",
    });
    log(`/admin/set-pin broadcast delivered to ${delivered} native_host(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      message: delivered > 0
        ? "Set-pin request sent. The extension only honors it when the correct CURRENT pin was supplied (?old=...). Confirm the new PIN in the extension popup."
        : "No browser extensions connected; set-pin will apply when one reconnects (and only with the correct current pin).",
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
    // "Active" means "made a browser tool call within SESSION_IDLE_TTL_MS",
    // NOT "has a live MCP process". The old definition made this endpoint a
    // permanent no-op: with ~15 VS Code windows open, every session counted as
    // active and nothing was ever closed (measured 2026-08-02: 14 preserved,
    // 0 closed). Callers can still force the old behavior with ?all=1.
    const closeAll = url.searchParams.get("all") === "1";
    const active = closeAll ? [] : activeSessionIds();
    const idleCount = mcpClients.size - active.length;
    const delivered = broadcastAdminMessage({
      type: "admin_close_tabs",
      mode: "unused",
      activeSessionIds: active,
      reason: closeAll ? "close-unused CLI (all=1)" : "close-unused CLI",
    });
    log(`/admin/close-unused delivered to ${delivered} native_host(s): preserving ${active.length} active, reaping ${idleCount} idle of ${mcpClients.size} registered`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      registeredSessions: mcpClients.size,
      activeSessionCount: active.length,
      idleSessionCount: idleCount,
      idleTtlMinutes: SESSION_IDLE_TTL_MS / 60000,
      message: delivered > 0
        ? `Sent close-unused to ${delivered} browser native_host(s). ${active.length} session(s) active in the last ${SESSION_IDLE_TTL_MS / 60000}min keep their windows; ${idleCount} idle session(s) are being closed.`
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
  // POST /admin/reload-extension
  //
  // Make Chrome re-read the unpacked extension from disk. Chrome does NOT do
  // this on browser restart, so without it every extension change required a
  // human to click Reload on chrome://extensions - and the version shown there
  // stays stale until they do, which looks identical to a change that was
  // never shipped.
  //
  // The extension calls chrome.runtime.reload(), which keeps the same
  // extension id (unlike --load-extension, which would mint a new one and
  // break native messaging). The service worker dies instantly, so there is no
  // ack to wait for; the native host reconnects on its own within a few
  // seconds. Verify with GET /admin/status -> nativeHosts.
  if (req.method === "POST" && url.pathname === "/admin/reload-extension") {
    const delivered = broadcastAdminMessage({
      type: "admin_reload_extension",
      reason: "reload-extension CLI",
    });
    log(`/admin/reload-extension broadcast delivered to ${delivered} native_host(s)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      delivered,
      message: delivered > 0
        ? `Sent reload to ${delivered} browser extension(s). The extension re-reads from disk and its native host reconnects in a few seconds - confirm with GET /admin/status (nativeHosts) and check the version in chrome://extensions.`
        : "No browser extensions are connected to the hub. No-op.",
    }));
    return;
  }

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
    // Keep this COMPLETE. It used to omit reload-extension and set-pin, and on
    // 2026-08-27 a session probed the admin surface, read this list, concluded
    // "this build has no reload-extension" and handed the outage to the human.
    available: [
      "GET /admin/status",
      "POST /admin/force-private",
      "POST /admin/unlock?pin=<pin>",
      "POST /admin/set-pin?old=<current>&new=<new>",
      "POST /admin/close-unused",
      "POST /admin/reload-extension",
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
    // Exit NON-ZERO: "the port I was told to bind is taken" is a failure, not a
    // no-op. It exited 0 before, which made a hub that never started look like a
    // hub that started fine - the silent half of the 18775-vs-18765 bug, where
    // an auto-spawned local hub aimed at the SSH tunnel's port and died unnoticed.
    // The message is also misleading when the port is not another hub at all,
    // so say what actually happened.
    log(`Port ${TCP_PORT} already in use - something else owns it (another hub, or an SSH tunnel). Exiting.`);
    process.exit(1);
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
  log(`Admin HTTP listening on 127.0.0.1:${ADMIN_HTTP_PORT} (POST /admin/{force-private,unlock,set-pin,close-unused,reload-extension,shutdown}, GET /admin/status)`);
});
