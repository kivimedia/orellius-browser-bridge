#!/usr/bin/env node

// Use keyboard (ArrowDown + Enter) to select workspace from combobox.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/wizard-walk-v4";
const SESSION_ID = "bipixie-walkthrough";

async function snap(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  console.log(`  SNAP ${label}`);
}

async function pressKey(page, key) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key });
  await new Promise((r) => setTimeout(r, 50));
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key });
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  await page.navigate("https://app.bipixie.com/instrument");
  await new Promise((r) => setTimeout(r, 6000));

  await page.runtimeEvaluate(`Array.from(document.querySelectorAll('button')).find(b => /connect to power bi/i.test((b.textContent||"").trim()))?.click()`);
  for (let i = 0; i < 30; i++) {
    if (await page.runtimeEvaluate(`!!document.querySelector('input[placeholder*="workspace" i]')`)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await snap(page, "01-after-connect");

  // Focus input via JS, then keyboard-type Marketing
  await page.runtimeEvaluate(`
    const i = document.querySelector('input[placeholder*="workspace" i]');
    if (i) { i.focus(); i.click(); }
  `);
  await new Promise((r) => setTimeout(r, 800));

  // Use Input.insertText to type, then keyboard ArrowDown + Enter
  await page.send("Input.insertText", { text: "Marketing" });
  await new Promise((r) => setTimeout(r, 1500));
  await snap(page, "02-typed-marketing");

  // Press ArrowDown then Enter
  await pressKey(page, "ArrowDown");
  await new Promise((r) => setTimeout(r, 400));
  await snap(page, "03-after-arrow-down");

  await pressKey(page, "Enter");
  await new Promise((r) => setTimeout(r, 1500));
  await snap(page, "04-after-enter");

  // Poll for reports up to 30s
  for (let i = 0; i < 30; i++) {
    const cb = await page.runtimeEvaluate(`document.querySelectorAll('input[type=checkbox]').length`);
    console.log(`  poll ${i}: ${cb} checkboxes`);
    if (cb > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await snap(page, "05-after-pick");

  // Dump report state
  const reports = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      return cbs.map(cb => {
        const lbl = cb.closest('label') || cb.parentElement;
        return { checked: cb.checked, text: lbl ? norm(lbl.textContent).slice(0,150) : "" };
      });
    })()
  `);
  console.log("\nReports:", JSON.stringify(reports, null, 2));

  // Dump headings to see what loaded
  const headings = await page.runtimeEvaluate(`
    Array.from(document.querySelectorAll("h1,h2,h3,h4,label")).filter(h=>h.getBoundingClientRect().width>0).map(h=>(h.textContent||"").trim().slice(0,100)).slice(0,20)
  `);
  console.log("\nHeadings:", JSON.stringify(headings, null, 2));

  console.log("\n== DONE", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
