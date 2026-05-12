#!/usr/bin/env node

// Smoke test for the isolated Chrome path.
// Launches its own Chrome, navigates, screenshots, clicks, types,
// records a short video, and tears down. Prints PASS/FAIL per step.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

function step(name, fn) {
  return (async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      console.log(`PASS  ${name}  (${Date.now() - t0}ms)${result ? "  " + result : ""}`);
      return result;
    } catch (e) {
      console.log(`FAIL  ${name}  (${Date.now() - t0}ms)  ${e.message}`);
      throw e;
    }
  })();
}

async function main() {
  const outDir = path.join(os.tmpdir(), "orellius-iso-smoke-" + Date.now().toString(36));
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`output dir: ${outDir}`);

  let chrome, browser, page;

  await step("launch chrome", async () => {
    chrome = await launchIsolatedChrome({ width: 1280, height: 720 });
    return `pid=${chrome.pid} port=${chrome.port}`;
  });

  await step("connect CDP", async () => {
    browser = new CdpBrowser(chrome.browserWebSocketUrl);
    await browser.connect();
  });

  await step("create page session", async () => {
    page = await browser.createPageSession("about:blank");
    return `targetId=${page.targetId.slice(0, 8)}`;
  });

  await step("navigate to example.com", async () => {
    await page.navigate("https://example.com");
  });

  await step("screenshot", async () => {
    const buf = await page.screenshot({ format: "jpeg", quality: 80 });
    const fp = path.join(outDir, "example.jpg");
    fs.writeFileSync(fp, buf);
    return `${buf.length} bytes -> ${fp}`;
  });

  await step("evaluate page title", async () => {
    const title = await page.runtimeEvaluate("document.title");
    if (!title || !/Example/i.test(title)) throw new Error(`unexpected title: ${title}`);
    return `title="${title}"`;
  });

  await step("click + read scroll position", async () => {
    await page.click({ x: 300, y: 200 });
    const pos = await page.runtimeEvaluate("JSON.stringify({x: window.scrollX, y: window.scrollY})");
    return pos;
  });

  await step("type into a contenteditable", async () => {
    // Create the input, focus it, place a selection inside, then exercise Input.insertText.
    await page.runtimeEvaluate(
      `(() => {
        const el = document.createElement('div');
        el.id = '__ot_input__';
        el.contentEditable = 'true';
        Object.assign(el.style, {position:'fixed',top:'10px',left:'10px',width:'400px',background:'yellow',padding:'8px',zIndex:99999});
        document.body.appendChild(el);
        el.focus();
        const sel = window.getSelection();
        sel.removeAllRanges();
        const r = document.createRange();
        r.setStart(el, 0);
        r.setEnd(el, 0);
        sel.addRange(r);
        return true;
      })()`
    );
    await page.typeText("hello orellius isolated");
    const got = await page.runtimeEvaluate("document.getElementById('__ot_input__').textContent");
    if (!got.includes("hello orellius isolated")) throw new Error(`typed text not visible: ${got}`);
    return `got="${got}"`;
  });

  await step("record 5s video", async () => {
    const tmpFrames = path.join(outDir, "frames");
    fs.mkdirSync(tmpFrames, { recursive: true });
    let idx = 0;
    const timing = [];
    const off = page.on("Page.screencastFrame", async (params) => {
      const fp = path.join(tmpFrames, `f${String(idx++).padStart(6, "0")}.jpg`);
      try {
        fs.writeFileSync(fp, Buffer.from(params.data, "base64"));
        timing.push(params.metadata?.timestamp || Date.now() / 1000);
      } catch {}
      try { await page.ackScreencastFrame(params.sessionId); } catch {}
    });
    // Force visible motion: oscillate background color via RAF in the page so dedup catches changes.
    await page.runtimeEvaluate(`
      (() => {
        if (window.__smokeRaf) cancelAnimationFrame(window.__smokeRaf);
        let t = 0;
        const tick = () => {
          t += 0.05;
          document.body.style.background = 'hsl(' + ((t * 60) % 360) + ', 70%, 90%)';
          window.__smokeRaf = requestAnimationFrame(tick);
        };
        tick();
        return true;
      })()
    `);
    await page.startScreencast({ format: "jpeg", quality: 80, maxWidth: 1280, maxHeight: 720, everyNthFrame: 2 });
    await new Promise((r) => setTimeout(r, 5000));
    await page.stopScreencast();
    off();
    if (idx === 0) throw new Error("0 frames captured — capture pipeline broken");

    // Build concat + ffmpeg
    const concat = ["ffconcat version 1.0"];
    const files = fs.readdirSync(tmpFrames).filter((f) => f.endsWith(".jpg")).sort();
    for (let i = 0; i < files.length; i++) {
      concat.push(`file '${path.join(tmpFrames, files[i]).replace(/\\/g, "/")}'`);
      const next = i + 1 < timing.length ? timing[i + 1] : timing[i] + 1 / 15;
      const dur = Math.max(0.03, Math.min(2.0, next - timing[i]));
      concat.push(`duration ${dur.toFixed(3)}`);
    }
    concat.push(`file '${path.join(tmpFrames, files[files.length - 1]).replace(/\\/g, "/")}'`);
    const concatPath = path.join(outDir, "concat.txt");
    fs.writeFileSync(concatPath, concat.join("\n"));
    const mp4 = path.join(outDir, "smoke.mp4");
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "22",
        mp4,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      ff.stderr.on("data", (c) => (err += c.toString()));
      ff.on("error", reject);
      ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}\n${err.slice(-2000)}`))));
    });
    const stat = fs.statSync(mp4);
    return `${idx} frames -> ${mp4} (${(stat.size / 1024).toFixed(1)} KiB)`;
  });

  await step("teardown", async () => {
    try { await browser.close(); } catch {}
    chrome.cleanup();
  });

  console.log(`\nALL DONE. Inspect output at ${outDir}`);
}

main().catch((e) => {
  console.error("\nSMOKE FAILED:", e.stack || e.message);
  process.exit(1);
});
