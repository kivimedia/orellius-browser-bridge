#!/usr/bin/env node

// Drive the BI Pixie portal walkthrough in isolated mode and record a sharp
// 1920x1080 video. Run from CLI:
//   node drive-bipixie-walkthrough.js
//
// On first run, opens the BI Pixie login page in a visible isolated Chrome and
// waits for the URL to leave /login. The isolated user-data-dir persists, so
// subsequent runs skip login.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const SAVE_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output";
const SAVE_PATH = path.join(SAVE_DIR, "bipixie-walkthrough-v3-iso.mp4");
// Keep one fixed user-data-dir for BI Pixie so login persists across runs.
const PERSISTENT_PROFILE = path.join(os.tmpdir(), "orellius-iso-profile-bipixie");

function step(name) {
  return Object.assign((fn) => fn().then((r) => {
    console.log(`PASS  ${name}${r ? "  " + r : ""}`);
    return r;
  }, (e) => {
    console.log(`FAIL  ${name}  ${e.message}`);
    throw e;
  }), {});
}

async function waitForCondition(label, fn, { timeoutMs = 180000, pollMs = 1500 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await fn();
      if (ok) return ok;
    } catch {}
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

// Drive the MSAL login flow: click "Sign in with Microsoft" → fill email → Next →
// fill password → Sign in → click "No" on Stay-signed-in prompt → wait until
// we're back on app.bipixie.com (away from login.microsoftonline.com).
async function autoLoginMsal(page, email, password) {
  // Step 1: click the "Sign in with Microsoft" button on app.bipixie.com/login
  // (it's the only button visible on the landing page when signed-out).
  await waitForCondition("MS sign-in button", async () => {
    const ok = await page.runtimeEvaluate(`
      (() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const t = btns.find(b => /sign in with microsoft/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()));
        if (!t) return false;
        t.click();
        return true;
      })()
    `);
    return ok;
  }, { timeoutMs: 15000, pollMs: 500 });
  console.log("  clicked MS sign-in");

  // Step 2: wait for login.microsoftonline.com (redirect can take a couple of seconds)
  await waitForCondition("MS login page", async () => {
    const u = await page.runtimeEvaluate("location.href");
    return /login\.microsoftonline\.com/i.test(u);
  }, { timeoutMs: 15000, pollMs: 500 });
  await new Promise((r) => setTimeout(r, 1500));

  // Step 3: email field, Next
  await waitForCondition("email field", async () => {
    return page.runtimeEvaluate(`!!document.querySelector('input[type=email], input[name=loginfmt]')`);
  }, { timeoutMs: 15000, pollMs: 500 });
  await page.runtimeEvaluate(`
    (() => {
      const el = document.querySelector('input[type=email]') || document.querySelector('input[name=loginfmt]');
      el.focus();
      el.value = '';
      // Place selection
      const sel = window.getSelection(); sel.removeAllRanges();
      return true;
    })()
  `);
  await page.typeText(email);
  console.log("  typed email");
  await new Promise((r) => setTimeout(r, 300));
  await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
  console.log("  clicked Next");

  // Step 4: password field, Sign in
  await waitForCondition("password field", async () => {
    return page.runtimeEvaluate(`(() => {
      const el = document.querySelector('input[type=password], input[name=passwd]');
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`);
  }, { timeoutMs: 20000, pollMs: 500 });
  await new Promise((r) => setTimeout(r, 600));
  await page.runtimeEvaluate(`
    (() => {
      const el = document.querySelector('input[type=password]') || document.querySelector('input[name=passwd]');
      el.focus();
      el.value = '';
      return true;
    })()
  `);
  await page.typeText(password);
  console.log("  typed password");
  await new Promise((r) => setTimeout(r, 300));
  await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
  console.log("  clicked Sign in");

  // Step 5: handle "Stay signed in?" KMSI prompt — click No (idBtn_Back) to keep
  // it brief, OR Yes (idSIButton9) for persistence. We click Yes here so the
  // user-data-dir actually carries the session if Ziv re-uses this profile.
  await new Promise((r) => setTimeout(r, 2500));
  await page.runtimeEvaluate(`
    (() => {
      const yes = document.querySelector('#idSIButton9');
      const no  = document.querySelector('#idBtn_Back');
      // On the KMSI prompt the "Yes" button is idSIButton9 (input type=submit)
      if (yes) { yes.click(); return 'kmsi_yes'; }
      if (no)  { no.click();  return 'kmsi_no';  }
      return 'no_kmsi';
    })()
  `);
  console.log("  handled KMSI prompt (best-effort)");

  // Step 6: wait until URL is back on app.bipixie.com
  await waitForCondition("back on app.bipixie.com", async () => {
    const u = await page.runtimeEvaluate("location.href");
    return /app\.bipixie\.com/i.test(u) && !/\/login/i.test(u);
  }, { timeoutMs: 30000, pollMs: 1000 });
  console.log("  back on app.bipixie.com");
}

async function clickByText(page, text) {
  // Permissive matcher: try exact match across many tag types first; if nothing
  // matches, fall back to "smallest visible element whose text contains the
  // target". The smallest match avoids picking the whole document body.
  return page.runtimeEvaluate(`
    (() => {
      const t = ${JSON.stringify(text)}.trim().toLowerCase();
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="link"], [role="tab"], li, span, div'));
      const visible = all.filter(el => {
        if (!el.offsetParent && el.tagName !== 'BODY') return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      let exact = visible.find(el => norm(el.textContent) === t);
      if (exact) {
        exact.scrollIntoView({block:'center'});
        exact.click();
        return { hit: 'exact', tag: exact.tagName };
      }
      // Fallback: smallest containing element
      const containing = visible
        .filter(el => norm(el.textContent).includes(t))
        .sort((a, b) => (a.textContent.length - b.textContent.length));
      if (containing.length > 0) {
        const target = containing[0];
        target.scrollIntoView({block:'center'});
        target.click();
        return { hit: 'contains', tag: target.tagName, len: target.textContent.length };
      }
      return false;
    })()
  `);
}

async function main() {
  fs.mkdirSync(SAVE_DIR, { recursive: true });
  fs.mkdirSync(PERSISTENT_PROFILE, { recursive: true });

  console.log("== launching isolated Chrome 1920x1080 ==");
  // sessionId acts as a stable namespace for the user-data-dir (the launcher
  // resolves it to <baseDir>/session-<sessionId>), so login state persists
  // across re-runs of this driver.
  const chrome = await launchIsolatedChrome({
    width: 1920,
    height: 1080,
    sessionId: "bipixie-walkthrough",
  });

  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();

  // Use the first existing target (the about:blank Chrome opened) instead of
  // creating a new one, so the visible window is the one we drive.
  const targets = await browser.listPageTargets();
  let page;
  if (targets.length > 0) {
    page = await browser.attachToTarget(targets[0].targetId);
  } else {
    page = await browser.createPageSession("about:blank");
  }

  console.log("== navigating to BI Pixie ==");
  await page.navigate("https://app.bipixie.com/");

  await new Promise((r) => setTimeout(r, 2500));
  let curUrl = await page.runtimeEvaluate("location.href");
  console.log(`current url: ${curUrl}`);

  // Decide whether we need to log in by looking for the sign-in button (signed-out
  // landing page) vs the sidebar (signed-in portal). The /login URL sometimes
  // redirects to / and sometimes stays — landing-page detection is more robust.
  const isSignedIn = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
      const els = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], li, span, div'));
      const sidebar = els.some(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return norm(el.textContent) === 'overview' || norm(el.textContent) === 'managed reports';
      });
      return sidebar;
    })()
  `);
  console.log(`signed in? ${isSignedIn}`);

  if (!isSignedIn) {
    console.log("== auto-logging in ==");
    try { await page.send("Page.bringToFront"); } catch {}
    await autoLoginMsal(page, "test@datachant.com", "DataChant!");
    console.log("== auto-login complete ==");
  }

  // Whatever page we landed on, navigate explicitly to /managed for a clean start.
  await page.navigate("https://app.bipixie.com/managed");
  await new Promise((r) => setTimeout(r, 3000));

  // Bring the tab to front (compositor stops painting hidden tabs → 0 frames).
  try { await page.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 500));

  // CRITICAL: wait for the React portal sidebar to actually render before we
  // start clicking or recording. If we click too early, all clicks miss because
  // React hasn't mounted the nav yet OR MSAL is still completing its post-login
  // handshake. Poll for visible "Overview" text up to 30s.
  console.log("waiting for portal sidebar to render ...");
  const ready = await waitForCondition("portal sidebar", async () => {
    const found = await page.runtimeEvaluate(`
      (() => {
        const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const els = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], li, span, div'));
        return els.some(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          return norm(el.textContent) === "overview" || norm(el.textContent) === "managed reports";
        });
      })()
    `);
    return found;
  }, { timeoutMs: 30000, pollMs: 1000 }).catch(() => false);

  if (!ready) {
    const url = await page.runtimeEvaluate("location.href");
    const visState = await page.runtimeEvaluate("document.visibilityState");
    console.log(`PORTAL NOT READY — url=${url}, vis=${visState}`);
    throw new Error("Portal sidebar did not render in 30s. Auth may have failed silently.");
  }
  console.log("portal sidebar ready.");

  const vis = await page.runtimeEvaluate("document.visibilityState");
  console.log(`document.visibilityState = ${vis}`);

  console.log("== starting screencast ==");
  const tmpFrames = path.join(os.tmpdir(), `bipixie-rec-${Date.now().toString(36)}`);
  fs.mkdirSync(tmpFrames, { recursive: true });
  const timing = [];
  let frameIdx = 0;
  const off = page.on("Page.screencastFrame", async (params) => {
    const idx = frameIdx++;
    const fp = path.join(tmpFrames, `f${String(idx).padStart(6, "0")}.jpg`);
    try {
      fs.writeFileSync(fp, Buffer.from(params.data, "base64"));
      timing.push(params.metadata?.timestamp || Date.now() / 1000);
    } catch {}
    try { await page.ackScreencastFrame(params.sessionId); } catch {}
  });
  await page.startScreencast({ format: "jpeg", quality: 85, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 2 });

  // Drive the walkthrough. Pauses are deliberate — we want each scene visible
  // long enough that the recording reads as a tour, not a blur.
  console.log("== driving walkthrough ==");
  const flow = [
    { label: "Managed Reports (start)", action: null, dwell: 3000 },
    { label: "Overview", action: () => clickByText(page, "Overview"), dwell: 3500 },
    { label: "Tracking Setup", action: () => clickByText(page, "Tracking Setup"), dwell: 3500 },
    { label: "Data Management", action: () => clickByText(page, "Data Management"), dwell: 3500 },
    { label: "Team", action: () => clickByText(page, "Team"), dwell: 3000 },
    { label: "Plan", action: () => clickByText(page, "Plan"), dwell: 3500 },
    { label: "Account", action: () => clickByText(page, "Account"), dwell: 3500 },
    { label: "Managed Reports (return)", action: () => clickByText(page, "Managed Reports"), dwell: 3000 },
    { label: "Add Pixies", action: () => clickByText(page, "Add Pixies"), dwell: 4000 },
    { label: "Back to Managed Reports", action: () => clickByText(page, "Managed Reports"), dwell: 2500 },
    { label: "Update Pixies", action: () => clickByText(page, "Update Pixies"), dwell: 2500 },
    { label: "Check for events", action: () => clickByText(page, "Check for events"), dwell: 4000 },
  ];

  for (const f of flow) {
    if (f.action) {
      const ok = await f.action();
      console.log(`  ${ok ? "click" : "MISS"}: ${f.label}`);
    } else {
      console.log(`  hold: ${f.label}`);
    }
    await new Promise((r) => setTimeout(r, f.dwell));
  }

  console.log("== stopping screencast ==");
  try { await page.stopScreencast(); } catch {}
  off();
  console.log(`captured ${frameIdx} frames`);

  if (frameIdx === 0) throw new Error("0 frames captured");

  // Build concat with per-frame durations; cap to avoid extreme stretches.
  const files = fs.readdirSync(tmpFrames).filter((x) => x.endsWith(".jpg")).sort();
  const lines = ["ffconcat version 1.0"];
  for (let i = 0; i < files.length; i++) {
    lines.push(`file '${path.join(tmpFrames, files[i]).replace(/\\/g, "/")}'`);
    const next = i + 1 < timing.length ? timing[i + 1] : timing[i] + 1 / 15;
    const dur = Math.max(0.03, Math.min(2.0, next - timing[i]));
    lines.push(`duration ${dur.toFixed(3)}`);
  }
  lines.push(`file '${path.join(tmpFrames, files[files.length - 1]).replace(/\\/g, "/")}'`);
  const concatPath = path.join(tmpFrames, "concat.txt");
  fs.writeFileSync(concatPath, lines.join("\n"));

  console.log("== ffmpeg encode ==");
  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
      "-vf", "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20",
      SAVE_PATH,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (c) => (err += c.toString()));
    ff.on("error", reject);
    ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}\n${err.slice(-1500)}`))));
  });

  // Cleanup temp frames (leave the persistent profile alone — login state lives there).
  try {
    for (const f of files) fs.unlinkSync(path.join(tmpFrames, f));
    fs.unlinkSync(concatPath);
    fs.rmdirSync(tmpFrames);
  } catch {}

  const stat = fs.statSync(SAVE_PATH);
  console.log(`\n== DONE ==`);
  console.log(`MP4: ${SAVE_PATH}`);
  console.log(`size: ${(stat.size / 1024).toFixed(1)} KiB`);
  console.log(`frames captured: ${frameIdx}`);

  await browser.close();
  chrome.cleanup();
}

main().catch((e) => {
  console.error("FAILED:", e.stack || e.message);
  process.exit(1);
});
