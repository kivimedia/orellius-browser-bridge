#!/usr/bin/env node

// Interactive exploration of the BI Pixie "Add Pixies" wizard.
// Walks each step, dumps visible interactive elements + headings + URL
// to a JSON file so we can rewrite scenes 05-09 against real DOM.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/wizard-probe";
const SESSION_ID = "bipixie-walkthrough";
const PORTAL_BASE = "https://app.bipixie.com";
const MS_EMAIL = "test@datachant.com";
const MS_PASSWORD = "DataChant!";

const PROBE_JS = `
  (() => {
    const norm = s => (s || "").replace(/\\s+/g, " ").trim();
    const els = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [role="checkbox"], input, select, textarea, h1, h2, h3, h4, [data-testid]'
    ));
    const out = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const text = norm(el.textContent || el.value || "").slice(0, 120);
      const role = el.getAttribute("role") || "";
      const aria = el.getAttribute("aria-label") || "";
      const ph = el.getAttribute("placeholder") || "";
      const id = el.id || "";
      const dt = el.getAttribute("data-testid") || "";
      const cls = (el.className && typeof el.className === "string") ? el.className.slice(0, 100) : "";
      out.push({
        tag: el.tagName.toLowerCase(),
        text, role, aria, placeholder: ph, id, dataTestid: dt,
        classes: cls,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    return {
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3,h4"))
        .filter(h => h.getBoundingClientRect().width > 0)
        .map(h => ({ level: h.tagName, text: norm(h.textContent).slice(0, 200) })),
      visible: out,
    };
  })()
`;

async function dumpStep(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dump = await page.runtimeEvaluate(PROBE_JS);
  const file = path.join(OUT_DIR, `${label}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`  DUMP ${label}.json  (${dump.visible.length} visible els, url=${dump.url})`);
  return dump;
}

async function clickByText(page, text, opts = {}) {
  const { partial = true } = opts;
  return page.runtimeEvaluate(`
    (() => {
      const t = ${JSON.stringify(text)}.trim().toLowerCase();
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="link"], [role="tab"], [role="option"], li, span, div'));
      const visible = all.filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return true;
      });
      const exact = visible.find(el => norm(el.textContent) === t);
      if (exact) { exact.scrollIntoView({block:"center"}); exact.click(); return { hit: "exact", tag: exact.tagName }; }
      if (!${partial}) return false;
      const containing = visible
        .filter(el => norm(el.textContent).includes(t))
        .sort((a, b) => (a.textContent.length - b.textContent.length));
      if (containing.length > 0) { const t1 = containing[0]; t1.scrollIntoView({block:"center"}); t1.click(); return { hit: "contains", tag: t1.tagName }; }
      return false;
    })()
  `);
}

async function autoLoginMsal(page) {
  await page.runtimeEvaluate(`
    (() => { const b = Array.from(document.querySelectorAll('button,a')).find(x => /sign in with microsoft/i.test((x.textContent||'').trim())); if (b) b.click(); })()
  `);
  let attempts = 0;
  while (attempts++ < 30) {
    const url = await page.runtimeEvaluate("location.href");
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
  for (let i = 0; i < 30; i++) {
    const u = await page.runtimeEvaluate("location.href");
    if (/app\.bipixie\.com/i.test(u) && !/\/login/i.test(u)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0
    ? await browser.attachToTarget(targets[0].targetId)
    : await browser.createPageSession("about:blank");

  // 1. Land on portal home
  await page.navigate(`${PORTAL_BASE}/`);
  await new Promise((r) => setTimeout(r, 5000));
  let url = await page.runtimeEvaluate("location.href");
  console.log(`After / nav: ${url}`);
  if (/sign-in|login|microsoftonline/i.test(url) || /sign-in|login/i.test(await page.runtimeEvaluate("location.pathname"))) {
    console.log("Need login");
    await autoLoginMsal(page);
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Even if URL says we're on app.bipixie.com, wait until DOM has portal sidebar OR the welcome page
  await new Promise((r) => setTimeout(r, 4000));

  await dumpStep(page, "01-portal-home");

  // 2. Click Add Pixies in the sidebar
  console.log("\nClick Add Pixies");
  const r1 = await clickByText(page, "Add Pixies");
  console.log("  click result:", r1);
  await new Promise((r) => setTimeout(r, 6000));
  await dumpStep(page, "02-after-click-add-pixies");

  // 3. Probe for Connect to Power BI
  console.log("\nClick Connect to Power BI (if visible)");
  const r2 = await clickByText(page, "Connect to Power BI");
  console.log("  click result:", r2);
  await new Promise((r) => setTimeout(r, 6000));
  await dumpStep(page, "03-after-connect-click");

  // 4. Probe workspace dropdown
  console.log("\nClick Select Workspace");
  const r3 = await clickByText(page, "Select Workspace");
  console.log("  click result:", r3);
  await new Promise((r) => setTimeout(r, 3000));
  await dumpStep(page, "04-after-select-workspace");

  // 5. Try the Marketing search
  console.log("\nType Marketing");
  await page.runtimeEvaluate(`
    const el = document.querySelector('input[type=search], input[type=text], input[role=combobox], [role=combobox] input');
    if (el) { el.focus(); }
  `);
  await page.typeText("Marketing");
  await new Promise((r) => setTimeout(r, 2500));
  await dumpStep(page, "05-after-type-marketing");

  // 6. Try clicking Marketing Insights
  console.log("\nClick Marketing Insights");
  const r4 = await clickByText(page, "Marketing Insights");
  console.log("  click result:", r4);
  await new Promise((r) => setTimeout(r, 4000));
  await dumpStep(page, "06-after-pick-workspace");

  // 7. Click Marketing Campaigns report
  console.log("\nClick Marketing Campaigns");
  const r5 = await clickByText(page, "Marketing Campaigns");
  console.log("  click result:", r5);
  await new Promise((r) => setTimeout(r, 4000));
  await dumpStep(page, "07-after-pick-report");

  // 8. Probe delivery method
  await page.runtimeEvaluate(`window.scrollBy({top: 400, behavior: "smooth"})`);
  await new Promise((r) => setTimeout(r, 2000));
  await dumpStep(page, "08-delivery-method-area");

  // 9. Try clicking Auto-Save to Power BI
  console.log("\nClick Auto-Save to Power BI");
  const r6 = await clickByText(page, "Auto-Save to Power BI");
  console.log("  click result:", r6);
  await new Promise((r) => setTimeout(r, 3000));
  await dumpStep(page, "09-after-pick-delivery");

  // 10. Probe save button
  await new Promise((r) => setTimeout(r, 2000));
  await dumpStep(page, "10-pre-save");

  console.log("\n== ALL DUMPS WRITTEN to", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
