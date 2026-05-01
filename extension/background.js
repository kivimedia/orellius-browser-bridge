// Background service worker for Orellius Browser Bridge extension.
// Handles: native messaging, CDP via chrome.debugger, tool dispatch, tab group management.

// Prevent unhandled rejections from killing the service worker
self.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});

const NATIVE_HOST_NAME = "com.orellius.browser_bridge";

// --- Debug logging ---
function log(msg) {
  console.log(`[BrowserBridge] ${msg}`);
}

// --- Badge status indicator ---
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
    chrome.action.setTitle({ title: `Browser Bridge: ${status}` });
  } catch {
    // action API may not be available during startup
  }
}

// --- State ---
let nativePort = null;

// Multi-session support: per-session tab groups
// Legacy single-session state kept as fallback for messages without sessionId
let tabGroupId = null;
let tabGroupTabs = new Set();
const sessionGroups = new Map(); // sessionId -> { tabGroupId, tabGroupTabs: Set }

const attachedTabs = new Map(); // tabId -> { enabledDomains: Set }
const consoleMessages = new Map(); // tabId -> [{level, text, timestamp, url}]
const networkRequests = new Map(); // tabId -> [{url, method, status, type, timestamp}]
const screenshotStore = new Map(); // imageId -> base64

// Track which sessionId is active for each tool request (threaded through dispatch)
let _currentSessionId = null;

// --- Keep-alive alarm ---
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (!nativePort) {
      log("Keepalive: native port is null, attempting reconnect...");
      setBadge("connecting");
      connectNativeHost();
    }
  }
});

// --- Native messaging ---
let connectAttempts = 0;

function connectNativeHost() {
  if (nativePort) return;
  connectAttempts++;
  const attempt = connectAttempts;
  log(`Connecting to native host "${NATIVE_HOST_NAME}" (attempt #${attempt})...`);
  setBadge("connecting");
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    log(`connectNative() returned successfully (attempt #${attempt})`);
    setBadge("connected");
    connectAttempts = 0;

    // Multi-browser handshake: tell the native host which browser we're
    // running in so the hub can route per-browser. Required for Chrome +
    // Firefox extensions to coexist on the same hub.
    try {
      nativePort.postMessage({ type: "init", browser: "chromium" });
    } catch (e) {
      log(`Failed to send init handshake: ${e.message}`);
    }

    nativePort.onMessage.addListener((msg) => {
      if (msg.type === "registered") {
        log(`Hub acknowledged: ${msg.role}`);
        return;
      }
      if (msg.type === "tool_request" && msg.id) {
        const sid = msg.sessionId || null;
        log(`Tool request: ${msg.tool} (id: ${msg.id}, session: ${sid || "legacy"})`);
        handleToolRequest(msg.id, msg.tool, msg.args || {}, sid);
      }
    });

    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      const reason = err ? err.message : "unknown reason";
      log(`Native host disconnected: ${reason}`);
      nativePort = null;
      setBadge("disconnected");
      // Retry with backoff: 2s, 4s, 8s, max 30s
      const delay = Math.min(2000 * Math.pow(2, Math.min(connectAttempts, 4)), 30000);
      log(`Will retry in ${delay / 1000}s...`);
      setTimeout(connectNativeHost, delay);
    });
  } catch (e) {
    log(`connectNative() threw: ${e.message}`);
    nativePort = null;
    setBadge("disconnected");
    const delay = Math.min(2000 * Math.pow(2, Math.min(connectAttempts, 4)), 30000);
    setTimeout(connectNativeHost, delay);
  }
}

function sendResponse(id, result) {
  if (!nativePort) {
    log(`Cannot send response for ${id}: native port is null`);
    return;
  }
  try {
    const msg = { id, type: "tool_response", result };
    if (_currentSessionId) msg.sessionId = _currentSessionId;
    nativePort.postMessage(msg);
  } catch (e) {
    log(`Failed to send response for ${id}: ${e.message}`);
  }
}

function sendError(id, error) {
  if (!nativePort) {
    log(`Cannot send error for ${id}: native port is null`);
    return;
  }
  try {
    log(`Sending error for ${id}: ${error}`);
    const msg = { id, type: "tool_error", error: String(error) };
    if (_currentSessionId) msg.sessionId = _currentSessionId;
    nativePort.postMessage(msg);
  } catch (e) {
    log(`Failed to send error for ${id}: ${e.message}`);
  }
}

// --- Tab group management (multi-session aware) ---

// Color palette for session tab groups
const SESSION_COLORS = ["blue", "cyan", "green", "yellow", "red", "pink", "purple", "orange"];
let sessionColorIdx = 0;

function getSessionState(sessionId) {
  if (!sessionId) return { tabGroupId, tabGroupTabs };
  if (!sessionGroups.has(sessionId)) {
    sessionGroups.set(sessionId, { tabGroupId: null, tabGroupTabs: new Set() });
  }
  return sessionGroups.get(sessionId);
}

async function ensureTabGroup(createIfEmpty) {
  const sessionId = _currentSessionId;
  const state = getSessionState(sessionId);

  // Check if this session's tab group still exists
  if (state.tabGroupId !== null) {
    try {
      const group = await chrome.tabGroups.get(state.tabGroupId);
      if (group) {
        const tabs = await chrome.tabs.query({ groupId: state.tabGroupId });
        state.tabGroupTabs = new Set(tabs.map((t) => t.id));
        if (state.tabGroupTabs.size > 0) {
          // Recover window ownership from the existing tab if we lost the
          // mapping (e.g. extension reload, service worker restart). ONLY
          // claim the window if every tab in it belongs to this session's
          // group - never claim a window that has the human's own tabs.
          if (sessionId && getSessionWindowId(sessionId) === undefined && tabs[0]?.windowId !== undefined) {
            const winTabs = await chrome.tabs.query({ windowId: tabs[0].windowId });
            const allOurs = winTabs.every((t) => state.tabGroupTabs.has(t.id));
            if (allOurs) {
              setSessionWindowId(sessionId, tabs[0].windowId);
            } else {
              log(`session ${sessionId} skipping window claim: window ${tabs[0].windowId} has ${winTabs.length - state.tabGroupTabs.size} non-session tabs`);
            }
          }
          // Sync legacy globals for backward compat
          if (!sessionId) { tabGroupId = state.tabGroupId; tabGroupTabs = state.tabGroupTabs; }
          return;
        }
      }
    } catch {
      state.tabGroupId = null;
      state.tabGroupTabs.clear();
    }
  }

  if (!createIfEmpty) return;

  // Create a new window with a tab, group it. The window opens in the
  // background (focused:false) by default so the human isn't interrupted -
  // this is the foundation of "private" mode. If the session wants the
  // window visible, it can call browser_show after.
  const wantFocus = defaultMode === "public";
  const win = await chrome.windows.create({ focused: wantFocus, url: "about:blank" });
  const tab = win.tabs[0];
  markOrelliusTab(tab.id);
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  // Label format: "🔒 Claude" + short session id. The lock emoji tells the
  // human "this window is owned by a Claude session, don't open new tabs in
  // it." Color stays per-session so concurrent sessions are visually distinct.
  const shortId = sessionId ? sessionId.slice(0, 8) : "";
  const label = sessionId ? `🔒 Claude · ${shortId}` : "MCP";
  const color = sessionId ? SESSION_COLORS[sessionColorIdx++ % SESSION_COLORS.length] : "blue";
  await chrome.tabGroups.update(groupId, { title: label, color });
  state.tabGroupId = groupId;
  state.tabGroupTabs = new Set([tab.id]);
  setSessionWindowId(sessionId, win.id);

  // Sync legacy globals
  if (!sessionId) { tabGroupId = groupId; tabGroupTabs = state.tabGroupTabs; }
}

