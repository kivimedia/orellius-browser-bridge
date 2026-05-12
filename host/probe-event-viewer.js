#!/usr/bin/env node

// Probe the Event Viewer panel on /managed to find expand selector.
import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/event-viewer-probe";
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

  await page.navigate("https://app.bipixie.com/managed");
  await new Promise((r) => setTimeout(r, 5000));
  await snap(page, "01-managed-landing");

  // Click Marketing Campaigns row
  await page.runtimeEvaluate(`
    Array.from(document.querySelectorAll('div, span, td')).find(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && /^marketing campaigns$/i.test((el.textContent||'').trim());
    })?.click()
  `);
  await new Promise((r) => setTimeout(r, 2000));
  await snap(page, "02-row-clicked");

  // Probe the Event Viewer area. Find all interactive elements in the bottom 200px.
  const bottomElements = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||'').replace(/\\s+/g,' ').trim();
      const vh = window.innerHeight;
      const all = Array.from(document.querySelectorAll('button, a, [role=button], svg, [aria-label], [title]'));
      return all.filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return r.top > vh - 200 && r.top < vh;
      }).slice(0, 50).map(el => ({
        tag: el.tagName,
        text: norm(el.textContent).slice(0, 60),
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        role: el.getAttribute('role') || '',
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }));
    })()
  `);
  console.log("Bottom interactive elements:", JSON.stringify(bottomElements, null, 2));

  // Try clicking the first thing that looks like an expand chevron near the Event Viewer header
  const chevronRes = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s||'').replace(/\\s+/g,' ').trim();
      // Find Event Viewer header's parent, then find any clickable in it
      const headers = Array.from(document.querySelectorAll('div, span, h1,h2,h3,h4'));
      const evHeader = headers.find(h => /^event viewer$/i.test(norm(h.textContent)));
      if (!evHeader) return { found: false, reason: "no Event Viewer header" };
      // Walk up to find the panel container
      let parent = evHeader.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const buttons = parent.querySelectorAll('button, [role=button], svg');
        if (buttons.length > 0) {
          const visible = Array.from(buttons).filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
          return {
            found: true,
            depth: i,
            buttonCount: visible.length,
            buttons: visible.slice(0,8).map(b => ({ tag: b.tagName, aria: b.getAttribute('aria-label'), text: norm(b.textContent).slice(0,40), rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })() })),
          };
        }
        parent = parent.parentElement;
      }
      return { found: false, reason: "no buttons in ancestors" };
    })()
  `);
  console.log("\nEvent Viewer header buttons:", JSON.stringify(chevronRes, null, 2));

  console.log("\n== DONE", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
