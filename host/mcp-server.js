#!/usr/bin/env node

// MCP Server for Orellius Browser Bridge extension.
// Started by Claude Code via stdio MCP transport.
// Connects as a TCP CLIENT to the hub process (hub.js) which multiplexes
// multiple MCP server sessions through a single native host connection.
// This enables multiple Claude Code instances to control different browser tabs.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import { fileURLToPath } from "node:url";
import * as sessionStore from "./session-store.js";
import { getBidiDriver } from "./bidi-driver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 18765;
const SESSION_ID = crypto.randomUUID().slice(0, 8);

// Browser routing: when set to "firefox", tools in BIDI_TOOLS are routed to
// host/bidi-driver.js (WebDriver BiDi over WebSocket) instead of forwarded to
// the extension. Default is "chromium" (existing behavior unchanged).
//
// Set via ORELLIUS_BROWSER env var, config file `browser` key, or the
// switch_browser MCP tool at runtime. mcp-server.js carries one browser per
// session, so each Claude Code session can be pinned to a different browser.
const BIDI_TOOLS = new Set([
  "computer",
  "javascript_tool",
  "read_console_messages",
  "read_network_requests",
  "resize_window",
  "gif_creator",
  "record_video",
  "upload_image",
]);

let currentBrowser = (process.env.ORELLIUS_BROWSER || "chromium").toLowerCase();
try {
  const configPath = path.join(os.homedir(), ".config", "orellius-browser-bridge", "config.json");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  if (cfg.browser && !process.env.ORELLIUS_BROWSER) currentBrowser = String(cfg.browser).toLowerCase();
} catch {}
if (!["chromium", "firefox"].includes(currentBrowser)) currentBrowser = "chromium";

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[mcp-server ${SESSION_ID} ${ts}] ${msg}\n`);
}

function getPort() {
  const configPath = path.join(os.homedir(), ".config", "orellius-browser-bridge", "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return config.port || DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

// --- TCP client to hub ---

const TCP_PORT = getPort();
let hubSocket = null;
let hubBuffer = Buffer.alloc(0);
const pendingRequests = new Map(); // id -> { resolve, reject, timer }
let requestIdCounter = 0;
let registered = false;

function sendToExtension(tool, args) {
  return new Promise((resolve, reject) => {
    if (!hubSocket || hubSocket.destroyed) {
      reject(new Error("Hub is not connected. Make sure a supported browser is running with the Orellius extension installed and enabled."));
      return;
    }
    const id = `${SESSION_ID}_${++requestIdCounter}`;
    // Per-tool timeout: video export (ffmpeg encoding) can take minutes for
    // long recordings, so bump it to 5min. Default 60s for everything else.
    const isVideoExport = (tool === "gif_creator" || tool === "record_video")
      && args && args.action === "export";
    const timeoutMs = isVideoExport ? 300000 : 60000;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Tool request timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timer });
    // Tag with target browser so the hub routes to the right native_host.
    // This is the multi-browser routing key (chromium vs firefox).
    const msg = JSON.stringify({
      id,
      sessionId: SESSION_ID,
      type: "tool_request",
      tool,
      args,
      browser: currentBrowser,
    }) + "\n";
    hubSocket.write(msg);
  });
}

/** Ensure hub.js is running. Spawns it as a detached background process if needed. */
async function ensureHub() {
  // Try connecting - if it works, hub is already running
  return new Promise((resolve) => {
    const probe = new net.Socket();
    probe.connect(TCP_PORT, "127.0.0.1", () => {
      probe.destroy();
      resolve(); // Hub is running
    });
    probe.on("error", () => {
      probe.destroy();
      // Hub not running - spawn it
      log("Hub not running, spawning...");
      const hubPath = path.join(__dirname, "hub.js");
      const child = spawn(process.execPath, [hubPath], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      });
      child.unref();
      // Wait a moment for it to start listening
      setTimeout(resolve, 1000);
    });
  });
}

function connectToHub() {
  if (hubSocket && !hubSocket.destroyed) return;

  hubSocket = new net.Socket();
  hubSocket.connect(TCP_PORT, "127.0.0.1", () => {
    log(`Connected to hub on port ${TCP_PORT}`);
    // Register as MCP client with our sessionId
    hubSocket.write(JSON.stringify({ type: "register_mcp_client", sessionId: SESSION_ID }) + "\n");
  });

  hubSocket.on("data", (chunk) => {
    hubBuffer = Buffer.concat([hubBuffer, chunk]);
    let newlineIdx;
    while ((newlineIdx = hubBuffer.indexOf(10)) !== -1) {
      const line = hubBuffer.subarray(0, newlineIdx).toString("utf-8").trim();
      hubBuffer = hubBuffer.subarray(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "registered") {
          registered = true;
          log(`Registered with hub as session ${msg.sessionId}`);
          continue;
        }
        if (msg.type === "heartbeat") continue;
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve, reject, timer } = pendingRequests.get(msg.id);
          clearTimeout(timer);
          pendingRequests.delete(msg.id);
          if (msg.type === "tool_error") {
            reject(new Error(msg.error || "Tool execution failed"));
          } else {
            resolve(msg.result);
          }
        }
      } catch {
        // skip malformed
      }
    }
  });

  hubSocket.on("error", (err) => {
    log(`Hub connection error: ${err.message}`);
  });

  hubSocket.on("close", () => {
    log("Hub connection closed");
    hubSocket = null;
    registered = false;
    // Reject all pending requests
    for (const [id, { reject, timer }] of pendingRequests) {
      clearTimeout(timer);
      reject(new Error("Hub connection lost"));
    }
    pendingRequests.clear();
    // Try reconnecting after a delay
    setTimeout(() => {
      if (!hubSocket) connectToHub();
    }, 2000);
  });
}

function shutdown() {
  log("Shutting down...");
  if (hubSocket && !hubSocket.destroyed) hubSocket.destroy();
  for (const [id, { reject, timer }] of pendingRequests) {
    clearTimeout(timer);
    reject(new Error("Server shutting down"));
  }
  pendingRequests.clear();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGHUP", shutdown);
process.stdin.on("end", () => {
  log("Stdin closed (Claude Code disconnected). Cleaning up session.");
  shutdown();
});
process.stdin.resume();

// Set up hub connection in the background (after MCP is already connected).
async function setupHubConnection() {
  await ensureHub();
  connectToHub();
}

setupHubConnection().catch((err) => {
  log(`Hub connection failed: ${err.message}. Browser tools will not work.`);
});

// --- Helper to wrap tool results for MCP ---

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function imageResult(base64, mimeType = "image/png") {
  return { content: [{ type: "image", data: base64, mimeType }] };
}

function mixedResult(parts) {
  return { content: parts };
}

// Auto-save session state after tool calls
let lastAutoSave = 0;
const AUTO_SAVE_COOLDOWN = 30000; // 30s between saves

async function autoSaveSession(toolName) {
  const now = Date.now();
  if (now - lastAutoSave < AUTO_SAVE_COOLDOWN) return;
  lastAutoSave = now;
  
  try {
    const tabsResult = await sendToExtension("tabs_context_mcp", {});
    const tabs = typeof tabsResult === "string" ? JSON.parse(tabsResult) : tabsResult;
    
    const state = {
      created: Date.now(),
      tabs: tabs.tabs || [],
      context: {
        lastTool: toolName,
        workingOn: "Auto-saved after tool call",
      },
    };
    
    sessionStore.saveSnapshot(SESSION_ID, state);
    log(`Auto-saved session (${tabs.tabs?.length || 0} tabs)`);
  } catch (err) {
    // Silent fail - don't break tool calls if auto-save fails
    log(`Auto-save failed: ${err.message}`);
  }
}

async function callTool(toolName, args) {
  try {
    let result;
    if (currentBrowser === "firefox" && BIDI_TOOLS.has(toolName)) {
      // Route directly to host/bidi-driver.js — bypasses the extension. The
      // extension still owns tabs/navigation/content-script tools, but
      // CDP-equivalent work goes over BiDi WebSocket to Firefox :9222.
      const driver = getBidiDriver();
      result = await driver.dispatch(toolName, args);
    } else {
      result = await sendToExtension(toolName, args);
    }

    // Auto-save after successful tool calls (except read-only tools)
    const writeTools = ["navigate", "computer", "form_input", "tabs_create_mcp", "javascript_tool"];
    if (writeTools.includes(toolName)) {
      // Fire and forget
      autoSaveSession(toolName).catch(() => {});
    }

    // Result from extension can be a string, object with content array, or raw data
    if (typeof result === "string") return textResult(result);
    if (result && result.content) return result;
    return textResult(JSON.stringify(result, null, 2));
  } catch (err) {
    return textResult(`Error: ${err.message}`);
  }
}

// --- MCP Server with all 18 tools ---

const server = new McpServer({
  name: "orellius-browser-bridge",
  version: "1.0.0",
});

// Pre-validation arg coercion: fix common Claude mistakes before zod sees them.
// The schema advertises z.number() for tabId (matching the official extension),
// but Claude sometimes sends strings or serializes arrays as strings.
// We wrap every setRequestHandler call so that any handler receiving a request
// with params.arguments gets those arguments coerced before zod validation.
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = function(schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      // Coerce tool call arguments if present
      const args = request?.params?.arguments;
      if (args) {
        if (typeof args.tabId === "string") args.tabId = Number(args.tabId);
        if (typeof args.coordinate === "string") {
          try { args.coordinate = JSON.parse(args.coordinate); } catch {}
        }
        if (typeof args.start_coordinate === "string") {
          try { args.start_coordinate = JSON.parse(args.start_coordinate); } catch {}
        }
        if (typeof args.region === "string") {
          try { args.region = JSON.parse(args.region); } catch {}
        }
      }
      return handler(request, extra);
    });
  };
}

// 1. tabs_context_mcp
server.tool(
  "tabs_context_mcp",
  "Get context information about the current MCP tab group. Returns all tab IDs inside the group if it exists. Also checks for available session recovery (previous session snapshots). CRITICAL: You must get the context at least once before using other browser automation tools so you know what tabs exist. Each new conversation should create its own new tab (using tabs_create_mcp) rather than reusing existing tabs, unless the user explicitly asks to use an existing tab.",
  { createIfEmpty: z.boolean().optional().describe("Creates a new MCP tab group if none exists, creates a new Window with a new tab group containing an empty tab (which can be used for this conversation). If a MCP tab group already exists, this parameter has no effect.") },
  async (args) => {
    const result = await callTool("tabs_context_mcp", args);
    
    // Check for recovery snapshot
    const hasRecovery = sessionStore.hasSnapshot(SESSION_ID);
    if (hasRecovery) {
      const snapshot = sessionStore.loadSnapshot(SESSION_ID);
      const age = sessionStore.timeAgo(snapshot.lastSnapshot);
      const note = snapshot.context?.workingOn || "No description";
      
      // Parse original result and inject recovery info
      try {
        const originalText = result.content?.[0]?.text || "{}";
        const data = JSON.parse(originalText);
        data.recovery = {
          available: true,
          sessionId: SESSION_ID,
          lastSnapshot: new Date(snapshot.lastSnapshot).toISOString(),
          age,
          tabCount: snapshot.tabs?.length || 0,
          note,
        };
        return textResult(JSON.stringify(data, null, 2));
      } catch {
        // If parsing fails, append recovery as text
        const recoveryText = `\n\n🔄 Recovery available: ${snapshot.tabs?.length || 0} tabs from ${age} (${note}). Use session_restore to recover.`;
        return textResult((result.content?.[0]?.text || "") + recoveryText);
      }
    }
    
    return result;
  }
);

// 2. tabs_create_mcp
server.tool(
  "tabs_create_mcp",
  "Creates a new empty tab in the MCP tab group. CRITICAL: You must get the context using tabs_context_mcp at least once before using other browser automation tools so you know what tabs exist.",
  {},
  async (args) => callTool("tabs_create_mcp", args)
);

// 3. navigate
server.tool(
  "navigate",
  'Navigate to a URL, or go forward/back in browser history. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    url: z.string().describe('The URL to navigate to. Can be provided with or without protocol (defaults to https://). Use "forward" to go forward in history or "back" to go back in history.'),
    tabId: z.number().describe("Tab ID to navigate. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("navigate", args)
);

// 4. computer
server.tool(
  "computer",
  "Use a mouse and keyboard to interact with a web browser, and take screenshots. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.\n* Whenever you intend to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.\n* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your click location so that the tip of the cursor visually falls on the element that you want to click.\n* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.",
  {
    action: z.enum([
      "left_click", "right_click", "double_click", "triple_click",
      "type", "screenshot", "wait", "scroll", "key",
      "left_click_drag", "zoom", "scroll_to", "hover"
    ]).describe('The action to perform:\n* `left_click`: Click the left mouse button at the specified coordinates.\n* `right_click`: Click the right mouse button at the specified coordinates to open context menus.\n* `double_click`: Double-click the left mouse button at the specified coordinates.\n* `triple_click`: Triple-click the left mouse button at the specified coordinates.\n* `type`: Type a string of text.\n* `screenshot`: Take a screenshot of the screen.\n* `wait`: Wait for a specified number of seconds.\n* `scroll`: Scroll up, down, left, or right at the specified coordinates.\n* `key`: Press a specific keyboard key.\n* `left_click_drag`: Drag from start_coordinate to coordinate.\n* `zoom`: Take a screenshot of a specific region for closer inspection.\n* `scroll_to`: Scroll an element into view using its element reference ID from read_page or find tools.\n* `hover`: Move the mouse cursor to the specified coordinates or element without clicking. Useful for revealing tooltips, dropdown menus, or triggering hover states.'),
    tabId: z.number().describe("Tab ID to execute the action on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates. Required for `left_click`, `right_click`, `double_click`, `triple_click`, and `scroll`. For `left_click_drag`, this is the end position."),
    duration: z.number().min(0).max(30).optional().describe("The number of seconds to wait. Required for `wait`. Maximum 30 seconds."),
    modifiers: z.string().optional().describe('Modifier keys for click actions. Supports: "ctrl", "shift", "alt", "cmd" (or "meta"), "win" (or "windows"). Can be combined with "+" (e.g., "ctrl+shift", "cmd+alt"). Optional.'),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Required for `scroll_to` action. Can be used as alternative to `coordinate` for click actions.'),
    region: z.array(z.number()).min(4).max(4).optional().describe("(x0, y0, x1, y1): The rectangular region to capture for `zoom`. Coordinates define a rectangle from top-left (x0, y0) to bottom-right (x1, y1) in pixels from the viewport origin. Required for `zoom` action. Useful for inspecting small UI elements like icons, buttons, or text."),
    repeat: z.number().min(1).max(100).optional().describe("Number of times to repeat the key sequence. Only applicable for `key` action. Must be a positive integer between 1 and 100. Default is 1. Useful for navigation tasks like pressing arrow keys multiple times."),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("The direction to scroll. Required for `scroll`."),
    scroll_amount: z.number().min(1).max(10).optional().describe("The number of scroll wheel ticks. Optional for `scroll`, defaults to 3."),
    start_coordinate: z.array(z.number()).min(2).max(2).optional().describe("(x, y): The starting coordinates for `left_click_drag`."),
    text: z.string().optional().describe('The text to type (for `type` action) or the key(s) to press (for `key` action). For `key` action: Provide space-separated keys (e.g., "Backspace Backspace Delete"). Supports keyboard shortcuts using the platform\'s modifier key (use "cmd" on Mac, "ctrl" on Windows/Linux, e.g., "cmd+a" or "ctrl+a" for select all).'),
    savePath: z.string().optional().describe('For `screenshot` and `zoom` actions: optional absolute path to write the captured JPEG to disk (e.g. "C:/Users/raviv/Downloads/grab.png"). When set, the screenshot is also saved as a file alongside the inline image so downstream tools (PIL, ffmpeg, annotate scripts) can consume it. The action still returns the inline image to the LLM as usual. Parent directory must exist; the file is overwritten if present. Ignored for non-capture actions.'),
    fullPage: z.boolean().optional().describe("For `screenshot` only: capture the entire scrollable page in one image instead of the viewport. Uses CDP Page.captureScreenshot with captureBeyondViewport. Useful on long forms (Meta Ads Manager, Stripe dashboards, Notion docs) where every action button isn't visible at once. Default false. Skips the captureVisibleTab fallback - if CDP is unavailable on the tab, the call will error rather than degrade to a viewport crop. JPEG size cap is raised from 500KB to 1.5MB before re-encoding kicks in."),
  },
  async (args) => {
    const result = await callTool("computer", args);
    return persistCaptureToDisk(result, args);
  }
);

/**
 * If args.savePath is set on a screenshot/zoom action, find the inline-image
 * content block returned by the extension, decode the base64, and write it
 * to disk. Returns a copy of the result with an extra text block confirming
 * the save (or describing why we couldn't save). Non-capture actions and
 * results without an image block fall through unchanged.
 *
 * Why this lives on the host: the extension already buffers the bytes in
 * `screenshotStore` keyed by imageId, but those bytes never escape to disk.
 * Doing the write here means we can land the JPEG on whatever absolute path
 * the calling agent specified - the extension is sandboxed and would have
 * to go through chrome.downloads.download which can't write to arbitrary
 * locations without a user prompt.
 */
function persistCaptureToDisk(result, args) {
  if (!args || !args.savePath) return result;
  if (args.action !== "screenshot" && args.action !== "zoom") return result;
  if (!result || !Array.isArray(result.content)) return result;

  const imageBlock = result.content.find((b) => b && b.type === "image" && typeof b.data === "string");
  if (!imageBlock) return result;

  try {
    const buf = Buffer.from(imageBlock.data, "base64");
    const dir = path.dirname(args.savePath);
    if (!fs.existsSync(dir)) {
      throw new Error(`Parent directory does not exist: ${dir}`);
    }
    fs.writeFileSync(args.savePath, buf);
    return {
      ...result,
      content: [
        ...result.content,
        { type: "text", text: `Saved to disk: ${args.savePath} (${buf.length} bytes, ${imageBlock.mimeType || "image/jpeg"}).` },
      ],
    };
  } catch (err) {
    return {
      ...result,
      content: [
        ...result.content,
        { type: "text", text: `WARNING: savePath was set but write failed: ${err.message}. Inline image is still returned above.` },
      ],
    };
  }
}

// 4b. download_screenshot
server.tool(
  "download_screenshot",
  "Save a previously-captured screenshot to disk by its imageId. Useful for retroactively persisting screenshots that you didn't realize you'd want to keep at capture time - eg building tutorials/guides from the last several screenshots in the conversation, or when an agent decides after the fact that a specific frame is worth keeping. The extension keeps the last 10 screenshots in memory keyed by imageId; any of those is fetchable here. To capture and save in one step, prefer the computer tool's `savePath` argument.",
  {
    imageId: z.string().describe("The screenshot ID returned by a prior `computer action=screenshot` call (e.g., 'screenshot_1777664220919'). Look in the text content block above the inline image: 'Successfully captured screenshot (... jpeg) - ID: <imageId>'."),
    savePath: z.string().describe('Absolute path to write the JPEG to (e.g. "C:/Users/raviv/Downloads/step-3.jpg"). Parent directory must exist; the file is overwritten if present.'),
  },
  async (args) => {
    const result = await callTool("download_screenshot", args);
    if (!args || !args.savePath) return result;
    if (!result || !Array.isArray(result.content)) return result;
    const imageBlock = result.content.find((b) => b && b.type === "image" && typeof b.data === "string");
    if (!imageBlock) return result; // extension reported "not found" - propagate
    try {
      const buf = Buffer.from(imageBlock.data, "base64");
      const dir = path.dirname(args.savePath);
      if (!fs.existsSync(dir)) {
        throw new Error(`Parent directory does not exist: ${dir}`);
      }
      fs.writeFileSync(args.savePath, buf);
      // Strip the redundant inline image to keep the response compact - the
      // caller wanted the file, not another copy in their LLM context.
      return {
        content: [
          { type: "text", text: `Saved screenshot ${args.imageId} to ${args.savePath} (${buf.length} bytes, ${imageBlock.mimeType || "image/jpeg"}).` },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text", text: `WARNING: write failed: ${err.message}. Screenshot was found in cache but not saved.` },
        ],
      };
    }
  }
);

// 4c. screenshot_scroll_stitch
server.tool(
  "screenshot_scroll_stitch",
  "Capture a full-page screenshot by scrolling through the document, taking one viewport-sized capture per scroll position, and stitching the slices into a single image. Use this instead of `computer({action:\"screenshot\", fullPage:true})` when the page uses lazy-loading, virtual scrolling (react-window/react-virtualized), or otherwise only renders content as it scrolls into view - those pages return mostly-blank slices when CDP captureBeyondViewport is used because the off-screen DOM never got rendered. Slower than fullPage (one CDP capture per viewport-tall slice + a stitch step), but actually correct for lazy content. Chromium-only (uses CDP).",
  {
    tabId: z.number().describe("Tab ID to capture. Must be a tab in the current group."),
    format: z.enum(["jpeg", "png"]).optional().describe("Output image format. Default 'jpeg' (smaller files); use 'png' for lossless output (much larger)."),
    quality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100 (default 80). Ignored for PNG."),
    max_height: z.number().int().min(500).max(60000).optional().describe("Safety cap on total document height in CSS pixels (default 30000, hard ceiling 60000). Pages taller than this are truncated at the bottom (you still get the top max_height pixels). Big numbers consume serious memory at the stitch step."),
    hide_sticky: z.boolean().optional().describe("Default true. Hides any element with computed `position:fixed` or `position:sticky` during capture so headers/footers/CTA bars don't ghost across slices. Restored after capture."),
    hide_selectors: z.array(z.string()).optional().describe("Extra CSS selectors to hide during capture (e.g. cookie banners, chat widgets, screen recorder pills). Hidden via `style.visibility = 'hidden'` and restored after capture."),
    scroll_delay_ms: z.number().int().min(50).max(5000).optional().describe("Pause between scrolling and capturing each slice, to let lazy content render (default 250ms). Bump higher for slow image-heavy pages."),
    savePath: z.string().optional().describe("Optional absolute path to write the stitched image to disk (e.g. \"C:/Users/raviv/Downloads/full-page.png\"). Parent directory must exist; file is overwritten."),
  },
  async (args) => {
    const result = await callTool("screenshot_scroll_stitch", args);
    if (!args || !args.savePath) return result;
    if (!result || !Array.isArray(result.content)) return result;
    const imageBlock = result.content.find((b) => b && b.type === "image" && typeof b.data === "string");
    if (!imageBlock) return result; // extension reported failure - propagate
    try {
      const buf = Buffer.from(imageBlock.data, "base64");
      const dir = path.dirname(args.savePath);
      if (!fs.existsSync(dir)) throw new Error(`Parent directory does not exist: ${dir}`);
      fs.writeFileSync(args.savePath, buf);
      return {
        ...result,
        content: [
          ...result.content,
          { type: "text", text: `Saved stitched screenshot to ${args.savePath} (${buf.length} bytes, ${imageBlock.mimeType || `image/${args.format || "jpeg"}`}).` },
        ],
      };
    } catch (err) {
      return {
        ...result,
        content: [
          ...result.content,
          { type: "text", text: `WARNING: savePath was set but write failed: ${err.message}. Inline image is still returned above.` },
        ],
      };
    }
  }
);

// 5. find
server.tool(
  "find",
  'Find elements on the page using natural language. Can search for elements by their purpose (e.g., "search bar", "login button") or by text content (e.g., "organic mango product"). Returns up to 20 matching elements with references that can be used with other tools. If more than 20 matches exist, you\'ll be notified to use a more specific query. If you don\'t have a valid tab ID, use tabs_context_mcp first to get available tabs.',
  {
    query: z.string().describe('Natural language description of what to find (e.g., "search bar", "add to cart button", "product title containing organic")'),
    tabId: z.number().describe("Tab ID to search in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("find", args)
);

// 6. form_input
server.tool(
  "form_input",
  "Set values in form elements using element reference ID from the read_page tool. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    ref: z.string().describe('Element reference ID from the read_page tool (e.g., "ref_1", "ref_2")'),
    value: z.union([z.string(), z.boolean(), z.number()]).describe("The value to set. For checkboxes use boolean, for selects use option value or text, for other inputs use appropriate string/number"),
    tabId: z.number().describe("Tab ID to set form value in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("form_input", args)
);

// 7. get_page_text
server.tool(
  "get_page_text",
  "Extract raw text content from the page, prioritizing article content. Ideal for reading articles, blog posts, or other text-heavy pages. Returns plain text without HTML formatting. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to extract text from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("get_page_text", args)
);

// 8. record_video (Playwright-style video recording, was: gif_creator)
server.tool(
  "record_video",
  "Record a browser session as video with synthetic cursor + click overlays composited onto each frame. Equivalent to Playwright's recordVideo. Output formats: webm (default), mp4, gif. Workflow: 1) start_recording (begins CDP screencast + mouse-event log on the tab), 2) drive the page via other tools (click, type, navigate, etc.), 3) stop_recording (halts capture but keeps frames), 4) export (writes the encoded video to disk via the native host's ffmpeg). All operations are scoped to a tab. Frames are captured at ~15fps by default and downscaled to fit 1280x720; tweak via options. The cursor and click ripples are SYNTHETIC (drawn from the same x/y values dispatched via Input.dispatchMouseEvent) because CDP-trusted clicks never move the OS pointer.",
  {
    action: z.enum(["start_recording", "stop_recording", "export", "clear"]).describe("Action to perform. start_recording: begin CDP Page.startScreencast on the tab and start logging mouse events. stop_recording: halt screencast but keep frames in memory. export: composite + ffmpeg-encode + write to disk; returns savePath. clear: discard frames (also stops if still recording)."),
    tabId: z.number().describe("Tab ID. Must be a tab in the current MCP group. Use tabs_context_mcp first if unknown."),
    format: z.enum(["webm", "mp4", "gif"]).optional().describe("Output container/codec for action='export'. Default 'webm' (libvpx-vp9, matches Playwright). 'mp4' uses libx264 (broadest compatibility). 'gif' uses ffmpeg's gif encoder (largest files, no audio, but universal preview)."),
    savePath: z.string().optional().describe("Absolute disk path for the output file (action='export'). If omitted, defaults to ~/Downloads/orellius-<timestamp>.<format>. Parent directories are created automatically."),
    filename: z.string().optional().describe("Convenience: just a filename when you don't care about the directory (saved under ~/Downloads). Ignored if savePath is set."),
    options: z.object({
      showClickIndicators: z.boolean().optional().describe("Draw a synthetic cursor at the most-recent dispatched (x,y) and a ripple ring on each mousePressed event for ~500ms (default: true)."),
      showProgressBar: z.boolean().optional().describe("Thin progress bar at the bottom of every frame (default: true)."),
      showWatermark: z.boolean().optional().describe("Small 'Orellius' watermark in the lower-left corner (default: true)."),
      maxWidth: z.number().optional().describe("Max capture width in CSS pixels (default 1280). The tab's CSS viewport is downscaled to fit."),
      maxHeight: z.number().optional().describe("Max capture height in CSS pixels (default 720)."),
      everyNthFrame: z.number().optional().describe("CDP screencast everyNthFrame (default 2 = ~15fps from a 30fps page; pass 1 for ~30fps; higher for lower fps + smaller files)."),
      captureQuality: z.number().optional().describe("CDP screencast JPEG quality, 1-100 (default 80). Affects per-frame size, not codec quality."),
    }).optional().describe("Capture/render options for start_recording (maxWidth/maxHeight/everyNthFrame/captureQuality) and export (showClickIndicators/showProgressBar/showWatermark). All have sensible defaults."),
  },
  async (args) => callTool("record_video", args)
);

// 8b. gif_creator (DEPRECATED alias for record_video - kept for backward compat)
server.tool(
  "gif_creator",
  'DEPRECATED. Use record_video instead. Same behavior - records a browser session as video (webm/mp4/gif) with synthetic cursor overlay. The name "gif_creator" is misleading because GIF is just one of three output formats; the primary use is MP4/WebM video. This alias is kept for backward compatibility and will be removed in a future release.',
  {
    action: z.enum(["start_recording", "stop_recording", "export", "clear"]),
    tabId: z.number(),
    format: z.enum(["webm", "mp4", "gif"]).optional(),
    savePath: z.string().optional(),
    filename: z.string().optional(),
    options: z.object({
      showClickIndicators: z.boolean().optional(),
      showProgressBar: z.boolean().optional(),
      showWatermark: z.boolean().optional(),
      maxWidth: z.number().optional(),
      maxHeight: z.number().optional(),
      everyNthFrame: z.number().optional(),
      captureQuality: z.number().optional(),
    }).optional(),
  },
  async (args) => callTool("record_video", args)
);

// 9. javascript_tool
server.tool(
  "javascript_tool",
  "Execute JavaScript code in the context of the current page. The code runs in the page's context and can interact with the DOM, window object, and page variables. Returns the result of the last expression or any thrown errors. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    action: z.literal("javascript_exec").describe("Must be set to 'javascript_exec'"),
    text: z.string().describe("The JavaScript code to execute. The code will be evaluated in the page context. The result of the last expression will be returned automatically. Do NOT use 'return' statements - just write the expression you want to evaluate (e.g., 'window.myData.value' not 'return window.myData.value'). You can access and modify the DOM, call page functions, and interact with page variables."),
    tabId: z.number().describe("Tab ID to execute the code in. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("javascript_tool", args)
);

// 10. read_console_messages
server.tool(
  "read_console_messages",
  "Read browser console messages (console.log, console.error, console.warn, etc.) from a specific tab. Useful for debugging JavaScript errors, viewing application logs, or understanding what's happening in the browser console. Returns console messages from the current domain only. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs. IMPORTANT: Always provide a pattern to filter messages - without a pattern, you may get too many irrelevant messages.",
  {
    tabId: z.number().describe("Tab ID to read console messages from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    pattern: z.string().optional().describe("Regex pattern to filter console messages. Only messages matching this pattern will be returned (e.g., 'error|warning' to find errors and warnings, 'MyApp' to filter app-specific logs). You should always provide a pattern to avoid getting too many irrelevant messages."),
    limit: z.number().optional().describe("Maximum number of messages to return. Defaults to 100. Increase only if you need more results."),
    onlyErrors: z.boolean().optional().describe("If true, only return error and exception messages. Default is false (return all message types)."),
    clear: z.boolean().optional().describe("If true, clear the console messages after reading to avoid duplicates on subsequent calls. Default is false."),
  },
  async (args) => callTool("read_console_messages", args)
);

// 11. read_network_requests
server.tool(
  "read_network_requests",
  "Read HTTP network requests (XHR, Fetch, documents, images, etc.) from a specific tab. Useful for debugging API calls, monitoring network activity, or understanding what requests a page is making. Returns all network requests made by the current page, including cross-origin requests. Requests are automatically cleared when the page navigates to a different domain. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read network requests from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    urlPattern: z.string().optional().describe("Optional URL pattern to filter requests. Only requests whose URL contains this string will be returned (e.g., '/api/' to filter API calls, 'example.com' to filter by domain)."),
    limit: z.number().optional().describe("Maximum number of requests to return. Defaults to 100. Increase only if you need more results."),
    clear: z.boolean().optional().describe("If true, clear the network requests after reading to avoid duplicates on subsequent calls. Default is false."),
  },
  async (args) => callTool("read_network_requests", args)
);

// 12. read_page
server.tool(
  "read_page",
  "Get an accessibility tree representation of elements on the page. By default returns all elements including non-visible ones. Output is limited to 50000 characters by default. If the output exceeds this limit, you will receive an error asking you to specify a smaller depth or focus on a specific element using ref_id. Optionally filter for only interactive elements. If you don't have a valid tab ID, use tabs_context_mcp first to get available tabs.",
  {
    tabId: z.number().describe("Tab ID to read from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    filter: z.enum(["interactive", "all"]).optional().describe('Filter elements: "interactive" for buttons/links/inputs only, "all" for all elements including non-visible ones (default: all elements)'),
    depth: z.number().optional().describe("Maximum depth of the tree to traverse (default: 15). Use a smaller depth if output is too large."),
    ref_id: z.string().optional().describe("Reference ID of a parent element to read. Will return the specified element and all its children. Use this to focus on a specific part of the page when output is too large."),
    max_chars: z.number().optional().describe("Maximum characters for output (default: 50000). Set to a higher value if your client can handle large outputs."),
  },
  async (args) => callTool("read_page", args)
);

// 13. resize_window
server.tool(
  "resize_window",
  "Resize the current browser window. Auto-repositions the window so the resulting bounds fit inside the display's work area (Chrome enforces a >=50%-on-screen rule on chrome.windows.update; without this, requesting a bigger size at the current top-left often pushes the window off-screen and Chrome rejects it). Pass `left`/`top` to position explicitly, or `maximize:true` to skip width/height and snap to the OS work area.",
  {
    width: z.number().optional().describe("Target window width in pixels. Required unless maximize:true."),
    height: z.number().optional().describe("Target window height in pixels. Required unless maximize:true."),
    left: z.number().int().optional().describe("Optional new left (X) position in screen pixels. If omitted, window is auto-clamped onto its current display."),
    top: z.number().int().optional().describe("Optional new top (Y) position in screen pixels. If omitted, window is auto-clamped onto its current display."),
    maximize: z.boolean().optional().describe("If true, set windowState to 'maximized' (fills the OS work area) and ignore width/height/left/top."),
    tabId: z.number().describe("Tab ID to get the window for. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("resize_window", args)
);

// 14. shortcuts_list
server.tool(
  "shortcuts_list",
  "List all available shortcuts and workflows (shortcuts and workflows are interchangeable). Returns shortcuts with their commands, descriptions, and whether they are workflows. Use shortcuts_execute to run a shortcut or workflow.",
  {
    tabId: z.number().describe("Tab ID to list shortcuts from. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
  },
  async (args) => callTool("shortcuts_list", args)
);

// 15. shortcuts_execute
server.tool(
  "shortcuts_execute",
  "Execute a shortcut or workflow by running it in a new sidepanel window using the current tab (shortcuts and workflows are interchangeable). Use shortcuts_list first to see available shortcuts. This starts the execution and returns immediately - it does not wait for completion.",
  {
    tabId: z.number().describe("Tab ID to execute the shortcut on. Must be a tab in the current group. Use tabs_context_mcp first if you don't have a valid tab ID."),
    shortcutId: z.string().optional().describe("The ID of the shortcut to execute"),
    command: z.string().optional().describe("The command name of the shortcut to execute (e.g., 'debug', 'summarize'). Do not include the leading slash."),
  },
  async (args) => callTool("shortcuts_execute", args)
);

// 16. switch_browser
server.tool(
  "switch_browser",
  "Switch which browser this MCP session drives. Pass browser:'firefox' to route CDP-equivalent tools (computer, javascript_tool, read_console_messages, read_network_requests, resize_window) through host/bidi-driver.js (WebDriver BiDi WebSocket to Firefox :9222). Pass browser:'chromium' to forward all tools to the extension over native messaging (Chrome/Brave/Edge). Calling without `browser` reports the current setting.",
  {
    browser: z.enum(["chromium", "firefox"]).optional().describe("Target browser. Omit to query the current setting."),
  },
  async (args) => {
    const next = args?.browser;
    if (!next) {
      return textResult(`Current browser: ${currentBrowser}. Pass browser:'firefox' or browser:'chromium' to switch.`);
    }
    const before = currentBrowser;
    currentBrowser = next;
    if (next === "firefox") {
      // Verify the BiDi sidecar can reach Firefox before reporting success.
      try {
        await getBidiDriver().connect();
        return textResult(
          `Switched browser: ${before} -> firefox. ` +
          `CDP-equivalent tools now route through WebDriver BiDi (Firefox :9222). ` +
          `Tab/navigation tools still go to the extension via native messaging.`
        );
      } catch (e) {
        currentBrowser = before; // roll back
        return textResult(
          `Failed to switch to firefox: ${e.message}. ` +
          `Make sure Firefox is running with --remote-debugging-port=9222 and the Orellius Firefox extension is installed.`
        );
      }
    }
    return textResult(`Switched browser: ${before} -> chromium. All tools now forward to the extension.`);
  }
);

// 17. update_plan
server.tool(
  "update_plan",
  "Present a plan to the user for approval before taking actions. The user will see the domains you intend to visit and your approach. Once approved, you can proceed with actions on the approved domains without additional permission prompts.",
  {
    domains: z.array(z.string()).describe("List of domains you will visit (e.g., ['github.com', 'stackoverflow.com']). These domains will be approved for the session when the user accepts the plan."),
    approach: z.array(z.string()).describe("High-level description of what you will do. Focus on outcomes and key actions, not implementation details. Be concise - aim for 3-7 items."),
  },
  async (args) => callTool("update_plan", args)
);

// 18. upload_image
server.tool(
  "upload_image",
  "Upload a previously captured screenshot or user-uploaded image to a file input or drag & drop target. Supports two approaches: (1) ref - for targeting specific elements, especially hidden file inputs, (2) coordinate - for drag & drop to visible locations like Google Docs. Provide either ref or coordinate, not both.",
  {
    imageId: z.string().describe("ID of a previously captured screenshot (from the computer tool's screenshot action) or a user-uploaded image"),
    tabId: z.number().describe("Tab ID where the target element is located. This is where the image will be uploaded to."),
    ref: z.string().optional().describe('Element reference ID from read_page or find tools (e.g., "ref_1", "ref_2"). Use this for file inputs (especially hidden ones) or specific elements. Provide either ref or coordinate, not both.'),
    coordinate: z.array(z.number()).optional().describe("Viewport coordinates [x, y] for drag & drop to a visible location. Use this for drag & drop targets like Google Docs. Provide either ref or coordinate, not both."),
    filename: z.string().optional().describe('Optional filename for the uploaded file (default: "image.png")'),
  },
  async (args) => callTool("upload_image", args)
);

// 18b. upload_file - upload a local file to any upload control (including
// OS-native file pickers triggered by `<input type=file>.click()` or
// `window.showOpenFilePicker`). Bridges via Page.setInterceptFileChooserDialog
// + DOM.setFileInputFiles. Use this instead of upload_image when you have an
// absolute path to a file on disk (e.g. an asset you generated, an image in
// the user's filesystem).
server.tool(
  "upload_file",
  "Upload a local file to any upload control on a page, including OS-native file pickers that don't expose a DOM <input type=file>. Arms Page.setInterceptFileChooserDialog, optionally clicks a trigger (selector / coordinate / ref), waits for the next Page.fileChooserOpened event, and fulfills it via DOM.setFileInputFiles. Use this for Meta Ads Manager, Google Drive, Slack, Notion, and any other app that pops the OS file dialog. filePath must be absolute on the machine running Chrome. If none of triggerSelector/triggerCoordinate/triggerRef is supplied, the tool just arms the interception and waits up to timeoutMs for you to click the upload button yourself - but supplying a trigger is strongly preferred (no race).",
  {
    tabId: z.number().describe("Tab ID where the upload control lives."),
    filePath: z.string().describe("Absolute path to the file on the machine running Chrome (the user's machine for local Chrome, the remote machine for remote Chrome). Forward slashes or escaped backslashes both work on Windows."),
    triggerSelector: z.string().optional().describe('CSS selector for the button that opens the upload dialog. Example: \'button[aria-label="Upload"]\'. Tool will document.querySelector + .click() this before waiting.'),
    triggerCoordinate: z.array(z.number()).optional().describe("Pixel coordinates [x, y] in the viewport. Tool will dispatch a real CDP mouse press+release on these coords to trigger the upload dialog."),
    triggerRef: z.string().optional().describe('Element reference ID from read_page or find tools (e.g. "ref_1"). Tool resolves via __orelliusBrowserBridge.resolveRef and clicks it.'),
    timeoutMs: z.number().optional().describe("How long to wait for the file chooser dialog to open after the trigger fires (default 15000). If you arm without a trigger, raise this to give yourself time to click manually."),
  },
  async (args) => callTool("upload_file", args)
);

// 19. session_save
server.tool(
  "session_save",
  "Manually save current session state to disk for crash recovery. Takes a snapshot of all open tabs, URLs, and context. Snapshots are automatically saved after each tool call, but you can use this to save important checkpoints with a descriptive note.",
  {
    note: z.string().optional().describe("Optional note about what you're working on (e.g., 'Reddit automation halfway done', 'Before submitting form')"),
  },
  async (args) => {
    try {
      // Get current tab state from extension
      const tabsResult = await callTool("tabs_context_mcp", {});
      const tabs = tabsResult.content?.[0]?.text ? JSON.parse(tabsResult.content[0].text) : { tabs: [] };
      
      const state = {
        created: Date.now(),
        tabs: tabs.tabs || [],
        context: {
          workingOn: args.note || "Manual save",
          lastTool: "session_save",
        },
      };
      
      const success = sessionStore.saveSnapshot(SESSION_ID, state);
      if (success) {
        return textResult(`✅ Session saved (${tabs.tabs?.length || 0} tabs)${args.note ? ': ' + args.note : ''}`);
      } else {
        return textResult("⚠️ Session persistence is disabled in config");
      }
    } catch (err) {
      return textResult(`❌ Failed to save session: ${err.message}`);
    }
  }
);

// 20. session_restore
server.tool(
  "session_restore",
  "List available session snapshots or restore a specific session. When restoring, reopens all tabs from the snapshot and provides a context summary of what you were working on.",
  {
    sessionId: z.string().optional().describe("Session ID to restore. If omitted, lists all available sessions sorted by recency."),
  },
  async (args) => {
    try {
      if (!args.sessionId) {
        // List available sessions
        const sessions = sessionStore.listSessions();
        if (sessions.length === 0) {
          return textResult("No saved sessions found.");
        }
        
        const lines = ["📂 Available sessions (newest first):\n"];
        for (const s of sessions.slice(0, 10)) {
          const age = sessionStore.timeAgo(s.lastSnapshot);
          const note = s.note ? ` - ${s.note}` : "";
          lines.push(`• ${s.sessionId} (${s.tabCount} tabs, ${age})${note}`);
        }
        if (sessions.length > 10) {
          lines.push(`\n... and ${sessions.length - 10} more`);
        }
        lines.push("\nUse session_restore with a sessionId to restore.");
        return textResult(lines.join("\n"));
      }
      
      // Restore specific session
      const snapshot = sessionStore.loadSnapshot(args.sessionId);
      if (!snapshot) {
        return textResult(`❌ Session ${args.sessionId} not found`);
      }
      
      // Restore tabs
      const restored = [];
      for (const tab of snapshot.tabs || []) {
        try {
          await callTool("tabs_create_mcp", { url: tab.url });
          restored.push(tab.url);
        } catch (err) {
          log(`Failed to restore tab ${tab.url}: ${err.message}`);
        }
      }
      
      const age = sessionStore.timeAgo(snapshot.lastSnapshot);
      const context = snapshot.context?.workingOn || "No context saved";
      
      return textResult(
        `✅ Restored session from ${age}\n` +
        `📝 Context: ${context}\n` +
        `🗂️  Restored ${restored.length}/${snapshot.tabs?.length || 0} tabs\n\n` +
        restored.map((url, i) => `${i + 1}. ${url}`).join("\n")
      );
    } catch (err) {
      return textResult(`❌ Failed to restore session: ${err.message}`);
    }
  }
);

// 21. session_prune
server.tool(
  "session_prune",
  "Delete old session snapshots to free up disk space. By default, deletes sessions older than 7 days. Sessions are automatically pruned on startup, so you rarely need to call this manually.",
  {
    maxAgeDays: z.number().optional().describe("Delete sessions older than this many days (default: 7)"),
  },
  async (args) => {
    try {
      const deleted = sessionStore.pruneOldSessions(args.maxAgeDays);
      if (deleted === 0) {
        return textResult("No old sessions to prune.");
      }
      return textResult(`🗑️  Deleted ${deleted} old session${deleted === 1 ? '' : 's'}`);
    } catch (err) {
      return textResult(`❌ Failed to prune sessions: ${err.message}`);
    }
  }
);

// 22. browser_lock
server.tool(
  "browser_lock",
  "Claim exclusive access to a tab so other Claude Code sessions sharing this Orellius extension cannot interfere. Every subsequent tool call from this session extends the lock (heartbeat). Useful when two VS Code windows are both driving the same browser and racing on CDP commands. Re-claiming an EXPIRED foreign lock is free. Re-claiming an ACTIVE foreign lock requires the human-known override_pin (visible by clicking the extension icon) - force:true alone no longer bypasses, since that allowed misbehaving sessions to silently steal tabs.",
  {
    tabId: z.number().describe("Tab ID to lock."),
    ttl_seconds: z.number().optional().describe("How long the lock stays active without activity (30-3600, default 600). Operations by the owning session extend this automatically."),
    force: z.boolean().optional().describe("DEPRECATED for cross-session takeover. No longer sufficient on an active foreign lock - use override_pin instead."),
    override_pin: z.string().optional().describe("Human-known 6-digit override PIN. Required to take over a tab actively locked by another session. The human can read the current PIN by clicking the Orellius extension icon and rotate it from the same popup."),
  },
  async (args) => callTool("browser_lock", args)
);

// 23. browser_unlock
server.tool(
  "browser_unlock",
  "Release a tab lock claimed via browser_lock. Call this when done with exclusive access so other sessions can operate on the tab. Breaking a lock held by another active session requires override_pin (force:true is no longer sufficient).",
  {
    tabId: z.number().describe("Tab ID to unlock."),
    force: z.boolean().optional().describe("DEPRECATED for breaking another session's lock - use override_pin instead."),
    override_pin: z.string().optional().describe("Human-known 6-digit override PIN. Required to break a foreign session's active lock. Visible by clicking the Orellius extension icon."),
  },
  async (args) => callTool("browser_unlock", args)
);

// 24. browser_lock_status
server.tool(
  "browser_lock_status",
  "List all active tab locks and their owning sessions. Useful for debugging cross-session conflicts.",
  {},
  async (args) => callTool("browser_lock_status", args)
);

// 25. browser_mode (replaces browser_focus_mode; accepts old names too)
server.tool(
  "browser_mode",
  'Get or set the default mode for the calling session. "private" mode (default) operates entirely inside the session\'s owned Chrome window - the human can keep working in their own window/desktop without ever seeing Orellius interrupt them. Tab activation still happens but only inside the owned window. "public" mode also calls chrome.windows.update({focused:true}) on every input, bringing the owned window to the foreground. Use "public" only when CDP input fails because another window stole focus, or when you genuinely need the human\'s attention on every action. For one-shot "look at this" moments, prefer browser_show. Persists across extension reloads. Aliases: "silent" -> "private", "active" -> "public".',
  {
    mode: z.enum(["private", "public", "silent", "active"]).optional().describe('"private" for invisible operation (default), "public" to grab window focus on every input. Omit to read current mode.'),
  },
  async (args) => callTool("browser_mode", args)
);

// 25b. browser_focus_mode (backward-compat alias for browser_mode)
server.tool(
  "browser_focus_mode",
  'DEPRECATED. Alias for browser_mode. "silent" maps to "private", "active" maps to "public".',
  {
    mode: z.enum(["silent", "active", "private", "public"]).optional().describe('Use browser_mode instead.'),
  },
  async (args) => callTool("browser_focus_mode", args)
);

// 26. browser_show
server.tool(
  "browser_show",
  "One-shot: bring the calling session's owned Chrome window to the foreground. Use when you need the human's eyes - showing them a result, presenting a UI for them to act on, or asking a question that requires them to look. Does NOT change the default mode; next input op respects whatever mode is set (private/public). Pair with browser_hide to send the window back to the background after you're done.",
  {},
  async (args) => callTool("browser_show", args)
);

// 27. browser_hide
server.tool(
  "browser_hide",
  "One-shot: minimize the calling session's owned Chrome window. Use after browser_show to return to private operation immediately, so the human can keep working without the agent's window in their way.",
  {},
  async (args) => callTool("browser_hide", args)
);

// 28. tabs_close_mcp
server.tool(
  "tabs_close_mcp",
  "Close a single tab from the calling session's MCP group. Use when you're done with a specific page mid-conversation and want to keep the workspace tidy. Closing a tab held by browser_lock from a DIFFERENT active session requires override_pin (force:true alone no longer bypasses). Other tabs in the session's window remain open.",
  {
    tabId: z.number().describe("Tab ID to close. Must be inside the session's MCP tab group."),
    force: z.boolean().optional().describe("DEPRECATED for cross-session closes - use override_pin instead."),
    override_pin: z.string().optional().describe("Human-known 6-digit override PIN. Required to close a tab actively locked by another session. Visible by clicking the Orellius extension icon."),
  },
  async (args) => callTool("tabs_close_mcp", args)
);

// 29. session_end
server.tool(
  "session_end",
  "End the current session: close every tab in the session's owned Chrome window, close the window, drop the session's window claim. Call this proactively when the conversation is wrapping up and you know the browser work is finished - it prevents orphan windows from piling up across many Claude Code conversations. If any tab in the session's window is locked by a DIFFERENT active session, the call requires override_pin (force:true alone no longer bypasses). Safe to call when no window is owned (returns a no-op message). After session_end, calling another browser tool will create a fresh window via tabs_context_mcp(createIfEmpty:true).",
  {
    force: z.boolean().optional().describe("DEPRECATED for cross-session blockers - use override_pin instead."),
    override_pin: z.string().optional().describe("Human-known 6-digit override PIN. Required when other sessions still hold locks on tabs in this window. Visible by clicking the Orellius extension icon."),
  },
  async (args) => callTool("session_end", args)
);

// --- Start MCP server FIRST (must respond to Claude Code before TCP setup) ---

const transport = new StdioServerTransport();
// Connect stdio immediately so Claude Code gets the MCP handshake
// before any slow TCP port negotiation.
server.connect(transport).catch((err) => {
  log(`MCP transport error: ${err.message}`);
});