function formatTabContext(tabs) {
  const available = tabs.map((t) => ({
    tabId: t.id,
    title: t.title || "Untitled",
    url: t.url || "",
  }));

  let text = `Tab Context:\n- Available tabs:\n`;
  for (const t of available) {
    text += `  \u2022 tabId ${t.tabId}: "${t.title}" (${t.url})\n`;
  }

  const manifest = chrome.runtime.getManifest();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          availableTabs: available,
          tabGroupId: getSessionState(_currentSessionId).tabGroupId,
          sessionId: _currentSessionId,
          extensionVersion: manifest.version,
        }) + "\n\n" + text,
      },
    ],
  };
}

async function isInGroup(tabId) {
  const sessionId = _currentSessionId;
  const state = getSessionState(sessionId);

  // Always check live state
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId !== -1) {
      // Recover session tab group if we lost it (service worker restart)
      if (state.tabGroupId === null) {
        try {
          const group = await chrome.tabGroups.get(tab.groupId);
          const expectedTitle = sessionId ? `MCP-${sessionId}` : "MCP";
          if (group.title === expectedTitle || group.title === "MCP") {
            state.tabGroupId = group.id;
            const groupTabs = await chrome.tabs.query({ groupId: state.tabGroupId });
            state.tabGroupTabs = new Set(groupTabs.map((t) => t.id));
            if (!sessionId) { tabGroupId = state.tabGroupId; tabGroupTabs = state.tabGroupTabs; }
          }
        } catch {}
      }
      return tab.groupId === state.tabGroupId;
    }
    return state.tabGroupTabs.has(tabId);
  } catch {
    return false;
  }
}

