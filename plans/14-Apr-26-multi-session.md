# Multi-Session Support for Orellius Browser Bridge

## Goal
Allow multiple Claude Code instances to control different browser tabs simultaneously through the same Chrome extension.

## Architecture

```
Claude 1 --stdio--> mcp-server.js (sessionId: "s_abc123") --TCP client--> hub.js (:18765) <--native msg--> extension
Claude 2 --stdio--> mcp-server.js (sessionId: "s_def456") --TCP client-->    ^                                  |
                                                                              |                            Tab Group "MCP-1" (session abc123)
                                                                        native-host.js                     Tab Group "MCP-2" (session def456)
```

## Changes

### 1. hub.js (NEW - ~150 lines)
- Persistent background process, listens on TCP :18765
- Accepts multiple MCP server connections (each with unique sessionId)
- Accepts ONE native host connection
- Routes tool_request from MCP server -> native host (adds sessionId)
- Routes tool_response from native host -> correct MCP server (by sessionId)
- Auto-spawned by mcp-server.js if not running
- Stays alive after all MCP servers disconnect (with 5min idle timeout)

### 2. mcp-server.js (MODIFY)
- Remove TCP server logic entirely
- Remove pidfile/kill-stale logic
- On startup: check if hub is running, spawn it if not
- Connect as TCP CLIENT to hub on :18765
- Generate unique sessionId (e.g. crypto.randomUUID().slice(0,8))
- Include sessionId in all tool_request messages
- Match responses by both id AND sessionId

### 3. native-host.js (MINIMAL CHANGE)
- Pass through sessionId field transparently (it's already JSON passthrough)

### 4. extension/background.js (MODIFY)
- Support multiple tab groups: Map<sessionId, { tabGroupId, tabGroupTabs }>
- Each session gets its own Chrome tab group named "MCP-{sessionId}"
- Tool calls include sessionId -> route to correct tab group
- isInGroup() checks the session-specific group
- tabs_context_mcp creates/returns session-specific group

## Message Protocol Change
Before: `{ id, type: "tool_request", tool, args }`
After:  `{ id, sessionId, type: "tool_request", tool, args }`

## Files to modify
1. `host/hub.js` - NEW
2. `host/mcp-server.js` - major refactor (simpler: remove TCP server, add TCP client)
3. `host/native-host.js` - pass through sessionId (no logic change)
4. `extension/background.js` - per-session tab groups

## Verification
- Start two Claude Code instances
- Each calls tabs_context_mcp -> gets different tab groups
- Navigate different URLs in each
- Take screenshots independently
- No cross-talk between sessions
