#!/usr/bin/env node
// A tiny HTTP CONNECT proxy that is the portal Chrome's ONLY route to the
// network (--proxy-server points at this, --proxy-bypass-list disables the
// loopback exemption Chrome has by default).
//
// WHY THIS EXISTS, SEPARATE FROM extension-portal/background.js's navigate()
// gate: the extension's scheme/host check only fires when the `navigate` TOOL
// is called with an agent-supplied URL. It does nothing about a page
// REDIRECTING ITSELF, loading a subresource, or a Turnstile/CDN request that
// points at a host outside the allowlist - none of that goes through the
// navigate tool at all. HostGator's own DNS answers localhost.hostgator.com
// with 127.0.0.1 (the exact lesson that made desktop/main.js's SOCKS route
// exact-hostname-only, see HOME_EGRESS_SOCKS_HOSTS) - if a page on an allowed
// host ever loaded or redirected to that name, a Chrome with no network-level
// gate would connect this PC's browser process straight to its own loopback:
// Ziv's real Orellius hub (18765/18766), his TOTP endpoint, the KM BOT desktop
// app admin surface. This proxy is the wall; the extension's gate is just the
// door that gives a clear error for the common, non-adversarial case (the
// agent asking for somewhere it plainly should not go).
//
// Rules, applied to EVERY CONNECT request Chrome makes (not just top-level
// navigation - every subresource, redirect target, websocket upgrade):
//   1. Only CONNECT is accepted. No plain HTTP proxying at all (matches "https
//      on 443 only" from the home-route precedent) - a GET/POST to this proxy
//      is refused outright, so there is no plaintext path through it either.
//   2. Target port must be 443.
//   3. Target hostname must EXACTLY match one of PORTAL_ALLOWED_HOSTS - no
//      suffix, no wildcard (same reasoning as background.js's PORTAL_ALLOWED_HOSTS
//      and desktop/main.js's PermitRemoteOpen list - one list, kept in three
//      places on purpose, test/portal-browser-tools.test.py checks they agree).
//   4. The hostname is resolved via DNS (both families), and if ANY resolved
//      address is loopback, link-local, or a private range, the connection is
//      refused - even for an allowed hostname. This is the layer the SSH
//      PermitRemoteOpen route explicitly does NOT have ("no lookups" - see
//      desktop/main.js's own comment); it is tractable to add here because
//      this proxy is plain Node code, not an ssh flag.
//   5. The proxy connects to the VALIDATED resolved address directly (never
//      re-resolves the hostname a second time), so there is no time-of-check/
//      time-of-use DNS-rebind window between the check and the connection.
//   6. Once connected, this is a blind byte relay for the TLS bytes - the
//      proxy never terminates TLS, never inspects the encrypted payload, and
//      needs no certificates.

import net from "node:net";
import dns from "node:dns/promises";
import http from "node:http";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.PORTAL_EGRESS_PROXY_PORT || 18789);

const ALLOWED_HOSTS = new Set(
  (process.env.PORTAL_ALLOWED_HOSTS ||
    "hostgator.com www.hostgator.com portal.hostgator.com " +
    "cloudways.com www.cloudways.com unified.cloudways.com platform.cloudways.com api.cloudways.com " +
    "dash.cloudflare.com challenges.cloudflare.com hagen.challenges.cloudflare.com")
    .toLowerCase().split(/\s+/).filter(Boolean)
);

function log(msg) {
  process.stderr.write(`[portal-egress-proxy] ${msg}\n`);
}

// IPv4/IPv6 loopback, link-local, and RFC1918/ULA private ranges. A DNS
// answer landing in any of these is refused even for an allowed hostname -
// this is the check the SSH-tunnel route (desktop/main.js) explicitly does
// not have, and the whole reason the home-route's own comment calls out
// localhost.hostgator.com -> 127.0.0.1 as the lesson.
function isPrivateOrLoopback(address, family) {
  if (family === 4 || net.isIPv4(address)) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true; // malformed -> refuse
    const [a, b] = octets;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this network"
    return false;
  }
  // IPv6
  const lower = address.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower === "::") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("::ffff:")) return isPrivateOrLoopback(lower.slice(7), 4); // v4-mapped
  return false;
}

async function resolveAllAddresses(hostname) {
  const results = [];
  try {
    for (const r of await dns.resolve4(hostname)) results.push({ address: r, family: 4 });
  } catch {}
  try {
    for (const r of await dns.resolve6(hostname)) results.push({ address: r, family: 6 });
  } catch {}
  return results;
}

// Two pure decision functions, separated from the real network/DNS I/O above
// so they are hermetically testable (test/portal-egress-proxy.test.mjs calls
// these directly with synthetic inputs - no real DNS, no sockets, no child
// process). Split in two because the server checks them at two different
// times: cheap() before ever making a DNS query (so a disallowed host is
// refused with zero network activity), afterResolution() only once a lookup
// actually happened.