// --- CDP helpers ---
async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabs.set(tabId, { enabledDomains: new Set() });
  // Force devicePixelRatio to 1 so screenshots match CSS coordinate space.
  // Without this, Retina displays produce 2x screenshots and all coordinates are wrong.
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
    width: win.width,
    height: win.height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function ensureDomain(tabId, domain) {
  const state = attachedTabs.get(tabId);
  if (!state) throw new Error("Not attached to tab");
  if (state.enabledDomains.has(domain)) return;
  await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`, {});
  state.enabledDomains.add(domain);
}

// Track the last detach reason per tab so error messages can explain *why* a
// command failed (user clicked cancel, target closed, etc).
const lastDetachReason = new Map(); // tabId -> reason string

// --- Per-tab session locks ---
// Prevents two Claude Code instances sharing the same Orellius extension from
// racing on the same tab. Each tool handler that touches a tab consults this
// before acting; owned-tab heartbeats extend the TTL so active work keeps the
// lock alive without explicit renew calls.
const tabLocks = new Map(); // tabId -> { sessionId, expiresAt }
const LOCK_STORAGE_KEY = "orellius_tab_locks_v1";
const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_EXTEND_MS = 2 * 60 * 1000;   // each op extends to at least 2 min remaining

// Mode: "private" (default) | "public"
//   private: input ops only activate the target tab inside the session's owned
//     window. The OS window itself is NOT brought to the foreground. The human
//     can keep working in their own Chrome window or another desktop without
//     ever seeing Orellius interrupt them. Tab-activation-within-the-owned-
//     window is still required for CDP input dispatch, but since the human
//     isn't IN that window, they don't see it switch.
//   public: same as private PLUS chrome.windows.update({focused:true}) on the
//     session's owned window, so the OS window pops to the foreground. Use
//     this when the agent genuinely needs the human's eyes (showing something,
//     asking).
//
// Backward-compat aliases: "silent" -> "private", "active" -> "public".
//
// Persisted in chrome.storage.local. Per-call override available via the
// browser_show MCP tool which transiently goes public for one window-raise.
const MODE_STORAGE_KEY = "orellius_mode_v1";
const LEGACY_MODE_STORAGE_KEY = "orellius_focus_mode_v1";
let defaultMode = "private"; // "private" | "public"

function normalizeMode(mode) {
  if (mode === "silent") return "private";
  if (mode === "active") return "public";
  return mode;
}

async function loadDefaultMode() {
  try {
    // Prefer new key; fall back to legacy key for migration.
    const data = await chrome.storage.local.get([MODE_STORAGE_KEY, LEGACY_MODE_STORAGE_KEY]);
    const raw = data[MODE_STORAGE_KEY] ?? data[LEGACY_MODE_STORAGE_KEY];
    const stored = normalizeMode(raw);
    if (stored === "private" || stored === "public") {
      defaultMode = stored;
    }
    log(`defaultMode loaded: ${defaultMode}`);
  } catch (e) {
    log(`loadDefaultMode failed: ${e.message}`);
  }
}

async function setDefaultMode(mode) {
  const m = normalizeMode(mode);
  if (m !== "private" && m !== "public") {
    throw new Error(`Invalid mode "${mode}". Must be "private" or "public" (or legacy "silent"/"active").`);
  }
  defaultMode = m;
  await chrome.storage.local.set({ [MODE_STORAGE_KEY]: m });
  log(`defaultMode set: ${m}`);
}

// Per-session window claim. Each Claude session that creates an MCP tab group
// claims the Chrome window that group lives in. Other sessions cannot operate
// on tabs in that window. The session is free to open multiple tabs inside
// its owned window. Stored only in memory because Chrome window IDs are
// ephemeral - they die when the user closes the window.
const sessionWindows = new Map(); // sessionId -> windowId

// Tab IDs that Orellius itself just created (not the human). Used by the
// onCreated listener to distinguish our tabs from human-created Ctrl+T tabs
// in a session-owned window. Entries auto-expire after 5s, by which time the
// tab has been added to the session's tabGroupTabs and is tracked there.
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

// Returns the sessionId that owns this windowId, or null if unclaimed.
function findOwnerOfWindow(windowId) {
  for (const [sid, wid] of sessionWindows) {
    if (wid === windowId) return sid;
  }
  return null;
}

// Throws if the given tab lives in a window owned by a different session.
// Used as a guard before any tab-activation or input dispatch.
//
// Self-healing: if our session claims a window that no longer exists (the
// `onRemoved` listener can miss the event in some shutdown paths - e.g. host
// reboots, fast-quit-then-relaunch), we silently release the stale claim
// rather than throwing a confusing "user-owned window" error forever.
async function assertTabInOwnedWindow(tabId, tab) {
  const sid = _currentSessionId;
  if (!sid) return; // legacy/unscoped sessions skip the check
  if (!tab) tab = await chrome.tabs.get(tabId);
  let myWindow = getSessionWindowId(sid);
  if (myWindow !== undefined) {
    // Verify the claimed window still exists. If not, drop the stale claim.
    let stillExists = true;
    try {
      await chrome.windows.get(myWindow);
    } catch {
      stillExists = false;
    }
    if (!stillExists) {
      sessionWindows.delete(sid);
      log(`session ${sid} released stale claim on dead window ${myWindow} (self-heal)`);
      myWindow = undefined;
    }
  }
  if (myWindow !== undefined && tab.windowId !== myWindow) {
    const otherOwner = findOwnerOfWindow(tab.windowId);
    const ownerStr = otherOwner ? `session "${otherOwner}"` : "no session (user-owned window)";
    throw new Error(
      `Tab ${tabId} is in window ${tab.windowId}, which belongs to ${ownerStr}. ` +
      `This session ("${sid}") owns window ${myWindow}. Operate only on tabs in your own window.`
    );
  }
}

function nowMs() { return Date.now(); }

function isLockExpired(lock) {
  return !lock || lock.expiresAt <= nowMs();
}

async function persistLocks() {
  try {
    const obj = {};
    for (const [tabId, lock] of tabLocks) obj[tabId] = lock;
    await chrome.storage.local.set({ [LOCK_STORAGE_KEY]: obj });
  } catch (e) {
    log(`persistLocks failed: ${e.message}`);
  }
}

async function loadLocks() {
  try {
    const data = await chrome.storage.local.get(LOCK_STORAGE_KEY);
    const obj = data[LOCK_STORAGE_KEY] || {};
    for (const [tabId, lock] of Object.entries(obj)) {
      if (!isLockExpired(lock)) tabLocks.set(Number(tabId), lock);
    }
    log(`Loaded ${tabLocks.size} active tab locks from storage`);
  } catch (e) {
    log(`loadLocks failed: ${e.message}`);
  }
}

// Throws with a clear message if another session owns this tab. Refreshes the
// lock TTL (heartbeat) when the current session owns it, so active work keeps
// the lock alive automatically.
function ensureLockOwnedByCurrentSession(tabId) {
  const lock = tabLocks.get(tabId);
  if (!lock || isLockExpired(lock)) {
    if (lock && isLockExpired(lock)) {
      tabLocks.delete(tabId);
      persistLocks();
    }
    return; // no active lock - anyone may operate
  }
  const mySessionId = _currentSessionId || "legacy";
  if (lock.sessionId !== mySessionId) {
    const remainingSec = Math.ceil((lock.expiresAt - nowMs()) / 1000);
    throw new Error(
      `Tab ${tabId} is locked by session "${lock.sessionId}" for another ${remainingSec}s. ` +
      `The owning Claude Code session is still active. Wait for it to finish or ` +
      `call browser_unlock with force:true to override.`
    );
  }
  // Heartbeat: extend expiry if less than HEARTBEAT_EXTEND_MS remains.
  const remaining = lock.expiresAt - nowMs();
  if (remaining < HEARTBEAT_EXTEND_MS) {
    lock.expiresAt = nowMs() + HEARTBEAT_EXTEND_MS;
    persistLocks();
  }
}

// Errors from the CDP transport that are worth retrying once after a silent
// reattach. The debugger can transiently detach when a click triggers a
// navigation or a popover-rendering focus shift; a single retry recovers the
// next command (read-only ones only - see retriableCdp below).
const TRANSIENT_CDP_ERRORS = [
  "Detached while handling command",
  "Debugger is not attached",
  "No tab with given id",
  "Cannot access contents of",
  // CDP input events dispatch to the currently-focused tab in the window, not
  // the targeted tabId. When another extension injects a popup that steals
  // focus (common with password managers), the next input command fails with
  // this message referring to the *focused* tab, not our target.
  "Cannot access a chrome-extension:// URL of different extension",
];

function isTransientCdpError(err) {
  const msg = err?.message || String(err || "");
  return TRANSIENT_CDP_ERRORS.some((s) => msg.includes(s));
}

// CDP input events dispatch based on BOTH the focused window and its focused
// tab. Activating the tab isn't enough if Chrome has multiple windows - input
// still goes to whichever window is foregrounded.
//
// With per-session window claims (see sessionWindows above), the human is
// in their own Chrome window and Orellius drives a SEPARATE owned window.
// In private mode we activate the target tab within the owned window
// (mandatory for CDP input routing) but never call windows.update({focused})
// so the human's window stays foregrounded. The owned window's tab switches
// invisibly because the human isn't looking at it.
//
// In public mode we additionally bring the owned window to the foreground -
// use this when the agent needs the human's eyes (showing something, asking).
//
// Cross-session safety: assertTabInOwnedWindow throws if a session tries to
// activate a tab in another session's window. Without that guard, two
// concurrent sessions sharing a window would race tab activations and each
// would think their click went to the wrong tab.
async function focusTabForInput(tabId, opts = {}) {
  try {
    const tab = await chrome.tabs.get(tabId);
    await assertTabInOwnedWindow(tabId, tab);
    await chrome.tabs.update(tabId, { active: true });
    const wantPublic = opts.public ?? (defaultMode === "public");
    if (wantPublic && tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (e) {
    // Ownership errors are programmer errors (caller acted on wrong window) -
    // re-throw so the tool returns a clear message instead of silently
    // operating on the wrong tab.
    if (e.message && e.message.includes("belongs to")) throw e;
    log(`focusTabForInput(${tabId}) failed: ${e.message}`);
  }
}

async function cdp(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// Retry wrapper for READ-ONLY CDP calls (screenshots, Runtime.evaluate, etc.).
// MUST NOT be used for input dispatch - retrying a click could double-fire it.
async function retriableCdp(tabId, method, params = {}) {
  try {
    return await cdp(tabId, method, params);
  } catch (err) {
    if (!isTransientCdpError(err)) throw err;
    const reason = lastDetachReason.get(tabId) || "unknown";
    log(`Transient CDP failure on ${method} (tab ${tabId}, last detach: ${reason}). Reattaching and retrying once.`);
    attachedTabs.delete(tabId);
    try { chrome.debugger.detach({ tabId }); } catch {}
    await sleep(100);
    await ensureAttached(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabGroupTabs.delete(tabId);
  // Also clean from all session groups
  for (const [, state] of sessionGroups) {
    state.tabGroupTabs.delete(tabId);
  }
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
  consoleMessages.delete(tabId);
  networkRequests.delete(tabId);
  lastDetachReason.delete(tabId);
  if (tabLocks.delete(tabId)) persistLocks();
});

// Drop window ownership when the human (or a script) closes the owned window.
// Without this, a session whose window died would still be marked as owning
// that windowId; re-creating a tab group would skip window creation and try
// to operate on a stale window.
chrome.windows.onRemoved.addListener((windowId) => {
  for (const [sid, wid] of sessionWindows) {
    if (wid === windowId) {
      sessionWindows.delete(sid);
      log(`session ${sid} lost its window ${windowId} (window closed)`);
    }
  }
});

// Auto-move human-created tabs out of session-owned windows. The contract for
// "private" mode: the human can peek at our window, can close it, but cannot
// open new tabs in it - those would interfere with our work. Ctrl+T or "+"
// click results in a new tab being detached into its own window, preserving
// the human's intent without disrupting our session.
//
// We distinguish Orellius-created tabs from human-created ones via the
// expectedOrelliusTabs set (populated by markOrelliusTab when our code
// creates a tab). The 250ms delay below gives our own create+group flow
// time to mark the tab; longer than the typical event ordering race window
// (50-100ms) but short enough that the human barely notices the tab popping
// out into a new window.
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.windowId || tab.id === undefined) return;
  // Bail fast if no session owns this window.
  const ownerSid = findOwnerOfWindow(tab.windowId);
  if (!ownerSid) return;
  // Bail fast if Orellius itself just created this tab.
  if (expectedOrelliusTabs.has(tab.id)) return;

  // Defer the verdict so our own create+group flow (which races with this
  // event) has time to mark the tab. After the delay, re-check ownership
  // markers: expectedOrelliusTabs flag, or membership in the session's
  // tabGroupTabs set.
  setTimeout(async () => {
    if (expectedOrelliusTabs.has(tab.id)) return; // ours after all
    const state = sessionGroups.get(ownerSid);
    if (state?.tabGroupTabs.has(tab.id)) return; // already grouped as ours
    if (defaultMode !== "private") return; // public mode - don't fight the human

    // Human created a tab in our owned window. Pop it into its own window.
    try {
      const stillExists = await chrome.tabs.get(tab.id).catch(() => null);
      if (!stillExists) return;
      await chrome.windows.create({ tabId: tab.id, focused: true });
      log(`Moved human-created tab ${tab.id} out of session "${ownerSid}"'s owned window ${tab.windowId} into a new window`);
    } catch (e) {
      log(`Failed to move human-created tab ${tab.id} out of owned window: ${e.message}`);
    }
  }, 250);
});

