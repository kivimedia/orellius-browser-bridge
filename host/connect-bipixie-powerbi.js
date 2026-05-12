#!/usr/bin/env node

// Drive the "Connect to Power BI" OAuth flow on /instrument.
// Handles popup window or same-window redirect, auto-accepts consent if shown.
// After connecting, dumps the post-connect /instrument DOM.

import fs from "node:fs";
import path from "node:path";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/connect-trace";
const SESSION_ID = "bipixie-walkthrough";
const MS_EMAIL = "test@datachant.com";
const MS_PASSWORD = "DataChant!";

const PROBE_JS = `
  (() => {
    const norm = s => (s || "").replace(/\\s+/g, " ").trim();
    const els = Array.from(document.querySelectorAll(
      'a, button, [role="button"], [role="link"], [role="combobox"], [role="textbox"], [role="checkbox"], [role="option"], input, select, textarea, h1, h2, h3, h4, label, [data-testid]'
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
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
    return { url: location.href, title: document.title, headings: Array.from(document.querySelectorAll("h1,h2,h3,h4")).filter(h=>h.getBoundingClientRect().width>0).map(h=>({level: h.tagName, text: norm(h.textContent).slice(0, 200)})), visible: out };
  })()
`;

async function dump(page, label) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  try {
    const d = await page.runtimeEvaluate(PROBE_JS);
    fs.writeFileSync(path.join(OUT_DIR, `${label}.json`), JSON.stringify(d, null, 2));
    const png = await page.send("Page.captureScreenshot", { format: "png" });
    if (png?.data) fs.writeFileSync(path.join(OUT_DIR, `${label}.png`), Buffer.from(png.data, "base64"));
    console.log(`  DUMP ${label}  (${d.visible.length} els, url=${d.url})`);
    return d;
  } catch (e) {
    console.log(`  DUMP ${label} FAILED: ${e.message}`);
    return null;
  }
}

async function tryClickInPage(page, predicate, label) {
  // predicate: JS string returning a boolean for matching el; clicks first hit
  return page.runtimeEvaluate(`
    (() => {
      const all = Array.from(document.querySelectorAll('a, button, [role=button], input[type=submit]'));
      const visible = all.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      const target = visible.find(el => ${predicate});
      if (!target) return { found: false };
      target.scrollIntoView({block:"center"});
      target.click();
      return { found: true, tag: target.tagName, text: (el => (el.textContent||el.value||"").trim().slice(0,80))(target) };
    })()
  `).then(r => { console.log(`  click ${label}:`, r); return r; });
}

async function waitForUrl(page, regex, { timeoutMs = 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const u = await page.runtimeEvaluate("location.href").catch(() => "");
    if (regex.test(u)) return u;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`URL did not match ${regex} within ${timeoutMs}ms`);
}

