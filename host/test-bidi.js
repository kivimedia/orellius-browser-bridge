#!/usr/bin/env node
// Smoke test for host/bidi-driver.js against a user-launched Firefox.
//
// Usage:
//   1. Launch Firefox with: firefox --remote-debugging-port=9222 -P orellius
//   2. Open at least one tab (e.g. https://example.com)
//   3. Run: node host/test-bidi.js [url]
//
// The test connects, takes a screenshot, runs a JS evaluate, clicks the
// center of the viewport, reads console + network buffers, and reports
// pass/fail per step.

import { getBidiDriver } from "./bidi-driver.js";
import fs from "node:fs";
import path from "node:path";

const targetUrl = process.argv[2] || null;

async function main() {
  const driver = getBidiDriver({ port: 9222 });

  console.log("[1/6] Connecting to Firefox BiDi at 127.0.0.1:9222...");
  await driver.connect();
  console.log("    ✓ connected");

  console.log("[2/6] Resolving browsing context...");
  const ctx = await driver.resolveContext({ url: targetUrl });
  console.log(`    ✓ context = ${ctx}`);

  console.log("[3/6] Capturing screenshot...");
  const { base64 } = await driver.screenshot({ context: ctx });
  const outPath = path.join(process.cwd(), "bidi-test-shot.png");
  fs.writeFileSync(outPath, Buffer.from(base64, "base64"));
  console.log(`    ✓ saved ${outPath} (${base64.length} bytes b64)`);

  console.log("[4/6] Running script.evaluate (window.innerWidth)...");
  const dim = await driver.evaluate({
    context: ctx,
    expression: "window.innerWidth + 'x' + window.innerHeight",
  });
  console.log(`    ✓ viewport = ${dim?.value}`);

  console.log("[5/6] Clicking at viewport center (just to verify trusted input)...");
  const [w, h] = (dim?.value || "1024x768").split("x").map(Number);
  await driver.click({ context: ctx, x: Math.floor(w / 2), y: Math.floor(h / 2) });
  console.log("    ✓ click dispatched");

  console.log("[6/6] Reading console + network buffers...");
  await new Promise((r) => setTimeout(r, 500));
  const console1 = driver.consoleByContext.get(ctx) || [];
  const network1 = driver.networkByContext.get(ctx) || [];
  console.log(`    ✓ ${console1.length} console messages, ${network1.length} network requests`);

  console.log("\n=== ALL CHECKS PASSED ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n=== TEST FAILED ===");
  console.error(err.message);
  console.error(err.stack);
  process.exit(1);
});
