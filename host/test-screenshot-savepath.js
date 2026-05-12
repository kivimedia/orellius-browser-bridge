#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const TAB_ID = 1820266597;
const TEST_PATH = "C:/Users/raviv/datachant/bipixie-walkthrough/output/test-rapid-shot.jpg";

async function main() {
  if (fs.existsSync(TEST_PATH)) fs.unlinkSync(TEST_PATH);
  const transport = new StdioClientTransport({
    command: "node",
    args: ["mcp-server.js"],
    cwd: "E:/FromC/projects/orellius-browser-bridge/host",
  });
  const client = new Client({ name: "test", version: "1.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log("connected");

  const r = await client.callTool({
    name: "computer",
    arguments: { action: "screenshot", tabId: TAB_ID, savePath: TEST_PATH },
  });
  console.log("Tool returned:", JSON.stringify(r).slice(0, 500));

  await new Promise((r) => setTimeout(r, 1000));
  if (fs.existsSync(TEST_PATH)) {
    const stat = fs.statSync(TEST_PATH);
    console.log(`SUCCESS: file exists, ${stat.size} bytes`);
  } else {
    console.log(`FAIL: file does not exist at ${TEST_PATH}`);
  }
  await client.close();
}
main().catch((e) => { console.error("FAILED:", e.stack || e.message); process.exit(1); });
