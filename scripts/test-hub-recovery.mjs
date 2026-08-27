#!/usr/bin/env node
// Isolated test of the hub's native-host recovery (host/hub.js, "Native-host
// recovery"). Runs throwaway hubs on spare ports with fake MCP clients and a
// fake native host - the live hub on 18765 is never touched, and no real
// browser is launched: the "launch" case points ORELLIUS_BROWSER_EXE at
// wscript.exe running a one-line script that writes a marker file (no window).
//
//   node scripts/test-hub-recovery.mjs
//
// Cases:
//   1. browser running, host registers 2s later  -> parked call is DELIVERED and answered
//   2. browser running, host never comes         -> tool_error after the wait, text says "retry once"
//   3. browser NOT running                       -> hub launches ORELLIUS_BROWSER_EXE (marker file appears),
//                                                   error text names the launch and its pid
//   4. /admin/status exposes parkedRequests + recovery; 404 list names reload-extension
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hubPath = path.join(here, "..", "host", "hub.js");
const WAIT_MS = 5000;
let failures = 0;

function assert(cond, label, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  (" + extra + ")" : ""}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startHub(port, env) {
  const hubEnv = { ...process.env, ...env, ORELLIUS_RECOVERY_WAIT_MS: String(WAIT_MS), ORELLIUS_RECOVERY_REKICK_MS: "1000", ORELLIUS_IDLE_TIMEOUT_MS: "0" };
  delete hubEnv.ORELLIUS_HUB_PORT;
  const logs = [];
  const child = spawn(process.execPath, [hubPath, `--port=${port}`], { env: hubEnv, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => logs.push(String(d)));
  child.stdout.on("data", (d) => logs.push(String(d)));
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port + 1}/admin/status`); break; } catch { await sleep(100); }
  }
  return { child, logs, port, admin: `http://127.0.0.1:${port + 1}` };
}

function lineClient(port, register) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, "127.0.0.1");
    const listeners = [];
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        for (const l of listeners) l(msg);
      }
    });
    sock.on("error", reject);
    sock.on("connect", () => {
      sock.write(JSON.stringify(register) + "\n");
      resolve({
        sock,
        send: (m) => sock.write(JSON.stringify(m) + "\n"),
        onMessage: (fn) => listeners.push(fn),
        waitFor: (pred, ms) => new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
          listeners.push((m) => { if (pred(m)) { clearTimeout(t); res(m); } });
        }),
      });
    });
  });
}

async function mcpClient(port, sessionId) {
  const c = await lineClient(port, { type: "register_mcp_client", sessionId });
  await c.waitFor((m) => m.type === "registered", 3000);
  return c;
}

async function fakeNativeHost(port) {
  const h = await lineClient(port, { type: "register_native_host", browser: "chromium" });
  await h.waitFor((m) => m.type === "registered", 3000);
  h.onMessage((m) => {
    if (m.type === "tool_request") h.send({ id: m.id, sessionId: m.sessionId, type: "tool_response", result: { echoed: m.tool } });
  });
  return h;
}

const RUNNING_NAME = process.platform === "win32" ? "node.exe" : "node";

async function case1() {
  console.log("\n--- case 1: browser running, host registers late -> parked call delivered");
  const hub = await startHub(18900, { ORELLIUS_BROWSER_PROCESS_NAME: RUNNING_NAME });
  try {
    const c = await mcpClient(18900, "sessA");
    const t0 = Date.now();
    const reply = c.waitFor((m) => m.id === "sessA_1", 8000);
    c.send({ id: "sessA_1", sessionId: "sessA", type: "tool_request", tool: "tabs_context_mcp", args: {}, browser: "chromium" });
    // tasklist alone takes >1s on a busy box (118 node.exe processes on
    // 2026-08-28), so give the count time to land before reading recovery.
    await sleep(2000);
    const st = await (await fetch(`${hub.admin}/admin/status`)).json();
    assert(st.parkedRequests === 1, "status shows 1 parked request while waiting", `parked=${st.parkedRequests}`);
    assert(st.recovery && st.recovery.browserRunning === true, "recovery saw the browser as running", JSON.stringify(st.recovery && st.recovery.steps));
    assert(st.recovery && !st.recovery.launched, "no launch attempted while the browser is running");
    await sleep(300);
    const host = await fakeNativeHost(18900);
    const m = await reply;
    const dt = Date.now() - t0;
    assert(m.type === "tool_response" && m.result && m.result.echoed === "tabs_context_mcp", "parked request was delivered and answered", `type=${m.type} after ${dt}ms`);
    assert(dt > 1500 && dt < WAIT_MS, "delivery happened at registration time, not at the deadline", `${dt}ms`);
    assert(hub.logs.join("").includes("delivered 1 parked request"), "hub log says it delivered the parked request");
    host.sock.destroy(); c.sock.destroy();
  } finally { hub.child.kill(); }
}

