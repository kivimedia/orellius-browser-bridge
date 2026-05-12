#!/usr/bin/env node

// Click the Add Pixies <a> anchor (not the DIV wrapper) and follow where it goes.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/wizard-probe-3";
const SESSION_ID = "bipixie-walkthrough";

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
      out.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || "",
        text: norm(el.textContent || el.value || "").slice(0, 140),
        role: el.getAttribute("role") || "",
        aria: el.getAttribute("aria-label") || "",
        placeholder: el.getAttribute("placeholder") || "",
        id: el.id || "",
        dataTestid: el.getAttribute("data-testid") || "",
        href: el.getAttribute("href") || "",
        name: el.getAttribute("name") || "",
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    return { url: location.href, title: document.title, headings: Array.from(document.querySelectorAll("h1,h2,h3,h4")).filter(h=>h.getBoundingClientRect().width>0).map(h=>({level: h.tagName, text: norm(h.textContent).slice(0, 200)})), visible: out };
  })()
`;

async function dump(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = await page.runtimeEvaluate(PROBE_JS);
  fs.writeFileSync(path.join(OUT_DIR, `${label}.json`), JSON.stringify(d, null, 2));
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  console.log(`  DUMP ${label}  (${d.visible.length} els, url=${d.url})`);
  return d;
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  // 1. Land on /overview
  await page.navigate("https://app.bipixie.com/overview");
  await new Promise((r) => setTimeout(r, 5000));
  await dump(page, "01-overview");

  // 2. Find the Add Pixies <a> anchor and report its href
  const info = await page.runtimeEvaluate(`
    (() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      const targets = anchors.filter(a => /add pixies/i.test((a.textContent||"").trim()));
      return targets.map(a => ({
        text: a.textContent.trim(),
        href: a.getAttribute('href'),
        outerHTML: a.outerHTML.slice(0, 400),
        rect: (() => { const r = a.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      }));
    })()
  `);
  console.log("Add Pixies anchors found:", JSON.stringify(info, null, 2));

  // 3. Click the FIRST visible Add Pixies anchor and observe URL
  const clickRes = await page.runtimeEvaluate(`
    (() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      const target = anchors.find(a => {
        if (!/add pixies/i.test((a.textContent||"").trim())) return false;
        const r = a.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!target) return { ok: false };
      const beforeUrl = location.href;
      target.scrollIntoView({block:"center"});
      target.click();
      return { ok: true, beforeUrl, href: target.getAttribute('href') };
    })()
  `);
  console.log("Click result:", clickRes);
  await new Promise((r) => setTimeout(r, 6000));
  const newUrl = await page.runtimeEvaluate("location.href");
  console.log(`After-click URL: ${newUrl}`);
  await dump(page, "02-after-anchor-click");

  // 4. Now we should be on the wizard. Probe Select Workspace area.
  console.log("\nProbe Select Workspace combobox");
  const wsResult = await page.runtimeEvaluate(`
    (() => {
      // Find a heading "Select Workspace"
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,label"));
      const head = headings.find(h => /select workspace/i.test((h.textContent||"").trim()));
      if (!head) return { found: false, headings: headings.slice(0,40).map(h=>h.textContent.trim().slice(0,80)) };
      // Find nearest combobox/input below it
      const all = Array.from(document.querySelectorAll('input, [role=combobox], [role=button], button'));
      const below = all.filter(el => {
        const r = el.getBoundingClientRect();
        const hr = head.getBoundingClientRect();
        return r.top > hr.top && r.top < hr.top + 200 && r.width > 100;
      });
      if (below.length === 0) return { found: true, head: head.textContent.trim(), below: [] };
      const target = below[0];
      target.scrollIntoView({block:"center"});
      target.focus();
      target.click();
      return { found: true, head: head.textContent.trim(), targetTag: target.tagName, role: target.getAttribute("role"), placeholder: target.getAttribute("placeholder") };
    })()
  `);
  console.log("workspace probe:", wsResult);
  await new Promise((r) => setTimeout(r, 2500));
  await dump(page, "03-workspace-clicked");

  await page.typeText("Marketing");
  await new Promise((r) => setTimeout(r, 2500));
  await dump(page, "04-after-type-marketing");

  // 5. List options that appeared
  const optsRes = await page.runtimeEvaluate(`
    (() => {
      const els = Array.from(document.querySelectorAll('[role=option], li, button, div'));
      return els.filter(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const t = (el.textContent||"").trim();
        return /marketing/i.test(t) && t.length < 60;
      }).map(el => ({ tag: el.tagName, role: el.getAttribute("role"), text: el.textContent.trim().slice(0,80), classes: (el.className||"").slice(0,80) })).slice(0, 10);
    })()
  `);
  console.log("matching options:", JSON.stringify(optsRes, null, 2));

  console.log("\n== ALL DUMPS WRITTEN to", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