// Log detach reason so transient vs. user-initiated detaches are diagnosable
// from the service worker console. Reasons: target_closed, canceled_by_user,
// replaced_with_devtools, restored.
chrome.debugger.onDetach.addListener((source, reason) => {
  lastDetachReason.set(source.tabId, reason);
  attachedTabs.delete(source.tabId);
  log(`Debugger detached from tab ${source.tabId}: ${reason}`);
});

// --- CDP event listeners for console and network ---
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;

  if (method === "Console.messageAdded" && params.message) {
    const msgs = consoleMessages.get(tabId) || [];
    msgs.push({
      level: params.message.level,
      text: params.message.text,
      url: params.message.url || "",
      timestamp: Date.now(),
    });
    // Keep last 1000
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Runtime.consoleAPICalled" && params.args) {
    const msgs = consoleMessages.get(tabId) || [];
    const text = params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    msgs.push({
      level: params.type || "log",
      text,
      url: params.stackTrace?.callFrames?.[0]?.url || "",
      timestamp: Date.now(),
    });
    if (msgs.length > 1000) msgs.splice(0, msgs.length - 1000);
    consoleMessages.set(tabId, msgs);
  }

  if (method === "Network.responseReceived" && params.response) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.response.url,
      method: params.response.requestHeaders ? "?" : "GET",
      status: params.response.status,
      statusText: params.response.statusText,
      type: params.type || "Other",
      mimeType: params.response.mimeType,
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }

  if (method === "Network.requestWillBeSent" && params.request) {
    const reqs = networkRequests.get(tabId) || [];
    reqs.push({
      url: params.request.url,
      method: params.request.method,
      status: 0,
      type: params.type || "Other",
      timestamp: Date.now(),
    });
    if (reqs.length > 1000) reqs.splice(0, reqs.length - 1000);
    networkRequests.set(tabId, reqs);
  }
});

// --- Key code mapping ---
const KEY_MAP = {
  enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", space: "Space", " ": "Space",
  arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
  f1: "F1", f2: "F2", f3: "F3", f4: "F4", f5: "F5", f6: "F6",
  f7: "F7", f8: "F8", f9: "F9", f10: "F10", f11: "F11", f12: "F12",
};

function parseKeyCombo(keyStr) {
  const parts = keyStr.split("+").map((p) => p.trim().toLowerCase());
  let modifiers = 0;
  let key = "";
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
    else key = KEY_MAP[part] || part;
  }
  return { key, modifiers };
}

function parseModifierString(modStr) {
  if (!modStr) return 0;
  let modifiers = 0;
  const parts = modStr.split("+").map((p) => p.trim().toLowerCase());
  for (const part of parts) {
    if (part === "ctrl" || part === "control") modifiers |= 2;
    else if (part === "alt") modifiers |= 1;
    else if (part === "shift") modifiers |= 8;
    else if (part === "meta" || part === "cmd" || part === "command" || part === "win" || part === "windows") modifiers |= 4;
  }
  return modifiers;
}

// --- Content script communication ---
async function sendContentMessage(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, message);
    return response;
  } catch {
    // Content script might not be injected yet, try injecting
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
    // Retry
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// --- Resolve ref to coordinates ---
async function resolveRefToCoordinates(tabId, ref) {
  const resp = await sendContentMessage(tabId, { type: "getRefCoordinates", ref });
  if (resp?.result) return [resp.result.x, resp.result.y];
  return null;
}

// --- Screenshot helper ---
// Cap viewport to 1280x800 for screenshots to keep size manageable.
// Retina displays produce 2x+ resolution PNGs that blow up base64 size.
const MAX_SCREENSHOT_WIDTH = 1280;
const MAX_SCREENSHOT_HEIGHT = 800;

async function takeScreenshot(tabId) {
  // Always refocus the target before capture. Some pages trigger focus-
  // stealing side effects (Radix portals, Google Sign-In iframes, etc.) that
  // make the CDP path refuse subsequent commands.
  await focusTabForInput(tabId);

  // Try CDP first (faster, supports beyondViewport). If attach OR the command
  // fails, drop straight through to the captureVisibleTab fallback. Wrapping
  // both attach and sendCommand in the try is critical - on this-tab-is-
  // another-extension errors, the attach itself throws before any command
  // runs, so leaving ensureAttached outside the try skips the fallback.
  let base64;
  let cdpError = null;
  try {
    await ensureAttached(tabId);
    const result = await retriableCdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 55,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    });
    base64 = result.data;
  } catch (err) {
    cdpError = err;
    log(`Page.captureScreenshot path failed (${err.message}); attempting tabs.captureVisibleTab fallback.`);
  }

  // Fallback path when CDP refuses this tab (typical post-popover state).
  // tabs.captureVisibleTab uses the <all_urls> host permission instead of the
  // debugger attachment, so it still works after a CDP detach. Retry with
  // refocus between attempts - if another extension is stealing focus, we
  // might need several tries to land a capture while our tab has focus.
  if (!base64) {
    let fallbackErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await focusTabForInput(tabId);
          await sleep(150);
        }
        const tab = await chrome.tabs.get(tabId);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 55 });
        base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        log(`Screenshot succeeded via captureVisibleTab fallback (attempt ${attempt + 1}).`);
        fallbackErr = null;
        break;
      } catch (e) {
        fallbackErr = e;
        log(`captureVisibleTab attempt ${attempt + 1} failed: ${e.message}`);
      }
    }
    if (!base64) {
      throw new Error(`Screenshot failed via both paths. CDP: ${cdpError?.message || "unknown"}. Fallback (3 attempts): ${fallbackErr?.message || "unknown"}`);
    }
  }

  // If still too large (>500KB base64 ≈ ~375KB binary), reduce quality further
  if (base64.length > 500000) {
    const smaller = await retriableCdp(tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 30,
      optimizeForSpeed: true,
      captureBeyondViewport: false,
    }).catch(() => null);
    if (smaller?.data) base64 = smaller.data;
  }

  const imageId = `screenshot_${Date.now()}`;
  screenshotStore.set(imageId, base64);
  // Keep only last 10 screenshots (less memory pressure)
  const keys = Array.from(screenshotStore.keys());
  while (keys.length > 10) {
    screenshotStore.delete(keys.shift());
  }

  return { base64, imageId };
}

// --- Mouse helpers ---
async function dispatchMouse(tabId, type, x, y, opts = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: opts.button || "left",
    clickCount: opts.clickCount || 1,
    modifiers: opts.modifiers || 0,
  });
}

