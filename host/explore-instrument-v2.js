#!/usr/bin/env node

// End-to-end wizard discovery: connect, dump every workspace/report/delivery option.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/wizard-walk";
const SESSION_ID = "bipixie-walkthrough";

const DUMP_JS = `
  (() => {
    const norm = s => (s || "").replace(/\\s+/g, " ").trim();
    const els = Array.from(document.querySelectorAll('a, button, [role=combobox], [role=option], [role=button], [role=listbox], [role=checkbox], [role=radio], input, select, label, h1, h2, h3, h4'));
    const visible = els.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    });
    return visible.map(el => ({
      tag: el.tagName.toLowerCase(),
      type: el.type || "",
      role: el.getAttribute("role") || "",
      text: norm(el.textContent || el.value || "").slice(0, 100),
      placeholder: el.getAttribute("placeholder") || "",
      checked: typeof el.checked === "boolean" ? el.checked : null,
      rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
    }));
  })()
`;

async function snap(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const els = await page.runtimeEvaluate(DUMP_JS).catch(() => []);
  fs.writeFileSync(path.join(OUT_DIR, `${label}.json`), JSON.stringify(els, null, 2));
  const png = await page.send("Page.captureScreenshot", { format: "png" });
  if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
  const url = await page.runtimeEvaluate("location.href").catch(() => "");
  console.log(`  SNAP ${label}  els=${els.length} url=${url}`);
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets = await browser.listPageTargets();
  const page = targets.length > 0 ? await browser.attachToTarget(targets[0].targetId) : await browser.createPageSession("about:blank");

  await page.navigate("https://app.bipixie.com/instrument");
  await new Promise((r) => setTimeout(r, 6000));
  await snap(page, "01-pre-connect");

  // Click Connect
  await page.runtimeEvaluate(`Array.from(document.querySelectorAll('button')).find(b => /connect to power bi/i.test((b.textContent||"").trim()))?.click()`);
  console.log("  clicked Connect");

  // Wait for workspace picker (poll up to 20s)
  for (let i = 0; i < 40; i++) {
    const has5 = await page.runtimeEvaluate(`/5 workspaces/i.test(document.body.textContent||"")`).catch(() => false);
    if (has5) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await snap(page, "02-after-connect");

  // Click chevron (rightmost button in workspace card)
  await page.runtimeEvaluate(`
    (() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const chevron = buttons.find(b => {
        const r = b.getBoundingClientRect();
        return r.width > 30 && r.width < 60 && r.height > 30 && r.height < 60 && r.x > 1400;
      });
      if (chevron) chevron.click();
      return !!chevron;
    })()
  `);
  await new Promise((r) => setTimeout(r, 2000));
  await snap(page, "03-after-chevron");

  // Focus input + type space to surface options
  await page.runtimeEvaluate(`document.querySelector('input[placeholder*="workspace" i]')?.focus()`);
  await page.typeText(" ");
  await new Promise((r) => setTimeout(r, 1500));
  await snap(page, "04-after-space");

  // Backspace
  await page.runtimeEvaluate(`
    const inp = document.querySelector('input[placeholder*="workspace" i]');
    if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input",{bubbles:true})); inp.focus(); }
  `);
  await new Promise((r) => setTimeout(r, 1500));
  await snap(page, "05-cleared");

  // Try arrow-down + enter to surface options
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" });
  await new Promise((r) => setTimeout(r, 600));
  await snap(page, "06-arrow-down");

  // List role=option elements
  const opts = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const all = Array.from(document.querySelectorAll('[role=option], li, button'));
      const visible = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 0 && r.y > 200; });
      return visible.slice(0, 30).map(el => ({ tag: el.tagName, role: el.getAttribute("role"), text: norm(el.textContent).slice(0,100), y: Math.round(el.getBoundingClientRect().y) }));
    })()
  `);
  console.log("Visible options after arrow:", JSON.stringify(opts, null, 2));

  // Pick first role=option, fall back to first dropdown-ish element
  const pickRes = await page.runtimeEvaluate(`
    (() => {
      const opts = Array.from(document.querySelectorAll('[role=option]'));
      const visible = opts.filter(o => { const r = o.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (visible.length > 0) { visible[0].click(); return { hit: "option", text: visible[0].textContent.trim().slice(0,80), count: visible.length }; }
      return { hit: null };
    })()
  `);
  console.log("Pick first:", pickRes);
  await new Promise((r) => setTimeout(r, 5000));
  await snap(page, "07-after-pick-workspace");

  // Now check for report checkboxes
  const reports = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      return cbs.map(cb => {
        const lbl = cb.closest('label') || cb.parentElement;
        const wrap = lbl ? lbl.parentElement : null;
        const text = wrap ? norm(wrap.textContent).slice(0, 120) : (lbl ? norm(lbl.textContent).slice(0,120) : "");
        const r = cb.getBoundingClientRect();
        return { checked: cb.checked, text, y: Math.round(r.y), visible: r.width > 0 || (lbl && lbl.getBoundingClientRect().width > 0) };
      });
    })()
  `);
  console.log("\nReports:", JSON.stringify(reports, null, 2));

  // Tick first unchecked checkbox
  const tickRes = await page.runtimeEvaluate(`
    (() => {
      const cbs = Array.from(document.querySelectorAll('input[type=checkbox]'));
      const target = cbs.find(c => !c.checked);
      if (target) { target.click(); const lbl = target.closest('label') || target.parentElement?.parentElement; return { hit: true, text: lbl ? lbl.textContent.trim().slice(0,80) : "" }; }
      return { hit: false };
    })()
  `);
  console.log("Tick first report:", tickRes);
  await new Promise((r) => setTimeout(r, 2500));
  await snap(page, "08-after-tick");

  // Scroll down + dump
  await page.runtimeEvaluate(`window.scrollTo({top: document.body.scrollHeight, behavior: "smooth"})`);
  await new Promise((r) => setTimeout(r, 2500));
  await snap(page, "09-bottom");

  // Probe save button + radios
  const probe = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim();
      const saves = Array.from(document.querySelectorAll('button')).filter(b => /save/i.test((b.textContent||"").trim()) && b.getBoundingClientRect().width > 0).map(b => ({ text: norm(b.textContent).slice(0,80), rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })() }));
      const radios = Array.from(document.querySelectorAll('input[type=radio]')).map(r => {
        const lbl = r.closest('label') || r.parentElement;
        return { checked: r.checked, text: lbl ? norm(lbl.textContent).slice(0,100) : "" };
      });
      return { saves, radios };
    })()
  `);
  console.log("\nProbe:", JSON.stringify(probe, null, 2));

  console.log("\n== DONE", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
