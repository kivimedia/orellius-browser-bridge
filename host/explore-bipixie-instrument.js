#!/usr/bin/env node

// Walk the connected /instrument wizard end-to-end.
// Discover workspace names, report names, delivery method options, save button.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/instrument-trace";
const SESSION_ID = "bipixie-walkthrough";

const PROBE_JS = `
  (() => {
    const norm = s => (s || "").replace(/\\s+/g, " ").trim();
    const els = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], [role="combobox"], [role="textbox"], [role="checkbox"], [role="radio"], [role="option"], [role="listbox"], input, select, textarea, h1, h2, h3, h4, label, [data-testid]'
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
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    return { url: location.href, title: document.title, visible: out };
  })()
`;

async function dump(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = await page.runtimeEvaluate(PROBE_JS);
  fs.writeFileSync(path.join(OUT_DIR, `${label}.json`), JSON.stringify(d, null, 2));
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  console.log(`  DUMP ${label}  (${d.visible.length} els)`);
  return d;
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  await page.navigate("https://app.bipixie.com/instrument");
  await new Promise((r) => setTimeout(r, 6000));
  await dump(page, "01-instrument-landing");

  // Click the workspace input/combobox (or its chevron) to open dropdown
  const r1 = await page.runtimeEvaluate(`
    (() => {
      const input = document.querySelector('input[role=combobox], input[placeholder*="workspace" i]');
      if (input) {
        input.focus();
        input.click();
        return { tag: "INPUT", placeholder: input.placeholder };
      }
      return { found: false };
    })()
  `);
  console.log("Click workspace input:", r1);
  await new Promise((r) => setTimeout(r, 2000));
  await dump(page, "02-workspace-input-focused");

  // Try to open dropdown by clicking the chevron (svg next to input)
  await page.runtimeEvaluate(`
    (() => {
      const buttons = document.querySelectorAll('button');
      for (const b of buttons) {
        const r = b.getBoundingClientRect();
        if (r.width > 30 && r.width < 60 && r.x > 1400) { b.click(); return true; }
      }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 2000));
  await dump(page, "03-after-chevron-click");

  // Type a single space to reveal all 5 workspaces in suggestions
  await page.runtimeEvaluate(`
    const i = document.querySelector('input[role=combobox], input[placeholder*="workspace" i]');
    if (i) { i.focus(); }
  `);
  await page.typeText(" ");
  await new Promise((r) => setTimeout(r, 2000));
  await dump(page, "04-after-type-space");

  // Backspace and dump available options
  await page.runtimeEvaluate(`
    const i = document.querySelector('input[role=combobox], input[placeholder*="workspace" i]');
    if (i) { i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); i.focus(); }
  `);
  await new Promise((r) => setTimeout(r, 1500));

  // Look for any list/option element on the page now
  const opts = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      // Anything that has role=option or is in a [role=listbox], or li in a dropdown panel
      const all = Array.from(document.querySelectorAll('[role=option], [role=listbox] *, ul li, [class*="option" i], [class*="dropdown" i] *, [class*="menu" i] *'));
      const seen = new Set();
      const out = [];
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const t = norm(el.textContent).slice(0, 120);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push({ tag: el.tagName, role: el.getAttribute("role"), text: t, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) } });
      }
      return out.slice(0, 30);
    })()
  `);
  console.log("Visible options after focus:", JSON.stringify(opts, null, 2));

  // Pick first option
  const r2 = await page.runtimeEvaluate(`
    (() => {
      const opts = Array.from(document.querySelectorAll('[role=option]'));
      const visible = opts.filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (visible.length === 0) return { found: false, count: opts.length };
      const t = visible[0]; t.click();
      return { found: true, text: t.textContent.trim().slice(0,80), totalVisible: visible.length };
    })()
  `);
  console.log("Pick first workspace:", r2);
  await new Promise((r) => setTimeout(r, 5000));
  await dump(page, "05-after-pick-workspace");

  // Now look for report checkboxes
  const reports = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      const visibleCbs = cbs.filter(c => { const r = c.getBoundingClientRect(); return r.width > 0 || c.parentElement?.getBoundingClientRect().width > 0; });
      const out = visibleCbs.map(cb => {
        const lbl = cb.closest("label") || cb.parentElement;
        const text = lbl ? norm(lbl.textContent).slice(0, 120) : "";
        return { checked: cb.checked, text };
      });
      return out;
    })()
  `);
  console.log("Report checkboxes:", JSON.stringify(reports, null, 2));

  // Tick the first available report (if any)
  await page.runtimeEvaluate(`
    (() => {
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      const visible = cbs.filter(c => !c.checked);
      if (visible.length > 0) { visible[0].click(); return true; }
      return false;
    })()
  `);
  await new Promise((r) => setTimeout(r, 2500));
  await dump(page, "06-after-tick-first-report");

  // Scroll to find delivery method and Save button
  await page.runtimeEvaluate(`window.scrollTo({top: document.body.scrollHeight, behavior: "smooth"})`);
  await new Promise((r) => setTimeout(r, 2500));
  await dump(page, "07-scrolled-to-bottom");

  // Probe Save button
  const saveProbe = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const all = Array.from(document.querySelectorAll('button, a'));
      return all.filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && /save/i.test(norm(el.textContent));
      }).slice(0, 5).map(el => ({ tag: el.tagName, text: norm(el.textContent).slice(0,80), rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() }));
    })()
  `);
  console.log("Save button candidates:", JSON.stringify(saveProbe, null, 2));

  // Probe delivery radios
  const radios = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const radios = Array.from(document.querySelectorAll('input[type=radio]'));
      return radios.filter(r => { const rr = r.getBoundingClientRect(); return rr.width > 0 || r.parentElement?.getBoundingClientRect().width > 0; }).map(r => ({
        checked: r.checked,
        labelText: (() => { const l = r.closest("label") || r.parentElement; return l ? norm(l.textContent).slice(0,100) : ""; })(),
      }));
    })()
  `);
  console.log("Delivery radios:", JSON.stringify(radios, null, 2));

  console.log("\n== ALL DUMPS WRITTEN to", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