async function mouseClick(tabId, x, y, opts = {}) {
  const button = opts.button || "left";
  const clickCount = opts.clickCount || 1;
  const modifiers = opts.modifiers || 0;

  // Guarantee the target tab has focus before dispatching input events.
  // Without this, focus-stealing extensions (password managers, popups) cause
  // input to land in the wrong tab or raise the "different extension" error.
  await focusTabForInput(tabId);

  // Stage-aware error handling: knowing which CDP call failed tells the caller
  // whether the click had any effect on the page. A detach between press and
  // release is the common popover/navigation-focus case - the press already
  // fired, so the click is effectively done even though release errored.
  try {
    await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
  } catch (err) {
    if (isTransientCdpError(err)) {
      // move didn't fire - tab state changed since the last command. One
      // reattach-and-retry is safe since mouseMoved has no side effects.
      const reason = lastDetachReason.get(tabId) || "transient";
      log(`Click at (${x}, ${y}): mouseMoved failed (${err.message}, last detach: ${reason}), refocusing + reattaching.`);
      attachedTabs.delete(tabId);
      try { chrome.debugger.detach({ tabId }); } catch {}
      await sleep(100);
      await focusTabForInput(tabId);
      await ensureAttached(tabId);
      await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
    } else {
      throw err;
    }
  }
  await sleep(50);
  try {
    await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
  } catch (err) {
    if (isTransientCdpError(err)) {
      // press failed - reattach and retry once. If the press already partially
      // fired before the detach, worst case is a duplicate press event, which
      // browsers coalesce into a single click.
      const reason = lastDetachReason.get(tabId) || "transient";
      log(`Click at (${x}, ${y}): mousePressed failed (${err.message}, last detach: ${reason}), refocusing + reattaching.`);
      attachedTabs.delete(tabId);
      try { chrome.debugger.detach({ tabId }); } catch {}
      await sleep(100);
      await focusTabForInput(tabId);
      await ensureAttached(tabId);
      await dispatchMouse(tabId, "mouseMoved", x, y, { modifiers });
      await sleep(50);
      await dispatchMouse(tabId, "mousePressed", x, y, { button, clickCount, modifiers });
    } else {
      throw err;
    }
  }
  await sleep(50);
  try {
    await dispatchMouse(tabId, "mouseReleased", x, y, { button, clickCount, modifiers });
  } catch (err) {
    // Release-phase detach: press already fired, so the click is effectively
    // complete from the page's perspective. Log but don't treat as fatal -
    // callers can take a fresh screenshot to see the new state.
    if (isTransientCdpError(err)) {
      const reason = lastDetachReason.get(tabId) || "transient";
      log(`Click at (${x}, ${y}) released after debugger detach (${reason}). Click likely took effect; reattaching.`);
      attachedTabs.delete(tabId);
      try { chrome.debugger.detach({ tabId }); } catch {}
      await sleep(150);
      await ensureAttached(tabId);
      return;
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Tool handlers ---
const toolHandlers = {
  async tabs_context_mcp(args) {
    await ensureTabGroup(args.createIfEmpty);
    const state = getSessionState(_currentSessionId);
    if (state.tabGroupId === null) {
      return {
        content: [{ type: "text", text: "No MCP tab group exists. Use createIfEmpty: true to create one." }],
      };
    }
    const tabs = await chrome.tabs.query({ groupId: state.tabGroupId });
    return formatTabContext(tabs);
  },

  async tabs_create_mcp(args) {
    await ensureTabGroup(true);
    const state = getSessionState(_currentSessionId);
    const ownedWindowId = getSessionWindowId(_currentSessionId);
    // Create the tab inside our owned window so the auto-move listener
    // doesn't kick the new tab out the moment we create it.
    const createOpts = { active: true };
    if (ownedWindowId !== undefined) createOpts.windowId = ownedWindowId;
    const tab = await chrome.tabs.create(createOpts);
    markOrelliusTab(tab.id);
    await chrome.tabs.group({ tabIds: [tab.id], groupId: state.tabGroupId });
    state.tabGroupTabs.add(tab.id);
    const tabs = await chrome.tabs.query({ groupId: state.tabGroupId });
    const result = formatTabContext(tabs);
    result.content[0].text = `Created new tab. Tab ID: ${tab.id}\n\n` + result.content[0].text;
    return result;
  },

  async navigate(args) {
    const { url, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    if (url === "back") {
      await chrome.tabs.goBack(tabId);
    } else if (url === "forward") {
      await chrome.tabs.goForward(tabId);
    } else {
      let targetUrl = url;
      // Strip any malformed protocol prefix before normalizing
      if (!targetUrl.match(/^https?:\/\//i) && !targetUrl.startsWith("about:") && !targetUrl.startsWith("chrome:") && !targetUrl.startsWith("brave:")) {
        // Remove any partial/broken protocol prefix (e.g., "hps://", "http:/", "ht://")
        targetUrl = targetUrl.replace(/^[a-z]{1,5}:\/+/i, "");
        targetUrl = "https://" + targetUrl;
      }
      try {
        new URL(targetUrl); // Validate URL before passing to Chrome
      } catch {
        return { content: [{ type: "text", text: `Invalid URL: "${url}". Could not parse as a valid URL.` }] };
      }
      await chrome.tabs.update(tabId, { url: targetUrl });
    }

    // Wait for page load — short timeout to avoid service worker idle kill
    // If the page takes longer, the caller can use screenshot/wait to check
    await new Promise((resolve) => {
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // 10s max — enough for most pages, avoids service worker timeout
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    const tab = await chrome.tabs.get(tabId);
    const sessionState = getSessionState(_currentSessionId);
    const groupIdForQuery = sessionState.tabGroupId || tabGroupId;
    const tabs = groupIdForQuery ? await chrome.tabs.query({ groupId: groupIdForQuery }) : [tab];
    const loading = tab.status !== "complete" ? " (still loading)" : "";
    const text = `Navigated to ${tab.url}${loading}.\n## Pages\n` +
      tabs.map((t, i) => `${i + 1}: ${t.url}${t.id === tabId ? " [selected]" : ""}`).join("\n");

    return { content: [{ type: "text", text }] };
  },

  async computer(args) {
    const { action, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    let coordinate = args.coordinate;
    // Resolve ref to coordinates if provided
    if (args.ref && !coordinate) {
      const coords = await resolveRefToCoordinates(tabId, args.ref);
      if (!coords) return { content: [{ type: "text", text: `Could not resolve ref "${args.ref}" to coordinates.` }] };
      coordinate = coords;
    }

    const modifiers = parseModifierString(args.modifiers);

    switch (action) {
      case "screenshot": {
        const { base64, imageId } = await takeScreenshot(tabId);
        // Get viewport dimensions for the response message
        let dims = "";
        try {
          const vp = await cdp(tabId, "Runtime.evaluate", {
            expression: "window.innerWidth + 'x' + window.innerHeight",
          });
          if (vp?.result?.value) dims = vp.result.value;
        } catch {}
        return {
          content: [
            { type: "text", text: `Successfully captured screenshot (${dims}, jpeg) - ID: ${imageId}` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "left_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for left_click" }] };
        try {
          await mouseClick(tabId, coordinate[0], coordinate[1], { modifiers });
          return { content: [{ type: "text", text: `Clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
        } catch (err) {
          // When OS-level input is blocked by focus stealing across windows,
          // fall back to synthetic JS events on the ref. Only works for ref-
          // based clicks (not raw coordinates) since we need a DOM element.
          if (args.ref && err?.message?.includes("chrome-extension")) {
            log(`left_click CDP path blocked (${err.message}); falling back to synthClick via content script.`);
            const resp = await sendContentMessage(tabId, { type: "synthClick", ref: args.ref });
            if (resp?.result?.ok) {
              return { content: [{ type: "text", text: `Clicked (synthetic) at (${resp.result.x}, ${resp.result.y})` }] };
            }
            throw new Error(`CDP click failed (${err.message}) and synthClick fallback also failed: ${resp?.result?.error || "no response"}`);
          }
          throw err;
        }
      }

      case "right_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for right_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { button: "right", modifiers });
        return { content: [{ type: "text", text: `Right-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "double_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for double_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 2, modifiers });
        return { content: [{ type: "text", text: `Double-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "triple_click": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for triple_click" }] };
        await mouseClick(tabId, coordinate[0], coordinate[1], { clickCount: 3, modifiers });
        return { content: [{ type: "text", text: `Triple-clicked at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "hover": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for hover" }] };
        await dispatchMouse(tabId, "mouseMoved", coordinate[0], coordinate[1], { modifiers });
        await sleep(200);
        return { content: [{ type: "text", text: `Hovered at (${coordinate[0]}, ${coordinate[1]})` }] };
      }

      case "type": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for type action" }] };
        await focusTabForInput(tabId);
        await ensureAttached(tabId);
        // Type character by character for better compatibility
        for (const char of args.text) {
          await cdp(tabId, "Input.insertText", { text: char });
          await sleep(10);
        }
        return { content: [{ type: "text", text: `Typed "${args.text.substring(0, 50)}${args.text.length > 50 ? "..." : ""}"` }] };
      }

      case "key": {
        if (!args.text) return { content: [{ type: "text", text: "text is required for key action" }] };
        await focusTabForInput(tabId);
        await ensureAttached(tabId);
        const repeat = Math.min(args.repeat || 1, 100);
        // Parse space-separated key combos
        const keys = args.text.split(" ").filter(Boolean);
        for (let r = 0; r < repeat; r++) {
          for (const keyStr of keys) {
            const { key, modifiers: keyMod } = parseKeyCombo(keyStr);
            const resolvedKey = key.length === 1 ? key : key;
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyDown",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
              windowsVirtualKeyCode: resolvedKey.charCodeAt ? resolvedKey.charCodeAt(0) : 0,
            });
            await cdp(tabId, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key: resolvedKey,
              code: resolvedKey.length === 1 ? `Key${resolvedKey.toUpperCase()}` : resolvedKey,
              modifiers: keyMod,
            });
            await sleep(30);
          }
        }
        return { content: [{ type: "text", text: `Pressed ${repeat} key${repeat > 1 ? "s" : ""}: ${args.text}` }] };
      }

      case "scroll": {
        if (!coordinate) return { content: [{ type: "text", text: "coordinate is required for scroll" }] };
        const dir = args.scroll_direction || "down";
        const amount = Math.min(args.scroll_amount || 3, 10);
        const deltaX = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
        const deltaY = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
        await cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: coordinate[0],
          y: coordinate[1],
          deltaX,
          deltaY,
          modifiers,
        });
        await sleep(300);
        const { base64 } = await takeScreenshot(tabId);
        return {
          content: [
            { type: "text", text: `Scrolled ${dir} by ${amount} ticks at (${coordinate[0]}, ${coordinate[1]})` },
            { type: "image", data: base64, mimeType: "image/jpeg" },
          ],
        };
      }

      case "scroll_to": {
        if (!coordinate && !args.ref) return { content: [{ type: "text", text: "coordinate or ref is required for scroll_to" }] };
        if (args.ref) {
          await sendContentMessage(tabId, {
            type: "scrollToRef",
            ref: args.ref,
          });
        }
        // Scroll target element into view via JS
        if (coordinate) {
          await cdp(tabId, "Runtime.evaluate", {
            expression: `window.scrollTo(${coordinate[0]}, ${coordinate[1]})`,
          });
        }
        await sleep(300);
        return { content: [{ type: "text", text: `Scrolled to target` }] };
      }

      case "wait": {
        const duration = Math.min(args.duration || 1, 30);
        await sleep(duration * 1000);
        return { content: [{ type: "text", text: `Waited for ${duration} second${duration !== 1 ? "s" : ""}` }] };
      }

      case "left_click_drag": {
        if (!args.start_coordinate || !coordinate) {
          return { content: [{ type: "text", text: "start_coordinate and coordinate are required for left_click_drag" }] };
        }
        const [sx, sy] = args.start_coordinate;
        const [ex, ey] = coordinate;
        await dispatchMouse(tabId, "mouseMoved", sx, sy, { modifiers });
        await sleep(50);
        await dispatchMouse(tabId, "mousePressed", sx, sy, { button: "left", modifiers });
        await sleep(50);
        // Move in steps
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const mx = sx + ((ex - sx) * i) / steps;
          const my = sy + ((ey - sy) * i) / steps;
          await dispatchMouse(tabId, "mouseMoved", mx, my, { modifiers });
          await sleep(20);
        }
        await dispatchMouse(tabId, "mouseReleased", ex, ey, { button: "left", modifiers });
        return { content: [{ type: "text", text: `Dragged from (${sx}, ${sy}) to (${ex}, ${ey})` }] };
      }

      case "zoom": {
        if (!args.region || args.region.length !== 4) {
          return { content: [{ type: "text", text: "region [x0, y0, x1, y1] is required for zoom" }] };
        }
        // Capture full screenshot then crop region
        const { base64: fullBase64 } = await takeScreenshot(tabId);
        // Return the full screenshot with region info — client can crop
        return {
          content: [
            { type: "text", text: `Zoom region: [${args.region.join(", ")}]` },
            { type: "image", data: fullBase64, mimeType: "image/png" },
          ],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown computer action: ${action}` }] };
    }
  },

  async read_page(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
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
    // Append viewport dimensions so Claude knows the coordinate space
    try {
      await ensureAttached(tabId);
      const vp = await cdp(tabId, "Runtime.evaluate", {
        expression: "window.innerWidth + 'x' + window.innerHeight",
      });
      if (vp?.result?.value) tree += `\n\nViewport: ${vp.result.value}`;
    } catch {}
    return { content: [{ type: "text", text: tree }] };
  },

  async get_page_text(args) {
    const { tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, { type: "getPageText" });
    if (!resp?.result) return { content: [{ type: "text", text: "Error: Could not extract page text" }] };

    try {
      const data = JSON.parse(resp.result);
      return {
        content: [
          {
            type: "text",
            text: `Title: ${data.title}\nURL: ${data.url}\nSource: <${data.sourceTag}>\n\n${data.text}`,
          },
        ],
      };
    } catch {
      return { content: [{ type: "text", text: resp.result }] };
    }
  },

  async find(args) {
    const { query, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, { type: "findElements", query });
    const results = resp?.result || [];

    if (results.length === 0) {
      return { content: [{ type: "text", text: `No elements found matching "${query}"` }] };
    }

    let text = `Found ${results.length} element(s) matching "${query}":\n\n`;
    for (const r of results) {
      text += `[${r.ref}] ${r.role} "${r.name}" at (${r.coordinates[0]}, ${r.coordinates[1]})\n`;
    }

    return { content: [{ type: "text", text }] };
  },

  async form_input(args) {
    const { ref, value, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const resp = await sendContentMessage(tabId, { type: "setFormValue", ref, value });
    const result = resp?.result;

    if (result?.error) return { content: [{ type: "text", text: `Error: ${result.error}` }] };
    return { content: [{ type: "text", text: `Set ${ref} to "${value}". Result: ${JSON.stringify(result)}` }] };
  },

  async javascript_tool(args) {
    const { text, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    await ensureAttached(tabId);
    try {
      const result = await retriableCdp(tabId, "Runtime.evaluate", {
        expression: text,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        return {
          content: [{ type: "text", text: `Error: ${result.exceptionDetails.text || JSON.stringify(result.exceptionDetails)}` }],
        };
      }

      const val = result.result;
      if (val.type === "undefined") return { content: [{ type: "text", text: "undefined" }] };
      return {
        content: [{ type: "text", text: val.value !== undefined ? JSON.stringify(val.value) : val.description || String(val) }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },

  async read_console_messages(args) {
    const { tabId, pattern, limit = 100, onlyErrors, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    // Ensure console domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Console");
    await ensureDomain(tabId, "Runtime");

    let msgs = consoleMessages.get(tabId) || [];

    if (onlyErrors) {
      msgs = msgs.filter((m) => ["error", "exception"].includes(m.level));
    }

    if (pattern) {
      try {
        const re = new RegExp(pattern, "i");
        msgs = msgs.filter((m) => re.test(m.text) || re.test(m.level));
      } catch {
        // Invalid regex, use as substring
        msgs = msgs.filter((m) => m.text.includes(pattern));
      }
    }

    msgs = msgs.slice(-limit);

    if (clear) {
      consoleMessages.set(tabId, []);
    }

    if (msgs.length === 0) {
      return { content: [{ type: "text", text: "No console messages matching the pattern." }] };
    }

    const text = msgs
      .map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Console messages (${msgs.length}):\n${text}` }] };
  },

  async read_network_requests(args) {
    const { tabId, urlPattern, limit = 100, clear } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    // Ensure network domain is enabled
    await ensureAttached(tabId);
    await ensureDomain(tabId, "Network");

    let reqs = networkRequests.get(tabId) || [];

    if (urlPattern) {
      reqs = reqs.filter((r) => r.url.includes(urlPattern));
    }

    reqs = reqs.slice(-limit);

    if (clear) {
      networkRequests.set(tabId, []);
    }

    if (reqs.length === 0) {
      return { content: [{ type: "text", text: "No network requests matching the pattern." }] };
    }

    const text = reqs
      .map((r) => `${r.method} ${r.url} ${r.status ? `→ ${r.status}` : "(pending)"}${r.mimeType ? ` [${r.mimeType}]` : ""}`)
      .join("\n");

    return { content: [{ type: "text", text: `Network requests (${reqs.length}):\n${text}` }] };
  },

  async resize_window(args) {
    const { width, height, tabId } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { width, height });
    return { content: [{ type: "text", text: `Resized window to ${width}x${height}` }] };
  },

  async download_screenshot(args) {
    // Look up a previously-captured screenshot by imageId and return its
    // base64 + mime so the host can write it to disk. Useful when an agent
    // realizes after the fact that a screenshot is worth keeping (e.g.,
    // building a guide / tutorial from the last several captures). No tab
    // required — the screenshotStore is session-scoped to the extension,
    // not to a tab.
    const { imageId } = args || {};
    if (!imageId) {
      return { content: [{ type: "text", text: "imageId is required." }] };
    }
    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      const known = Array.from(screenshotStore.keys());
      return { content: [{ type: "text", text: `Screenshot ${imageId} not found in cache. Last 10 imageIds in store: ${known.length ? known.join(", ") : "(empty)"}.` }] };
    }
    return {
      content: [
        { type: "text", text: `Found screenshot ${imageId} (${base64.length} base64 chars).` },
        { type: "image", data: base64, mimeType: "image/jpeg" },
      ],
    };
  },

  async upload_image(args) {
    const { imageId, tabId, ref, coordinate, filename = "image.png" } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    try { ensureLockOwnedByCurrentSession(tabId); } catch (e) { return { content: [{ type: "text", text: e.message }] }; }

    const base64 = screenshotStore.get(imageId);
    if (!base64) {
      return { content: [{ type: "text", text: `Image ${imageId} not found. Take a screenshot first.` }] };
    }

    // Use CDP to set file input
    if (ref) {
      // Find the element and set its files via CDP
      await ensureAttached(tabId);
      const result = await cdp(tabId, "Runtime.evaluate", {
        expression: `(() => {
          const el = window.__orelliusBrowserBridge?.resolveRef?.("${ref}");
          if (!el) return null;
          return el.tagName.toLowerCase();
        })()`,
        returnByValue: true,
      });

      if (result.result?.value === "input") {
        // For file inputs, we need DOM.setFileInputFiles via CDP
        // First get the node
        const doc = await cdp(tabId, "DOM.getDocument", {});
        const nodeResult = await cdp(tabId, "Runtime.evaluate", {
          expression: `(() => {
            const el = window.__orelliusBrowserBridge?.resolveRef?.("${ref}");
            if (el) el.scrollIntoView();
            return true;
          })()`,
          returnByValue: true,
        });
        return { content: [{ type: "text", text: `Upload via file input requires a temporary file. Use the file input directly.` }] };
      }
    }

    return { content: [{ type: "text", text: `Image upload for ref=${ref}, coordinate=${coordinate} — use drag & drop or file input.` }] };
  },

  async gif_creator(args) {
    return { content: [{ type: "text", text: "GIF recording is not yet implemented in this extension." }] };
  },

  async shortcuts_list(args) {
    return { content: [{ type: "text", text: "No shortcuts available. Shortcuts are not supported in this extension." }] };
  },

  async shortcuts_execute(args) {
    return { content: [{ type: "text", text: "Shortcuts are not supported in this extension." }] };
  },

  async switch_browser(args) {
    return { content: [{ type: "text", text: "Browser switching is not yet supported. The extension connects to whichever browser has it loaded (Chrome, Brave, or Edge). To switch, disable the extension in the current browser, enable it in the target browser, and restart both." }] };
  },

  async update_plan(args) {
    const { domains, approach } = args;
    let text = `Plan:\n\nDomains: ${domains.join(", ")}\n\nApproach:\n`;
    for (const step of approach) {
      text += `- ${step}\n`;
    }
    text += "\nPlan auto-approved (no permission restrictions in this extension).";
    return { content: [{ type: "text", text }] };
  },

  async browser_lock(args) {
    const { tabId, ttl_seconds, force } = args;
    if (!(await isInGroup(tabId))) return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    const mySessionId = _currentSessionId || "legacy";
    const existing = tabLocks.get(tabId);
    const ttlMs = Math.max(30, Math.min(3600, ttl_seconds || DEFAULT_LOCK_TTL_MS / 1000)) * 1000;
    if (existing && !isLockExpired(existing) && existing.sessionId !== mySessionId && !force) {
      const remainingSec = Math.ceil((existing.expiresAt - nowMs()) / 1000);
      return { content: [{ type: "text", text: `Tab ${tabId} is already locked by session "${existing.sessionId}" for another ${remainingSec}s. Pass force:true to override.` }] };
    }
    const lock = { sessionId: mySessionId, expiresAt: nowMs() + ttlMs };
    tabLocks.set(tabId, lock);
    await persistLocks();
    return { content: [{ type: "text", text: `Locked tab ${tabId} to session "${mySessionId}" for ${Math.round(ttlMs / 1000)}s. Lock will auto-extend on each tool call from this session.` }] };
  },

  async browser_unlock(args) {
    const { tabId, force } = args;
    const mySessionId = _currentSessionId || "legacy";
    const existing = tabLocks.get(tabId);
    if (!existing) return { content: [{ type: "text", text: `Tab ${tabId} is not locked.` }] };
    if (existing.sessionId !== mySessionId && !force) {
      return { content: [{ type: "text", text: `Tab ${tabId} is locked by session "${existing.sessionId}", not yours. Pass force:true to break the lock.` }] };
    }
    tabLocks.delete(tabId);
    await persistLocks();
    return { content: [{ type: "text", text: `Unlocked tab ${tabId}.` }] };
  },

  async browser_lock_status(args) {
    const mySessionId = _currentSessionId || "legacy";
    const lines = [];
    for (const [tabId, lock] of tabLocks) {
      if (isLockExpired(lock)) continue;
      const remainingSec = Math.ceil((lock.expiresAt - nowMs()) / 1000);
      const owner = lock.sessionId === mySessionId ? `${lock.sessionId} (you)` : lock.sessionId;
      lines.push(`Tab ${tabId}: locked by ${owner}, ${remainingSec}s remaining`);
    }
    const text = lines.length ? lines.join("\n") : "No active tab locks.";
    return { content: [{ type: "text", text }] };
  },

  async browser_focus_mode(args) {
    // Backward-compat alias for browser_mode. Accepts "silent"/"active"
    // and translates to "private"/"public".
    return await toolHandlers.browser_mode(args);
  },

  async browser_mode(args) {
    const { mode } = args || {};
    if (mode === undefined) {
      return { content: [{ type: "text", text:
        `Current default mode: "${defaultMode}". ` +
        `Pass mode:"private" so Orellius operates without grabbing your window focus (default), ` +
        `or mode:"public" to bring its window to the foreground on every input.`
      }] };
    }
    try {
      await setDefaultMode(mode);
      const m = normalizeMode(mode);
      const explanation = m === "private"
        ? "Orellius will activate the target tab inside its own owned window but will NOT bring that window to the foreground. You can keep working in another window or desktop without interruption. Use browser_show when you want the agent to surface its window once."
        : "Orellius will activate the target tab AND bring its owned window to the foreground on every input. The window will pop up over your work each time the agent acts. Switch back to private when you want quiet.";
      return { content: [{ type: "text", text: `Mode set to "${m}". ${explanation}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed: ${e.message}` }] };
    }
  },

  async browser_show(args) {
    // One-shot: bring the calling session's owned window to the foreground.
    // Use when the agent needs the human's eyes (showing a result, asking a
    // question). Does not change the default mode - next input op respects
    // whatever mode is set.
    const sid = _currentSessionId;
    const wid = getSessionWindowId(sid);
    if (wid === undefined) {
      return { content: [{ type: "text", text:
        `No window owned by session "${sid || 'legacy'}". Create a tab group first via tabs_context_mcp(createIfEmpty:true).`
      }] };
    }
    try {
      await chrome.windows.update(wid, { focused: true, drawAttention: true });
      return { content: [{ type: "text", text: `Brought window ${wid} (session "${sid}") to the foreground.` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to show window ${wid}: ${e.message}` }] };
    }
  },

  async browser_hide(args) {
    // One-shot: send the calling session's owned window to the background
    // without closing it. Useful after you've shown the human something and
    // want to return to private operation immediately.
    const sid = _currentSessionId;
    const wid = getSessionWindowId(sid);
    if (wid === undefined) {
      return { content: [{ type: "text", text: `No window owned by session "${sid || 'legacy'}".` }] };
    }
    try {
      await chrome.windows.update(wid, { state: "minimized" });
      return { content: [{ type: "text", text: `Minimized window ${wid} (session "${sid}").` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to hide window ${wid}: ${e.message}` }] };
    }
  },

  async tabs_close_mcp(args) {
    const { tabId, force } = args || {};
    if (typeof tabId !== "number") {
      return { content: [{ type: "text", text: "tabs_close_mcp requires a numeric tabId." }] };
    }
    if (!(await isInGroup(tabId))) {
      return { content: [{ type: "text", text: `Tab ${tabId} is not in the MCP group.` }] };
    }
    const mySid = _currentSessionId || "legacy";
    const lock = tabLocks.get(tabId);
    if (lock && !isLockExpired(lock) && lock.sessionId !== mySid && !force) {
      return { content: [{ type: "text", text:
        `Tab ${tabId} is locked by session "${lock.sessionId}". Pass force:true to close it anyway.`
      }] };
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to close tab ${tabId}: ${e.message}` }] };
    }
    if (tabLocks.delete(tabId)) await persistLocks();
    for (const [, state] of sessionGroups) state.tabGroupTabs.delete(tabId);
    const myState = sessionGroups.get(mySid);
    const remaining = myState?.tabGroupId
      ? await chrome.tabs.query({ groupId: myState.tabGroupId }).catch(() => [])
      : [];
    return { content: [{ type: "text", text:
      `Closed tab ${tabId}. ${remaining.length} tab(s) remain in this session's MCP group.`
    }] };
  },

  async session_end(args) {
    const { force } = args || {};
    const sid = _currentSessionId || "legacy";
    const wid = getSessionWindowId(sid);
    if (wid === undefined) {
      return { content: [{ type: "text", text:
        `Session "${sid}" has no owned window to end. Nothing to clean up.`
      }] };
    }
    let tabsInWindow = [];
    try {
      tabsInWindow = await chrome.tabs.query({ windowId: wid });
    } catch (e) {
      // Window already gone - just drop our claim and return.
      sessionWindows.delete(sid);
      sessionGroups.delete(sid);
      return { content: [{ type: "text", text:
        `Window ${wid} was already closed. Released session "${sid}" claim.`
      }] };
    }
    if (!force) {
      const blockingLocks = [];
      for (const t of tabsInWindow) {
        const lock = tabLocks.get(t.id);
        if (lock && !isLockExpired(lock) && lock.sessionId !== sid) {
          blockingLocks.push({ tabId: t.id, owner: lock.sessionId });
        }
      }
      if (blockingLocks.length) {
        const desc = blockingLocks.map((b) => `tab ${b.tabId} -> ${b.owner}`).join(", ");
        return { content: [{ type: "text", text:
          `Refusing to end session: ${blockingLocks.length} tab(s) are locked by other sessions (${desc}). Pass force:true to override.`
        }] };
      }
    }
    let droppedLocks = 0;
    for (const t of tabsInWindow) {
      if (tabLocks.delete(t.id)) droppedLocks++;
    }
    if (droppedLocks) await persistLocks();
    try {
      await chrome.windows.remove(wid);
    } catch (e) {
      // Window vanished between our query and the remove - that's fine.
    }
    sessionWindows.delete(sid);
    sessionGroups.delete(sid);
    return { content: [{ type: "text", text:
      `Ended session "${sid}". Closed window ${wid} (${tabsInWindow.length} tab(s)). Released ${droppedLocks} lock(s). Session claim cleared.`
    }] };
  },
};

// --- Tool dispatch ---
async function handleToolRequest(id, tool, args, sessionId) {
  const handler = toolHandlers[tool];
  if (!handler) {
    _currentSessionId = sessionId;
    sendError(id, `Unknown tool: ${tool}`);
    _currentSessionId = null;
    return;
  }

  try {
    // Set session context for the duration of this tool call
    _currentSessionId = sessionId;
    const result = await handler(args);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, `${tool} failed: ${err.message}`);
  } finally {
    _currentSessionId = null;
  }
}

// --- Init ---

// Recover MCP tab group state after service worker restart
async function recoverTabGroupState() {
  try {
    // Recover all MCP tab groups (legacy "MCP" and session-specific "MCP-xxx")
    const allGroups = await chrome.tabGroups.query({});
    for (const group of allGroups) {
      if (!group.title?.startsWith("MCP")) continue;
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const tabSet = new Set(tabs.map((t) => t.id));

      if (group.title === "MCP") {
        // Legacy single-session group
        tabGroupId = group.id;
        tabGroupTabs = tabSet;
      } else if (group.title.startsWith("MCP-")) {
        // Session-specific group
        const sid = group.title.slice(4);
        sessionGroups.set(sid, { tabGroupId: group.id, tabGroupTabs: tabSet });
      }
    }
    log(`Recovered ${sessionGroups.size} session groups + ${tabGroupId ? 1 : 0} legacy group`);
  } catch {
    // Not critical - will be set on first tabs_context_mcp call
  }
}

log("Service worker started");
setBadge("disconnected");
recoverTabGroupState();
loadLocks();
loadDefaultMode();
connectNativeHost();
