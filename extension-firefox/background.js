// Background script (event page) for Orellius Browser Bridge - Firefox edition.
//
// Differences from Chrome version:
//  - No chrome.debugger / CDP. Tools that need trusted input, full-page
//    screenshots, console capture, or network capture are routed by
//    mcp-server.js to the host-side BiDi sidecar (host/bidi-driver.js)
//    instead of being forwarded to this extension.
//  - No chrome.tabGroups (Firefox has no equivalent). Per-session isolation
//    is enforced purely via dedicated windows (sessionWindows map).
//  - Background runs as an event page (manifest "scripts: [...]"), not a
//    service worker. Firefox MV3 still doesn't support service workers
//    (Bugzilla 1573659), so we use the legacy non-persistent script.
//
// Firefox supports both the chrome.* and browser.* namespaces; we keep the
// chrome.* prefix for symmetry with the Chrome build.

self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.orellius.browser_bridge";

function log(msg) {
  console.log(`[OrelliusFF] ${msg}`);
}

// --- Badge ---
function setBadge(status) {
  const config = {
    connected: { text: "ON", color: "#22c55e" },
    disconnected: { text: "OFF", color: "#ef4444" },
    connecting: { text: "...", color: "#f59e0b" },
  };
  const { text, color } = config[status] || config.disconnected;
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setTitle({ title: `Orellius (Firefox): ${status}` });
  } catch {}
}

// --- State ---
let nativePort = null;
let _currentSessionId = null;
const screenshotStore = new Map();

// Per-session window claim (mirrors Chrome version's logic, minus tabGroups).
const sessionWindows = new Map(); // sessionId -> windowId
const sessionTabs = new Map();    // sessionId -> Set<tabId>
const expectedOrelliusTabs = new Set();

function markOrelliusTab(tabId) {
  if (!tabId) return;
  expectedOrelliusTabs.add(tabId);
  setTimeout(() => expectedOrelliusTabs.delete(tabId), 5000);
}

function setSessionWindowId(sessionId, windowId) {
  if (!sessionId || windowId === undefined) return;
  sessionWindows.set(sessionId, windowId);
  log(`session ${sessionId} claimed window ${windowId}`);
}

function getSessionWindowId(sessionId) {
  return sessionId ? sessionWindows.get(sessionId) : undefined;
}

function getSessionTabs(sessionId) {
  if (!sessionId) return new Set();
  if (!sessionTabs.has(sessionId)) sessionTabs.set(sessionId, new Set());
  return sessionTabs.get(sessionId);
}

function findOwnerOfWindow(windowId) {
  for (const [sid, wid] of sessionWindows) {
    if (wid === windowId) return sid;
  }
  return null;
}

async function isInSession(tabId) {
  const sid = _currentSessionId;
  if (!sid) return true; // legacy: no session scoping
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.windowId === getSessionWindowId(sid);
  } catch {
    return false;
  }
}

// --- Tab locks (cross-session safety, same semantics as Chrome) ---
const tabLocks = new Map();
const LOCK_STORAGE_KEY = "orellius_tab_locks_v1";
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_EXTEND_MS = 2 * 60 * 1000;
const MODE_STORAGE_KEY = "orellius_mode_v1";
let defaultMode = "private";

function nowMs() { return Date.now(); }
function isLockExpired(lock) { return !lock || lock.expiresAt <= nowMs(); }

async function persistLocks() {
  const obj = {};
  for (const [tabId, lock] of tabLocks) obj[tabId] = lock;
  try { await chrome.storage.local.set({ [LOCK_STORAGE_KEY]: obj }); }
  catch (e) { log(`persistLocks failed: ${e.message}`); }
}

async function loadLocks() {
  try {
    const data = await chrome.storage.local.get(LOCK_STORAGE_KEY);
    const obj = data[LOCK_STORAGE_KEY] || {};
    for (const [tabId, lock] of Object.entries(obj)) {
      if (!isLockExpired(lock)) tabLocks.set(Number(tabId), lock);
    }
    log(`Loaded ${tabLocks.size} active tab locks`);
  } catch (e) { log(`loadLocks failed: ${e.message}`); }
}

