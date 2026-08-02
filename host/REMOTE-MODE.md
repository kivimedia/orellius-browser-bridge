# Remote mode - drive the VPS browser instead of your own

Agent browsing defaults to the VPS Chrome so the human's own Chrome stays
theirs. This doc covers the transport. Policy lives in
`~/.claude/skills/orellius/SKILL.md`.

## Why a tunnel and not a public port

`hub.js` binds `127.0.0.1` and has **no authentication** - it is safe only
because it is loopback-only. An SSH tunnel preserves that exactly: the hub still
only ever sees a loopback connection. Never expose 18765 publicly to "simplify"
this.

## Start the tunnel

```bash
node host/orellius-remote.mjs                 # 127.0.0.1:18775 -> VPS 127.0.0.1:18765
node host/orellius-remote.mjs --port=18780    # different local port
node host/orellius-remote.mjs --check         # probe only; exit 0 = healthy
node host/orellius-remote.mjs --print-env     # print the env a session needs
```

It is a supervised `ssh -N` loop with exponential backoff (autossh is not
available on Windows), and it is idempotent - a second invocation on a live
port exits cleanly instead of fighting for the bind.

`--check` distinguishes three states, which matters when debugging:

| Exit | Meaning |
|---|---|
| 0 | tunnel up and a real hub answered the handshake |
| 1 | nothing listening - tunnel is down |
| 2 | port open but the peer is NOT an Orellius hub |

## Point a session at it

Per-project `.mcp.json`:

```json
{
  "mcpServers": {
    "orellius-remote": {
      "command": "node",
      "args": ["E:/FromC/projects/orellius-browser-bridge/host/mcp-server.js"],
      "env": {
        "ORELLIUS_HUB_HOST": "127.0.0.1",
        "ORELLIUS_HUB_PORT": "18775",
        "ORELLIUS_HUB_REMOTE": "1"
      }
    }
  }
}
```

### `ORELLIUS_HUB_REMOTE=1` is not optional

The tunnel listens on `127.0.0.1`, so the host alone cannot tell "tunnel to the
VPS browser" apart from "local browser". Without this flag, a dropped tunnel
makes `ensureHub()` auto-spawn a **local** hub, and the session silently drives
the human's own Chrome while believing it is on the VPS. With it, a missing hub
returns an actionable error and refuses to fall back.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `ORELLIUS_HUB_HOST` | `127.0.0.1` | Hub host. Also readable from `~/.config/orellius-browser-bridge/config.json` as `hubHost`. |
| `ORELLIUS_HUB_PORT` | `18765` | Hub port. Wins over the config file, so one session can differ from the rest. |
| `ORELLIUS_HUB_REMOTE` | unset | `1` = never auto-spawn a local hub. |
| `ORELLIUS_SESSION_TTL_MS` | `900000` | Hub-side idle eviction (15 min). |
| `ORELLIUS_SWEEP_INTERVAL_MS` | `60000` | How often the hub sweeps for idle sessions. |

## Lazy connection

`mcp-server.js` does not touch the hub until the **first browser tool call**. A
session that never browses spawns nothing and claims no window.

The hub evicts any session idle past the TTL: its Chrome window is closed and
its socket dropped. This is not an error - `mcp-server.js` re-registers
transparently on the next call, keeping the same session id.

## The VPS stack

Four pm2 apps from `ecosystem.config.cjs`, healed by
`~/scripts/bridge-keepalive.sh`:

| App | What |
|---|---|
| `orellius-hub` | the broker on 18765 |
| `orellius-chrome` | real Chrome on Xvfb `:99` (1920x1080x24) with the extension |
| `orellius-x11vnc` | VNC on `127.0.0.1:5900` - `-localhost` is load-bearing |
| `orellius-view` | websockify + noVNC on `127.0.0.1:6080` |

Live view: `https://104-200-30-37.sslip.io/orellius-view/` (nginx TLS + basic
auth). Use the `/show-me` skill rather than handing out the URL by hand.

## Gotchas

- **Never re-add `--disable-dev-shm-usage`** to the Chrome launch script. This
  box has a 16 GB `/dev/shm`; the flag made Chrome write shared memory into the
  profile dir and leaked **111,112 files / 14.5 GB** between 2026-06-09 and
  2026-08-02.
- **Never run `~/start-chrome-orellius.sh`** on the VPS - it begins with
  `killall chrome`, which would also kill the 17hats, linkedin and instagram
  service browsers. Use `~/orellius-chrome-launch.sh`.
- A hub restart used to leave the browser permanently disconnected
  (`nativeHosts: []`) because `native-host.js` never re-registered. Fixed
  2026-08-02; a `kill -9` on the hub now self-heals in ~5s.
