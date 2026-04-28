# Close-tab tooling for Orellius

## Goal

Give Claude sessions an explicit way to clean up after themselves. Today, every conversation that uses Orellius leaves an orphan tab + window behind. Over a workday this accumulates dozens of dead "MCP" tab groups across Chrome.

## Approach

Two new MCP tools + one optional auto-cleanup flag.

### Tool 1: `tabs_close_mcp`

Close a single tab inside the calling session's MCP group.

- Args: `tabId` (required, number), `force` (optional, bool)
- Refuses if the tab holds an active `browser_lock` from a different session, unless `force: true`
- Removes the tab. If it was the last tab in the owned window, the window stays open with a fresh `about:blank` so the session retains its claim. Caller decides whether to also call `session_end`.
- Returns `{ ok: true, closedTabId, remainingTabs }` or an error.

### Tool 2: `session_end`

Close every tab in the calling session's owned window, close the window, drop the session's claim.

- Args: `force` (optional, bool) - bypass any locks held by this session
- Steps:
  1. Iterate tabs in the owned window. For each: skip-or-close depending on lock state. If any lock from a different session, fail unless `force: true`.
  2. `chrome.windows.remove(ownedWindowId)`
  3. Drop the session's window claim from in-memory state + persisted state
  4. Return `{ ok: true, closedTabs: N, windowId }`
- After this, the session's stored snapshot is preserved (so `session_restore` still works) but the window is gone.

### Auto-cleanup on disconnect (opt-in)

Add a config flag `auto_close_on_disconnect: false` (default).

- Read from `~/.config/orellius-browser-bridge/config.json` (already-existing config dir)
- When `true`: the existing `process.stdin.on("end", shutdown)` handler ALSO fires `session_end` before exiting
- Default `false` so this doesn't surprise anyone whose workflow leaves windows open intentionally

## Files to modify

- `extension/background.js` - add `tabs_close_mcp` and `session_end` message handlers. Both call `chrome.tabs.remove` / `chrome.windows.remove`. Respect lock state from the existing lock map.
- `host/mcp-server.js` - register two new MCP tools (numbers 28 and 29, after `browser_hide`). Wire `auto_close_on_disconnect` into the stdin-close hook.
- `host/config.js` (or wherever config lives) - add `auto_close_on_disconnect` reader. If config module doesn't exist yet, do a minimal inline read.
- `README.md` - document the two new tools in the tool table, mention auto-cleanup flag.

## Verification

- Local sanity: `node --check host/mcp-server.js`
- Manual: open a session, create a tab via `tabs_context_mcp(createIfEmpty:true)`, verify tab+window appear in Chrome, call `session_end`, verify both disappear.
- Lock interaction: lock a tab, try `session_end` without force - should fail. Retry with `force:true` - should succeed.

## Open questions

- Should `session_end` be idempotent? If called twice, second call returns "already ended" instead of error - probably yes.
- Should `tabs_close_mcp` accept multiple `tabIds` in one call (array)? Probably yes for convenience, single-tab is just the array of length 1.
