#!/usr/bin/env node
// Holds the portal Chrome alive for its whole life: launches it headless over
// a DevTools PIPE (never a TCP port - no raw CDP ever listens anywhere),
// loads extension-portal/ via Extensions.loadUnpacked, and kills the whole
// process tree the moment this supervisor exits or the pipe breaks.
//
// WHY A SUPERVISOR HAS TO HOLD THE PIPE: `--load-extension` is dead on
// branded Chrome 154 (extension-headless investigation, 29-Sep-2026,
// verified: "extension_service.cc:423 --load-extension is not allowed in
// Google Chrome, ignoring", even with
// --disable-features=DisableLoadExtensionCommandLineSwitch). The only way to
// load an unpacked extension into a real, non-Store Chrome is
// --remote-debugging-pipe + --enable-unsafe-extension-debugging, then the
// DevTools call Extensions.loadUnpacked over that pipe - and the extension
// unloads a few seconds after the pipe closes (verified: a test extension
// pinged 4 times, then 0 times in the 15s after close). The Chrome PROCESS
// itself does NOT exit on its own when the pipe closes (verified: still
// alive 10.5s later) - something has to notice and kill it, or a
// half-extensionless portal Chrome sits there indefinitely.
//
// Message framing over the pipe is NUL-delimited JSON, not newline-delimited
// (verified against real Chrome 154 during the investigation) - this is not
// the same framing as the hub.js<->mcp-server.js protocol elsewhere in this
// project; do not "fix" it to match.
//
// This process opens no network port of its own. desktop/main.js supervises
// IT the same way spawnLocalHub supervises the hub - watch the child handle,
// relaunch on exit - never by polling an HTTP admin surface that would just
// be one more thing to secure.

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";

