// pm2 ecosystem for the Orellius browser stack on the VPS.
//
// Added 2026-08-02. Before this, orellius-hub ran ad-hoc (started by hand from
// a stray ~/.openclaw checkout) and x11vnc ran detached with -bg, so neither
// was supervised and a reboot killed remote browsing silently. This file also
// gives scripts/bridge-keepalive.sh something to heal from.
//
// Start order on a cold start: hub -> chrome -> x11vnc -> view.
// Everything retries, so an inversion self-corrects.
module.exports = {
  apps: [
    {
      name: "orellius-hub",
      script: "host/hub.js",
      cwd: "/home/ziv/orellius-browser-bridge",
      interpreter: "node",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      time: true,
      env: {
        // 15 min: a session that has made no browser call in that long has its
        // Chrome window closed and is deregistered. mcp-server.js re-registers
        // transparently on its next call.
        ORELLIUS_SESSION_TTL_MS: "900000",
      },
    },
    {
      name: "orellius-chrome",
      // The launch script carries the disk circuit-breaker, the display guard
      // and the orphaned-scratch-file sweep. Never invoke google-chrome here
      // directly, and never use ~/start-chrome-orellius.sh (it runs
      // `killall chrome`, which would kill the 17hats / linkedin / instagram
      // service browsers too).
      script: "/home/ziv/orellius-chrome-launch.sh",
      cwd: "/home/ziv",
      interpreter: "bash",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      time: true,
    },
    {
      name: "orellius-x11vnc",
      // NOTE: no -bg. x11vnc must stay in the foreground or pm2 supervises a
      // process that has already forked away and exited.
      // -localhost is load-bearing: it keeps 5900 off the public internet, so
      // the nginx TLS + basic-auth location is the only way in.
      script: "x11vnc",
      args: "-display :99 -rfbport 5900 -localhost -rfbauth /home/ziv/.vnc/passwd -forever -shared -noxdamage -o /tmp/x11vnc.log",
      interpreter: "none",
      cwd: "/home/ziv",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      time: true,
    },
    {
      name: "orellius-view",
      // noVNC over websockify, loopback only. Public access is via
      // https://104-200-30-37.sslip.io/orellius-view/ (nginx, basic auth).
      script: "/usr/bin/websockify",
      args: "--web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900",
      interpreter: "python3",
      cwd: "/home/ziv",
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      time: true,
    },
  ],
};
