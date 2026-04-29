#!/usr/bin/env node
// Unit test for hub.js multi-browser routing.
//
// Spawns a fresh hub on an isolated port, attaches two fake native_hosts
// (chromium + firefox) and one fake MCP client, and verifies that a
// tool_request with browser:"firefox" reaches the firefox native_host
// (and not the chromium one), and vice versa.

import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HUB_PATH = path.join(__dirname, "hub.js");
const PORT = 19999;

function logOk(name) { console.log(`  PASS: ${name}`); }
function fail(name, msg) { console.error(`  FAIL: ${name} - ${msg}`); process.exit(1); }

function readNdjson(socket, callback) {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    let i;
    while ((i = buf.indexOf(10)) !== -1) {
      const line = buf.subarray(0, i).toString("utf-8").trim();
      buf = buf.subarray(i + 1);
      if (!line) continue;
      try { callback(JSON.parse(line)); } catch {}
    }
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = new net.Socket();
    s.connect(port, "127.0.0.1", () => resolve(s));
    s.on("error", reject);
  });
}

async function main() {
  // Spawn hub on an isolated port so the test doesn't collide with a real
  // hub or browser extensions running on the default port.
  console.log(`[setup] spawning hub on :${PORT}`);
  const hub = spawn(process.execPath, [HUB_PATH, `--port=${PORT}`], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  hub.stderr.on("data", (d) => process.stderr.write(`[hub] ${d}`));

  let attempts = 0;
  while (attempts < 30) {
    try {
      const s = await connect(PORT);
      s.destroy();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }
  }
  if (attempts >= 30) fail("hub-listen", `hub never became reachable on :${PORT}`);

  // --- Fake native hosts ---
  const chromiumHost = await connect(PORT);
  const firefoxHost = await connect(PORT);

  let chromiumGot = null;
  let firefoxGot = null;

  readNdjson(chromiumHost, (msg) => {
    if (msg.type === "registered") return;
    chromiumGot = msg;
  });
  readNdjson(firefoxHost, (msg) => {
    if (msg.type === "registered") return;
    firefoxGot = msg;
  });

  chromiumHost.write(JSON.stringify({ type: "register_native_host", browser: "chromium" }) + "\n");
  firefoxHost.write(JSON.stringify({ type: "register_native_host", browser: "firefox" }) + "\n");

  // Wait a moment for registrations to settle
  await new Promise((r) => setTimeout(r, 200));

  // --- Fake MCP client ---
  const mcp = await connect(PORT);
  let mcpInbox = [];
  readNdjson(mcp, (msg) => mcpInbox.push(msg));
  mcp.write(JSON.stringify({ type: "register_mcp_client", sessionId: "test-session-1" }) + "\n");
  await new Promise((r) => setTimeout(r, 100));

  // --- Test 1: tool_request with browser:firefox -> firefox host gets it ---
  mcp.write(JSON.stringify({
    id: "req-1",
    sessionId: "test-session-1",
    type: "tool_request",
    tool: "noop",
    args: {},
    browser: "firefox",
  }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  if (!firefoxGot) fail("route-firefox", "firefox host received nothing");
  if (firefoxGot.id !== "req-1") fail("route-firefox", `wrong id: ${firefoxGot.id}`);
  if (firefoxGot.browser !== "firefox") fail("route-firefox", `wrong browser: ${firefoxGot.browser}`);
  if (chromiumGot) fail("route-firefox", "chromium host received the firefox-targeted request");
  logOk("firefox-targeted request reaches firefox host only");

  // --- Test 2: tool_request with browser:chromium -> chromium host gets it ---
  firefoxGot = null; // clear
  mcp.write(JSON.stringify({
    id: "req-2",
    sessionId: "test-session-1",
    type: "tool_request",
    tool: "noop",
    args: {},
    browser: "chromium",
  }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  if (!chromiumGot) fail("route-chromium", "chromium host received nothing");
  if (chromiumGot.id !== "req-2") fail("route-chromium", `wrong id: ${chromiumGot.id}`);
  if (firefoxGot) fail("route-chromium", "firefox host received the chromium-targeted request");
  logOk("chromium-targeted request reaches chromium host only");

  // --- Test 3: response with sessionId routes back to the right MCP client ---
  // Firefox host returns a response for req-1
  firefoxHost.write(JSON.stringify({
    id: "req-1",
    sessionId: "test-session-1",
    type: "tool_response",
    result: { content: [{ type: "text", text: "ff-ok" }] },
  }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  const got = mcpInbox.find((m) => m.id === "req-1");
  if (!got) fail("response-route", "MCP client never received the firefox response");
  if (got.result?.content?.[0]?.text !== "ff-ok") fail("response-route", `wrong payload: ${JSON.stringify(got)}`);
  logOk("response routed back to MCP client by sessionId");

  // --- Test 4: error when no native_host for the requested browser ---
  // Disconnect firefox, then send a firefox-targeted request.
  firefoxHost.destroy();
  await new Promise((r) => setTimeout(r, 200));
  mcpInbox.length = 0;
  mcp.write(JSON.stringify({
    id: "req-3",
    sessionId: "test-session-1",
    type: "tool_request",
    tool: "noop",
    args: {},
    browser: "firefox",
  }) + "\n");
  await new Promise((r) => setTimeout(r, 200));

  const err = mcpInbox.find((m) => m.id === "req-3" && m.type === "tool_error");
  if (!err) fail("missing-host", `no tool_error received. inbox: ${JSON.stringify(mcpInbox)}`);
  if (!err.error.includes("firefox")) fail("missing-host", `error message doesn't mention firefox: ${err.error}`);
  logOk("missing-browser error returned to MCP client");

  // Cleanup
  chromiumHost.destroy();
  mcp.destroy();
  hub.kill();
  console.log("\n=== ALL HUB ROUTING CHECKS PASSED ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("test-hub-routing failed:", err.message);
  process.exit(1);
});
