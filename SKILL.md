---
name: orellius
description: Drive a real, signed-in Chromium browser via the Orellius browser-bridge MCP. Invoke with `/orellius` (bare = grab a tab and stand by) or `/orellius <task>` (do the task in browser). Use when the user says "/orellius", "use orellius", "open in chrome", "navigate the browser", "click X on the page", "screenshot the page", "log into X for me", or any browser-driving request. Default mode is private (own window, no focus theft from the user's main window).
---

# orellius

Drive a real Chromium browser (Chrome / Brave / Edge / Firefox) via the Orellius MCP bridge. The MCP server exposes ~25 tools under `mcp__orellius-browser-bridge__*` plus mode controls (`browser_mode`, `browser_show`, `browser_hide`, `browser_lock`, etc.).

When this file is installed as `~/.claude/skills/orellius/SKILL.md`, Claude Code exposes it as the **`/orellius`** slash command. To create personal aliases like `/chrome`, `/browser`, `/web`, copy this file into additional skill directories with a different `name:` in the frontmatter.

## Behavior by args

**Bare `/orellius`** (no args): get ready. Run:

```
mcp__orellius-browser-bridge__tabs_context_mcp({ createIfEmpty: true })
```

This claims a Chrome window for this session if there isn't one yet, in the background (private mode - no focus theft). Report back what tabs are owned and which is active. Then stand by for the actual task.

**`/orellius <task>`**: execute the task. Inspect what the task needs (navigate? click? read? screenshot? login?) and pick the right tool. If no tab is owned yet, call `tabs_context_mcp({ createIfEmpty: true })` first.

## Mode discipline (STRICT)

- Default mode is **`private`** - never grab the user's window focus. Most users have many windows open and don't want every click/type to yank Chrome to the foreground.
- DO NOT call `browser_mode` with `"public"` (or alias `"active"`) unless the user explicitly asks ("bring it to front", "show me live", "active mode").
- For "look at this" moments, use one-shot `browser_show` then `browser_hide` immediately after - never flip default mode.

## Don't pre-launch Chrome

Don't run `chrome.exe --new-window <url>` or equivalent to "warm up" before calling Orellius. The right way is `tabs_context_mcp({ createIfEmpty: true })` - it spawns a window in the background if needed, owned by this session. Pre-launching from the shell creates an unowned window the bridge can't claim and confuses the cross-session lock.

## Common patterns

**Navigate**: `mcp__orellius-browser-bridge__navigate({ url, waitUntil: "load" })`

**Read what's on the page**: `mcp__orellius-browser-bridge__get_page_text` (cheap, text only) or `mcp__orellius-browser-bridge__read_page` (DOM with structure).

**Click / type / scroll / screenshot**: `mcp__orellius-browser-bridge__computer({ action: "click" | "type" | "scroll" | "screenshot", ... })`. For screenshots that need to land on disk, pass `savePath`.

**Find an element first**: `mcp__orellius-browser-bridge__find({ query })` returns coords + selector. Real-mouse click via `computer` is more reliable than JS injection on most modern sites - use `javascript_tool` only for sites where real mouse fails (Cloudflare-protected forms, fingerprinting checks, etc.).

**Login flows / human handoff**: when the user has to type a password or click a 2FA prompt, use `browser_show` to bring the window to their foreground, do whatever ping pattern your environment supports (a voice alert, a chat message, etc.), then after they finish, `browser_hide`.

**Concurrent sessions**: each Claude Code session owns its own window. `browser_lock` claims a tab for exclusive access. If a tool returns "...belongs to session..." that's the cross-session lock - don't retry blindly, run `tabs_context_mcp` to see what your session owns.

**Cross-session tab lock** (`browser_lock` / `browser_unlock` / `browser_lock_status`): claim exclusive access to a tab while you do a multi-step flow (login, form-fill, payment) so other Claude sessions can't accidentally navigate it out from under you. Always pair: `browser_lock` -> work -> `browser_unlock`.

## When NOT to use Orellius

- Reading content from a public URL with no auth/JS-render: prefer `WebFetch` (cheaper, no browser overhead).
- Searching the web: prefer `WebSearch`.
- Text-only screenshots / static markup: WebFetch + parsing is faster than `computer({action:"screenshot"})`.

Use Orellius when you need: real session cookies, JS-rendered content, real clicks/typing, mouse-position-sensitive widgets, or when you have to drive a flow the user would otherwise click through themselves.

## Installing as a slash command

Place this file at `~/.claude/skills/orellius/SKILL.md` (Linux/macOS) or `%USERPROFILE%\.claude\skills\orellius\SKILL.md` (Windows). The frontmatter `name: orellius` registers the skill as `/orellius` in Claude Code's slash-command picker on next session start.

For aliases (e.g. `/chrome`, `/browser`, `/web`), copy this file to `~/.claude/skills/chrome/SKILL.md` etc. with `name:` updated to match the directory name.
