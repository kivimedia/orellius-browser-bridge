// Thin CDP (Chrome DevTools Protocol) client over WebSocket.
//
// Used by the isolated MCP server so each Claude Code session can drive its own
// Chrome process directly without going through the extension or native host.

import WebSocket from "ws";

function log(msg) {
  process.stderr.write(`[iso-cdp ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

export class CdpBrowser {
  constructor(browserWsUrl) {
    this.browserWsUrl = browserWsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
    this.eventListeners = new Map();
    this.closed = false;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.browserWsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw) => this._onMessage(raw));
    this.ws.on("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      log(`bad CDP message: ${e.message}`);
      return;
    }
    if (msg.id !== undefined) {
      const target = msg.sessionId ? this.sessions.get(msg.sessionId)?.pending : this.pending;
      if (!target) return;
      const slot = target.get(msg.id);
      if (!slot) return;
      target.delete(msg.id);
      if (msg.error) slot.reject(new Error(`${msg.error.message} (CDP ${msg.error.code})`));
      else slot.resolve(msg.result);
      return;
    }
    const ev = msg.method;
    const handlers = this.eventListeners.get(ev);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn(msg.params, msg.sessionId);
        } catch (e) {
          log(`event handler ${ev} threw: ${e.message}`);
        }
      }
    }
    if (msg.sessionId) {
      const sess = this.sessions.get(msg.sessionId);
      if (sess) sess._dispatchEvent(ev, msg.params);
    }
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP closed"));
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(event, fn) {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  async attachToTarget(targetId) {
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    const sess = new PageSession(this, sessionId, targetId);
    this.sessions.set(sessionId, sess);
    return sess;
  }

  async createPageSession(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    return this.attachToTarget(targetId);
  }

  async listPageTargets() {
    const { targetInfos } = await this.send("Target.getTargets");
    return (targetInfos || []).filter((t) => t.type === "page");
  }

  async close() {
    if (this.ws && !this.closed) {
      try {
        this.ws.close();
      } catch {}
    }
    this.closed = true;
  }
}

export class PageSession {
  constructor(browser, sessionId, targetId) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.pending = new Map();
    this.eventListeners = new Map();
    this._lastMouse = { x: 0, y: 0 };
    this._modifierMap = { ctrl: 2, control: 2, shift: 8, alt: 1, meta: 4, cmd: 4, win: 4, windows: 4 };
  }

  send(method, params = {}) {
    if (this.browser.closed) return Promise.reject(new Error("CDP closed"));
    const id = this.browser.nextId++;
    const payload = JSON.stringify({ id, method, params, sessionId: this.sessionId });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.browser.ws.send(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  on(event, fn) {
    let set = this.eventListeners.get(event);
    if (!set) {
      set = new Set();
      this.eventListeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  _dispatchEvent(method, params) {
    const set = this.eventListeners.get(method);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(params);
      } catch (e) {
        log(`session ${this.sessionId} event ${method} handler threw: ${e.message}`);
      }
    }
  }

  parseModifiers(spec) {
    if (!spec) return 0;
    let m = 0;
    for (const part of String(spec).toLowerCase().split("+")) {
      const v = this._modifierMap[part.trim()];
      if (v) m |= v;
    }
    return m;
  }

  async navigate(url) {
    await this.send("Page.enable");
    const { errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw new Error(`navigate failed: ${errorText}`);
    await new Promise((resolve) => {
      let done = false;
      const off = this.on("Page.loadEventFired", () => {
        if (done) return;
        done = true;
        off();
        resolve();
      });
      setTimeout(() => {
        if (done) return;
        done = true;
        off();
        resolve();
      }, 8000);
    });
  }

  async screenshot({ format = "jpeg", quality = 80, fullPage = false } = {}) {
    const params = { format };
    if (format === "jpeg") params.quality = quality;
    if (fullPage) params.captureBeyondViewport = true;
    const { data } = await this.send("Page.captureScreenshot", params);
    return Buffer.from(data, "base64");
  }

  async getViewport() {
    const r = await this.send("Runtime.evaluate", {
      expression: "JSON.stringify({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})",
      returnByValue: true,
    });
    return JSON.parse(r.result.value);
  }

  async click({ x, y, button = "left", clickCount = 1, modifiers = 0 }) {
    this._lastMouse = { x, y };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount, modifiers });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount, modifiers });
  }

  async hover({ x, y }) {
    this._lastMouse = { x, y };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async scroll({ x, y, deltaX = 0, deltaY = 0 }) {
    this._lastMouse = { x, y };
    await this.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
  }

  async typeText(text) {
    await this.send("Input.insertText", { text });
  }

  async pressKey(key, modifiers = 0) {
    const KEY_MAP = {
      Enter: { code: "Enter", key: "Enter", windowsVirtualKeyCode: 13 },
      Tab: { code: "Tab", key: "Tab", windowsVirtualKeyCode: 9 },
      Escape: { code: "Escape", key: "Escape", windowsVirtualKeyCode: 27 },
      Backspace: { code: "Backspace", key: "Backspace", windowsVirtualKeyCode: 8 },
      Delete: { code: "Delete", key: "Delete", windowsVirtualKeyCode: 46 },
      ArrowLeft: { code: "ArrowLeft", key: "ArrowLeft", windowsVirtualKeyCode: 37 },
      ArrowUp: { code: "ArrowUp", key: "ArrowUp", windowsVirtualKeyCode: 38 },
      ArrowRight: { code: "ArrowRight", key: "ArrowRight", windowsVirtualKeyCode: 39 },
      ArrowDown: { code: "ArrowDown", key: "ArrowDown", windowsVirtualKeyCode: 40 },
      Home: { code: "Home", key: "Home", windowsVirtualKeyCode: 36 },
      End: { code: "End", key: "End", windowsVirtualKeyCode: 35 },
      PageUp: { code: "PageUp", key: "PageUp", windowsVirtualKeyCode: 33 },
      PageDown: { code: "PageDown", key: "PageDown", windowsVirtualKeyCode: 34 },
      Space: { code: "Space", key: " ", windowsVirtualKeyCode: 32 },
    };
    const def = KEY_MAP[key] || { key, code: key };
    const params = { ...def, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  }

  async pressShortcut(shortcut) {
    const parts = String(shortcut).split("+").map((s) => s.trim());
    const keyName = parts.pop();
    const mods = this.parseModifiers(parts.join("+"));
    await this.pressKey(keyName, mods);
  }

  async runtimeEvaluate(expression, { returnByValue = true, awaitPromise = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`runtime evaluate failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return returnByValue ? r.result.value : r.result;
  }

  async setViewport({ width, height, deviceScaleFactor = 1, mobile = false }) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });
  }

  async startScreencast({ format = "jpeg", quality = 80, maxWidth = 1280, maxHeight = 720, everyNthFrame = 2 } = {}) {
    await this.send("Page.enable");
    await this.send("Page.startScreencast", { format, quality, maxWidth, maxHeight, everyNthFrame });
  }

  async ackScreencastFrame(sessionFrameId) {
    await this.send("Page.screencastFrameAck", { sessionId: sessionFrameId });
  }

  async stopScreencast() {
    await this.send("Page.stopScreencast");
  }

  async detach() {
    try {
      await this.browser.send("Target.detachFromTarget", { sessionId: this.sessionId });
    } catch {}
    this.browser.sessions.delete(this.sessionId);
  }

  async close() {
    try {
      await this.browser.send("Target.closeTarget", { targetId: this.targetId });
    } catch {}
    this.browser.sessions.delete(this.sessionId);
  }
}