async function case2() {
  console.log("\n--- case 2: browser running, host never comes -> model-directed error at the deadline");
  const hub = await startHub(18902, { ORELLIUS_BROWSER_PROCESS_NAME: RUNNING_NAME });
  try {
    const c = await mcpClient(18902, "sessB");
    const t0 = Date.now();
    const reply = c.waitFor((m) => m.id === "sessB_1", WAIT_MS + 4000);
    c.send({ id: "sessB_1", sessionId: "sessB", type: "tool_request", tool: "navigate", args: {}, browser: "chromium" });
    const m = await reply;
    const dt = Date.now() - t0;
    assert(m.type === "tool_error", "call failed as tool_error", `after ${dt}ms`);
    assert(dt >= WAIT_MS - 200 && dt < WAIT_MS + 2500, "failure came at the deadline, not instantly", `${dt}ms vs wait ${WAIT_MS}ms`);
    assert(/is running but its extension has not re-registered/.test(m.error), "text explains the running-browser case");
    assert(/Retry this exact tool call once/.test(m.error), "text tells the model to retry");
    assert(/Do NOT ask the human/.test(m.error) && /Never end your turn by asking/.test(m.error), "text forbids handing it to the human");
    assert(!/Open a chromium browser/.test(m.error), "old human-directed sentence is gone");
    assert(/admin\/reload-extension/.test(m.error) && /chrome:\/\/extensions/.test(m.error), "text carries the reload ladder");
    console.log("    error text as the model will see it:\n" + m.error.split("\n").map((l) => "      | " + l).join("\n"));
    c.sock.destroy();
  } finally { hub.child.kill(); }
}

async function case3() {
  console.log("\n--- case 3: browser NOT running -> hub launches it (marker file, no window)");
  const marker = path.join(os.tmpdir(), `orellius-recovery-launch-${process.pid}.txt`);
  try { fs.unlinkSync(marker); } catch {}
  let env;
  if (process.platform === "win32") {
    const js = path.join(os.tmpdir(), `orellius-recovery-launch-${process.pid}.js`);
    fs.writeFileSync(js, `var fso=new ActiveXObject("Scripting.FileSystemObject");var f=fso.CreateTextFile("${marker.replace(/\\/g, "\\\\")}",true);f.WriteLine("launched");f.Close();`);
    env = { ORELLIUS_BROWSER_PROCESS_NAME: "no-such-process-zzz.exe", ORELLIUS_BROWSER_EXE: "C:\\Windows\\System32\\wscript.exe", ORELLIUS_BROWSER_ARGS: `//B ${js}` };
  } else {
    env = { ORELLIUS_BROWSER_PROCESS_NAME: "no-such-process-zzz", ORELLIUS_BROWSER_EXE: "/usr/bin/touch", ORELLIUS_BROWSER_ARGS: marker };
  }
  const hub = await startHub(18904, env);
  try {
    const c = await mcpClient(18904, "sessC");
    const reply = c.waitFor((m) => m.id === "sessC_1", WAIT_MS + 4000);
    c.send({ id: "sessC_1", sessionId: "sessC", type: "tool_request", tool: "screenshot", args: {}, browser: "chromium" });
    const m = await reply;
    const st = await (await fetch(`${hub.admin}/admin/status`)).json();
    assert(st.recovery && st.recovery.browserRunning === false, "recovery saw the browser as NOT running", JSON.stringify(st.recovery && st.recovery.steps));
    assert(st.recovery && st.recovery.launched && st.recovery.launched.ok === true, "recovery reports a successful launch", JSON.stringify(st.recovery && st.recovery.launched));
    assert(fs.existsSync(marker), "the launched command really ran (marker file exists)", marker);
    assert(m.type === "tool_error" && /was just launched by the hub \(pid \d+\)/.test(m.error), "error text names the launch and pid");
    assert(/Retry this exact tool call now/.test(m.error), "text tells the model to retry after a cold start");
    c.sock.destroy();
  } finally { hub.child.kill(); try { fs.unlinkSync(marker); } catch {} }
}

async function case4() {
  console.log("\n--- case 4: admin surface is honest");
  const hub = await startHub(18906, {});
  try {
    const st = await (await fetch(`${hub.admin}/admin/status`)).json();
    assert("parkedRequests" in st && "recovery" in st, "status has parkedRequests and recovery fields", Object.keys(st).join(","));
    const nf = await (await fetch(`${hub.admin}/admin/does-not-exist`)).json();
    assert(Array.isArray(nf.available) && nf.available.includes("POST /admin/reload-extension"), "404 list names reload-extension", JSON.stringify(nf.available));
    assert(nf.available.some((s) => s.startsWith("POST /admin/set-pin")), "404 list names set-pin");
  } finally { hub.child.kill(); }
}

for (const c of [case1, case2, case3, case4]) {
  try { await c(); } catch (err) { assert(false, `${c.name} threw`, err.message); }
}
console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}`);
process.exit(failures === 0 ? 0 : 1);
