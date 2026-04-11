<h1 align="center">Orellius Browser Bridge</h1>

<p align="center">
  <b>Unrestricted browser automation for Claude Code.</b><br>
  No domain blocklist. Your real, signed-in Chromium browser. 18 MCP tools.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-black">
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue">
  <img alt="Manifest" src="https://img.shields.io/badge/manifest-v3-orange">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-compatible-purple">
</p>

---

Orellius Browser Bridge gives [Claude Code](https://claude.ai/code) an MCP-powered bridge into your real, signed-in Chromium browser — with **no domain blocklist**. Claude can navigate, click, type, screenshot, and run JavaScript on any URL it wants: Reddit, Twitter/X, Facebook, Discord web, paywalled docs, SSO dashboards. All fair game.

Works with **Chrome**, **Brave**, and **Edge** on **macOS** and **Linux**.

> **Disclaimer — not affiliated with Claude Code.** This is a fan-made, unofficial community project. It is not endorsed by or connected to Claude Code in any way. It exists to give Claude unrestricted access to any Chromium browser you load it into. Use at your own risk.

## TL;DR — quick start

```bash
git clone https://github.com/Orellius/orellius-browser-bridge.git
cd orellius-browser-bridge
cd host && npm install && cd ..

# 1. Open chrome://extensions, enable Developer mode, Load unpacked → pick extension/
# 2. Copy the extension ID shown on the card
./install.sh <extension-id>

# 3. Fully restart your browser, then:
claude mcp add orellius-browser-bridge -- node "$(pwd)/host/mcp-server.js"
```

Then in Claude Code: *"Open reddit.com and show me the top five posts in /r/programming."*

Detailed walkthrough, configuration, and security notes are below.

---

## Why it exists

Most browser-automation MCP tools fall into one of two camps:

1. **Headless Playwright/Puppeteer wrappers** — fresh Chromium every session. No logged-in state, no cookies, no extensions, no muscle memory. Fine for scraping, useless for any site that requires an account.
2. **Sandboxed extensions with domain allowlists/blocklists** — safer, but they slam the door on exactly the sites you'd most want Claude to help with: social media, Reddit, internal dashboards, review queues, community forums.

Orellius Browser Bridge is a third option: a real extension loaded into your real browser, with no built-in domain restrictions whatsoever. You're trusting Claude with your live browser session — that's the entire point. Claude can genuinely *use the web the way you do*, including writing and submitting posts, comments, and DMs on any site.

Use it accordingly. Load the extension into a browser profile whose cookies and saved passwords you're comfortable handing Claude.

---

## What you can actually do with it

Once registered with Claude Code, you can say things like:

- *"Open reddit.com, go to /r/selfhosted, find the top post about Jellyfin, and post a comment asking about hardware transcoding."*
- *"Log into my GitHub, open the issues tab for `acme/website`, and triage anything older than 30 days."*
- *"Take a screenshot of each of the five latest Linear tickets assigned to me."*
- *"Open the Hacker News front page and summarize everything above 200 points."*
- *"Navigate to Notion, find my design doc, and add a new section at the bottom with these bullet points."*

Claude will open a dedicated `MCP` tab group (blue) in your browser, do its work there, and leave your own tabs alone.

---

## Architecture

```
┌─────────────┐  stdio MCP  ┌──────────────┐    TCP     ┌─────────────┐  native    ┌───────────┐
│ Claude Code │ ──────────► │  mcp-server  │ ◄────────► │ native-host │ messaging  │ Extension │
│             │             │     .js      │ 127.0.0.1  │     .js     │ ─────────► │ (Chromium)│
└─────────────┘             └──────────────┘   :18765   └─────────────┘            └───────────┘
```

Two IPC hops are needed because Chrome's native messaging API requires Chrome itself to spawn the host process, while Claude Code spawns the MCP server independently. They meet on a local TCP socket.

| Component | Role |
|---|---|
| `host/mcp-server.js` | MCP server over stdio. Exposes 18 tools to Claude Code. Runs a TCP listener on `127.0.0.1:18765` for the native host to dial in. |
| `host/native-host.js` | Native messaging host. Launched by the browser when the extension calls `connectNative()`. Bridges Chrome's length-prefixed message format to newline-delimited JSON over TCP. |
| `extension/` | Manifest V3 extension. Service worker drives the Chrome DevTools Protocol via `chrome.debugger`. Content script builds the accessibility tree and resolves element references. |

---

## Features

### Tools available to Claude

| Tool | What it does |
|---|---|
| `tabs_context_mcp` | List tabs in the current MCP tab group. **Call this first** in any new conversation. |
| `tabs_create_mcp` | Open a new tab inside the MCP tab group. |
| `navigate` | Go to a URL or move forward/back in history. |
| `computer` | Click, type, scroll, drag, hover, screenshot, zoom, key press. |
| `find` | Find elements by natural-language query (e.g. "search bar", "upvote button", "reply button"). |
| `read_page` | Get an accessibility-tree representation of the page with stable element refs. |
| `form_input` | Set values on inputs, checkboxes, selects by element ref. |
| `get_page_text` | Extract clean article text. |
| `javascript_tool` | Execute arbitrary JS in the page context and return the result. |
| `read_console_messages` | Read filtered `console.*` output from a tab. |
| `read_network_requests` | Inspect HTTP requests made by the page. |
| `gif_creator` | Record an automation session and export as a polished GIF with click overlays. |
| `upload_image` | Upload a captured screenshot or user image to a file input or drag-drop target. |
| `resize_window` | Set window dimensions for responsive testing. |
| `shortcuts_list` / `shortcuts_execute` | Discover and run extension shortcuts/workflows. |
| `switch_browser` | Hand off the active connection to a different Chromium browser. |
| `update_plan` | Show Claude's plan and target domains to the user for approval. |

### Design choices

- **No domain blocklist.** There is no built-in denylist of "risky" domains. Every tool (`computer`, `form_input`, `javascript_tool`, `navigate`) works on any URL Chromium will load.
- **Tab grouping.** Claude's tabs live in a dedicated `MCP` tab group (blue) so they're visually separated from your own browsing.
- **Single active connection.** Only one browser profile can be connected at a time — the MCP server politely tells additional connections to back off, preventing profile-vs-profile races.
- **Reconnect-aware.** If Chrome's service worker restarts mid-request, in-flight tool requests are re-sent on reconnection instead of failing.
- **Stale-server cleanup.** The MCP server writes a PID file and SIGTERMs orphaned predecessors before binding the port — restart Claude Code as often as you like.
- **Local-only, no telemetry.** Everything runs over `localhost`. No outbound network from either the host process or the extension.

---

## Installation

### Prerequisites

- **Node.js 18+** ([nodejs.org](https://nodejs.org/))
- **Claude Code** ([install instructions](https://docs.claude.com/claude-code))
- **A Chromium browser** — Chrome, Brave, or Edge (Chromium 116 or newer)

### 1. Clone the repo

```bash
git clone https://github.com/Orellius/orellius-browser-bridge.git
cd orellius-browser-bridge
```

### 2. Install host dependencies

```bash
cd host && npm install && cd ..
```

### 3. Load the extension in your browser

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` folder from this repo.
4. The extension card now shows an **ID** like `abcdefghijklmnopabcdefghijklmnop` — copy it.

> **Repeat for each browser** you want Claude to drive. Each Chromium browser assigns its own ID to the same unpacked extension, so Brave and Chrome will give you two different IDs even though it's the same source folder.

### 4. Register the native messaging host

Pass every extension ID you collected to `install.sh`:

```bash
# One browser:
./install.sh <chrome-extension-id>

# Multiple browsers — pass all IDs:
./install.sh <chrome-extension-id> <brave-extension-id> <edge-extension-id>
```

This writes a native messaging host manifest (`com.orellius.browser_bridge.json`) into the right per-browser directory for your platform. macOS and Linux are detected automatically.

### 5. Restart your browser

Close **all** browser windows and reopen. Native messaging host registration is loaded once at startup.

### 6. Register the MCP server with Claude Code

```bash
claude mcp add orellius-browser-bridge -- node "$(pwd)/host/mcp-server.js"
```

### 7. Test it

Start a new Claude Code session and ask:

> *"Navigate to news.ycombinator.com and take a screenshot of the front page."*

Claude should open a new browser window with an `MCP` tab group and screenshot the page.

Then try it on a site most sandboxed automation tools won't touch:

> *"Open reddit.com, find /r/programming, and show me the titles of the top five posts."*

---

## Configuration

### Custom port

By default the MCP server and native host bridge over TCP `127.0.0.1:18765`. To change it, create:

```
~/.config/orellius-browser-bridge/config.json
```

```json
{ "port": 19000 }
```

Both the MCP server and the native host read this file at startup, so they'll always agree on the port.

---

## Troubleshooting

**"Browser extension is not connected"** — The extension can't reach the MCP server.
- Make sure a supported browser is running and the extension is enabled (`chrome://extensions`).
- Restart the browser after running `install.sh`.
- Verify the host manifest exists at the platform path printed by `install.sh`.
- Check that the extension ID inside the manifest's `allowed_origins` matches the one currently shown on the extensions page (re-loading the unpacked extension can change the ID).

**"Another browser profile is already connected"** — The MCP server only accepts one extension connection at a time. Disable the extension in your other profiles, or close those browser windows.

**Tool calls hang and time out at 60s** — The page might be stuck on a modal, or `chrome.debugger` was detached by you clicking the yellow warning bar at the top of the tab. Re-run the tool; the extension reattaches automatically.

**MCP server won't start: `EADDRINUSE`** — A previous instance is still bound to the port. The server should kill the orphan automatically; if not, find and kill it manually:
```bash
lsof -ti :18765 | xargs kill
```

**The extension ID changed after I reloaded it** — That happens with unpacked extensions if the install path changes. Re-run `install.sh` with the new ID.

**Leftover manifest from an older install** — If you previously ran a different Chromium-automation extension, there may be stale `*.json` files in your browser's `NativeMessagingHosts` folder. They won't break this install, but you can clean them up:

```bash
# macOS
ls "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/"
ls "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/"
ls "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/"

# Linux
ls "$HOME/.config/google-chrome/NativeMessagingHosts/"
ls "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/"
ls "$HOME/.config/microsoft-edge/NativeMessagingHosts/"
```

The only file this project writes is `com.orellius.browser_bridge.json`. Anything else is from something older — delete at your discretion.

---

## Project structure

```
orellius-browser-bridge/
├── extension/            # Chromium extension (Manifest V3)
│   ├── manifest.json
│   ├── background.js     # Service worker, CDP dispatch, tab group mgmt
│   ├── content.js        # A11y tree, element refs, form input
│   └── icons/
├── host/                 # Node.js host process
│   ├── mcp-server.js     # MCP stdio server + TCP bridge
│   ├── native-host.js    # Chrome native messaging ↔ TCP shim
│   ├── package.json
│   └── package-lock.json
├── install.sh            # Native host manifest installer (macOS/Linux)
└── README.md
```

---

## Security notes — read this before installing

This is an **intentionally unsafe** tool by the standards of typical browser automation. You should understand exactly what you're opting into:

- **The extension requests `<all_urls>` and the `debugger` permission.** That's the cost of unrestricted automation: Claude can read, screenshot, and interact with anything you can — including pages displaying your email, your Slack, your banking, your password manager's autofill.
- **There is no domain blocklist.** Claude can navigate to sites that can irreversibly act on your accounts (post, reply, DM, delete, transfer, approve). Use `update_plan` to have Claude declare its target domains before it acts, and review its plan before approving.
- **Your cookies and logged-in sessions are the access model.** If Claude opens a tab in a browser profile where you're signed into Gmail, it can send mail as you.
- **Don't run this inside your daily-driver browser profile** unless that's a conscious choice. Consider a dedicated Chromium profile with only the accounts you're actually OK automating.
- **Local-only communication.** The MCP server binds to `127.0.0.1` only. No port is opened to your network, and there is no outbound telemetry.

If any of that reads as "too risky for me" — that's a reasonable reaction, and you should use a sandboxed alternative instead.

---

## Platform support

| Platform | Status |
|---|---|
| macOS  | Supported |
| Linux  | Supported |
| Windows | Not yet — `install.sh` is bash-only. PRs welcome (the host manifest needs a Windows registry entry under `HKCU\Software\Google\Chrome\NativeMessagingHosts`). |

---

## License

MIT
