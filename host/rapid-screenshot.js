#!/usr/bin/env node

// Rapid-fire screenshot capture via Orellius MCP stdio.
// Spawns mcp-server.js, takes N screenshots at I ms intervals, optionally
// triggers a click partway through.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const TAB_ID = 1820266597;
const OUT_DIR = "C:/Users/raviv/datachant/bipixie-walkthrough/output/scene-11-frames";
const HOST_DIR = "E:/FromC/projects/orellius-browser-bridge/host";

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Clean prior frames
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith(".jpg") || f.endsWith(".png")) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-server.js"],
    cwd: HOST_DIR,
  });

  const client = new Client({ name: "rapid-screenshot", version: "1.0" }, { capabilities: {} });
  await client.connect(transport);

  console.log("MCP connected");

  // Reset state: click Bookmark 1 first
  console.log("Reset to Bookmark 1...");
  await client.callTool({ name: "computer", arguments: { action: "left_click", tabId: TAB_ID, coordinate: [336, 220] } });
  await new Promise((r) => setTimeout(r, 3000));

  console.log("Starting capture loop...");
  const totalFrames = 30;
  const intervalMs = 200;
  const clickAtFrame = 6; // Click Bookmark 3 after the 6th frame (~1.2s in)
  const startWall = Date.now();

  for (let i = 0; i < totalFrames; i++) {
    const t0 = Date.now();
    if (i === clickAtFrame) {
      // Fire click without awaiting — let it happen during the next screenshot
      console.log(`  frame ${i}: clicking Bookmark 3`);
      client.callTool({ name: "computer", arguments: { action: "left_click", tabId: TAB_ID, coordinate: [336, 465] } }).catch(() => {});
    }
    const filePath = path.join(OUT_DIR, `f${String(i).padStart(4, "0")}.jpg`);
    try {
      const r = await client.callTool({
        name: "computer",
        arguments: { action: "screenshot", tabId: TAB_ID, savePath: filePath },
      });
      const elapsed = Date.now() - t0;
      console.log(`  frame ${i}: ${elapsed}ms (${(Date.now() - startWall) / 1000}s into capture)`);
    } catch (e) {
      console.log(`  frame ${i} FAILED: ${e.message}`);
    }
    const remain = intervalMs - (Date.now() - t0);
    if (remain > 0) await new Promise((r) => setTimeout(r, remain));
  }

  await client.close();
  console.log("\n== DONE ==");
}

main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