async function loadDefaultMode() {
  try {
    const data = await chrome.storage.local.get(MODE_STORAGE_KEY);
    const stored = data[MODE_STORAGE_KEY];
    if (stored === "private" || stored === "public") defaultMode = stored;
    log(`defaultMode loaded: ${defaultMode}`);
  } catch (e) { log(`loadDefaultMode failed: ${e.message}`); }
}

function ensureLockOwnedByCurrentSession(tabId) {
  const lock = tabLocks.get(tabId);
  if (!lock || isLockExpired(lock)) {
    if (lock) { tabLocks.delete(tabId); persistLocks(); }
    return;
  }
  const mySid = _currentSessionId || "legacy";
  if (lock.sessionId !== mySid) {
    const remainingSec = Math.ceil((lock.expiresAt - nowMs()) / 1000);
    throw new Error(
      `Tab ${tabId} is locked by session "${lock.sessionId}" for another ${remainingSec}s. ` +
      `Wait or call browser_unlock with force:true.`
    );
  }
  const remaining = lock.expiresAt - nowMs();
  if (remaining < HEARTBEAT_EXTEND_MS) {
    lock.expiresAt = nowMs() + HEARTBEAT_EXTEND_MS;
    persistLocks();
  }
}

// --- Keep-alive ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && !nativePort) {
    log("Keepalive: native port null, reconnecting...");
    setBadge("connecting");
    connectNativeHost();
  }
});

// --- Native messaging ---
let connectAttempts = 0;

function connectNativeHost() {
  if (nativePort) return;
  connectAttempts++;
  log(`Connecting to native host (attempt #${connectAttempts})...`);
  setBadge("connecting");
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    setBadge("connected");
    connectAttempts = 0;

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === "registered") {
        log(`Hub acknowledged: ${msg.role}`);
        return;
      }
      if (msg.type === "tool_request" && msg.id) {
        const sid = msg.sessionId || null;
        log(`Tool request: ${msg.tool} (id ${msg.id}, session ${sid || "legacy"})`);
        handleToolRequest(msg.id, msg.tool, msg.args || {}, sid);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      log(`Native host disconnected: ${err?.message || "unknown"}`);
      nativePort = null;
      setBadge("disconnected");
      const delay = Math.min(2000 * Math.pow(2, Math.min(connectAttempts, 4)), 30000);
      setTimeout(connectNativeHost, delay);
    });
  } catch (e) {
    log(`connectNative threw: ${e.message}`);
    nativePort = null;
    setBadge("disconnected");
    const delay = Math.min(2000 * Math.pow(2, Math.min(connectAttempts, 4)), 30000);
    setTimeout(connectNativeHost, delay);
  }
}

function sendResponse(id, result) {
  if (!nativePort) { log(`No port for response ${id}`); return; }
  const msg = { id, type: "tool_response", result };
  if (_currentSessionId) msg.sessionId = _currentSessionId;
  try { nativePort.postMessage(msg); } catch (e) { log(`sendResponse failed: ${e.message}`); }
}

function sendError(id, error) {
  if (!nativePort) { log(`No port for error ${id}`); return; }
  const msg = { id, type: "tool_error", error: String(error) };
  if (_currentSessionId) msg.sessionId = _currentSessionId;
  try { nativePort.postMessage(msg); } catch (e) { log(`sendError failed: ${e.message}`); }
}

// --- Window/tab session helpers ---

async function ensureSessionWindow(createIfEmpty) {
  const sid = _currentSessionId;
  let wid = getSessionWindowId(sid);

  // If we have a claim, verify the window still exists.
  if (wid !== undefined) {
    try {
      await chrome.windows.get(wid);
      return wid;
    } catch {
      sessionWindows.delete(sid);
      if (sid) sessionTabs.delete(sid);
      wid = undefined;
    }
  }

  if (!createIfEmpty) return undefined;

  const wantFocus = defaultMode === "public";
  const win = await chrome.windows.create({ focused: wantFocus, url: "about:blank" });
  const tab = win.tabs[0];
  markOrelliusTab(tab.id);
  setSessionWindowId(sid, win.id);
  getSessionTabs(sid).add(tab.id);
  return win.id;
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));
  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  • tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }
  const manifest = chrome.runtime.getManifest();
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        availableTabs: available,
        windowId: getSessionWindowId(_currentSessionId),
        sessionId: _currentSessionId,
        extensionVersion: manifest.version,
        browser: "firefox",
      }) + "\n\n" + text,
    }],
  };
}

