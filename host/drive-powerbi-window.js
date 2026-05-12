#!/usr/bin/env node

// Window B (Power BI) capture driver for Getting Started walkthrough.
// Scenes:
//   11 = Open Marketing Campaigns report + click Bookmark 3
//   14 = Tour the BI Pixie Dashboard (10 pages, ~10s each)
//
// Uses a SEPARATE iso profile (session-bipixie-powerbi) so the BI Pixie
// Window A profile is untouched. First run does an MSAL login against
// app.powerbi.com using the same test creds.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const PROJECT_ROOT = "C:/Users/raviv/datachant/bipixie-walkthrough";
const SCENES_DIR = path.join(PROJECT_ROOT, "output/scenes");
const SESSION_ID = "bipixie-powerbi";
const MS_EMAIL = "test@datachant.com";
const MS_PASSWORD = "DataChant!";
const PBI_HOME = "https://app.powerbi.com/home?experience=power-bi";
const DASHBOARD_URL = "https://app.powerbi.com/groups/me/apps/a5226c48-7ab7-4b9f-97d2-b84ce57b144d/reports/555a6de5-a45e-4b8d-bf68-edea98813e27/ReportSection7ee331b5bc4e07523cdc?experience=power-bi";
// Marketing Campaigns report URL: discovered at runtime by browsing to
// the Marketing Insights workspace, since the report ID isn't fixed.
// For Scene 11 we navigate to the workspace and click the report by name.
const MARKETING_INSIGHTS_WORKSPACE = "https://app.powerbi.com/home?experience=power-bi";

