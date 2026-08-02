# Remote-first browser: stop agents competing with Ziv for Chrome

Date: 2026-08-02
Trigger: Ziv reports ~12s Chrome freezes, laggy mouse, and agents too often taking over his screen.

## Goal

Two outcomes:
1. Kill the freeze. Ziv's Chrome stays responsive while agents work.
2. Agents browse on the VPS by default. Ziv's local Chrome is his. Agent browsing is shown on his screen only when he asks.

## Decisions (Ziv, 2026-08-02)

- Architecture: **Hybrid** - VPS default, local Chrome only when a task genuinely needs his live logged-in session, and only after saying so.
- VPS identity: **Mixed** - worker seat where the platform supports one, his own accounts where it does not.
- Show me: **Live view AND take-over control** - he can watch and grab the mouse/keyboard.

## Diagnosis (measured 2026-08-02, not inferred)

The freeze is NOT primarily Orellius. It is the machine paging.

| Measure | Value | Meaning |
|---|---|---|
| Committed memory | 85.4 GB / 105.9 GB limit | On 64 GB physical. ~21 GB lives compressed or paged. |
| Memory Compression proc | 7.98 GB | Windows squeezing working sets hard. |
| Pages Input/sec | avg 230, peak 611 | Sustained HARD faults - reading pages back from disk/compressed store. |
| Available RAM | 19.5 GB | Looks fine, hides the commit pressure. |
| CPU baseline | 41.5% | With nothing user-visible running. |
| Chrome | 32 procs / 5 GB / 25 renderers | |
| node | 122 procs / 7.16 GB | |

Mechanism: Chrome sits behind VS Code and Premiere, Windows trims its working set. Alt-tabbing back must fault gigabytes in from the compressed store. That stalls the compositor too, which is why the mouse cursor lags. Reinstalling Chrome could not have helped - nothing was wrong with Chrome.

Biggest contributors: ~10 VS Code windows (one alone at 3.1 GB), TWO Premiere Pro instances (Beta + release), 122 node processes, Dropbox, 32 Chrome processes.

## Real Orellius defects found (contributing, not sole cause)

1. **Eager double-spawn.** Every Claude session starts BOTH `mcp-server.js` and `mcp-server-iso.js` at launch, before any browser tool is called. 29 processes / ~1.6 GB for sessions that mostly never browse. Verified: 0 orphans, all children of live `claude.exe` - so this is by-design waste, not a leak of dead processes.
2. **"Active" means "process alive", not "using the browser".** `POST /admin/close-unused` preserves any session with a live MCP server. Ran it during diagnosis: 14 sessions preserved, 0 windows closed. With 15 VS Code windows open, nothing is ever reapable.
3. **No session TTL.** Hub uptime 38.5 h; sessions registered on 31-Jul still held claims on 02-Aug. Chrome windows from two-day-old conversations still pinned, keeping renderers alive.
4. **VPS checkout is ancient.** Extension v1.0.0 on the VPS vs v1.11.9 locally. Missing every force-private, tab-isolation, and PIN fix.
5. **VPS hub is unsupervised.** Listening on 18765 (pid 2835228) but NOT in pm2, unlike `orellius-chrome`. Dies on reboot with nothing to restart it.
6. **VPS profile is 20 GB**, of which 2.7 GB is `OptGuideOnDeviceModel` - Chrome's on-device AI model, useless for an automation browser.
7. **Xvfb is 1024x768x16.** 16-bit colour makes every VPS screenshot subtly wrong.

## Key architectural find (makes Phase 1 nearly free)

`ensureHub()` in `host/mcp-server.js:110` probes `127.0.0.1:TCP_PORT` and, if anything answers, reuses it and never spawns a local hub. `ORELLIUS_HUB_PORT` already overrides the port.

So: an SSH tunnel `-L <localport>:127.0.0.1:18765` to the VPS plus `ORELLIUS_HUB_PORT=<localport>` points a local Claude session at the VPS Chrome with **zero code change**, and the hub's "localhost-only, no auth" security assumption stays true.

## Phases

### Phase 0 - Immediate relief (local, today)
- Make both MCP servers lazy: no hub connect, no spawn, until the first browser tool call.
- Remove `orellius-iso` from the global MCP config; opt in per-project where it is actually used.
- Add a real idle TTL: a session with no browser call in N minutes releases its Chrome window and deregisters. Re-registers transparently on the next call.
- Redefine "active" for `close-unused` as "made a browser call recently", not "process alive".

Expected: ~1.6 GB back, and Chrome stops carrying windows for dead conversations.

### Phase 1 - Remote transport (no protocol change)
- `orellius-remote` launcher: autossh tunnel + `ORELLIUS_HUB_PORT`, self-healing.
- Later, for cleanliness: add a proper `ORELLIUS_HUB_HOST` env var.

### Phase 2 - Make the VPS browser worth using
- Update VPS checkout v1.0.0 -> v1.11.9.
- Put `orellius-hub` under pm2 and add it to `bridge-keepalive.conf` (the fleet watchdog).
- Rebuild the profile from scratch; disable the on-device model component.
- Raise Xvfb to 1920x1080x24.
- Seed logins: worker seats where available, his accounts where not. MFA via the TOTP tool + SMS relay.

### Phase 3 - Show me / take over
- noVNC + websockify behind nginx on the existing sslip.io vhost (LE cert already there).
- **Rotate the VNC password off `kivi2026`** before exposing it.
- `/show-me` skill returns the link; x11vnc already runs `-forever -shared` so take-over works.

### Phase 4 - Routing policy
- Default VPS. Local Chrome only when the task needs his live session, announced in chat first.
- Encode in the `/orellius` skill + a memory file so every session follows it.

## Blockers / risks

- 🔴 **sudo needed** for the nginx work (noVNC block, and the still-unapplied SMS relay block from 2026-07-30). The permission classifier has blocked sudo for past sessions.
- 🔴 **VNC password `kivi2026`** is in memory files. Must rotate before any public exposure.
- Datacenter IP blocks (Cloudflare, some client portals) may reject the VPS. Mitigation: fall back to local for those specific sites, or a residential proxy.
- Google / Stripe / registrars / Cloudflare / GitHub are on the TOTP tool's deny-list by design. Those stay manually seeded and manually re-authed.
- Cookie-jar conflict is exactly why Mixed identity was chosen - see `orellius-shares-main-chrome-cookie-jar.md` (2026-06-04, View-As got flipped mid-test).

## Verification

- Phase 0: node process count and total RAM before/after; `Pages Input/sec` back under ~50 at idle; Alt-Tab to Chrome responds in under 1s.
- Phase 1: a browser tool call from a local session lands on the VPS Chrome (verified by screenshot showing the VPS page, and no new window in Ziv's Chrome).
- Phase 2: `pm2 list` shows orellius-hub online; profile under 2 GB; a 1920x1080 24-bit screenshot.
- Phase 3: the https link loads noVNC, mouse take-over moves the VPS cursor.

## Open questions

- Which platforms get a worker seat vs his own login? Needs a per-platform pass (kmboards, kmhub, Freshdesk, Trello, Zapier, Shopify, client CRMs).
- N for the idle TTL. Proposing 15 min.
