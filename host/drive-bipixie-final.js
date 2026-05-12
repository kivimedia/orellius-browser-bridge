#!/usr/bin/env node

// Per-scene capture driver for BI Pixie Getting Started walkthrough.
//
// Usage:
//   node drive-bipixie-final.js --scene NN [--retake]
//   node drive-bipixie-final.js --scene 02-13       # range
//   node drive-bipixie-final.js --scene all
//
// Emits: C:/Users/raviv/datachant/bipixie-walkthrough/output/scenes/scene-NN.mp4
// Reuses the persistent iso profile session-bipixie-walkthrough so login
// survives across scene captures. PII blur (avatar + email) injected as CSS
// before every screencast starts.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const PROJECT_ROOT = "C:/Users/raviv/datachant/bipixie-walkthrough";
const SCENES_DIR = path.join(PROJECT_ROOT, "output/scenes");
const SESSION_ID = "bipixie-walkthrough";
const MS_EMAIL = "test@datachant.com";
const MS_PASSWORD = "DataChant!";
const PORTAL_BASE = "https://app.bipixie.com";

const PII_BLUR_CSS = `
  /* Avatar circle in header (top-right) */
  header [class*="avatar" i],
  header img[alt*="user" i],
  header [aria-label*="account" i],
  [data-testid*="avatar" i],
  [class*="MuiAvatar" i] { filter: blur(14px) !important; }
  /* Email anywhere */
  [data-testid*="email" i],
  [class*="user-email" i],
  [aria-label*="@datachant.com" i] { filter: blur(10px) !important; }
`;

const PII_BLUR_JS = `
  (() => {
    if (window.__bipixiePiiBlurInstalled) return 'already';
    window.__bipixiePiiBlurInstalled = true;
    const style = document.createElement('style');
    style.id = 'bipixie-pii-blur';
    style.textContent = ${JSON.stringify(PII_BLUR_CSS)};
    document.documentElement.appendChild(style);
    const wrapEmails = () => {
      const re = /test@datachant\\.com/i;
      const walk = (root) => {
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        const hits = [];
        let n; while ((n = w.nextNode())) if (re.test(n.nodeValue)) hits.push(n);
        for (const n of hits) {
          const span = document.createElement('span');
          span.style.filter = 'blur(8px)';
          span.textContent = n.nodeValue;
          n.parentNode && n.parentNode.replaceChild(span, n);
        }
      };
      walk(document.body);
    };
    wrapEmails();
    new MutationObserver(() => wrapEmails()).observe(document.body, {childList: true, subtree: true});
    return 'installed';
  })()
`;

function step(name, fn) {
  return fn().then((r) => { console.log(`PASS  ${name}${r ? "  " + JSON.stringify(r).slice(0, 80) : ""}`); return r; },
                    (e) => { console.log(`FAIL  ${name}  ${e.message}`); throw e; });
}