function cheapConnectCheck(hostname, port, allowedHosts) {
  if (port !== 443) return { ok: false, code: 403, message: "Forbidden - only port 443 is allowed" };
  if (net.isIP(hostname)) return { ok: false, code: 403, message: "Forbidden - IP-literal targets are never allowed, only the three portal hostnames" };
  if (!allowedHosts.has(hostname)) return { ok: false, code: 403, message: `Forbidden - "${hostname}" is not one of the portal's allowed hosts` };
  return { ok: true };
}

function afterResolutionCheck(hostname, resolvedAddresses) {
  if (!resolvedAddresses.length) return { ok: false, code: 502, message: "Bad Gateway - DNS resolution returned nothing" };
  const bad = resolvedAddresses.find((a) => isPrivateOrLoopback(a.address, a.family));
  if (bad) return { ok: false, code: 403, message: `Forbidden - "${hostname}" resolved to ${bad.address}, which is loopback/private - refusing even though the hostname is allowed` };
  return { ok: true, address: resolvedAddresses[0] };
}

// The ONE narrow exception to "CONNECT only, https on 443 only": the
// extension's own cheap hub-health probe (background.js's HUB_ADMIN_URL,
// "one localhost fetch and no process at all" before it bothers spawning the
// native host). --proxy-bypass-list=<-loopback> routes this through us like
// everything else, and without an exception it always fails (this proxy
// never had a path for plain HTTP or non-443 ports), degrading a
// zero-process check into "spawn a process every ~5 minutes regardless" -
// a functional bug, found in the 30-Sep-2026 security review. This is NOT a
// general loopback bypass: it is one fixed, literal destination (this
// machine's OWN paired hub admin port), GET only, no DNS involved at all
// (an IP literal, never resolved), so it cannot be redirected or rebound to
// anything else the way a hostname-based rule could be.
const OWN_ADMIN_PORT = Number(process.env.PORTAL_OWN_ADMIN_PORT || 18788);

function isOwnAdminHealthCheck(req) {
  if (req.method !== "GET") return false;
  let u;
  try { u = new URL(req.url, `http://127.0.0.1:${OWN_ADMIN_PORT}`); } catch { return false; }
  return u.protocol === "http:" && u.hostname === "127.0.0.1" &&
    Number(u.port || 80) === OWN_ADMIN_PORT && u.pathname === "/admin/status";
}

const server = http.createServer((req, res) => {
  if (isOwnAdminHealthCheck(req)) {
    const upstream = http.get(`http://127.0.0.1:${OWN_ADMIN_PORT}/admin/status`, { timeout: 3000 }, (ures) => {
      res.writeHead(ures.statusCode || 502, ures.headers);
      ures.pipe(res);
    });
    upstream.on("error", () => { try { res.writeHead(502).end(); } catch {} });
    upstream.on("timeout", () => upstream.destroy());
    return;
  }
  // No plain-HTTP proxying at all otherwise - CONNECT only. A GET here means
  // something is trying to use this as an open HTTP proxy, not a CONNECT
  // tunnel.
  res.writeHead(405, { "Content-Type": "text/plain" });
  res.end("This proxy only accepts CONNECT. No plaintext HTTP is forwarded.\n");
});

server.on("connect", async (req, clientSocket, head) => {
  const refuse = (code, message) => {
    log(`refused CONNECT ${req.url}: ${message}`);
    try {
      clientSocket.write(`HTTP/1.1 ${code} ${message}\r\n\r\n`);
    } catch {}
    clientSocket.destroy();
  };

  const m = /^([^:]+):(\d+)$/.exec(req.url || "");
  if (!m) return refuse(400, "Bad Request - CONNECT target must be host:port");
  const hostname = m[1].toLowerCase();
  const port = Number(m[2]);

  // Cheap checks (port/scheme/allowlist) run before any DNS query - a
  // disallowed host is refused with zero network activity.
  const cheap = cheapConnectCheck(hostname, port, ALLOWED_HOSTS);
  if (!cheap.ok) return refuse(cheap.code, cheap.message);

  let addresses;
  try {
    addresses = await resolveAllAddresses(hostname);
  } catch (err) {
    return refuse(502, `Bad Gateway - DNS resolution failed: ${err.message}`);
  }
  const decision = afterResolutionCheck(hostname, addresses);
  if (!decision.ok) return refuse(decision.code, decision.message);

  // Connect to the address we just validated - never re-resolve the hostname,
  // which would reopen exactly the DNS-rebind window this check exists to close.
  const target = decision.address;
  const upstream = net.connect(port, target.address, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", (err) => refuse(502, `Bad Gateway - ${err.message}`));
  clientSocket.on("error", () => upstream.destroy());
});

// Only actually bind a socket when run as a script - importing this module
// for its pure functions (test/portal-egress-proxy.test.mjs) must never open
// a port.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, "127.0.0.1", () => {
    log(`listening on 127.0.0.1:${PORT}, allowed hosts: ${[...ALLOWED_HOSTS].join(", ")}`);
  });
}

export { cheapConnectCheck, afterResolutionCheck, isPrivateOrLoopback };