async function findOAuthPage(browser, originalTargetId, { timeoutMs = 15000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await browser.listPageTargets();
    const oauth = targets.find(t => t.targetId !== originalTargetId && /microsoftonline|powerbi\.com|live\.com/i.test(t.url || ""));
    if (oauth) return oauth;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function autoConsent(oauthPage) {
  // On consent screen, look for Accept/Yes/Allow/Continue/Submit etc.
  for (let i = 0; i < 10; i++) {
    const url = await oauthPage.runtimeEvaluate("location.href").catch(() => "");
    console.log(`  oauth url poll ${i}: ${url}`);
    if (/app\.bipixie\.com|\/instrument/i.test(url)) return true;
    // Find email input
    const hasEmail = await oauthPage.runtimeEvaluate(`!!document.querySelector('input[type=email], input[name=loginfmt]')`).catch(() => false);
    if (hasEmail) {
      console.log("  oauth: typing email");
      await oauthPage.runtimeEvaluate(`document.querySelector('input[type=email], input[name=loginfmt]').focus()`);
      await oauthPage.typeText(MS_EMAIL);
      await new Promise((r) => setTimeout(r, 300));
      await oauthPage.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const hasPw = await oauthPage.runtimeEvaluate(`(() => { const el = document.querySelector('input[type=password], input[name=passwd]'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width>0&&r.height>0; })()`).catch(() => false);
    if (hasPw) {
      console.log("  oauth: typing password");
      await oauthPage.runtimeEvaluate(`document.querySelector('input[type=password], input[name=passwd]').focus()`);
      await oauthPage.typeText(MS_PASSWORD);
      await new Promise((r) => setTimeout(r, 300));
      await oauthPage.runtimeEvaluate(`document.querySelector('input[type=submit], #idSIButton9, button[type=submit]')?.click()`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    // Stay-signed-in or Accept
    const r = await oauthPage.runtimeEvaluate(`
      (() => {
        const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button, input[type=submit], a'));
        const visible = buttons.filter(el => { const rr = el.getBoundingClientRect(); return rr.width > 0 && rr.height > 0; });
        // Priority order: Accept > Yes > Allow > Continue > Submit
        for (const phrase of ['accept', 'yes', 'allow', 'continue', 'submit', 'sign in', 'next']) {
          const t = visible.find(b => norm(b.textContent || b.value || "") === phrase || norm(b.textContent || b.value || "") === phrase + ' >>>>') ;
          if (t) { t.click(); return { hit: phrase }; }
        }
        // partial match
        for (const phrase of ['accept', 'yes, allow', 'allow access', 'consent']) {
          const t = visible.find(b => norm(b.textContent || b.value || "").includes(phrase));
          if (t) { t.click(); return { hit: 'partial:' + phrase }; }
        }
        return { hit: null, available: visible.slice(0,10).map(b => norm(b.textContent || b.value || "").slice(0,40)) };
      })()
    `).catch(() => ({ hit: null }));
    console.log("  oauth consent attempt:", r);
    await new Promise((r) => setTimeout(r, 2500));
  }
  return false;
}

async function main() {
  const chrome = await launchIsolatedChrome({ width: 1920, height: 1080, sessionId: SESSION_ID });
  const browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  const targets0 = await browser.listPageTargets();
  const page = targets0.length > 0 ? await browser.attachToTarget(targets0[0].targetId) : await browser.createPageSession("about:blank");
  const mainTargetId = targets0.length > 0 ? targets0[0].targetId : null;

  await page.navigate("https://app.bipixie.com/instrument");
  await new Promise((r) => setTimeout(r, 6000));
  await dump(page, "01-pre-connect");

  // Click Connect to Power BI
  const click = await page.runtimeEvaluate(`
    (() => {
      const norm = s => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('button, a'));
      const target = all.find(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return norm(el.textContent) === 'connect to power bi';
      });
      if (!target) return { found: false };
      target.scrollIntoView({block:"center"});
      target.click();
      return { found: true, tag: target.tagName };
    })()
  `);
  console.log("Connect click:", click);
  if (!click.found) { console.log("ALREADY CONNECTED?"); await dump(page, "01b-already-connected"); await browser.close(); chrome.cleanup(); return; }

  // Either same-window redirect, or popup. Wait 4s, check.
  await new Promise((r) => setTimeout(r, 4000));

  // Check main page URL
  let url = await page.runtimeEvaluate("location.href").catch(() => "");
  console.log(`After Connect click, main page url: ${url}`);

  let oauthPage = null;
  if (/microsoftonline|login\.live|powerbi\.com\/oauth/i.test(url)) {
    console.log("OAuth happened in same window");
    oauthPage = page;
  } else {
    const popup = await findOAuthPage(browser, mainTargetId);
    if (popup) {
      console.log(`OAuth popup found: ${popup.url}`);
      oauthPage = await browser.attachToTarget(popup.targetId);
    }
  }

  if (oauthPage) {
    await dump(oauthPage, "02-oauth-page-initial");
    const ok = await autoConsent(oauthPage);
    console.log(`autoConsent returned: ${ok}`);
    await dump(oauthPage, "03-oauth-after-consent");
  } else {
    console.log("No OAuth page detected - maybe instant connect?");
  }

  // Wait for main page (page) to be back at /instrument with connected state
  await new Promise((r) => setTimeout(r, 5000));
  try { await page.send("Page.bringToFront"); } catch {}
  await new Promise((r) => setTimeout(r, 2000));
  await dump(page, "04-instrument-after-connect");

  // Final probe: is there a Select Workspace heading visible now?
  const verify = await page.runtimeEvaluate(`
    (() => {
      const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,label"));
      const visible = headings.filter(h => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      return visible.map(h => ({ level: h.tagName, text: (h.textContent||"").trim().slice(0,80) })).slice(0,30);
    })()
  `);
  console.log("Final headings on /instrument:", JSON.stringify(verify, null, 2));

  console.log("\n== ALL DUMPS WRITTEN to", OUT_DIR);
  await browser.close();
  chrome.cleanup();
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
