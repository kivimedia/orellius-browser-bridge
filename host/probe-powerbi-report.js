#!/usr/bin/env node

// Probe Power BI Marketing Campaigns report — find bookmarks UI.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/pbi-probe";
const SESSION_ID = "bipixie-powerbi";
const PBI_HOME = "https://app.powerbi.com/home?experience=power-bi";
const MS_EMAIL = "test@datachant.com";
const MS_PASSWORD = "DataChant!";

async function snap(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  console.log(`  SNAP ${label}`);
}

async function autoLoginMsal(page) {
  for (let i = 0; i < 20; i++) {
    const url = await page.runtimeEvaluate("location.href").catch(() => "");
    if (/login\.microsoftonline\.com/i.test(url)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));
  await page.runtimeEvaluate(`document.querySelector('input[type=email], input[name=loginfmt]')?.focus()`);
  await page.typeText(MS_EMAIL);
  await new Promise((r) => setTimeout(r, 300));
  await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
  await new Promise((r) => setTimeout(r, 4000));
  await page.runtimeEvaluate(`document.querySelector('input[type=password], input[name=passwd]')?.focus()`);
  await page.typeText(MS_PASSWORD);
  await new Promise((r) => setTimeout(r, 300));
  await page.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
  await new Promise((r) => setTimeout(r, 3000));
  await page.runtimeEvaluate(`document.querySelector('#idSIButton9, #idBtn_Back')?.click()`);
  for (let i = 0; i < 60; i++) {
    const u = await page.runtimeEvaluate("location.href").catch(() => "");
    if (/app\.powerbi\.com/i.test(u) && !/login/i.test(u)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  await page.navigate(PBI_HOME);
  await new Promise((r) => setTimeout(r, 5000));
  let url = await page.runtimeEvaluate("location.href");
  if (/login\.microsoftonline/i.test(url)) {
    console.log("Need login");
    await autoLoginMsal(page);
  }
  await new Promise((r) => setTimeout(r, 5000));
  await snap(page, "01-pbi-home");

  // Click Marketing Insights workspace
  console.log("Click Marketing Insights");
  await page.runtimeEvaluate(`
    (() => {
      const all = Array.from(document.querySelectorAll('a, button, span, div'));
      const t = all.find(el => /^marketing insights$/i.test((el.textContent||"").trim()));
      if (t) { t.scrollIntoView({block:"center"}); t.click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 8000));
  await snap(page, "02-after-marketing-insights");

  // Click Marketing Campaigns report
  console.log("Click Marketing Campaigns");
  await page.runtimeEvaluate(`
    (() => {
      const all = Array.from(document.querySelectorAll('a, button, span, div'));
      const t = all.find(el => /^marketing campaigns$/i.test((el.textContent||"").trim()));
      if (t) { t.scrollIntoView({block:"center"}); t.click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 12000));
  await snap(page, "03-marketing-campaigns-loaded");

  // Look for any bookmark UI - either a button to open pane, or in-canvas bookmark
  const bookmarks = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||"").replace(/\\s+/g," ").trim();
      const candidates = [];
      // Look for Bookmark text anywhere
      const all = Array.from(document.querySelectorAll('div, span, button, a, [role=button]'));
      const visible = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      for (const el of visible) {
        const t = norm(el.textContent);
        if (/bookmark/i.test(t) && t.length < 60) {
          candidates.push({
            tag: el.tagName,
            role: el.getAttribute("role"),
            aria: el.getAttribute("aria-label"),
            text: t.slice(0,80),
            rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })(),
          });
        }
      }
      return candidates.slice(0, 30);
    })()
  `);
  console.log("\nBookmark candidates:", JSON.stringify(bookmarks, null, 2));

  // Look for buttons that might open the bookmarks pane
  const navButtons = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||"").replace(/\\s+/g," ").trim();
      const all = Array.from(document.querySelectorAll('button, [role=button]'));
      const visible = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return visible.map(el => ({
        text: norm(el.textContent).slice(0,60),
        aria: el.getAttribute("aria-label") || "",
        title: el.getAttribute("title") || "",
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })(),
      })).filter(b => /book|view|pane|nav/i.test(b.text + " " + b.aria + " " + b.title)).slice(0, 30);
    })()
  `);
  console.log("\nNav-related buttons:", JSON.stringify(navButtons, null, 2));

  // List all visible iframes — Power BI reports embed in iframes
  const iframes = await page.runtimeEvaluate(`
    Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, w: f.getBoundingClientRect().width, h: f.getBoundingClientRect().height, id: f.id }))
  `);
  console.log("\nIframes:", JSON.stringify(iframes, null, 2));

  console.log("\n== DONE", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
