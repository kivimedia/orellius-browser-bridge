#!/usr/bin/env node

// Direct probe of /add-pixies wizard page.
// Walks: land on /add-pixies, click "Connect to Power BI", select workspace,
// pick report, pick delivery, dump DOM + screenshot at each stage.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/wizard-probe-2";
const SESSION_ID = "bipixie-walkthrough";
const PORTAL_BASE = "https://app.bipixie.com";

const PROBE_JS = `
  (() => {
    const norm = s => (s || "").replace(/\\s+/g, " ").trim();
    const els = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="checkbox"], [role="radio"], input, select, textarea, h1, h2, h3, h4, label, [data-testid]'
    ));
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const text = norm(el.textContent || el.value || "").slice(0, 140);
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        text,
        role: el.getAttribute("role") || "",
        aria: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        id: el.id || "",
        dataTestid: el.getAttribute("data-testid") || "",
        href: el.getAttribute("href") || "",
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    return {
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3,h4")).filter(h => h.getBoundingClientRect().width > 0).map(h => ({ level: h.tagName, text: norm(h.textContent).slice(0, 200) })),
      visible: out,
    };
  })()
`;

async function dump(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = await page.runtimeEvaluate(PROBE_JS);
  fs.writeFileSync(path.join(OUT_DIR, `${label}.json`), JSON.stringify(d, null, 2));
  // Screenshot via Page.captureScreenshot
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) {
    fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  }
  console.log(`  DUMP ${label}  (${d.visible.length} els, url=${d.url})`);
  return d;
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0
    ? await browser.attachToTarget(targets[0].targetId)
    : await browser.createPageSession("about:blank");

  // 1. Navigate directly to /add-pixies
  console.log("Navigate to /add-pixies");
  await page.navigate(`${PORTAL_BASE}/add-pixies`);
  await new Promise((r) => setTimeout(r, 8000));
  await dump(page, "01-add-pixies-landing");

  // 2. Try clicking Connect to Power BI
  console.log("\nClick Connect to Power BI");
  const r1 = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('button, a, [role=button]'));
      const target = all.find(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return /connect to power bi/i.test(norm(el.textContent));
      });
      if (target) { target.scrollIntoView({block:"center"}); target.click(); return { tag: target.tagName, text: target.textContent.slice(0,80) }; }
      return false;
    })()
  `);
  console.log("  click result:", r1);
  await new Promise((r) => setTimeout(r, 8000));
  await dump(page, "02-after-connect");

  // 3. Probe workspace selector — look for combobox / select / button labelled workspace
  console.log("\nProbe workspace selector");
  const r2 = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('button, [role=combobox], [role=button], input, select'));
      const target = all.find(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = norm(el.textContent || el.placeholder || el.getAttribute("aria-label") || "");
        return /workspace/i.test(t) || /select.*workspace/i.test(t);
      });
      if (target) { target.scrollIntoView({block:"center"}); target.click(); return { tag: target.tagName, text: (target.textContent||target.placeholder||"").slice(0,80) }; }
      return false;
    })()
  `);
  console.log("  click result:", r2);
  await new Promise((r) => setTimeout(r, 3000));
  await dump(page, "03-workspace-dropdown-open");

  // 4. Type Marketing in the visible search/text input
  console.log("\nType Marketing in workspace search");
  await page.runtimeEvaluate(`
    (() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const visible = inputs.filter(el => { const r = el.getBoundingClientRect(); return r.width>0 && r.height>0; });
      const search = visible.find(i => /search|workspace|filter/i.test(i.placeholder||i.name||i.getAttribute("aria-label")||"")) || visible[visible.length-1];
      if (search) search.focus();
    })()
  `);
  await page.typeText("Marketing");
  await new Promise((r) => setTimeout(r, 2500));
  await dump(page, "04-after-type-marketing");

  // 5. Click Marketing Insights
  console.log("\nClick Marketing Insights option");
  const r3 = await page.runtimeEvaluate(`
    (() => {
      const all = Array.from(document.querySelectorAll('[role=option], li, div, button'));
      const target = all.find(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return /marketing insights/i.test((el.textContent||"").trim());
      });
      if (target) { target.scrollIntoView({block:"center"}); target.click(); return { tag: target.tagName, text: target.textContent.slice(0,80) }; }
      return false;
    })()
  `);
  console.log("  click result:", r3);
  await new Promise((r) => setTimeout(r, 4000));
  await dump(page, "05-after-pick-workspace");

  // 6. Click Marketing Campaigns report
  console.log("\nClick Marketing Campaigns report");
  const r4 = await page.runtimeEvaluate(`
    (() => {
      const all = Array.from(document.querySelectorAll('[role=option], li, div, button, span, a'));
      const target = all.find(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return /^marketing campaigns$/i.test((el.textContent||"").trim());
      });
      if (target) { target.scrollIntoView({block:"center"}); target.click(); return { tag: target.tagName, text: target.textContent.slice(0,80) }; }
      return false;
    })()
  `);
  console.log("  click result:", r4);
  await new Promise((r) => setTimeout(r, 4000));
  await dump(page, "06-after-pick-report");

  // 7. Scroll for delivery method, dump
  await page.runtimeEvaluate(`window.scrollBy({top: 400, behavior: "smooth"})`);
  await new Promise((r) => setTimeout(r, 2500));
  await dump(page, "07-delivery-area");

  console.log("\n== ALL DUMPS WRITTEN to", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