async function waitForCondition(label, fn, { timeoutMs = 30000, pollMs = 500 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try { const ok = await fn(); if (ok) return ok; }
    catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms${lastErr ? `: ${lastErr.message}` : ""}`);
}

async function clickByText(page, text, opts = {}) {
  const { partial = true } = opts;
  return page.runtimeEvaluate(`
    (() => {
      const t = ${JSON.stringify(text)}.trim().toLowerCase();
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="link"], [role="tab"], [role="checkbox"], [role="option"], li, span, div'));
      const visible = all.filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') return false;
        return true;
      });
      const exact = visible.find(el => norm(el.textContent) === t);
      if (exact) {
        exact.scrollIntoView({block:'center'});
        exact.click();
        return { hit: 'exact', tag: exact.tagName };
      }
      if (!${partial}) return false;
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

async function autoLoginMsal(page) {
  console.log("  -> autoLoginMsal");
  await waitForCondition("MS sign-in button", async () => page.runtimeEvaluate(`
    (() => {
      const btns = Array.from(document.querySelectorAll('button, a'));
      const t = btns.find(b => /sign in with microsoft/i.test((b.textContent||'').replace(/\\s+/g,' ').trim()));
      if (!t) return false; t.click(); return true;
    })()
  `), { timeoutMs: 15000 });
  await waitForCondition("MS login page", async () => /login\.microsoftonline\.com/i.test(await page.runtimeEvaluate("location.href")));
  await new Promise((r) => setTimeout(r, 1500));
  await waitForCondition("email field", async () =>
    page.runtimeEvaluate(`!!document.querySelector('input[type=email], input[name=loginfmt]')`));
  await page.runtimeEvaluate(`document.querySelector('input[type=email], input[name=loginfmt]').focus()`);
  await page.typeText(MS_EMAIL);
  await new Promise((r) => setTimeout(r, 300));
  await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
  await waitForCondition("password field", async () => page.runtimeEvaluate(`(() => {
    const el = document.querySelector('input[type=password], input[name=passwd]');
    if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  })()`), { timeoutMs: 20000 });
  await new Promise((r) => setTimeout(r, 600));
  await page.runtimeEvaluate(`document.querySelector('input[type=password], input[name=passwd]').focus()`);
  await page.typeText(MS_PASSWORD);
  await new Promise((r) => setTimeout(r, 300));
  await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
  await new Promise((r) => setTimeout(r, 2500));
  await page.runtimeEvaluate(`document.querySelector('#idSIButton9, #idBtn_Back')?.click()`);
  await waitForCondition("back on app.bipixie.com", async () => {
    const u = await page.runtimeEvaluate("location.href");
    return /app\.bipixie\.com/i.test(u) && !/\/login/i.test(u);
  }, { timeoutMs: 30000 });
}

async function ensureSignedIn(page) {
  await page.navigate(`${PORTAL_BASE}/`);
  await new Promise((r) => setTimeout(r, 4000));
  // Poll up to 12s for either the sidebar (signed-in) or the sign-in button
  // (signed-out). Avoids false-negative when React mounts slowly.
  let state = "unknown";
  const start = Date.now();
  while (Date.now() - start < 12000) {
    state = await page.runtimeEvaluate(`
      (() => {
        const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
        const els = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], li, span, div'));
        const sidebar = els.some(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          return norm(el.textContent) === 'overview' || norm(el.textContent) === 'managed reports';
        });
        if (sidebar) return 'signed_in';
        const signInBtn = els.some(el => /sign in with microsoft/i.test(el.textContent || ''));
        if (signInBtn) return 'signed_out';
        return 'unknown';
      })()
    `);
    if (state === "signed_in" || state === "signed_out") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`  detect: ${state}`);
  if (state === "signed_out") {
    try { await page.send("Page.bringToFront"); } catch {}
    await autoLoginMsal(page);
  } else if (state === "unknown") {
    // Best-effort: try logging in anyway; autoLoginMsal will fail fast if no button.
    console.log("  detect inconclusive after 12s; attempting login");
    try { await page.send("Page.bringToFront"); } catch {}
    await autoLoginMsal(page).catch((e) => console.log(`  login skipped: ${e.message}`));
  }
}

async function injectPiiBlur(page) {
  const r = await page.runtimeEvaluate(PII_BLUR_JS);
  console.log(`  pii-blur: ${r}`);
}

// CDP Page.screencastFrame only fires when the page repaints. On static
// scenes (just a checkbox tick, just a radio click) Chrome's compositor has
// no reason to repaint, so frames stop. Inject a 1px hidden heartbeat that
// rotates every animation frame to force constant compositor work.
async function injectHeartbeat(page) {
  await page.runtimeEvaluate(`
    (() => {
      if (window.__bipixieHeartbeat) return 'already';
      window.__bipixieHeartbeat = true;
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0.001;pointer-events:none;z-index:-1;';
      document.documentElement.appendChild(el);
      let n = 0;
      const tick = () => {
        n = (n + 1) % 360;
        el.style.transform = 'rotate(' + n + 'deg)';
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return 'installed';
    })()
  `);
}

async function snapshotPage(page, label) {
  try {
    const png = await page.send("Page.captureScreenshot", { format: "png" });
    if (png?.data) {
      const dir = "C:/Users/raviv/datachant/bipixie-walkthrough/output/scene-failures";
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${label}.png`), Buffer.from(png.data, "base64"));
      const headings = await page.runtimeEvaluate(`Array.from(document.querySelectorAll("h1,h2,h3,h4,div,span")).filter(h=>h.getBoundingClientRect().width>0).map(h=>(h.textContent||"").trim().slice(0,120)).filter(t=>t.length>0).slice(0,40)`).catch(() => []);
      console.log(`  SNAP ${label}.png  headings=${JSON.stringify(headings).slice(0,400)}`);
    }
  } catch (e) { console.log(`  snap ${label} failed: ${e.message}`); }
}

async function navAndPrep(page, urlOrFn) {
  if (typeof urlOrFn === "string") await page.navigate(urlOrFn);
  else await urlOrFn();
  await new Promise((r) => setTimeout(r, 2500));
  try { await page.send("Page.bringToFront"); } catch {}
  await waitForCondition("portal sidebar", async () => page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
      const els = Array.from(document.querySelectorAll('a, button, [role="link"], [role="button"], li, span, div'));
      return els.some(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return norm(el.textContent) === 'overview' || norm(el.textContent) === 'managed reports';
      });
    })()
  `), { timeoutMs: 30000, pollMs: 1000 });
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  await new Promise((r) => setTimeout(r, 1500));
}

class Recorder {
  constructor(page, sceneNum) {
    this.page = page;
    this.sceneNum = sceneNum;
    this.tmpDir = path.join(os.tmpdir(), `bipixie-rec-${sceneNum}-${Date.now().toString(36)}`);
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.timing = [];
    this.frameIdx = 0;
    this.off = null;
    this.startWall = 0;
    this.stopWall = 0;
  }
  async start() {
    // Use Page.captureScreenshot polling instead of Page.startScreencast.
    // CDP screencast is paint-driven and Chrome refuses to repaint static
    // pages even with --disable-renderer-backgrounding etc. Polling
    // captureScreenshot gives us a reliable 15fps regardless.
    this.startWall = Date.now() / 1000;
    this.captureInterval = 67; // ~15fps
    this.capturing = true;
    console.log(`  REC scene-${this.sceneNum} started (poll-screenshot @ 15fps)`);
    this._loop = (async () => {
      while (this.capturing) {
        const t0 = Date.now();
        try {
          const png = await this.page.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
          if (png?.data) {
            const idx = this.frameIdx++;
            const fp = path.join(this.tmpDir, `f${String(idx).padStart(6, "0")}.jpg`);
            fs.writeFileSync(fp, Buffer.from(png.data, "base64"));
            this.timing.push(Date.now() / 1000);
          }
        } catch (e) {
          if (!this.capturing) return;
        }
        const elapsed = Date.now() - t0;
        const wait = Math.max(0, this.captureInterval - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
  }
  async stop() {
    this.capturing = false;
    // Race the loop drain against a 5s timeout so a stuck Page.captureScreenshot
    // can't hang the whole driver.
    const drain = this._loop.catch(() => {});
    const timeout = new Promise((r) => setTimeout(r, 5000));
    await Promise.race([drain, timeout]);
    this.stopWall = Date.now() / 1000;
    const wall = this.stopWall - this.startWall;
    console.log(`  REC scene-${this.sceneNum} stopped (${this.frameIdx} frames, ${wall.toFixed(1)}s wall)`);
  }
  async encode() {
    if (this.frameIdx === 0) throw new Error(`scene-${this.sceneNum}: 0 frames captured`);
    const files = fs.readdirSync(this.tmpDir).filter((x) => x.endsWith(".jpg")).sort();
    const lines = ["ffconcat version 1.0"];
    const wallDur = Math.max(this.stopWall - this.startWall, 1);
    for (let i = 0; i < files.length; i++) {
      lines.push(`file '${path.join(this.tmpDir, files[i]).replace(/\\/g, "/")}'`);
      let dur;
      if (i + 1 < this.timing.length) {
        // delta to next captured frame
        dur = this.timing[i + 1] - this.timing[i];
      } else {
        // last frame holds until stopWall (so idle dwell fills the scene)
        dur = this.stopWall - this.timing[i];
      }
      dur = Math.max(0.03, Math.min(15.0, dur));
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    lines.push(`file '${path.join(this.tmpDir, files[files.length - 1]).replace(/\\/g, "/")}'`);
    const concatPath = path.join(this.tmpDir, "concat.txt");
    fs.writeFileSync(concatPath, lines.join("\n"));
    fs.mkdirSync(SCENES_DIR, { recursive: true });
    const outPath = path.join(SCENES_DIR, `scene-${this.sceneNum}.mp4`);
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; ff.stderr.on("data", (c) => (err += c.toString()));
      ff.on("error", reject);
      ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}\n${err.slice(-1500)}`))));
    });
    try {
      for (const f of files) fs.unlinkSync(path.join(this.tmpDir, f));
      fs.unlinkSync(concatPath);
      fs.rmdirSync(this.tmpDir);
    } catch {}
    const stat = fs.statSync(outPath);
    console.log(`  ENC scene-${this.sceneNum}.mp4  ${(stat.size / 1024).toFixed(0)} KiB  ${this.frameIdx} frames`);
    return outPath;
  }
}

// ---------- SCENE FUNCTIONS ----------

const SCENES = {};

SCENES["02"] = async function sceneSignIn(page) {
  console.log("\n== Scene 02: Sign in to BI Pixie ==");
  // Go straight to Overview. Earlier version navigated to /login first to
  // "show the sign-in flow" but /login returns a 404 — that 404 page leaked
  // into the capture as the first ~3s of the scene.
  await navAndPrep(page, `${PORTAL_BASE}/`);
  // Hold on Overview header for ~22s (matches VO 19.6s + tail).
  await new Promise((r) => setTimeout(r, 22000));
};

SCENES["03"] = async function sceneWelcomeTour(page) {
  console.log("\n== Scene 03: Welcome page tour ==");
  await navAndPrep(page, `${PORTAL_BASE}/`);
  // Hold 8s on Overview header then begin smooth-scroll tour.
  await new Promise((r) => setTimeout(r, 8000));
  // Scroll to Why BI Pixie card and try to expand.
  await clickByText(page, "Why BI Pixie");
  await new Promise((r) => setTimeout(r, 6000));
  await page.runtimeEvaluate(`window.scrollBy({top: 400, behavior: 'smooth'})`);
  await new Promise((r) => setTimeout(r, 4000));
  // How BI Pixie works card.
  await clickByText(page, "How BI Pixie works");
  await new Promise((r) => setTimeout(r, 6000));
  await page.runtimeEvaluate(`window.scrollBy({top: 400, behavior: 'smooth'})`);
  await new Promise((r) => setTimeout(r, 8000));
  // BI Pixie for Every Organization
  await clickByText(page, "BI Pixie for Every Organization").catch(() => clickByText(page, "Every Organization"));
  await new Promise((r) => setTimeout(r, 5000));
  await page.runtimeEvaluate(`window.scrollBy({top: 400, behavior: 'smooth'})`);
  await new Promise((r) => setTimeout(r, 8000));
  // Scroll back to top so Add Pixies button is in view.
  await page.runtimeEvaluate(`window.scrollTo({top: 0, behavior: 'smooth'})`);
  await new Promise((r) => setTimeout(r, 6000));
  // Total ~75s.
};

SCENES["04"] = async function sceneClickAddPixies(page) {
  console.log("\n== Scene 04: Click Add Pixies ==");
  await navAndPrep(page, `${PORTAL_BASE}/`);
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  await new Promise((r) => setTimeout(r, 2500));
  // Click the <a href="/instrument"> anchor in the welcome guide (NOT the
  // wrapping DIV). The DIV match would not navigate.
  const r = await page.runtimeEvaluate(`
    (() => {
      const anchors = Array.from(document.querySelectorAll('a[href="/instrument"]'));
      const visible = anchors.filter(a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (visible.length === 0) return { found: false };
      const t = visible[0];
      t.scrollIntoView({block:"center"});
      t.click();
      return { found: true };
    })()
  `);
  if (!r?.found) throw new Error("scene-04: Add Pixies anchor not found on /overview");
  await new Promise((r) => setTimeout(r, 4000));
};

SCENES["05"] = async function sceneConnect(page) {
  console.log("\n== Scene 05: Connect to Power BI ==");
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  // Should already be on /instrument (from scene 04). Wait for Connect button.
  await waitForCondition("Connect to Power BI button", async () => page.runtimeEvaluate(`
    (() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /connect to power bi/i.test((x.textContent||"").trim()));
      if (!b) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()
  `), { timeoutMs: 15000 });
  // Hold 1.5s on the button (so VO can intro it), then click.
  await new Promise((r) => setTimeout(r, 1500));
  await page.runtimeEvaluate(`
    Array.from(document.querySelectorAll('button')).find(b => /connect to power bi/i.test((b.textContent||"").trim()))?.click()
  `);
  console.log("  clicked Connect to Power BI");
  // Wait for Select Workspace label to appear (proves connection succeeded).
  await waitForCondition("Select Workspace label", async () => page.runtimeEvaluate(`
    (() => {
      const labels = Array.from(document.querySelectorAll('label,h2,h3,h4'));
      return labels.some(l => /select workspace/i.test((l.textContent||"").trim()));
    })()
  `), { timeoutMs: 20000 });
  console.log("  Select Workspace card visible");
  await new Promise((r) => setTimeout(r, 4000));
};

SCENES["06"] = async function sceneSelectWorkspace(page) {
  console.log("\n== Scene 06: Select workspace ==");
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  // Focus the workspace search input
  await page.runtimeEvaluate(`
    const i = document.querySelector('input[placeholder*="workspace" i]');
    if (i) { i.scrollIntoView({block:"center"}); i.focus(); i.click(); }
  `);
  await new Promise((r) => setTimeout(r, 1000));
  // Type Marketing using CDP Input.insertText for proper keyboard event sequence
  await page.send("Input.insertText", { text: "Marketing" });
  await new Promise((r) => setTimeout(r, 2000));
  // Keyboard select: ArrowDown + Enter (combobox does not respond to bare LI click)
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown" });
  await new Promise((r) => setTimeout(r, 600));
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  // Wait for "Reports in Marketing Insights" heading to appear
  await waitForCondition("Reports in Marketing Insights", async () => page.runtimeEvaluate(`
    (() => {
      const els = Array.from(document.querySelectorAll('h1,h2,h3,h4,label'));
      return els.some(l => /reports in marketing insights/i.test((l.textContent||"").trim()));
    })()
  `), { timeoutMs: 20000 });
  console.log("  Reports panel loaded");
  await new Promise((r) => setTimeout(r, 3500));
};

SCENES["07"] = async function sceneSelectReport(page) {
  console.log("\n== Scene 07: Select Marketing Campaigns ==");
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  await new Promise((r) => setTimeout(r, 1500));
  // Click the checkbox whose enclosing label contains "Marketing Campaigns"
  const r = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      const target = cbs.find(cb => {
        const lbl = cb.closest('label') || cb.parentElement;
        return lbl && /marketing campaigns/i.test(norm(lbl.textContent));
      });
      if (!target) return { found: false, count: cbs.length };
      target.scrollIntoView({block:"center"});
      const wasChecked = target.checked;
      // Only click if not already checked — otherwise we'd toggle it OFF.
      if (!wasChecked) target.click();
      return { found: true, wasChecked };
    })()
  `);
  if (!r?.found) throw new Error(`scene-07: Marketing Campaigns checkbox not found (${r?.count} cbs)`);
  console.log(r.wasChecked ? "  Marketing Campaigns already checked (no toggle)" : "  ticked Marketing Campaigns");
  await new Promise((r) => setTimeout(r, 5000));
};

SCENES["08"] = async function sceneDelivery(page) {
  console.log("\n== Scene 08: Delivery method ==");
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  await page.runtimeEvaluate(`window.scrollTo({top: document.body.scrollHeight, behavior: 'smooth'})`);
  await new Promise((r) => setTimeout(r, 3000));
  // Click the Auto-Save to Power BI radio (or its label)
  const r = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const radios = Array.from(document.querySelectorAll('input[type=radio]'));
      const target = radios.find(rd => {
        const lbl = rd.closest('label') || rd.parentElement;
        return lbl && /auto-save to power bi/i.test(norm(lbl.textContent));
      });
      if (target) {
        const lbl = target.closest('label') || target.parentElement;
        lbl.scrollIntoView({block:"center"});
        target.click();
        return { found: true };
      }
      // Fallback: click the labelled card by text
      const all = Array.from(document.querySelectorAll('label, [role=radio]'));
      const t2 = all.find(el => /auto-save to power bi/i.test(norm(el.textContent)));
      if (t2) { t2.scrollIntoView({block:"center"}); t2.click(); return { found: true, fallback: true }; }
      return { found: false };
    })()
  `);
  if (!r?.found) throw new Error("scene-08: Auto-Save to Power BI radio not found");
  console.log("  picked Auto-Save to Power BI", r.fallback ? "(via label)" : "");
  await new Promise((r) => setTimeout(r, 12000));
};

SCENES["09"] = async function sceneSave(page) {
  console.log("\n== Scene 09: Save to Power BI (LIVE) ==");
  await injectPiiBlur(page);
  await injectHeartbeat(page);
  // Click the "Save to Power BI" button at the bottom of the wizard.
  const r = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const btns = Array.from(document.querySelectorAll('button'));
      const visible = btns.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      // Match "Save to Power BI (N)" or "Update Pixies (N)" — the wizard
      // shows Update when at least one report in this workspace is already
      // tracked. Either flow saves the wizard state.
      const target = visible.find(b => /^(save to power bi|update pixies)/i.test(norm(b.textContent)));
      if (!target) return { found: false, all: visible.map(b => norm(b.textContent).slice(0,40)) };
      target.scrollIntoView({block:"center"});
      target.click();
      return { found: true, text: norm(target.textContent).slice(0,80) };
    })()
  `);
  if (!r?.found) throw new Error(`scene-09: Save to Power BI button not found - visible buttons: ${JSON.stringify(r?.all)}`);
  console.log(`  clicked: ${r.text}`);
  // Wait for any post-save success indicator (text changes between
  // releases — accept "All reports updated", "Pixies added", "Saved", etc.)
  // up to 120s. Snapshot every 30s while waiting so we can diagnose.
  let sawSuccess = false;
  const successStart = Date.now();
  let iter = 0;
  while (Date.now() - successStart < 120000) {
    iter++;
    const state = await page.runtimeEvaluate(`
      (() => {
        const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
        const all = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span,p,button'));
        const visible = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
        const phrases = ['all reports updated', 'pixies added', 'pixies updated', 'reports updated', 'saved successfully', 'success', 'completed'];
        for (const ph of phrases) {
          if (visible.some(el => norm(el.textContent).includes(ph))) return { hit: ph };
        }
        // Also look for new buttons indicating completed state
        const btns = visible.filter(el => el.tagName === 'BUTTON').map(b => norm(b.textContent).slice(0,40));
        return { hit: null, btns };
      })()
    `);
    if (state.hit) { console.log(`  saw: ${state.hit}`); sawSuccess = true; break; }
    if (iter % 15 === 0) {
      console.log(`  scene-09 still waiting (${Math.round((Date.now()-successStart)/1000)}s) buttons=${JSON.stringify(state.btns).slice(0,200)}`);
      await snapshotPage(page, `scene-09-wait-${iter}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!sawSuccess) {
    await snapshotPage(page, "scene-09-timeout-final");
    throw new Error("scene-09: timed out waiting for save success indicator after 120s");
  }
  console.log("  save success");
  await new Promise((r) => setTimeout(r, 4000));
};

SCENES["10"] = async function sceneManaged(page) {
  console.log("\n== Scene 10: Managed Reports ==");
  await navAndPrep(page, `${PORTAL_BASE}/managed`);
  await new Promise((r) => setTimeout(r, 4000));
  // Click the Marketing Campaigns row.
  await clickByText(page, "Marketing Campaigns");
  await new Promise((r) => setTimeout(r, 26000));
};

SCENES["12"] = async function sceneVerify(page) {
  console.log("\n== Scene 12: Verify bookmark event ==");
  await navAndPrep(page, `${PORTAL_BASE}/managed`);
  await new Promise((r) => setTimeout(r, 3000));
  // Click the Marketing Campaigns row — this auto-expands the Events panel
  // at the bottom showing "Events: Marketing Campaigns" + "Check for events"
  // button. Do NOT also click "Event Viewer" header text (it lives in the
  // collapsed-state footer and matches partial strings that break layout).
  await clickByText(page, "Marketing Campaigns");
  await new Promise((r) => setTimeout(r, 4000));
  // Click "Check for events" button (now should be visible)
  let attempts = 0;
  let foundAnyEvent = false;
  while (attempts < 3 && !foundAnyEvent) {
    const clickRes = await clickByText(page, "Check for events");
    attempts++;
    console.log(`  Check for events attempt ${attempts}: ${JSON.stringify(clickRes).slice(0,80)}`);
    // Wait 25s for ANY event row to appear (Bookmark Click, Page View, Filter Change, etc.)
    foundAnyEvent = await waitForCondition("any event row", async () => {
      return page.runtimeEvaluate(`
        (() => {
          const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
          // Look for known event type names anywhere on the page
          const phrases = ['bookmark click', 'page view', 'filter change', 'visual click', 'report open', 'slicer change'];
          return Array.from(document.querySelectorAll('span,div,td,p'))
            .some(el => phrases.some(ph => norm(el.textContent) === ph));
        })()
      `);
    }, { timeoutMs: 25000, pollMs: 2000 }).catch(() => false);
    if (!foundAnyEvent) await new Promise((r) => setTimeout(r, 3000));
  }
  if (foundAnyEvent) console.log("  Event row(s) appeared in Event Viewer");
  else console.log("  WARN: no events visible after 3 attempts - bookmark events may still be propagating from Power BI");
  // Hold 6s on the events table state
  await new Promise((r) => setTimeout(r, 6000));
};

SCENES["13"] = async function sceneInstallCard(page) {
  console.log("\n== Scene 13: Install dashboard card ==");
  await navAndPrep(page, `${PORTAL_BASE}/`);
  await new Promise((r) => setTimeout(r, 4000));
  // Scroll to the BI Pixie Dashboard card.
  await page.runtimeEvaluate(`
    const els = Array.from(document.querySelectorAll('h1,h2,h3,div,span'));
    const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
    const target = els.find(el => norm(el.textContent).includes('bi pixie dashboard'));
    if (target) target.scrollIntoView({block:'center', behavior:'smooth'});
  `);
  // DO NOT click Install. Hold ~14s with the button visible.
  await new Promise((r) => setTimeout(r, 14000));
};

// ---------- MAIN ----------

async function main() {
  const args = process.argv.slice(2);
  let sceneArg = "all";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scene") sceneArg = args[i + 1];
  }
  const sceneNums = expandSceneArg(sceneArg);
  console.log(`Capturing scenes: ${sceneNums.join(", ")}`);

  fs.mkdirSync(SCENES_DIR, { recursive: true });

  const chrome = await launchIsolatedChrome({
    width: 1920, height: 1080, sessionId: SESSION_ID,
  });

  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();

  const targets = await browser.listPageTargets();
  let page;
  if (targets.length > 0) page = await browser.attachToTarget(targets[0].targetId);
  else page = await browser.createPageSession("about:blank");

  await ensureSignedIn(page);
  console.log("== signed in, ready ==");

  // Keep the tab's screencast active — Chrome throttles inactive/backgrounded
  // tabs which causes scenes with little visual change to drop to <1fps.
  try { await page.send("Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}
  try { await page.send("Page.setWebLifecycleState", { state: "active" }); } catch {}

  for (const num of sceneNums) {
    const fn = SCENES[num];
    if (!fn) { console.log(`  SKIP scene-${num}: no function defined (Power BI scene? use drive-powerbi-window.js)`); continue; }
    try { await page.send("Page.bringToFront"); } catch {}
    const rec = new Recorder(page, num);
    try {
      await rec.start();
      await fn(page);
      await rec.stop();
      await rec.encode();
    } catch (e) {
      console.error(`SCENE ${num} FAILED:`, e.message);
      try { await rec.stop(); } catch {}
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  await browser.close();
  chrome.cleanup();
  console.log("\n== ALL DONE ==");
}

function expandSceneArg(s) {
  if (s === "all") return ["02","03","04","05","06","07","08","09","10","12","13"];
  if (/^\d{2}$/.test(s)) return [s];
  const m = s.match(/^(\d{2})-(\d{2})$/);
  if (m) {
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
    const out = [];
    for (let i = a; i <= b; i++) out.push(String(i).padStart(2, "0"));
    return out;
  }
  return s.split(",").map((x) => x.trim());
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