function log(msg) {
  process.stderr.write(`[portal-supervisor ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "..", "extension-portal");
const CHROME_EXE = process.env.PORTAL_CHROME_EXE ||
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PROFILE_DIR = process.env.PORTAL_PROFILE_DIR ||
  path.join(os.homedir(), ".portal-browser-bridge", "chrome-profile");
const EGRESS_PROXY_PORT = Number(process.env.PORTAL_EGRESS_PROXY_PORT || 18789);
const EGRESS_PROXY_SCRIPT = path.join(HERE, "portal-egress-proxy.mjs");

// A real, current desktop UA string - keeps this browser indistinguishable
// from Ziv's own in the one signal a login/Turnstile flow actually looks at
// (User-Agent), separate from headless detection (handled by --headless=new
// plus --disable-blink-features below, which the investigation measured as
// navigator.webdriver=false).
const USER_AGENT = process.env.PORTAL_CHROME_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

if (!fs.existsSync(CHROME_EXE)) {
  log(`FATAL: Chrome not found at ${CHROME_EXE} (set PORTAL_CHROME_EXE)`);
  process.exit(1);
}
if (!fs.existsSync(path.join(EXTENSION_DIR, "manifest.json"))) {
  log(`FATAL: extension not found at ${EXTENSION_DIR}`);
  process.exit(1);
}
fs.mkdirSync(PROFILE_DIR, { recursive: true });

// --- NUL-delimited CDP-over-pipe client --------------------------------------

function makeCdpClient(chromeProc) {
  const toChrome = chromeProc.stdio[3];
  const fromChrome = chromeProc.stdio[4];
  let buf = "";
  let nextId = 1;
  const pending = new Map();
  fromChrome.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\0")) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try { m = JSON.parse(raw); } catch { continue; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  function send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    try {
      toChrome.write(JSON.stringify(msg) + "\0");
    } catch (err) {
      return Promise.resolve({ error: { message: `pipe write failed: ${err.message}` } });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); resolve({ error: { message: `${method} timed out after ${timeoutMs}ms` } }); }
      }, timeoutMs);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
  }
  return { send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); } catch {}
}

// --- Egress proxy (the network-level wall) -----------------------------------

function spawnEgressProxy() {
  const child = spawn(process.execPath, [EGRESS_PROXY_SCRIPT], {
    env: { ...process.env, PORTAL_EGRESS_PROXY_PORT: String(EGRESS_PROXY_PORT) },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stderr.on("data", (d) => log(`[egress-proxy] ${String(d).trim()}`));
  child.on("exit", (code) => {
    log(`egress proxy exited (code ${code}) - killing portal Chrome, nothing may reach the network unfiltered`);
    shutdown("egress proxy died", 1);
  });
  return child;
}

async function waitForEgressProxy(deadlineMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const sock = await new Promise((resolve, reject) => {
        const s = new net.Socket();
        s.once("connect", () => { s.destroy(); resolve(true); });
        s.once("error", reject);
        s.connect(EGRESS_PROXY_PORT, "127.0.0.1");
      });
      if (sock) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

// --- Main lifecycle -----------------------------------------------------------

let chromeProc = null;
let egressProxyProc = null;
let shuttingDown = false;

function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  killTree(chromeProc && chromeProc.pid);
  if (egressProxyProc) { try { egressProxyProc.kill(); } catch {} }
  process.exit(exitCode ?? 0);
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));

async function main() {
  egressProxyProc = spawnEgressProxy();
  const proxyUp = await waitForEgressProxy();
  if (!proxyUp) {
    log("FATAL: egress proxy never came up - refusing to launch a Chrome with no network filter");
    shutdown("egress proxy failed to start", 1);
    return;
  }
  log(`egress proxy confirmed listening on 127.0.0.1:${EGRESS_PROXY_PORT}`);

  const args = [
    "--headless=new",
    `--user-data-dir=${PROFILE_DIR}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-component-update",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,800",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    `--user-agent=${USER_AGENT}`,
    // The ONLY route out of this Chrome. <-loopback> removes Chrome's default
    // proxy bypass for loopback/localhost destinations - without it, a
    // request that resolves to 127.0.0.1 goes DIRECT and never reaches the
    // egress proxy's loopback/private-range check at all, which would defeat
    // the whole point of that proxy. Verify this flag's effect during the
    // live spike (documented Chromium behavior, not yet proven on this exact
    // build in this project).
    `--proxy-server=127.0.0.1:${EGRESS_PROXY_PORT}`,
    `--proxy-bypass-list=<-loopback>`,
    "about:blank",
  ];

  log(`launching portal Chrome: ${CHROME_EXE}`);
  chromeProc = spawn(CHROME_EXE, args, {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  chromeProc.on("exit", (code) => {
    log(`portal Chrome exited on its own (code ${code}) - this supervisor exits too, so a parent supervisor relaunches the whole thing fresh`);
    shutdown("chrome exited", code || 0);
  });
  chromeProc.on("error", (err) => {
    log(`FATAL: could not launch Chrome: ${err.message}`);
    shutdown("chrome launch error", 1);
  });

  const cdp = makeCdpClient(chromeProc);

  // Poll Browser.getVersion instead of a fixed sleep - the investigation used
  // a blind 2500ms wait; a readiness poll is more robust across machine load.
  let version = null;
  for (let i = 0; i < 60 && !version; i++) {
    await sleep(250);
    const v = await cdp.send("Browser.getVersion", {}, undefined, 2000);
    if (v && v.result) version = v.result;
  }
  if (!version) {
    log("FATAL: Chrome never answered Browser.getVersion over the pipe");
    shutdown("pipe never came up", 1);
    return;
  }
  log(`Chrome answered: ${version.product}`);

  const loaded = await cdp.send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
  if (!loaded || !loaded.result || !loaded.result.id) {
    log(`FATAL: Extensions.loadUnpacked failed: ${JSON.stringify(loaded && loaded.error)}`);
    shutdown("extension load failed", 1);
    return;
  }
  log(`extension loaded, id=${loaded.result.id}`);

  // Hold the pipe open for the browser's whole life. If Chrome closes it
  // (crash, killed externally) fromChrome emits 'end'/'close'; either way we
  // tear down rather than leave an extensionless portal Chrome running.
  chromeProc.stdio[4].on("close", () => shutdown("pipe closed from Chrome's side", 0));
  chromeProc.stdio[4].on("error", (err) => shutdown(`pipe error: ${err.message}`, 1));

  log("portal browser is up and holding. SIGTERM/SIGINT to shut down cleanly.");
}

main().catch((err) => {
  log(`FATAL: unhandled error in main(): ${err.stack || err.message}`);
  shutdown("unhandled error", 1);
});