async function focusTabForInput(tabId, opts = {}) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    const wantPublic = opts.public ?? (defaultMode === "public");
    if (wantPublic && tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    log(`focusTabForInput(${tabId}) failed: ${e.message}`);
  }
}

// --- Cleanup listeners ---
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [, set] of sessionTabs) set.delete(tabId);
  if (tabLocks.delete(tabId)) persistLocks();
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [sid, wid] of sessionWindows) {
    if (wid === windowId) {
      sessionWindows.delete(sid);
      sessionTabs.delete(sid);
      log(`session ${sid} lost its window ${windowId}`);
    }
  }
});

// Auto-eject human-created tabs from session-owned windows (private mode only).
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.windowId || tab.id === undefined) return;
  const ownerSid = findOwnerOfWindow(tab.windowId);
  if (!ownerSid) return;
  if (expectedOrelliusTabs.has(tab.id)) return;

  setTimeout(async () => {
    if (expectedOrelliusTabs.has(tab.id)) return;
    if (getSessionTabs(ownerSid).has(tab.id)) return;
    if (defaultMode !== "private") return;
    try {
      const stillExists = await chrome.tabs.get(tab.id).catch(() => null);
      if (!stillExists) return;
      await chrome.windows.create({ tabId: tab.id, focused: true });
      log(`Moved human tab ${tab.id} out of session ${ownerSid}'s window`);
    } catch (e) {
      log(`Failed to move human tab ${tab.id}: ${e.message}`);
    }
  }, 250);
});

// --- Content script comms ---
async function sendContentMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Tools that this extension handles directly ---
//
// CDP-equivalent tools (computer, javascript_tool, read_console_messages,
// read_network_requests, resize_window, upload_image, gif_creator) are NOT
// handled here - mcp-server.js routes them to host/bidi-driver.js. If one
// of them shows up here it means the host's routing table is out of sync;
// we return a clear error so the bug is visible.

const BIDI_DELEGATED = new Set([
  "computer",
  "javascript_tool",
  "read_console_messages",
  "read_network_requests",
  "resize_window",
  "upload_image",
  "gif_creator",
]);

