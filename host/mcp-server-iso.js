#!/usr/bin/env node

// MCP Server for Orellius "isolated" mode.
//
// Each Claude Code session that launches this server gets its OWN dedicated
// Chrome process (its own --user-data-dir, its own --remote-debugging-port).
// Sessions cannot interfere with each other because they're different OS
// processes. No shared extension SW, no shared native host, no shared
// session-window claim. Bonus: video capture sees no compositor pausing
// because the window we own is always the one we drive.
//
// Trade-off vs the regular extension-mode mcp-server.js: this Chrome starts
// fresh each time (no logged-in cookies). That's intentional — for the user's
// real-Chrome work, keep the extension mode. This server is for isolated
// automation and recording.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { z } from "zod";

import { launchIsolatedChrome } from "./iso-chrome-launcher.js";
import { CdpBrowser } from "./iso-cdp.js";

const SESSION_ID = crypto.randomUUID().slice(0, 8);

function log(msg) {
  process.stderr.write(`[mcp-iso ${SESSION_ID} ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

// --- Browser state (one per server process) ---

let chrome = null; // returned by launchIsolatedChrome
let browser = null; // CdpBrowser
const tabs = new Map(); // tabId(number) -> { targetId, session, recording? }
let nextTabId = 1820264400; // start in the same range as the extension for habit-friendliness

async function ensureBrowser() {
  if (browser) return browser;
  chrome = await launchIsolatedChrome({
    sessionId: SESSION_ID,
    width: Number(process.env.ORELLIUS_ISO_WIDTH || 1280),
    height: Number(process.env.ORELLIUS_ISO_HEIGHT || 720),
  });
  browser = new CdpBrowser(chrome.browserWebSocketUrl);
  await browser.connect();
  log(`browser connected (chrome pid=${chrome.pid}, port=${chrome.port})`);
  return browser;
}

async function ensureTab(createIfEmpty) {
  await ensureBrowser();
  if (tabs.size > 0) return Array.from(tabs.entries())[0];
  if (!createIfEmpty) return null;
  const session = await browser.createPageSession("about:blank");
  const tabId = nextTabId++;
  tabs.set(tabId, { targetId: session.targetId, session });
  log(`created tab ${tabId} (targetId=${session.targetId})`);
  return [tabId, tabs.get(tabId)];
}

function getTab(tabId) {
  const t = tabs.get(tabId);
  if (!t) throw new Error(`Tab ${tabId} not found in this isolated session.`);
  return t;
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function imageResult(buffer, mimeType = "image/jpeg") {
  return {
    content: [
      {
        type: "image",
        data: buffer.toString("base64"),
        mimeType,
      },
    ],
  };
}

function imageWithText(buffer, text, mimeType = "image/jpeg") {
  return {
    content: [
      { type: "text", text },
      {
        type: "image",
        data: buffer.toString("base64"),
        mimeType,
      },
    ],
  };
}

// --- MCP server ---

const server = new McpServer({
  name: "orellius-browser-bridge-isolated",
  version: "0.1.0",
});

// Coerce common arg-type mistakes the same way the regular server does.
{
  const orig = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = function (schema, handler) {
    return orig(schema, async (request, extra) => {
      const args = request?.params?.arguments;
      if (args) {
        if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
        if (typeof args.coordinate === "string") {
          try { args.coordinate = JSON.parse(args.coordinate); } catch {}
        }
        if (typeof args.start_coordinate === "string") {
          try { args.start_coordinate = JSON.parse(args.start_coordinate); } catch {}
        }
      }
      return handler(request, extra);
    });
  };
}

// --- Tools ---

server.tool(
  "tabs_context_mcp",
  "Get context information about the current MCP tab group. Returns all tab IDs. CRITICAL: call once before any other browser tool.",
  { createIfEmpty: z.boolean().optional() },
  async ({ createIfEmpty }) => {
    await ensureTab(createIfEmpty);
    const out = {
      mode: "isolated",
      sessionId: SESSION_ID,
      chromePid: chrome?.pid,
      chromePort: chrome?.port,
      availableTabs: Array.from(tabs.entries()).map(([tabId, t]) => ({
        tabId,
        targetId: t.targetId,
      })),
    };
    return textResult(JSON.stringify(out, null, 2));
  }
);

server.tool(
  "tabs_create_mcp",
  "Create a new empty tab in the isolated Chrome.",
  {},
  async () => {
    await ensureBrowser();
    const session = await browser.createPageSession("about:blank");
    const tabId = nextTabId++;
    tabs.set(tabId, { targetId: session.targetId, session });
    return textResult(`Created tab ${tabId} (targetId=${session.targetId})`);
  }
);

server.tool(
  "tabs_close_mcp",
  "Close a tab in the isolated Chrome.",
  { tabId: z.number() },
  async ({ tabId }) => {
    const t = getTab(tabId);
    await t.session.close();
    tabs.delete(tabId);
    return textResult(`Closed tab ${tabId}`);
  }
);

server.tool(
  "navigate",
  "Navigate to a URL in an isolated tab. URL may be without protocol (defaults to https).",
  {
    url: z.string(),
    tabId: z.number(),
  },
  async ({ url, tabId }) => {
    const t = getTab(tabId);
    let target = url;
    if (!/^[a-zA-Z]+:\/\//.test(target) && target !== "about:blank") {
      target = "https://" + target;
    }
    await t.session.navigate(target);
    return textResult(`Navigated to ${target}`);
  }
);

server.tool(
  "computer",
  "Mouse + keyboard + screenshot, isolated.",
  {
    action: z.enum([
      "left_click", "right_click", "double_click", "triple_click",
      "type", "screenshot", "wait", "scroll", "key",
      "left_click_drag", "hover",
    ]),
    tabId: z.number(),
    coordinate: z.array(z.number()).min(2).max(2).optional(),
    duration: z.number().min(0).max(30).optional(),
    modifiers: z.string().optional(),
    text: z.string().optional(),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().min(1).max(10).optional(),
    start_coordinate: z.array(z.number()).min(2).max(2).optional(),
    repeat: z.number().min(1).max(100).optional(),
    savePath: z.string().optional(),
  },
  async (args) => {
    const t = getTab(args.tabId);
    const s = t.session;
    const mods = s.parseModifiers(args.modifiers);
    switch (args.action) {
      case "left_click":
      case "right_click":
      case "double_click":
      case "triple_click": {
        if (!args.coordinate) throw new Error(`${args.action} requires coordinate`);
        const button = args.action === "right_click" ? "right" : "left";
        const clickCount = args.action === "double_click" ? 2 : args.action === "triple_click" ? 3 : 1;
        await s.click({ x: args.coordinate[0], y: args.coordinate[1], button, clickCount, modifiers: mods });
        return textResult(`Clicked at (${args.coordinate[0]}, ${args.coordinate[1]})`);
      }
      case "left_click_drag": {
        if (!args.coordinate || !args.start_coordinate) throw new Error("drag requires start_coordinate and coordinate");
        const [x0, y0] = args.start_coordinate;
        const [x1, y1] = args.coordinate;
        await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0 });
        await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 });
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const x = x0 + ((x1 - x0) * i) / steps;
          const y = y0 + ((y1 - y0) * i) / steps;
          await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left" });
        }
        await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
        return textResult(`Dragged from (${x0},${y0}) to (${x1},${y1})`);
      }
      case "type": {
        if (!args.text) throw new Error("type requires text");
        await s.typeText(args.text);
        return textResult(`Typed ${args.text.length} chars`);
      }
      case "key": {
        if (!args.text) throw new Error("key requires text (key name or shortcut)");
        const repeat = args.repeat || 1;
        const keys = args.text.split(/\s+/);
        for (let r = 0; r < repeat; r++) {
          for (const k of keys) {
            if (k.includes("+")) await s.pressShortcut(k);
            else await s.pressKey(k, mods);
          }
        }
        return textResult(`Pressed ${keys.length * repeat} key(s)`);
      }
      case "screenshot": {
        const buf = await s.screenshot({ format: "jpeg", quality: 80 });
        const text = `Captured screenshot (${buf.length} bytes)`;
        if (args.savePath) {
          fs.mkdirSync(path.dirname(args.savePath), { recursive: true });
          fs.writeFileSync(args.savePath, buf);
          return imageWithText(buf, `${text}. Saved to disk: ${args.savePath}`);
        }
        return imageWithText(buf, text);
      }
      case "wait": {
        const ms = (args.duration || 1) * 1000;
        await new Promise((r) => setTimeout(r, ms));
        return textResult(`Waited ${ms}ms`);
      }
      case "scroll": {
        if (!args.coordinate) throw new Error("scroll requires coordinate");
        const ticks = args.scroll_amount || 3;
        const stepPx = 100;
        let dx = 0, dy = 0;
        if (args.scroll_direction === "up") dy = -stepPx * ticks;
        if (args.scroll_direction === "down") dy = stepPx * ticks;
        if (args.scroll_direction === "left") dx = -stepPx * ticks;
        if (args.scroll_direction === "right") dx = stepPx * ticks;
        await s.scroll({ x: args.coordinate[0], y: args.coordinate[1], deltaX: dx, deltaY: dy });
        return textResult(`Scrolled ${args.scroll_direction} ${ticks} ticks`);
      }
      case "hover": {
        if (!args.coordinate) throw new Error("hover requires coordinate");
        await s.hover({ x: args.coordinate[0], y: args.coordinate[1] });
        return textResult(`Hovered at (${args.coordinate[0]}, ${args.coordinate[1]})`);
      }
      default:
        throw new Error(`unsupported action: ${args.action}`);
    }
  }
);

server.tool(
  "javascript_tool",
  "Execute JavaScript in the page context. Returns the value of the last expression.",
  {
    action: z.literal("javascript_exec"),
    tabId: z.number(),
    text: z.string(),
  },
  async ({ tabId, text }) => {
    const t = getTab(tabId);
    const wrapped = `(async () => { return (${text}); })()`;
    const value = await t.session.runtimeEvaluate(wrapped);
    return textResult(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
);

server.tool(
  "record_video",
  "Record the tab as MP4 via CDP screencast → ffmpeg. Single-step: this tool drives the whole capture (start, dwell, stop, encode).",
  {
    tabId: z.number(),
    durationSec: z.number().min(1).max(600),
    savePath: z.string().describe("Absolute path for the output MP4."),
    maxWidth: z.number().optional(),
    maxHeight: z.number().optional(),
    everyNthFrame: z.number().min(1).max(10).optional(),
    captureQuality: z.number().min(1).max(100).optional(),
  },
  async (args) => {
    const t = getTab(args.tabId);
    const s = t.session;
    const tmpDir = path.join(os.tmpdir(), `orellius-iso-rec-${SESSION_ID}-${Date.now().toString(36)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const frames = []; // { path, timestamp }
    const timing = [];
    let frameIdx = 0;

    const handler = async (params) => {
      const idx = frameIdx++;
      const fp = path.join(tmpDir, `f${String(idx).padStart(6, "0")}.jpg`);
      try {
        fs.writeFileSync(fp, Buffer.from(params.data, "base64"));
        frames.push({ path: fp });
        timing.push(params.metadata?.timestamp || Date.now() / 1000);
      } catch (e) {
        log(`screencast frame write failed: ${e.message}`);
      }
      try { await s.ackScreencastFrame(params.sessionId); } catch {}
    };
    const off = s.on("Page.screencastFrame", handler);

    await s.startScreencast({
      format: "jpeg",
      quality: args.captureQuality || 80,
      maxWidth: args.maxWidth || 1280,
      maxHeight: args.maxHeight || 720,
      everyNthFrame: args.everyNthFrame || 2,
    });

    await new Promise((r) => setTimeout(r, args.durationSec * 1000));

    try { await s.stopScreencast(); } catch {}
    off();

    if (frames.length === 0) {
      return textResult("No frames captured. The tab may have been hidden the whole time.");
    }

    // Build ffconcat with per-frame durations from screencast timestamps.
    const concatLines = ["ffconcat version 1.0"];
    for (let i = 0; i < frames.length; i++) {
      concatLines.push(`file '${frames[i].path.replace(/\\/g, "/")}'`);
      const next = i + 1 < timing.length ? timing[i + 1] : timing[i] + 1 / 15;
      const dur = Math.max(0.02, Math.min(2.0, next - timing[i]));
      concatLines.push(`duration ${dur.toFixed(3)}`);
    }
    concatLines.push(`file '${frames[frames.length - 1].path.replace(/\\/g, "/")}'`);
    const concatPath = path.join(tmpDir, "concat.txt");
    fs.writeFileSync(concatPath, concatLines.join("\n"));

    fs.mkdirSync(path.dirname(args.savePath), { recursive: true });

    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-vf", "fps=15,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "22",
        args.savePath,
      ], { stdio: ["ignore", "ignore", "pipe"] });
      let ffErr = "";
      ff.stderr.on("data", (c) => (ffErr += c.toString()));
      ff.on("error", reject);
      ff.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg exit ${c}\n${ffErr.slice(-2000)}`))));
    });

    // Best-effort cleanup of temp frames.
    for (const f of frames) {
      try { fs.unlinkSync(f.path); } catch {}
    }
    try { fs.unlinkSync(concatPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}

    const stat = fs.statSync(args.savePath);
    return textResult(
      `Recorded ${frames.length} frames over ${args.durationSec}s → ${args.savePath} (${(stat.size / 1024).toFixed(1)} KiB).`
    );
  }
);

server.tool(
  "session_end",
  "End the isolated session: kill Chrome, drop temp dirs (when ORELLIUS_ISO_EPHEMERAL=1).",
  {},
  async () => {
    if (chrome) chrome.cleanup();
    if (browser) await browser.close();
    tabs.clear();
    chrome = null;
    browser = null;
    return textResult("Isolated session ended.");
  }
);

// --- Main ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("MCP server (isolated mode) ready on stdio");
}

const cleanup = () => {
  try { chrome?.cleanup(); } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  cleanup();
  process.exit(1);
});
