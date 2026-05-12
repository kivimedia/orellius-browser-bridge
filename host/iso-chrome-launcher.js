// Chrome process launcher for Orellius "isolated" mode.
//
// Each MCP server instance launches its own Chrome with a unique --user-data-dir
// and --remote-debugging-port. Multiple VS Code Claude sessions therefore each
// drive their own Chrome process and cannot interfere — no shared extension SW,
// no shared native host, no shared session-window claim.
//
// On Windows we prefer the system Chrome install. On other platforms we honor
// CHROME_PATH or fall back to common paths.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";

function log(msg) {
  process.stderr.write(`[iso-chrome ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function findChromeExe() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } else if (process.platform === "darwin") {
    const candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
  } else {
    for (const c of ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
      if (fs.existsSync(c)) return c;
    }
  }
  throw new Error("Chrome/Chromium not found. Set CHROME_PATH env var to chrome.exe.");
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
  });
}

async function waitForChromeReady(port, deadlineMs = 20000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < deadlineMs) {
    try {
      const v = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1000);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome did not open debugging port ${port} within ${deadlineMs}ms: ${lastErr?.message}`);
}

export async function launchIsolatedChrome(opts = {}) {
  const chromeExe = findChromeExe();
  const port = opts.port || (await pickFreePort());

  // Per-session user data dir keeps cookies, history, prefs separate per VS Code.
  // We DO NOT remove it on exit by default — users may want to keep logged-in state
  // across runs in the same VS Code workspace. Set ORELLIUS_ISO_EPHEMERAL=1 to wipe.
  const sessionId = opts.sessionId || `${process.pid}-${Date.now().toString(36)}`;
  const baseDir = opts.baseDir || path.join(os.tmpdir(), "orellius-iso");
  const userDataDir = path.join(baseDir, `session-${sessionId}`);
  fs.mkdirSync(userDataDir, { recursive: true });

  const width = opts.width || 1280;
  const height = opts.height || 720;

  const args = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=Translate,InfoBars,OptimizationHints,MediaRouter",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--no-default-browser-check",
    `--window-size=${width},${height}`,
    "--new-window",
    "about:blank",
  ];

  // On Windows, allow the user to push the Chrome window to a different virtual
  // desktop manually. We don't try to do it automatically — virtual desktops are
  // per-user and Chrome starts on whichever desktop the launching process sits.

  log(`launching Chrome: ${chromeExe} (port=${port}, userDataDir=${userDataDir})`);
  const child = spawn(chromeExe, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    windowsHide: false,
  });

  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  child.on("exit", (code, sig) => {
    log(`chrome exited code=${code} signal=${sig}`);
  });

  let exited = false;
  child.on("exit", () => (exited = true));

  // Wait for the debugging port to come up.
  let version;
  try {
    version = await waitForChromeReady(port);
  } catch (e) {
    if (!exited) {
      try {
        child.kill();
      } catch {}
    }
    throw e;
  }

  log(`chrome ready: ${version.Browser} on port ${port}`);

  return {
    pid: child.pid,
    port,
    userDataDir,
    sessionId,
    chromeExe,
    browserWebSocketUrl: version.webSocketDebuggerUrl,
    chromeVersion: version.Browser,
    process: child,
    kill() {
      if (exited) return;
      try {
        if (process.platform === "win32") {
          // /T to kill child processes (renderers etc), /F to force.
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill("SIGTERM");
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
          }, 2000);
        }
      } catch (e) {
        log(`kill error: ${e.message}`);
      }
    },
    cleanup() {
      this.kill();
      if (process.env.ORELLIUS_ISO_EPHEMERAL === "1") {
        // Best-effort wipe; Chrome may still be holding files for a moment.
        setTimeout(() => {
          try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
          } catch {}
        }, 2000);
      }
    },
  };
}
