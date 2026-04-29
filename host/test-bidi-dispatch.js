#!/usr/bin/env node
// Extended BiDi smoke test: exercises the dispatch(tool, args) entry point
// that mcp-server.js calls. This covers the full Firefox-mode tool path
// without needing a live mcp-server instance.

import { getBidiDriver } from "./bidi-driver.js";

const TEST_URL = process.argv[2] || "https://example.com/";

async function main() {
  const driver = getBidiDriver({ port: 9222 });

  console.log("[1/7] Connect");
  await driver.connect();
  console.log("    OK");

  console.log("[2/7] Resolve a browsing context");
  const ctx = await driver.resolveContext({});
  console.log(`    context = ${ctx}`);

  // Navigate the resolved context to a known URL so the rest of the tests
  // have a deterministic page to work against.
  console.log(`[3/7] Navigate context to ${TEST_URL}`);
  await driver._send("browsingContext.navigate", { context: ctx, url: TEST_URL, wait: "complete" });
  console.log("    OK");

  // Wait for any post-load network/console activity to flush into our buffers.
  await new Promise((r) => setTimeout(r, 800));

  console.log("[4/7] dispatch('computer', {action:'screenshot'})");
  const shot = await driver.dispatch("computer", { action: "screenshot", bidiContext: ctx });
  const hasImage = shot?.content?.some((p) => p.type === "image");
  console.log(`    text: ${shot?.content?.[0]?.text?.slice(0, 80)}`);
  console.log(`    image: ${hasImage ? "yes" : "MISSING"}`);
  if (!hasImage) throw new Error("screenshot dispatch returned no image part");

  console.log("[5/7] dispatch('javascript_tool', {text:'2+2'})");
  const js = await driver.dispatch("javascript_tool", { text: "2+2", bidiContext: ctx });
  const jsText = js?.content?.[0]?.text;
  console.log(`    result: ${jsText}`);
  if (jsText !== "4") throw new Error(`expected '4', got ${JSON.stringify(jsText)}`);

  console.log("[6/7] dispatch('read_network_requests') (should have entries from navigation)");
  const net = await driver.dispatch("read_network_requests", { bidiContext: ctx, limit: 5 });
  console.log(`    ${net?.content?.[0]?.text?.split("\n")[0]}`);

  console.log("[7/7] dispatch('computer', {action:'left_click', coordinate:[100,100]})");
  const click = await driver.dispatch("computer", {
    action: "left_click",
    coordinate: [100, 100],
    bidiContext: ctx,
  });
  console.log(`    ${click?.content?.[0]?.text}`);

  console.log("\n=== ALL DISPATCH CHECKS PASSED ===");
}

async function shutdown() {
  const { getBidiDriver } = await import("./bidi-driver.js");
  try { await getBidiDriver({ port: 9222 }).close(); } catch {}
}

main().then(async () => { await shutdown(); process.exit(0); })
      .catch(async (err) => {
        console.error("\n=== TEST FAILED ===");
        console.error(err.message);
        if (err.stack) console.error(err.stack);
        await shutdown();
        process.exit(1);
      });
