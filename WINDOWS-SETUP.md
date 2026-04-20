# Windows Setup Guide

Quick setup guide for Orellius Browser Bridge on Windows.

## Prerequisites

1. **Node.js 18+** - Download from [nodejs.org](https://nodejs.org/)
2. **Claude Code** - Install from [Claude Code docs](https://docs.claude.com/claude-code)
3. **Chrome, Brave, or Edge** - Any Chromium browser (v116+)
4. **Administrator access** - Needed for registry writes

## Installation Steps

### 1. Clone the repo
```powershell
git clone https://github.com/Orellius/orellius-browser-bridge.git
cd orellius-browser-bridge
```

### 2. Install dependencies
```powershell
cd host
npm install
cd ..
```

### 3. Load the extension in your browser

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`)
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension\` folder from this repo
5. **Copy the extension ID** shown on the card (e.g., `abcdefghijklmnopqrstuvwxyz123456`)

### 4. Run the installer **as Administrator**

Right-click **Command Prompt** or **PowerShell** → **"Run as administrator"**

```powershell
cd path\to\orellius-browser-bridge
node install.js <your-extension-id>
```

Example:
```powershell
node install.js abcdefghijklmnopqrstuvwxyz123456
```

**For multiple browsers** (Chrome + Brave + Edge), pass all extension IDs:
```powershell
node install.js <chrome-id> <brave-id> <edge-id>
```

**What this does:**
- Creates `%USERPROFILE%\.orellius-browser-bridge\com.orellius.browser_bridge.json`
- Writes registry keys under `HKCU\Software\Google\Chrome\NativeMessagingHosts`
- (and Brave/Edge equivalents if you passed multiple IDs)

### 5. Restart your browser

**IMPORTANT:** Close **ALL** browser windows completely, then reopen.

Windows only reads native messaging registry keys at startup.

### 6. Register with Claude Code

```powershell
claude mcp add orellius-browser-bridge -- node "%CD%\host\mcp-server.js"
```

Or with full path:
```powershell
claude mcp add orellius-browser-bridge -- node "C:\path\to\orellius-browser-bridge\host\mcp-server.js"
```

### 7. Test it

Start a new Claude Code session and say:

> *"Navigate to news.ycombinator.com and take a screenshot"*

Claude should open a browser window with an `MCP` tab group and screenshot the page.

---

## Troubleshooting

### "Browser extension is not connected"

**Possible causes:**
1. Browser not restarted after install
2. Extension disabled
3. Extension ID mismatch
4. Registry keys not written (permission issue)

**Fixes:**
- Close **all** browser windows and reopen
- Verify extension is enabled at `chrome://extensions`
- Re-run `node install.js <extension-id>` **as Admin**
- Check registry manually:
  ```powershell
  reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.orellius.browser_bridge"
  ```
  Should show default value pointing to your manifest JSON.

### Registry write failed (Permission denied)

You need Administrator privileges. Two options:

**Option 1:** Run Command Prompt as Admin (recommended)
```
Right-click Command Prompt → "Run as administrator"
cd path\to\orellius-browser-bridge
node install.js <extension-id>
```

**Option 2:** Manual registry edit
1. Open Registry Editor (`regedit`)
2. Navigate to `HKCU\Software\Google\Chrome\NativeMessagingHosts`
3. Create key: `com.orellius.browser_bridge`
4. Set default value to: `C:\Users\YourName\.orellius-browser-bridge\com.orellius.browser_bridge.json`

### Extension ID changed after reload

Unpacked extensions can change ID if the folder path changes. Fix:
1. Check current ID at `chrome://extensions`
2. Re-run `node install.js <new-id>`
3. Restart browser

### Tools time out after 60s

- Page might be stuck on a modal
- Or you clicked the yellow "debugger attached" warning bar at the top of the tab
- **Fix:** Re-run the tool - the extension reattaches automatically

---

## Security Notes

See main [README.md](README.md#security-notes---read-this-before-installing) for full details.

**Key points:**
- Extension has `<all_urls>` and `debugger` permissions
- Claude can access ANY site you're logged into
- Consider using a separate browser profile for automation
- All communication is `localhost` only (no network exposure)

---

## Session Persistence

Sessions auto-save after tool calls and survive browser crashes.

**Location:** `%USERPROFILE%\.config\orellius-browser-bridge\sessions\`

**New tools:**
- `session_save(note)` - Manual checkpoint
- `session_restore(sessionId)` - List/restore sessions
- `session_prune(maxAgeDays)` - Cleanup old snapshots

**Auto-cleanup:** Sessions older than 7 days are pruned on startup.

---

## File Paths Reference

| Item | Windows Path |
|---|---|
| Extension folder | `C:\path\to\orellius-browser-bridge\extension\` |
| Native host manifest | `%USERPROFILE%\.orellius-browser-bridge\com.orellius.browser_bridge.json` |
| Session snapshots | `%USERPROFILE%\.config\orellius-browser-bridge\sessions\` |
| Chrome registry | `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.orellius.browser_bridge` |
| Brave registry | `HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.orellius.browser_bridge` |
| Edge registry | `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.orellius.browser_bridge` |

---

## Uninstall

### 1. Remove from Claude Code
```powershell
claude mcp remove orellius-browser-bridge
```

### 2. Remove extension
Go to `chrome://extensions` → Remove the extension

### 3. Clean up registry (optional)
```powershell
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.orellius.browser_bridge" /f
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.orellius.browser_bridge" /f
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.orellius.browser_bridge" /f
```

### 4. Delete files (optional)
```powershell
rmdir /s /q "%USERPROFILE%\.orellius-browser-bridge"
rmdir /s /q "%USERPROFILE%\.config\orellius-browser-bridge"
```

---

## Need Help?

- Check [main README](README.md) for general docs
- Review [design doc](HEALING-SESSION-PERSISTENCE.md) for session persistence details
- Open an issue on GitHub
