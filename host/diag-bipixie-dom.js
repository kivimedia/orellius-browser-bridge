#!/usr/bin/env node
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const chrome = await launchIsolatedChrome({
  width: 1920,
  height: 1080,
  sessionId: "bipixie-walkthrough",
});
const browser = new CdpBrowser(chrome.browserWebSocketUrl);
await browser.connect();

const targets = await browser.listPageTargets();
const page = targets.length > 0
  ? await browser.attachToTarget(targets[0].targetId)
  : await browser.createPageSession("about:blank");

await page.navigate("https://app.bipixie.com/managed");
await new Promise((r) => setTimeout(r, 4500));
try { await page.send("Page.bringToFront"); } catch {}
await new Promise((r) => setTimeout(r, 800));

const url = await page.runtimeEvaluate("location.href");
console.log("URL:", url);
const vis = await page.runtimeEvaluate("document.visibilityState");
console.log("vis:", vis);

const dump = await page.runtimeEvaluate(`
  (() => {
    const targets = ['Overview','Managed Reports','Tracking Setup','Data Management','Team','Plan','Account','Add Pixies','Update Pixies','Check for events'];
    const out = { byTarget: {} };
    const all = Array.from(document.querySelectorAll('*')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.offsetParent !== null;
    });
    for (const t of targets) {
      const lc = t.toLowerCase();
      const matches = all.filter(el => {
        const txt = (el.textContent || '').replace(/\\s+/g,' ').trim().toLowerCase();
        return txt === lc || (txt.length < lc.length + 30 && txt.includes(lc));
      });
      out.byTarget[t] = matches.slice(0, 5).map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        classes: (el.className || '').toString().slice(0, 80),
        ariaLabel: el.getAttribute('aria-label'),
        textLen: (el.textContent || '').length,
        textHead: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 60),
        rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
      }));
    }
    out.allClickable = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"]'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .map(el => ({
        tag: el.tagName,
        role: el.getAttribute('role'),
        text: (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 50),
        classes: (el.className || '').toString().slice(0, 60),
      }))
      .filter(x => x.text);
    return out;
  })()
`);

console.log("\n=== matches by target ===");
for (const [t, list] of Object.entries(dump.byTarget)) {
  console.log("\n>>> " + JSON.stringify(t) + " (" + list.length + " candidates)");
  for (const m of list) {
    const role = m.role ? "[role=" + m.role + "]" : "";
    console.log("  " + m.tag + role + "  " + m.rect.join("x") + "  text(" + m.textLen + ")=" + JSON.stringify(m.textHead));
    if (m.classes) console.log("    ." + m.classes);
  }
}

console.log("\n=== all clickables ===");
for (const c of dump.allClickable.slice(0, 60)) {
  const role = c.role ? "[role=" + c.role + "]" : "";
  console.log("  " + c.tag + role + "  " + JSON.stringify(c.text));
}

await browser.close();
chrome.cleanup();
