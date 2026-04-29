// host/bidi-driver.js
//
// WebDriver BiDi client for the Firefox build of Orellius Browser Bridge.
//
// Replaces what `chrome.debugger` (CDP) does in the Chrome extension:
//   - trusted mouse/keyboard input (input.performActions)
//   - full-page screenshots (browsingContext.captureScreenshot)
//   - JS evaluation in any frame (script.evaluate)
//   - console capture (subscribe log.entryAdded)
//   - network capture (subscribe network.beforeRequestSent + responseCompleted)
//   - viewport resize (browsingContext.setViewport)
//
// The user must launch Firefox with `--remote-debugging-port=9222`. This
// driver auto-discovers the BiDi WebSocket URL from /json/version, opens a
// long-lived session, and exposes a `dispatch(tool, args)` entry point that
// the host's mcp-server.js calls for tools where the Chrome version uses CDP.
//
// Tab identity: the Firefox extension reports `chrome.tabs.id` integers in
// tool args; BiDi works in `browsingContextId` strings. We map between them
// via URL+title when first encountered (good enough for one-window-per-
// session Orellius). For ambiguous cases the extension can pass `bidiContext`
// directly through args.

import http from "node:http";
import { WebSocket } from "ws";

const DEFAULT_DEBUG_PORT = 9222;
const DISCOVERY_TIMEOUT_MS = 5000;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[bidi-driver ${ts}] ${msg}\n`);
}

class BidiDriver {
  constructor(opts = {}) {
    this.port = opts.port || DEFAULT_DEBUG_PORT;
    this.host = opts.host || "127.0.0.1";
    this.ws = null;
    this.sessionId = null;
    this.nextCmdId = 1;
    this.pending = new Map(); // cmdId -> { resolve, reject }
    this.subscribed = new Set();
    this.consoleByContext = new Map();   // browsingContextId -> [{ level, text, url, ts }]
    this.networkByContext = new Map();   // browsingContextId -> [{ url, method, status, ts }]
    this.contextCache = new Map();       // tabId-or-url -> browsingContextId
    this.connectPromise = null;
  }

  // --- Discovery + connect ---
  //
  // Firefox 129+ exposes the BiDi WebSocket at the well-known path /session
  // and does NOT mirror Chrome's /json/version discovery endpoint. We try
  // /json/version as a best-effort probe (so a Chrome-via-CDP-mux build
  // would also work), then fall back to the well-known Firefox path.

  async _discoverWsUrl() {
    const probed = await new Promise((resolve) => {
      try {
        const req = http.get(
          { host: this.host, port: this.port, path: "/json/version", timeout: 1500 },
          (res) => {
            if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
            let body = "";
            res.on("data", (c) => { body += c; });
            res.on("end", () => {
              try {
                const data = JSON.parse(body);
                resolve(data.webSocketDebuggerUrl || data.webSocketUrl || null);
              } catch { resolve(null); }
            });
          }
        );
        req.on("error", () => resolve(null));
        req.on("timeout", () => { req.destroy(); resolve(null); });
      } catch { resolve(null); }
    });

    if (probed) return probed;
    // Firefox / WebDriver BiDi well-known path. Verified empirically on
    // Firefox 143.0.4: HTTP GET upgrades cleanly to WebSocket here.
    return `ws://${this.host}:${this.port}/session`;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      let wsUrl;
      try {
        wsUrl = await this._discoverWsUrl();
      } catch (e) {
        throw new Error(
          `Cannot reach Firefox Remote Agent at ${this.host}:${this.port}. ` +
          `Launch Firefox with --remote-debugging-port=${this.port} and retry. ` +
          `Underlying error: ${e.message}`
        );
      }
      log(`Discovered BiDi WS URL: ${wsUrl}`);

      await new Promise((resolve, reject) => {
        this.ws = new WebSocket(wsUrl);
        this.ws.on("open", () => {
          log("WebSocket open");
          resolve();
        });
        this.ws.on("error", (err) => {
          log(`WebSocket error: ${err.message}`);
          reject(err);
        });
        this.ws.on("message", (data) => this._onMessage(data));
        this.ws.on("close", () => {
          log("WebSocket closed");
          this.ws = null;
          this.sessionId = null;
          // Reject everything pending so callers see the disconnect.
          for (const [, p] of this.pending) p.reject(new Error("BiDi WebSocket closed"));
          this.pending.clear();
        });
      });

      // Open a BiDi session. The webSocketDebuggerUrl from /json/version is
      // already a BiDi-capable endpoint on Firefox 129+, but session.new is
      // still required to enable BiDi-only commands.
      await this._send("session.new", {
        capabilities: { alwaysMatch: { acceptInsecureCerts: true } },
      });

      // Default subscriptions for console + network so per-context buffers
      // start filling immediately. Each subscription applies globally; we
      // filter by browsingContextId when reading.
      await this.subscribe(["log.entryAdded", "network.beforeRequestSent", "network.responseCompleted"]);
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString("utf-8")); }
    catch { return; }

    // Command response
    if (msg.type === "success" || msg.type === "error") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.type === "success") p.resolve(msg.result || {});
      else {
        const code = msg.error || `error_${msg.id}`;
        const desc = msg.message || "(no message)";
        const stack = msg.stacktrace ? `\n${msg.stacktrace}` : "";
        p.reject(new Error(`BiDi: ${code}: ${desc}${stack}`));
      }
      return;
    }

    // Event
    if (msg.type === "event") {
      this._onEvent(msg.method, msg.params || {});
    }
  }

  _onEvent(method, params) {
    if (method === "log.entryAdded") {
      const ctx = params.source?.context;
      if (!ctx) return;
      const bucket = this.consoleByContext.get(ctx) || [];
      bucket.push({
        level: params.level || params.type || "log",
        text: params.text || (params.args || []).map((a) => a.value ?? a.value?.toString?.() ?? "").join(" "),
        url: params.source?.url || "",
        timestamp: Date.now(),
      });
      if (bucket.length > 1000) bucket.splice(0, bucket.length - 1000);
      this.consoleByContext.set(ctx, bucket);
    } else if (method === "network.beforeRequestSent") {
      const ctx = params.context;
      if (!ctx) return;
      const bucket = this.networkByContext.get(ctx) || [];
      bucket.push({
        url: params.request?.url || "",
        method: params.request?.method || "GET",
        status: 0,
        timestamp: Date.now(),
      });
      if (bucket.length > 1000) bucket.splice(0, bucket.length - 1000);
      this.networkByContext.set(ctx, bucket);
    } else if (method === "network.responseCompleted") {
      const ctx = params.context;
      if (!ctx) return;
      const bucket = this.networkByContext.get(ctx) || [];
      // Find the matching request and fill in the status. Fall back to a fresh entry.
      const url = params.response?.url || params.request?.url || "";
      const matching = [...bucket].reverse().find((e) => e.url === url && e.status === 0);
      if (matching) {
        matching.status = params.response?.status || 0;
        matching.mimeType = params.response?.mimeType;
      } else {
        bucket.push({
          url,
          method: params.request?.method || "GET",
          status: params.response?.status || 0,
          mimeType: params.response?.mimeType,
          timestamp: Date.now(),
        });
        if (bucket.length > 1000) bucket.splice(0, bucket.length - 1000);
        this.networkByContext.set(ctx, bucket);
      }
    }
  }

  _send(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("BiDi WebSocket not open"));
    }
    const id = this.nextCmdId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
      // Per-command timeout so a frozen browser doesn't hang the host forever.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`BiDi command ${method} (id ${id}) timed out`));
        }
      }, 30000);
    });
  }

  async subscribe(events) {
    const fresh = events.filter((e) => !this.subscribed.has(e));
    if (fresh.length === 0) return;
    await this._send("session.subscribe", { events: fresh });
    for (const e of fresh) this.subscribed.add(e);
    log(`Subscribed to: ${fresh.join(", ")}`);
  }

  // Best-effort tear-down: Firefox enforces "1 active BiDi session per
  // browser instance", and a closed WS does NOT reliably free the session
  // (verified empirically on 143.0.4: a test process that exited cleanly
  // still pinned the session, blocking the next session.new with
  // "Maximum number of active sessions"). Always call this before exit.
  async close() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try { await this._send("session.end", {}); }
    catch (e) { log(`session.end failed (ignored): ${e.message}`); }
    try { this.ws.close(); } catch {}
    this.ws = null;
  }

  // --- Context resolution ---
  // mcp-server.js passes { tabId, url, title } from the extension's last
  // tabs_context_mcp call. We match by URL+title against BiDi's tree.
  // Callers may also pass `bidiContext` directly to bypass resolution.

  async resolveContext(args) {
    if (args && args.bidiContext) return args.bidiContext;

    const tree = await this._send("browsingContext.getTree", {});
    const contexts = flattenContexts(tree.contexts || []);

    // Match heuristics: url match wins, then title contains, then first tab.
    if (args && args.url) {
      const m = contexts.find((c) => c.url === args.url);
      if (m) return m.context;
    }
    if (args && args.title) {
      const t = String(args.title).toLowerCase();
      const m = contexts.find((c) => (c.url || "").toLowerCase().includes(t) || (c.userContext || "").toLowerCase().includes(t));
      if (m) return m.context;
    }
    // Last-resort: first top-level context.
    if (contexts[0]) return contexts[0].context;
    throw new Error("No BiDi browsingContext available - is Firefox open with at least one tab?");
  }

  // --- Tool implementations ---

  async screenshot({ context, fullPage = false, clip } = {}) {
    const params = { context };
    if (fullPage) params.origin = "document";
    if (clip) params.clip = clip;
    const r = await this._send("browsingContext.captureScreenshot", params);
    return { base64: r.data, format: r.format || "image/png" };
  }

  async evaluate({ context, expression, awaitPromise = true }) {
    const r = await this._send("script.evaluate", {
      expression,
      target: { context },
      awaitPromise,
      resultOwnership: "none",
    });
    if (r.type === "exception") {
      throw new Error(`script.evaluate threw: ${r.exceptionDetails?.text || JSON.stringify(r.exceptionDetails)}`);
    }
    return r.result || r;
  }

  async setViewport({ context, width, height }) {
    return this._send("browsingContext.setViewport", {
      context,
      viewport: { width, height },
    });
  }

  async activate({ context }) {
    return this._send("browsingContext.activate", { context });
  }

  // input.performActions wraps a sequence of pointer/key events into one
  // trusted dispatch. Coordinates are CSS pixels relative to the viewport.
  async click({ context, x, y, button = 0, clickCount = 1, modifiers = [] }) {
    await this.activate({ context });
    const actions = [];
    // Modifier key down
    for (const mod of modifiers) {
      actions.push({ type: "keyDown", value: mod });
    }
    actions.push({ type: "pointerMove", x, y, duration: 0, origin: "viewport" });
    actions.push({ type: "pause", duration: 30 });
    for (let i = 0; i < clickCount; i++) {
      actions.push({ type: "pointerDown", button });
      actions.push({ type: "pause", duration: 30 });
      actions.push({ type: "pointerUp", button });
      if (i < clickCount - 1) actions.push({ type: "pause", duration: 80 });
    }
    for (const mod of modifiers.slice().reverse()) {
      actions.push({ type: "keyUp", value: mod });
    }

    return this._send("input.performActions", {
      context,
      actions: [
        {
          type: "pointer",
          id: "orellius-pointer",
          parameters: { pointerType: "mouse" },
          actions: actions.filter((a) => a.type.startsWith("pointer") || a.type === "pause"),
        },
        ...(modifiers.length
          ? [{
              type: "key",
              id: "orellius-key",
              actions: actions.filter((a) => a.type.startsWith("key") || a.type === "pause"),
            }]
          : []),
      ],
    });
  }

  async drag({ context, fromX, fromY, toX, toY, button = 0 }) {
    await this.activate({ context });
    return this._send("input.performActions", {
      context,
      actions: [{
        type: "pointer",
        id: "orellius-drag",
        parameters: { pointerType: "mouse" },
        actions: [
          { type: "pointerMove", x: fromX, y: fromY, origin: "viewport", duration: 0 },
          { type: "pointerDown", button },
          { type: "pause", duration: 50 },
          { type: "pointerMove", x: toX, y: toY, origin: "viewport", duration: 200 },
          { type: "pause", duration: 50 },
          { type: "pointerUp", button },
        ],
      }],
    });
  }

  async typeText({ context, text }) {
    await this.activate({ context });
    return this._send("input.performActions", {
      context,
      actions: [{
        type: "key",
        id: "orellius-text",
        actions: [
          ...[...text].flatMap((ch) => [
            { type: "keyDown", value: ch },
            { type: "keyUp", value: ch },
          ]),
        ],
      }],
    });
  }

  async pressKey({ context, key, modifiers = [] }) {
    await this.activate({ context });
    const actions = [
      ...modifiers.map((m) => ({ type: "keyDown", value: m })),
      { type: "keyDown", value: key },
      { type: "keyUp", value: key },
      ...modifiers.slice().reverse().map((m) => ({ type: "keyUp", value: m })),
    ];
    return this._send("input.performActions", {
      context,
      actions: [{ type: "key", id: "orellius-key", actions }],
    });
  }

  async scroll({ context, x, y, deltaX, deltaY }) {
    await this.activate({ context });
    return this._send("input.performActions", {
      context,
      actions: [{
        type: "wheel",
        id: "orellius-wheel",
        actions: [{ type: "scroll", x, y, deltaX, deltaY, duration: 100 }],
      }],
    });
  }

  // --- Higher-level tool dispatch (called by mcp-server.js) ---
  //
  // These mirror the toolHandlers in the Chrome extension but produce the
  // same MCP response shape so callers can't tell which path served them.

  async dispatch(tool, args) {
    await this.connect();

    switch (tool) {
      case "computer":
        return this._dispatchComputer(args);
      case "javascript_tool":
        return this._dispatchJs(args);
      case "read_console_messages":
        return this._dispatchConsole(args);
      case "read_network_requests":
        return this._dispatchNetwork(args);
      case "resize_window":
        return this._dispatchResize(args);
      case "gif_creator":
        return { content: [{ type: "text", text: "GIF recording is not yet implemented in the BiDi sidecar." }] };
      case "upload_image":
        return { content: [{ type: "text", text: "Image upload via BiDi is not yet implemented. Use form_input to set a file input directly." }] };
      default:
        throw new Error(`bidi-driver does not handle tool "${tool}"`);
    }
  }

  async _dispatchComputer(args) {
    const ctx = await this.resolveContext(args);
    const action = args.action;
    const coord = args.coordinate;
    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64 } = await this.screenshot({ context: ctx, fullPage: false });
        const dimsR = await this.evaluate({ context: ctx, expression: "window.innerWidth + 'x' + window.innerHeight" });
        const dims = dimsR?.value || "?";
        return {
          content: [
            { type: "text", text: `Captured screenshot (${dims}, jpeg via BiDi)` },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      }
      case "left_click":
        if (!coord) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        await this.click({ context: ctx, x: coord[0], y: coord[1], button: 0, modifiers });
        return { content: [{ type: "text", text: `Clicked at (${coord[0]}, ${coord[1]})` }] };
      case "right_click":
        if (!coord) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await this.click({ context: ctx, x: coord[0], y: coord[1], button: 2, modifiers });
        return { content: [{ type: "text", text: `Right-clicked at (${coord[0]}, ${coord[1]})` }] };
      case "double_click":
        if (!coord) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await this.click({ context: ctx, x: coord[0], y: coord[1], button: 0, clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coord[0]}, ${coord[1]})` }] };
      case "triple_click":
        if (!coord) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await this.click({ context: ctx, x: coord[0], y: coord[1], button: 0, clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coord[0]}, ${coord[1]})` }] };
      case "hover":
        if (!coord) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await this._send("input.performActions", {
          context: ctx,
          actions: [{
            type: "pointer", id: "orellius-hover", parameters: { pointerType: "mouse" },
            actions: [{ type: "pointerMove", x: coord[0], y: coord[1], origin: "viewport", duration: 0 }],
          }],
        });
        return { content: [{ type: "text", text: `Hovered at (${coord[0]}, ${coord[1]})` }] };
      case "type":
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await this.typeText({ context: ctx, text: args.text });
        return { content: [{ type: "text", text: `Typed "${args.text.slice(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        const repeat = Math.min(args.repeat || 1, 100);
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, mods } = parseKeyCombo(keyStr);
            await this.pressKey({ context: ctx, key, modifiers: mods });
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }
      case "scroll": {
        if (!coord) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const dx = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const dy = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await this.scroll({ context: ctx, x: coord[0], y: coord[1], deltaX: dx, deltaY: dy });
        const { base64 } = await this.screenshot({ context: ctx });
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coord[0]}, ${coord[1]})` },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      }
      case "scroll_to":
        if (coord) {
          await this.evaluate({ context: ctx, expression: `window.scrollTo(${coord[0]}, ${coord[1]})` });
        }
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await new Promise((r) => setTimeout(r, duration * 1000));
        return { content: [{ type: "text", text: `Waited ${duration}s` }] };
      }
      case "left_click_drag": {
        if (!args.start_coordinate || !coord) return { content: [{ type: "text", text: "start_coordinate and coordinate are required" }] };
        await this.drag({ context: ctx, fromX: args.start_coordinate[0], fromY: args.start_coordinate[1], toX: coord[0], toY: coord[1] });
        return { content: [{ type: "text", text: `Dragged to (${coord[0]}, ${coord[1]})` }] };
      }
      case "zoom": {
        const { base64 } = await this.screenshot({ context: ctx });
        return {
          content: [
            { type: "text", text: `Zoom region: [${(args.region || []).join(", ")}]` },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      }
      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  }

  async _dispatchJs(args) {
    const ctx = await this.resolveContext(args);
    const r = await this.evaluate({ context: ctx, expression: args.text, awaitPromise: true });
    if (r?.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
    if (r?.value !== undefined) return { content: [{ type: "text", text: JSON.stringify(r.value) }] };
    return { content: [{ type: "text", text: r?.description || String(r) }] };
  }

  async _dispatchConsole(args) {
    const ctx = await this.resolveContext(args);
    let msgs = this.consoleByContext.get(ctx) || [];
    if (args.onlyErrors) msgs = msgs.filter((m) => ["error", "warn", "exception"].includes(m.level));
    if (args.pattern) {
      try {
        const re = new RegExp(args.pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        msgs = msgs.filter((m) => m.text.includes(args.pattern));
      }
    }
    const limit = args.limit || 100;
    msgs = msgs.slice(-limit);
    if (args.clear) this.consoleByContext.set(ctx, []);
    if (msgs.length === 0) return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    const text = msgs.map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`).join("\n");
    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  }

  async _dispatchNetwork(args) {
    const ctx = await this.resolveContext(args);
    let reqs = this.networkByContext.get(ctx) || [];
    if (args.urlPattern) reqs = reqs.filter((r) => r.url.includes(args.urlPattern));
    const limit = args.limit || 100;
    reqs = reqs.slice(-limit);
    if (args.clear) this.networkByContext.set(ctx, []);
    if (reqs.length === 0) return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    const text = reqs.map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`).join("\n");
    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  }

  async _dispatchResize(args) {
    const ctx = await this.resolveContext(args);
    await this.setViewport({ context: ctx, width: args.width, height: args.height });
    return { content: [{ type: "text", text: `Resized viewport to ${args.width}x${args.height}` }] };
  }
}

function flattenContexts(contexts, out = []) {
  for (const c of contexts) {
    out.push(c);
    if (c.children?.length) flattenContexts(c.children, out);
  }
  return out;
}

const KEY_MAP = {
  enter: "", return: "", tab: "", escape: "", esc: "",
  backspace: "", delete: "", space: " ",
  arrowup: "", arrowdown: "", arrowleft: "", arrowright: "",
  up: "", down: "", left: "", right: "",
  home: "", end: "", pageup: "", pagedown: "",
  shift: "", ctrl: "", control: "", alt: "", meta: "",
  cmd: "", command: "",
};

function parseKeyCombo(s) {
  const parts = s.split("+").map((p) => p.trim().toLowerCase());
  const mods = [];
  let key = "";
  for (const p of parts) {
    if (["ctrl", "control"].includes(p)) mods.push(KEY_MAP.ctrl);
    else if (p === "alt") mods.push(KEY_MAP.alt);
    else if (p === "shift") mods.push(KEY_MAP.shift);
    else if (["meta", "cmd", "command", "win", "windows"].includes(p)) mods.push(KEY_MAP.meta);
    else key = KEY_MAP[p] || p;
  }
  return { key, mods };
}

function parseModifierString(s) {
  if (!s) return [];
  const mods = [];
  for (const p of s.split("+").map((x) => x.trim().toLowerCase())) {
    if (["ctrl", "control"].includes(p)) mods.push(KEY_MAP.ctrl);
    else if (p === "alt") mods.push(KEY_MAP.alt);
    else if (p === "shift") mods.push(KEY_MAP.shift);
    else if (["meta", "cmd", "command", "win", "windows"].includes(p)) mods.push(KEY_MAP.meta);
  }
  return mods;
}

// --- Singleton ---
let driver = null;

export function getBidiDriver(opts) {
  if (!driver) driver = new BidiDriver(opts);
  return driver;
}

export { BidiDriver };
