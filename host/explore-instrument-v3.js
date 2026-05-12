#!/usr/bin/env node

// Targeted wizard walk: pick "Marketing Insights", wait long enough for reports.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/wizard-walk-v3";
const SESSION_ID = "bipixie-walkthrough";

async function snap(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  console.log(`  SNAP ${label}`);
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  await page.navigate("https://app.bipixie.com/instrument");
  await new Promise((r) => setTimeout(r, 6000));
  await snap(page, "01");

  await page.runtimeEvaluate(`Array.from(document.querySelectorAll('button')).find(b => /connect to power bi/i.test((b.textContent||"").trim()))?.click()`);
  console.log("clicked Connect");

  // Wait for input to be visible
  for (let i = 0; i < 40; i++) {
    const ok = await page.runtimeEvaluate(`!!document.querySelector('input[placeholder*="workspace" i]')`);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await snap(page, "02-after-connect");

  // Click input directly (not chevron)
  await page.runtimeEvaluate(`
    const i = document.querySelector('input[placeholder*="workspace" i]');
    if (i) { i.scrollIntoView({block:"center"}); i.focus(); i.click(); }
  `);
  await new Promise((r) => setTimeout(r, 1000));
  await snap(page, "03-input-focused");

  // Type Marketing
  await page.typeText("Marketing");
  await new Promise((r) => setTimeout(r, 2000));
  await snap(page, "04-typed-marketing");

  // Click "Marketing Insights" exact
  const r1 = await page.runtimeEvaluate(`
    (() => {
      const opts = Array.from(document.querySelectorAll('[role=option], li'));
      const t = opts.find(o => /^marketing insights$/i.test((o.textContent||"").trim()));
      if (!t) return { found: false, allTexts: opts.slice(0,10).map(o => (o.textContent||"").trim().slice(0,80)) };
      t.scrollIntoView({block:"center"});
      t.click();
      return { found: true };
    })()
  `);
  console.log("Pick Marketing Insights:", r1);
  // Wait LONG for reports to load
  for (let i = 0; i < 30; i++) {
    const cb = await page.runtimeEvaluate(`document.querySelectorAll('input[type=checkbox]').length`);
    console.log(`  poll ${i}: ${cb} checkboxes`);
    if (cb > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await snap(page, "05-after-pick-marketing-insights");

  // Dump reports
  const reports = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      return cbs.map(cb => {
        const lbl = cb.closest('label') || cb.parentElement;
        const wrap = lbl?.parentElement?.parentElement || lbl?.parentElement || lbl;
        return {
          checked: cb.checked,
          labelText: lbl ? norm(lbl.textContent).slice(0, 150) : "",
          wrapText: wrap ? norm(wrap.textContent).slice(0, 150) : "",
        };
      });
    })()
  `);
  console.log("\nReports:", JSON.stringify(reports, null, 2));

  // Try ticking Marketing Campaigns specifically
  const r2 = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      const target = cbs.find(cb => {
        const lbl = cb.closest('label') || cb.parentElement;
        if (!lbl) return false;
        return /marketing campaigns/i.test(norm(lbl.textContent));
      });
      if (target) { target.click(); return { hit: true, alreadyChecked: target.checked }; }
      return { hit: false };
    })()
  `);
  console.log("Tick Marketing Campaigns:", r2);
  await new Promise((r) => setTimeout(r, 3000));
  await snap(page, "06-after-tick-marketing-campaigns");

  // Scroll to delivery
  await page.runtimeEvaluate(`window.scrollTo({top: document.body.scrollHeight, behavior: "smooth"})`);
  await new Promise((r) => setTimeout(r, 2500));
  await snap(page, "07-scrolled");

  // Probe radios + save
  const probe = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const radios = Array.from(document.querySelectorAll('input[type=radio]')).map(r => {
        const lbl = r.closest('label') || r.parentElement;
        return { checked: r.checked, text: lbl ? norm(lbl.textContent).slice(0,150) : "" };
      });
      const saves = Array.from(document.querySelectorAll('button')).filter(b => /save/i.test((b.textContent||"")) && b.getBoundingClientRect().width > 0).map(b => ({ text: norm(b.textContent).slice(0,80) }));
      return { radios, saves };
    })()
  `);
  console.log("\nDelivery + Save:", JSON.stringify(probe, null, 2));

  console.log("\n== DONE", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
