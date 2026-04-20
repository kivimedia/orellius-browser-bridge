# Orellius Browser Bridge - Setup Notes

## Installation Status: ✅ COMPLETE

Installed on km-vps-openclaw on April 11, 2026

### What's Installed

1. **X11 Virtual Display (Xvfb)** - already installed  
2. **Google Chrome 147.0.7727.55** - installed to /opt/google/chrome
3. **Orellius Browser Bridge** - cloned and configured
   - Extension: `~/orellius-browser-bridge/extension/`
   - MCP Server: `~/orellius-browser-bridge/host/mcp-server.js`
   - Native Host: Registered with Chrome

### Extension ID

**Computed ID**: `nfkbbinfciecoemdjipbefonkkpmmogi`

This ID was computed based on the extension path. When you load the extension in Chrome, it may assign a different ID. If that happens, re-run:

```bash
cd ~/orellius-browser-bridge
./install.sh <actual-extension-id>
```

### Native Messaging Host

Installed at: `~/.config/google-chrome/NativeMessagingHosts/com.orellius.browser_bridge.json`

The host is configured to accept connections from the extension and bridge them to the MCP server via TCP port 18765.

### How to Use

#### Option 1: With Claude Code (as designed)

```bash
# Add MCP server to Claude Code
claude mcp add orellius-browser-bridge -- node ~/orellius-browser-bridge/host/mcp-server.js

# Then in Claude Code session:
# "Navigate to reddit.com and take a screenshot"
```

#### Option 2: Manual Testing

1. Start Xvfb virtual display:
```bash
Xvfb :99 -screen 0 1920x1080x24 > /dev/null 2>&1 &
export DISPLAY=:99
```

2. Start Chrome with extension:
```bash
google-chrome \
  --no-sandbox \
  --disable-dev-shm-usage \
  --user-data-dir=~/.chrome-orellius \
  --load-extension=~/orellius-browser-bridge/extension \
  > /dev/null 2>&1 &
```

3. Start MCP server:
```bash
node ~/orellius-browser-bridge/host/mcp-server.js
```

4. The extension should connect to the native host, which connects to the MCP server on localhost:18765

### Architecture

```
┌─────────────┐  stdio MCP  ┌──────────────┐    TCP     ┌─────────────┐  native    ┌───────────┐
│ Claude Code │ ──────────► │  mcp-server  │ ◄────────► │ native-host │ messaging  │ Extension │
│             │             │     .js      │ 127.0.0.1  │     .js     │ ─────────► │ (Chrome)  │
└─────────────┘             └──────────────┘   :18765   └─────────────┘            └───────────┘
```

### Security Notes

⚠️ **This tool gives AI full access to your logged-in browser sessions**

- Can read/write any page you're logged into
- Can post/DM/email as you
- Can access banking/sensitive sites
- NO domain blocklist

**Recommendation**: Use a dedicated Chrome profile with ONLY accounts you want automated.

### Troubleshooting

**Extension not connecting?**
- Check Chrome is running with extension loaded
- Verify extension ID matches the one in native messaging host manifest
- Check MCP server is running on port 18765

**Can't load extension?**  
- Chrome needs Developer Mode enabled
- On headless server, use `--load-extension` flag
- Extension path must be absolute

**Port conflicts?**
- Default port: 18765
- Configure via `~/.config/orellius-browser-bridge/config.json`:
  ```json
  { "port": 19000 }
  ```

### Files & Locations

- Extension: `~/orellius-browser-bridge/extension/`
- MCP Server: `~/orellius-browser-bridge/host/mcp-server.js`
- Native Host Wrapper: `~/orellius-browser-bridge/host/native-host-wrapper.sh`
- Native Host Manifest: `~/.config/google-chrome/NativeMessagingHosts/com.orellius.browser_bridge.json`
- Chrome Profile: `~/.chrome-orellius/`
- Startup Script: `~/start-chrome-with-display.sh`

### Next Steps

1. ✅ X11 + Chrome installed
2. ✅ Orellius cloned and dependencies installed
3. ✅ Native messaging host registered
4. ⏸️ Extension loaded (needs manual verification)
5. ⏸️ MCP server integration (needs Claude Code or custom client)

The system is ready - you just need to load the extension in Chrome and connect it to an MCP client.