async function waitForCondition(label, fn, { timeoutMs = 60000, pollMs = 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const ok = await fn(); if (ok) return ok; } catch {}
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function autoLoginMsal(page) {
  console.log("  autoLoginMsal: starting");
  // Stage 1: handle PBI's "Enter your email" pre-MSAL page if shown.
  // This page lives on app.powerbi.com (NOT login.microsoftonline.com) and has
  // the title "Power BI" + a Submit button.
  for (let i = 0; i < 30; i++) {
    const u = await page.runtimeEvaluate("location.href");
    if (/app\.powerbi\.com\/home/i.test(u)) { console.log(`  on PBI home (already signed in)`); return; }
    const onMsal = /login\.microsoftonline\.com/i.test(u);
    const isPbiSignupPage = /app\.powerbi\.com/i.test(u) && !onMsal && await page.runtimeEvaluate(`/Power BI/.test(document.title) && document.body.textContent.includes("Enter your email")`).catch(() => false);
    console.log(`  iter ${i}: url=${u.slice(0,80)} pbiSignup=${isPbiSignupPage} msal=${onMsal}`);
    if (isPbiSignupPage) {
      console.log("  filling PBI pre-MSAL email form");
      await page.runtimeEvaluate(`(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.type === 'email' || /email/i.test(i.placeholder||''));
        if (inp) { inp.focus(); }
      })()`);
      await page.typeText(MS_EMAIL);
      await new Promise((r) => setTimeout(r, 500));
      await page.runtimeEvaluate(`(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /^submit$/i.test((b.textContent||'').trim()));
        if (btn) btn.click();
      })()`);
      // Wait for redirect away from PBI signup page
      for (let j = 0; j < 20; j++) {
        await new Promise((r) => setTimeout(r, 1000));
        const nu = await page.runtimeEvaluate("location.href");
        if (/login\.microsoftonline\.com/i.test(nu) || /app\.powerbi\.com\/home/i.test(nu)) {
          console.log(`  PBI signup -> redirect detected: ${nu.slice(0,80)}`);
          break;
        }
      }
      break;
    }
    if (onMsal) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Stage 2: MSAL flow (or already-signed-in)
  let url = await page.runtimeEvaluate("location.href");
  if (/app\.powerbi\.com\/home/i.test(url)) { console.log("  reached PBI home after stage 1"); return; }

  if (/login\.microsoftonline\.com/i.test(url)) {
    console.log("  on MSAL");
    // Email page - might not be shown if already cached
    const hasEmail = await page.runtimeEvaluate(`(() => {
      const e = document.querySelector('input[type=email], input[name=loginfmt]');
      if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0;
    })()`).catch(() => false);
    if (hasEmail) {
      console.log("  MSAL email page");
      await page.runtimeEvaluate(`document.querySelector('input[type=email], input[name=loginfmt]').focus()`);
      await page.typeText(MS_EMAIL);
      await new Promise((r) => setTimeout(r, 400));
      await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    // Password page
    await waitForCondition("MSAL password field", async () => page.runtimeEvaluate(`(() => {
      const el = document.querySelector('input[type=password], input[name=passwd]');
      if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    })()`), { timeoutMs: 30000 });
    console.log("  MSAL password page");
    await new Promise((r) => setTimeout(r, 800));
    await page.runtimeEvaluate(`document.querySelector('input[type=password], input[name=passwd]').focus()`);
    await page.typeText(MS_PASSWORD);
    await new Promise((r) => setTimeout(r, 400));
    await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
    await new Promise((r) => setTimeout(r, 4000));
    // Stay signed in -> No
    const noClicked = await page.runtimeEvaluate(`(() => {
      const btn = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button]')).find(b => /^no$/i.test((b.textContent||b.value||'').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    })()`).catch(() => false);
    if (noClicked) console.log("  clicked 'No' on Stay signed in");
    else {
      // Fallback: try the back button
      await page.runtimeEvaluate(`document.querySelector('#idBtn_Back, #idSIButton9')?.click()`);
    }
  }

  // Stage 3: wait for PBI to load
  await waitForCondition("on app.powerbi.com (signed in)", async () => {
    const u2 = await page.runtimeEvaluate("location.href").catch(() => "");
    return /app\.powerbi\.com/i.test(u2) && !/login/i.test(u2) && !await page.runtimeEvaluate(`document.body.textContent.includes("Enter your email")`).catch(() => true);
  }, { timeoutMs: 60000 });
  console.log("  signed-in URL:", await page.runtimeEvaluate("location.href"));
  await new Promise((r) => setTimeout(r, 6000));
}

async function clickByText(page, text) {
  return page.runtimeEvaluate(`
    (() => {
      const t = ${JSON.stringify(text)}.trim().toLowerCase();
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="link"], [role="tab"], li, span, div'));
      const visible = all.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      const exact = visible.find(el => norm(el.textContent) === t);
      if (exact) { exact.scrollIntoView({block:'center'}); exact.click(); return { hit: 'exact', tag: exact.tagName }; }
      const containing = visible
        .filter(el => norm(el.textContent).includes(t))
        .sort((a, b) => (a.textContent.length - b.textContent.length));
      if (containing.length > 0) {
        const target = containing[0];
        target.scrollIntoView({block:'center'});
        target.click();
        return { hit: 'contains', tag: target.tagName };
      }
      return false;
    })()
  `);
}

class Recorder {
  constructor(page, sceneNum) {
    this.page = page; this.sceneNum = sceneNum;
    this.tmpDir = path.join(os.tmpdir(), `bipixie-rec-${sceneNum}-${Date.now().toString(36)}`);
    fs.mkdirSync(this.tmpDir, { recursive: true });
    this.timing = []; this.frameIdx = 0; this.off = null;
    this.startWall = 0; this.stopWall = 0;
  }
  async start() {
    // Poll-screenshot recorder (CDP screencast is paint-driven; static
    // frames between Power BI clicks would otherwise be dropped).
    this.startWall = Date.now() / 1000;
    this.captureInterval = 67;
    this.capturing = true;
    console.log(`  REC scene-${this.sceneNum} started (poll-screenshot @ 15fps)`);
    this._loop = (async () => {
      while (this.capturing) {
        const t0 = Date.now();
        try {
          // Race captureScreenshot against a 2s timeout. Power BI navigations
          // can hang Page.captureScreenshot indefinitely; without the race,
          // the loop stops emitting frames after the first one.
          const png = await Promise.race([
            this.page.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("ss-timeout")), 2000)),
          ]);
          if (png?.data) {
            const idx = this.frameIdx++;
            const fp = path.join(this.tmpDir, `f${String(idx).padStart(6, "0")}.jpg`);
            fs.writeFileSync(fp, Buffer.from(png.data, "base64"));
            this.timing.push(Date.now() / 1000);
          }
        } catch (e) { if (!this.capturing) return; }
        const elapsed = Date.now() - t0;
        const wait = Math.max(0, this.captureInterval - elapsed);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    })();
  }
  async stop() {
    this.capturing = false;
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
    for (let i = 0; i < files.length; i++) {
      lines.push(`file '${path.join(this.tmpDir, files[i]).replace(/\\/g, "/")}'`);
      let dur;
      if (i + 1 < this.timing.length) dur = this.timing[i + 1] - this.timing[i];
      else dur = this.stopWall - this.timing[i];
      dur = Math.max(0.03, Math.min(15.0, dur));
      lines.push(`duration ${dur.toFixed(3)}`);
    }
    lines.push(`file '${path.join(this.tmpDir, files[files.length - 1]).replace(/\\/g, "/")}'`);
    const concatPath = path.join(this.tmpDir, "concat.txt");
    fs.writeFileSync(concatPath, lines.join("\n"));
    fs.mkdirSync(SCENES_DIR, { recursive: true });
    const outPath = path.join(SCENES_DIR, `scene-${this.sceneNum}.mp4`);
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", outPath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; ff.stderr.on("data", (c) => (err += c.toString()));
      ff.on("error", reject);
      ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}\n${err.slice(-1500)}`))));
    });
    try { for (const f of files) fs.unlinkSync(path.join(this.tmpDir, f)); fs.unlinkSync(concatPath); fs.rmdirSync(this.tmpDir); } catch {}
    console.log(`  ENC scene-${this.sceneNum}.mp4  ${this.frameIdx} frames`);
    return outPath;
  }
}

const SCENES = {};

SCENES["11"] = async function sceneOpenReportAndBookmark(page) {
  console.log("\n== Scene 11: Open Marketing Campaigns + click Bookmark 3 ==");
  // Navigate DIRECTLY to the Marketing Campaigns report URL (discovered via
  // Orellius session 2026-05-05). Avoids the unreliable click path through
  // the home page's Recent/Recommended cards.
  const REPORT_URL = "https://app.powerbi.com/groups/e1a11ced-b868-46f5-a1b2-9aa55963d954/reports/6f1ef802-7bfc-4581-88f8-7dfc928401b3/ReportSection?experience=power-bi";
  await page.navigate(REPORT_URL);
  await new Promise((r) => setTimeout(r, 18000)); // report load is slow in fresh iso profile
  // Dump page state for debug
  const headings = await page.runtimeEvaluate(`
    Array.from(document.querySelectorAll("h1,h2,h3,h4,div[role=heading]"))
      .filter(h => h.getBoundingClientRect().width > 0)
      .map(h => (h.textContent||"").trim().slice(0,80))
      .filter(t => t.length > 0)
      .slice(0, 15)
  `);
  console.log("  page headings:", JSON.stringify(headings).slice(0, 300));
  // Open bookmarks navigator (built-in visual on the canvas).
  // Find element with text "Bookmark 3" and click.
  await waitForCondition("Bookmark 3 visible", async () => {
    return page.runtimeEvaluate(`
      (() => {
        const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
        return Array.from(document.querySelectorAll('div,span,button,a'))
          .some(el => {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            return norm(el.textContent) === 'bookmark 3';
          });
      })()
    `);
  }, { timeoutMs: 30000, pollMs: 2000 });
  await clickByText(page, "Bookmark 3");
  await new Promise((r) => setTimeout(r, 6000)); // hold post-bookmark
};

SCENES["14"] = async function sceneDashboardTour(page) {
  console.log("\n== Scene 14: BI Pixie Dashboard tour ==");
  await page.navigate(DASHBOARD_URL);
  // Pre-warm wait. Dashboard should already be warm if Ziv pre-loaded it,
  // but be safe.
  await new Promise((r) => setTimeout(r, 12000));
  const pages = [
    "Summary",
    "User Adoption",
    "User Attrition",
    "User Engagement Analysis",
    "User Satisfaction",
    "Survey Results",
    "Heatmap",
    "Data Auditing",
    "RLS Auditing",
    "Design Impact",
  ];
  // Try to open the page navigator pane if it's collapsed.
  await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||'').replace(/\\s+/g,' ').trim().toLowerCase();
      const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => /pages|page navigation/i.test(el.getAttribute('aria-label')||''));
      if (btn) btn.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 1500));
  for (const p of pages) {
    const r = await clickByText(page, p);
    console.log(`  page: ${p} -> ${r ? r.hit : 'MISS'}`);
    await new Promise((rr) => setTimeout(rr, 10000)); // 10s per page
  }
};

async function main() {
  const args = process.argv.slice(2);
  let sceneArg = "11,14";
  for (let i = 0; i < args.length; i++) if (args[i] === "--scene") sceneArg = args[i + 1];
  const sceneNums = sceneArg.split(",").map((s) => s.trim());

  fs.mkdirSync(SCENES_DIR, { recursive: true });

  const chrome = await launchIsolatedChrome({
    width: 1920, height: 1080, sessionId: SESSION_ID,
  });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  let page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  console.log("== launching Power BI ==");
  await page.navigate(PBI_HOME);
  await new Promise((r) => setTimeout(r, 5000));
  const u = await page.runtimeEvaluate("location.href");
  const onSignupPage = /app\.powerbi\.com/i.test(u) && !/\/home/i.test(u) && await page.runtimeEvaluate(`document.body.textContent.includes("Enter your email")`).catch(() => false);
  const onMsal = /login\.microsoftonline\.com/i.test(u);
  console.log(`== initial URL: ${u.slice(0,80)}  msal=${onMsal}  pbiSignup=${onSignupPage} ==`);
  if (onMsal || onSignupPage) {
    console.log("== auto-login MSAL ==");
    try { await page.send("Page.bringToFront"); } catch {}
    await autoLoginMsal(page);
  }
  console.log("== signed into Power BI ==");

  for (const num of sceneNums) {
    const fn = SCENES[num];
    if (!fn) { console.log(`SKIP scene-${num}`); continue; }
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
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
