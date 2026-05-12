#!/usr/bin/env node

// Aggressive Power BI OAuth driver:
// - Poll listPageTargets every 500ms for 60s after Connect click
// - Capture any new target's URL + screenshot
// - Drive Microsoft consent flow with retries

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/connect-v2";
const SESSION_ID = "bipixie-walkthrough";
const MS_EMAIL = "test@datachant.com";
const MS_PASSWORD = "DataChant!";

async function snap(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    const png = await page.send("Page.captureScreenshot", { format: "png" });
    if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
    const url = await page.runtimeEvaluate("location.href").catch(() => "");
    const headings = await page.runtimeEvaluate(`Array.from(document.querySelectorAll("h1,h2,h3,h4,label")).filter(h=>h.getBoundingClientRect().width>0).map(h=>(h.textContent||"").trim().slice(0,80)).slice(0,15)`).catch(() => []);
    console.log(`  SNAP ${label}  url=${url}  headings=${JSON.stringify(headings)}`);
  } catch (e) { console.log(`  SNAP ${label} failed: ${e.message}`); }
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const initial = await browser.listPageTargets();
  const main = initial.length > 0 ? await browser.attachToTarget(initial[0].targetId) : await browser.createPageSession("about:blank");
  const mainTargetId = initial.length > 0 ? initial[0].targetId : null;
  console.log(`Main target: ${mainTargetId}`);

  await main.navigate("https://app.bipixie.com/instrument");
  await new Promise((r) => setTimeout(r, 6000));
  await snap(main, "01-pre-connect");

  console.log("\nClicking Connect to Power BI...");
  const click = await main.runtimeEvaluate(`
    (() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /connect to power bi/i.test((b.textContent||"").trim()));
      if (!btn) return { found: false };
      btn.scrollIntoView({block:"center"});
      btn.click();
      return { found: true };
    })()
  `);
  console.log("Click:", click);

  // Aggressively poll for new targets for 60s
  const seenTargets = new Set([mainTargetId]);
  const popupPages = new Map(); // targetId -> page
  const start = Date.now();
  let iter = 0;
  while (Date.now() - start < 60000) {
    iter++;
    const targets = await browser.listPageTargets();
    for (const t of targets) {
      if (seenTargets.has(t.targetId)) continue;
      seenTargets.add(t.targetId);
      console.log(`  [${iter}] NEW TARGET ${t.targetId} url=${t.url}`);
      try {
        const p = await browser.attachToTarget(t.targetId);
        popupPages.set(t.targetId, p);
        await new Promise((r) => setTimeout(r, 800));
        await snap(p, `popup-${t.targetId.slice(0,6)}-initial`);
      } catch (e) { console.log(`  attach failed: ${e.message}`); }
    }
    // Drive any open popup
    for (const [tid, p] of popupPages.entries()) {
      try {
        const url = await p.runtimeEvaluate("location.href");
        const hasEmail = await p.runtimeEvaluate(`!!document.querySelector('input[type=email], input[name=loginfmt]')`);
        const hasPw = await p.runtimeEvaluate(`(() => { const e = document.querySelector('input[type=password], input[name=passwd]'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width>0; })()`);
        console.log(`  [${iter}] popup ${tid.slice(0,6)} url=${url.slice(0,80)}  email=${hasEmail} pw=${hasPw}`);
        if (hasEmail) {
          await p.runtimeEvaluate(`document.querySelector('input[type=email], input[name=loginfmt]').focus()`);
          await p.typeText(MS_EMAIL);
          await new Promise((r) => setTimeout(r, 300));
          await p.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
          await new Promise((r) => setTimeout(r, 3000));
        } else if (hasPw) {
          await p.runtimeEvaluate(`document.querySelector('input[type=password], input[name=passwd]').focus()`);
          await p.typeText(MS_PASSWORD);
          await new Promise((r) => setTimeout(r, 300));
          await p.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          // Stay-signed-in or consent screen — find Yes/Accept/Allow
          const r = await p.runtimeEvaluate(`
            (() => {
              const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
              const all = Array.from(document.querySelectorAll('button, input[type=submit], a'));
              const visible = all.filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
              for (const phrase of ['accept', 'yes', 'allow', 'continue', 'submit', 'next', 'sign in']) {
                const t = visible.find(b => norm(b.textContent || b.value || "") === phrase);
                if (t) { t.click(); return { hit: phrase }; }
              }
              return { hit: null, top: visible.slice(0,8).map(b => norm(b.textContent || b.value || "")) };
            })()
          `);
          if (r.hit) console.log(`  [${iter}] popup ${tid.slice(0,6)} clicked: ${r.hit}`);
        }
      } catch (e) {
        if (/Target closed|target was destroyed/i.test(e.message)) {
          console.log(`  [${iter}] popup ${tid.slice(0,6)} closed`);
          popupPages.delete(tid);
        }
      }
    }
    // Check main window state — has the wizard updated?
    try {
      const mainUrl = await main.runtimeEvaluate("location.href");
      const has5ws = await main.runtimeEvaluate(`/5 workspaces/i.test(document.body.textContent||"")`);
      const hasConnectBtn = await main.runtimeEvaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /connect to power bi/i.test((x.textContent||"").trim())); return !!b && b.getBoundingClientRect().width > 0; })()`);
      if (iter % 4 === 0) console.log(`  [${iter}] main url=${mainUrl.slice(0,60)} has5ws=${has5ws} hasConnectBtn=${hasConnectBtn}`);
      if (has5ws && popupPages.size === 0) { console.log("  CONNECTED + workspaces visible!"); await snap(main, "02-connected-with-workspaces"); break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\nFinal state:");
  await snap(main, "99-final-main");
  for (const [tid, p] of popupPages.entries()) {
    await snap(p, `99-final-popup-${tid.slice(0,6)}`);
  }
  console.log("\n== ALL DUMPS WRITTEN to", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