const toolHandlers = {
  async tabs_context_mcp(args) {
    const wid = await ensureSessionWindow(args.createIfEmpty);
    if (wid === undefined) {
      return { content: [{ type: "text", text: "No session window exists. Use createIfEmpty: true to create one." }] };
    }
    const tabs = await chrome.tabs.query({ windowId: wid });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    const wid = await ensureSessionWindow(true);
    const tab = await chrome.tabs.create({ windowId: wid, active: true });
    markOrelliusTab(tab.id);
    getSessionTabs(_currentSessionId).add(tab.id);
    const tabs = await chrome.tabs.query({ windowId: wid });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:")) {
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try { new URL(targetUrl); }
      catch { return { content: [{ type: "text", text: `Invalid URL: "${url}".` }] }; }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    const sid = _currentSessionId;
    const wid = getSessionWindowId(sid);
    const tabs = wid !== undefined ? await chrome.tabs.query({ windowId: wid }) : [tab];
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");
    return { content: [{ type: "text", text }] };
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, {
      type: "generateAccessibilityTree",
      options: {
        filter: args.filter,
        depth: args.depth,
        max_chars: args.max_chars,
        ref_id: args.ref_id,
      },
    });

    let tree = resp?.result || "Error: Could not generate accessibility tree";
    // Viewport via content script (no CDP available).
    try {
      const vp = await sendContentMessage(tabId, { type: "getViewport" });
      if (vp?.result) tree += `\n\nViewport: ${vp.result}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return { content: [{ type: "text", text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}` }] };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];
    if (results.length === 0) return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }
    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;
    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async shortcuts_list() {
    return { content: [{ type: "text", text: "No shortcuts available in the Firefox extension." }] };
  },

  async shortcuts_execute() {
    return { content: [{ type: "text", text: "Shortcuts are not supported in the Firefox extension." }] };
  },

  async switch_browser() {
    return { content: [{ type: "text", text: "Browser switching is handled by mcp-server.js, not the extension." }] };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) text += `- ${step}\n`;
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },

  async browser_lock(args) {
    const { tabId, ttl_seconds, force } = args;
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    const mySid = _currentSessionId || "legacy";
    const existing = tabLocks.get(tabId);
    const ttlMs = Math.max(30, Math.min(3600, ttl_seconds || DEFAULT_LOCK_TTL_MS / 1000)) * 1000;
    if (existing && !isLockExpired(existing) && existing.sessionId !== mySid && !force) {
      const remainingSec = Math.ceil((existing.expiresAt - nowMs()) / 1000);
      return { content: [{ type: "text", text: `Tab ${tabId} is locked by "${existing.sessionId}" for ${remainingSec}s. Pass force:true.` }] };
    }
    tabLocks.set(tabId, { sessionId: mySid, expiresAt: nowMs() + ttlMs });
    await persistLocks();
    return { content: [{ type: "text", text: `Locked tab ${tabId} to "${mySid}" for ${Math.round(ttlMs / 1000)}s.` }] };
  },

  async browser_unlock(args) {
    const { tabId, force } = args;
    const mySid = _currentSessionId || "legacy";
    const existing = tabLocks.get(tabId);
    if (!existing) return { content: [{ type: "text", text: `Tab ${tabId} is not locked.` }] };
    if (existing.sessionId !== mySid && !force) {
      return { content: [{ type: "text", text: `Tab ${tabId} is locked by "${existing.sessionId}". Pass force:true.` }] };
    }
    tabLocks.delete(tabId);
    await persistLocks();
    return { content: [{ type: "text", text: `Unlocked tab ${tabId}.` }] };
  },

  async browser_lock_status() {
    const mySid = _currentSessionId || "legacy";
    const lines = [];
    for (const [tabId, lock] of tabLocks) {
      if (isLockExpired(lock)) continue;
      const remainingSec = Math.ceil((lock.expiresAt - nowMs()) / 1000);
      const owner = lock.sessionId === mySid ? `${lock.sessionId} (you)` : lock.sessionId;
      lines.push(`Tab ${tabId}: locked by ${owner}, ${remainingSec}s remaining`);
    }
    const text = lines.length ? lines.join("\n") : "No active tab locks.";
    return { content: [{ type: "text", text }] };
  },

  async browser_focus_mode(args) { return await toolHandlers.browser_mode(args); },

  async browser_mode(args) {
    const { mode } = args || {};
    if (mode === undefined) {
      return { content: [{ type: "text", text:
        `Current default mode: "${defaultMode}". ` +
        `Pass mode:"private" (default, no focus grab) or mode:"public" (foreground every input).`
      }] };
    }
    const m = mode === "silent" ? "private" : mode === "active" ? "public" : mode;
    if (m !== "private" && m !== "public") {
      return { content: [{ type: "text", text: `Invalid mode "${mode}". Must be "private" or "public".` }] };
    }
    defaultMode = m;
    await chrome.storage.local.set({ [MODE_STORAGE_KEY]: m });
    return { content: [{ type: "text", text: `Mode set to "${m}".` }] };
  },

  async browser_show() {
    const sid = _currentSessionId;
    const wid = getSessionWindowId(sid);
    if (wid === undefined) return { content: [{ type: "text", text: `No window owned by session "${sid || 'legacy'}".` }] };
    try {
      await chrome.windows.update(wid, { focused: true, drawAttention: true });
      return { content: [{ type: "text", text: `Brought window ${wid} to foreground.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }] };
    }
  },

  async browser_hide() {
    const sid = _currentSessionId;
    const wid = getSessionWindowId(sid);
    if (wid === undefined) return { content: [{ type: "text", text: `No window owned by session "${sid || 'legacy'}".` }] };
    try {
      await chrome.windows.update(wid, { state: "minimized" });
      return { content: [{ type: "text", text: `Minimized window ${wid}.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }] };
    }
  },

  async tabs_close_mcp(args) {
    const { tabId, force } = args || {};
    if (typeof tabId !== "number") return { content: [{ type: "text", text: "tabs_close_mcp requires a numeric tabId." }] };
    if (!(await isInSession(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in this session's window.` }] };
    const mySid = _currentSessionId || "legacy";
    const lock = tabLocks.get(tabId);
    if (lock && !isLockExpired(lock) && lock.sessionId !== mySid && !force) {
      return { content: [{ type: "text", text: `Tab ${tabId} is locked by "${lock.sessionId}". Pass force:true.` }] };
    }
    try { await chrome.tabs.remove(tabId); }
    catch (e) { return { content: [{ type: "text", text: `Failed to close tab ${tabId}: ${e.message}` }] }; }
    if (tabLocks.delete(tabId)) await persistLocks();
    getSessionTabs(mySid).delete(tabId);
    const wid = getSessionWindowId(mySid);
    const remaining = wid !== undefined ? await chrome.tabs.query({ windowId: wid }).catch(() => []) : [];
    return { content: [{ type: "text", text: `Closed tab ${tabId}. ${remaining.length} tab(s) remain in this session's window.` }] };
  },

  async session_end(args) {
    const { force } = args || {};
    const sid = _currentSessionId || "legacy";
    const wid = getSessionWindowId(sid);
    if (wid === undefined) return { content: [{ type: "text", text: `Session "${sid}" has no owned window. Nothing to clean up.` }] };

    let tabsInWindow = [];
    try { tabsInWindow = await chrome.tabs.query({ windowId: wid }); }
    catch {
      sessionWindows.delete(sid);
      sessionTabs.delete(sid);
      return { content: [{ type: "text", text: `Window ${wid} was already closed. Released session "${sid}" claim.` }] };
    }

    if (!force) {
      const blocking = [];
      for (const t of tabsInWindow) {
        const lock = tabLocks.get(t.id);
        if (lock && !isLockExpired(lock) && lock.sessionId !== sid) blocking.push({ tabId: t.id, owner: lock.sessionId });
      }
      if (blocking.length) {
        const desc = blocking.map((b) => `tab ${b.tabId} -> ${b.owner}`).join(", ");
        return { content: [{ type: "text", text: `Refusing to end session: ${blocking.length} tab(s) locked by other sessions (${desc}). Pass force:true.` }] };
      }
    }

    let dropped = 0;
    for (const t of tabsInWindow) {
      if (tabLocks.delete(t.id)) dropped++;
    }
    if (dropped) await persistLocks();
    try { await chrome.windows.remove(wid); } catch {}
    sessionWindows.delete(sid);
    sessionTabs.delete(sid);
    return { content: [{ type: "text", text: `Ended session "${sid}". Closed window ${wid} (${tabsInWindow.length} tab(s)). Released ${dropped} lock(s).` }] };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args, sessionId) {
  _currentSessionId = sessionId;

  if (BIDI_DELEGATED.has(tool)) {
    sendError(id, `Tool "${tool}" must be routed to host BiDi sidecar by mcp-server.js, not forwarded to the Firefox extension. Routing bug.`);
    _currentSessionId = null;
    return;
  }

  const handler = toolHandlers[tool];
  if (!handler) {
    sendError(id, `Unknown tool: ${tool}`);
    _currentSessionId = null;
    return;
  }

  try {
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  } finally {
    _currentSessionId = null;
  }
}

// --- Init ---
log(`Background event page started (Firefox build, version ${chrome.runtime.getManifest().version})`);
setBadge("disconnected");
loadLocks();
loadDefaultMode();
connectNativeHost();
