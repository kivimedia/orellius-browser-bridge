# Session Persistence & Healing - Design Doc

## Problem
When the browser crashes or the extension restarts, all active MCP sessions lose context:
- Tab groups disappear
- Open tabs/URLs are lost
- Claude loses track of what it was doing
- User has to manually explain context again

## Solution
**Persistent session state** with automatic recovery on reconnection.

---

## Architecture

### 1. Session State Schema
```json
{
  "sessionId": "abc123",
  "created": 1713580800000,
  "lastSnapshot": 1713581000000,
  "tabGroup": {
    "id": 123,
    "color": "blue",
    "title": "MCP Session abc123"
  },
  "tabs": [
    {
      "id": 456,
      "url": "https://example.com",
      "title": "Example Domain",
      "active": true,
      "screenshot": "data:image/png;base64,..."
    }
  ],
  "context": {
    "lastTool": "navigate",
    "workingOn": "Reddit post automation",
    "plan": ["Open reddit", "Find subreddit", "Post comment"]
  }
}
```

### 2. Storage Layer
**File:** `~/.config/orellius-browser-bridge/sessions/<sessionId>.json`

**Operations:**
- `saveSnapshot(sessionId, state)` - write to disk
- `loadSnapshot(sessionId)` - read from disk
- `listSessions()` - enumerate all saved sessions
- `pruneOldSessions(maxAge)` - cleanup (default: 7 days)

### 3. Auto-Snapshot Triggers
- **On tool completion** - after each successful tool call
- **Periodic** - every 30s if tabs changed
- **On disconnect** - emergency save before connection drops
- **Manual** - new `snapshot_save` tool

### 4. Recovery Flow

#### On MCP Client Connect:
1. Check if a session snapshot exists for this `sessionId`
2. If yes, offer recovery:
   ```
   Previous session found (2 tabs, last active 5 min ago).
   Resume? (y/n)
   ```
3. If accepted:
   - Restore tab group (create if missing)
   - Reopen tabs at saved URLs
   - Attach debugger to each tab
   - Return context summary to Claude

#### On Browser Crash:
1. Extension service worker restarts
2. Scans for orphaned tab groups matching session IDs
3. Keeps them alive (don't auto-close)
4. When MCP client reconnects, offers recovery

---

## Implementation Plan

### Phase 1: Basic Persistence (this PR)
- [x] Session state schema
- [ ] Snapshot storage (JSON files)
- [ ] Auto-save on tool completion
- [ ] Recovery prompt on reconnect
- [ ] `tabs_context_mcp` returns recovery status

### Phase 2: Enhanced Recovery
- [ ] Screenshot thumbnails in recovery prompt
- [ ] Partial recovery (pick which tabs to restore)
- [ ] Cookie/localStorage backup (optional, security-sensitive)
- [ ] Recovery UI in extension popup

### Phase 3: Cross-Browser Session Transfer
- [ ] Export session to portable format
- [ ] Import into different browser profile
- [ ] Share session state between Claude Code instances

---

## Security Considerations

### What Gets Saved
✅ **Safe to persist:**
- Tab URLs
- Tab titles
- Tab group metadata
- Session ID
- Tool call history (redacted args)

⚠️ **Optional (user consent required):**
- Screenshots (may contain sensitive data)
- Page text extracts

❌ **Never persist:**
- Cookies (use browser's built-in session restore)
- localStorage tokens
- Form field values
- JavaScript execution results

### Storage Location
`~/.config/orellius-browser-bridge/sessions/` with `0600` permissions (owner-only read/write).

---

## New MCP Tools

### `session_save`
Manually trigger a snapshot save.
```json
{
  "name": "session_save",
  "description": "Save current session state to disk for crash recovery",
  "parameters": {
    "note": "Optional note about what you're working on"
  }
}
```

### `session_restore`
List and restore previous sessions.
```json
{
  "name": "session_restore",
  "description": "Restore a previous session from snapshot",
  "parameters": {
    "sessionId": "Optional - if omitted, lists available sessions"
  }
}
```

### `session_prune`
Cleanup old session files.
```json
{
  "name": "session_prune",
  "description": "Delete session snapshots older than N days",
  "parameters": {
    "maxAgeDays": 7
  }
}
```

---

## Modified Tools

### `tabs_context_mcp` (enhanced)
Add recovery status to response:
```json
{
  "tabs": [...],
  "recovery": {
    "available": true,
    "sessionId": "abc123",
    "lastSnapshot": "2024-04-20T04:30:00Z",
    "tabCount": 3,
    "lastNote": "Working on Reddit automation"
  }
}
```

---

## Edge Cases

### Stale Tab IDs
- Tab IDs change after browser restart
- **Solution:** Match by URL + position in group, not by ID
- Store URL as primary key, ID as hint

### Multiple Sessions, Same Browser
- User runs two Claude Code instances
- **Solution:** Each session gets its own tab group color + unique snapshot file
- Recovery prompts are per-session, non-blocking

### Expired Tab Groups
- Browser auto-closes empty tab groups
- **Solution:** On recovery, recreate group if missing, then restore tabs

---

## Testing Checklist

- [ ] Save/restore single tab
- [ ] Save/restore multiple tabs
- [ ] Browser crash → reconnect → auto-recovery prompt
- [ ] Extension restart (service worker killed) → recovery
- [ ] Two sessions in parallel (no cross-contamination)
- [ ] Old session cleanup (7+ days)
- [ ] Permission denied on snapshot directory (graceful fail)
- [ ] Snapshot corruption (invalid JSON) → skip recovery, log error

---

## Rollout

1. Merge storage layer + auto-save (non-blocking)
2. Test in dev for 1 week
3. Add recovery prompt (opt-in via config flag)
4. Enable by default after proven stable
5. Add UI polish (extension popup)

---

## Config

`~/.config/orellius-browser-bridge/config.json`:
```json
{
  "port": 18765,
  "session": {
    "enablePersistence": true,
    "snapshotIntervalSeconds": 30,
    "maxAgeDays": 7,
    "autoRestore": true,
    "saveScreenshots": false
  }
}
```

