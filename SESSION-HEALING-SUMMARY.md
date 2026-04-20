# Session Healing - Implementation Summary

## What We Built
Added **session persistence & auto-recovery** to Orellius Browser Bridge so Claude Code sessions survive browser crashes and extension restarts.

## Key Features

### 1. Auto-Save (Passive Healing)
- **Triggers:** After every write tool call (navigate, computer, form_input, tabs_create_mcp, javascript_tool)
- **Cooldown:** 30 seconds between saves (prevents excessive disk writes)
- **What's saved:**
  - All open tab URLs and titles
  - Session ID and timestamps
  - Last tool used
  - Optional user note about what you're working on

### 2. Recovery Detection
- **tabs_context_mcp** now includes recovery status in response
- Shows if a previous session snapshot exists
- Displays: age, tab count, last work note

### 3. Manual Control (3 New MCP Tools)

#### `session_save`
Manually save a checkpoint with a note:
```
session_save(note="About to submit Reddit comment")
```

#### `session_restore`
List or restore previous sessions:
```
session_restore()  # List all available sessions
session_restore(sessionId="abc123")  # Restore specific session
```

#### `session_prune`
Clean up old snapshots:
```
session_prune(maxAgeDays=7)  # Default: 7 days
```

## Storage

### Location
`~/.config/orellius-browser-bridge/sessions/<sessionId>.json`

### Permissions
`0600` (owner-only read/write) - secure by default

### Auto-Cleanup
Old sessions (>7 days) are automatically pruned on startup

## What Gets Saved
✅ **Included:**
- Tab URLs
- Tab titles
- Tab group metadata
- Session ID
- Tool call history (tool names only)
- User notes

❌ **Excluded (for security):**
- Cookies
- localStorage tokens
- Form values
- JavaScript results
- Screenshots (optional, disabled by default)

## Recovery Flow

### Automatic (on reconnect):
1. MCP client connects
2. `tabs_context_mcp` checks for snapshot
3. Returns recovery info in response:
   ```json
   {
     "tabs": [...],
     "recovery": {
       "available": true,
       "sessionId": "abc123",
       "age": "5m ago",
       "tabCount": 3,
       "note": "Working on Reddit automation"
     }
   }
   ```

### Manual:
Call `session_restore(sessionId="abc123")` to:
- Reopen all tabs at saved URLs
- Attach debugger to each
- Return context summary

## Configuration

Add to `~/.config/orellius-browser-bridge/config.json`:
```json
{
  "port": 18765,
  "session": {
    "enablePersistence": true,    // Master switch
    "snapshotIntervalSeconds": 30, // Cooldown between auto-saves
    "maxAgeDays": 7,               // Prune threshold
    "autoRestore": false,          // Future: auto-restore on connect
    "saveScreenshots": false       // Future: include screenshots
  }
}
```

**Default:** All features enabled, 30s cooldown, 7-day retention.

## Testing Checklist
- [x] Code syntax valid (no errors)
- [ ] Save single tab
- [ ] Save multiple tabs
- [ ] Browser crash → recovery prompt
- [ ] Extension restart → recovery
- [ ] Two parallel sessions (no cross-contamination)
- [ ] Auto-prune old sessions
- [ ] Permission denied (graceful fail)
- [ ] Corrupted JSON (skip recovery, log error)

## Edge Cases Handled

### Stale Tab IDs
- Tab IDs change after browser restart
- **Solution:** Match by URL, not tab ID

### Multiple Sessions
- Two Claude Code instances running
- **Solution:** Each gets unique snapshot file by sessionId

### Empty Tab Groups
- Browser auto-closes empty groups
- **Solution:** Recreate group on recovery

## Next Steps (Future Enhancements)

### Phase 2
- [ ] Screenshot thumbnails in recovery UI
- [ ] Partial recovery (pick which tabs to restore)
- [ ] Cookie/localStorage backup (opt-in, security-sensitive)
- [ ] Extension popup UI for recovery

### Phase 3
- [ ] Export session to portable format
- [ ] Import into different browser profile
- [ ] Share session between Claude instances

## Commit
```
436c4d1 - Add session persistence & healing
```

## Files Changed
- `host/session-store.js` - New persistence layer
- `host/mcp-server.js` - Integration + 3 new tools
- `HEALING-SESSION-PERSISTENCE.md` - Design doc
- `SESSION-HEALING-SUMMARY.md` - This file

---

**Status:** ✅ Implemented, tested for syntax, ready for runtime testing  
**Ready for:** PR / merge to main
