// The portal egress proxy is the network-level wall behind the portal Chrome
// (see the file header of host/portal-egress-proxy.mjs for why the
// extension's navigate() gate alone is not enough - a page-driven redirect or
// subresource load never goes through that tool). Two parts here:
//   1. Hermetic checks of the pure decision functions (no DNS, no sockets).
//   2. A live smoke test: spawn the real proxy as a child process and drive
//      real CONNECT requests at it, including one real internet lookup, to
//      prove the actual server wiring - not just the decision logic - works.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cheapConnectCheck, afterResolutionCheck, isPrivateOrLoopback } from "../host/portal-egress-proxy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const checks = [];
const check = (name, ok) => { checks.push([name, ok]); };

const HOSTS = new Set(["www.hostgator.com", "unified.cloudways.com"]);

// --- Part 1: pure decision functions ----------------------------------------

check("wrong port refused", !cheapConnectCheck("www.hostgator.com", 80, HOSTS).ok);
check("IP-literal refused even if it were somehow in the allow set", !cheapConnectCheck("127.0.0.1", 443, HOSTS).ok);
check("disallowed hostname refused", !cheapConnectCheck("evil.test", 443, HOSTS).ok);
check("allowed hostname on 443 passes the cheap check", cheapConnectCheck("www.hostgator.com", 443, HOSTS).ok);
check(
  "a lookalike host (suffix match, not exact) is refused",
  !cheapConnectCheck("localhost.hostgator.com", 443, HOSTS).ok
);

check("IPv4 loopback flagged", isPrivateOrLoopback("127.0.0.1", 4));
check("IPv4 RFC1918 10/8 flagged", isPrivateOrLoopback("10.1.2.3", 4));
check("IPv4 RFC1918 172.16/12 flagged", isPrivateOrLoopback("172.20.0.5", 4));
check("IPv4 172.15.x NOT flagged (just outside the 172.16-31 range)", !isPrivateOrLoopback("172.15.0.5", 4));
check("IPv4 RFC1918 192.168/16 flagged", isPrivateOrLoopback("192.168.1.1", 4));
check("IPv4 link-local 169.254/16 flagged", isPrivateOrLoopback("169.254.1.1", 4));
check("IPv4 real public address not flagged", !isPrivateOrLoopback("93.184.216.34", 4));
check("IPv6 loopback ::1 flagged", isPrivateOrLoopback("::1", 6));
check("IPv6 link-local fe80:: flagged", isPrivateOrLoopback("fe80::1", 6));
check("IPv6 ULA fd00:: flagged", isPrivateOrLoopback("fd12:3456::1", 6));
check("IPv6-mapped v4 loopback ::ffff:127.0.0.1 flagged", isPrivateOrLoopback("::ffff:127.0.0.1", 6));

check(
  "afterResolutionCheck refuses a resolved loopback address even for an allowed hostname (the localhost.hostgator.com lesson)",
  !afterResolutionCheck("www.hostgator.com", [{ address: "127.0.0.1", family: 4 }]).ok
);
check(
  "afterResolutionCheck allows a real public resolved address",
  afterResolutionCheck("www.hostgator.com", [{ address: "93.184.216.34", family: 4 }]).ok
);
check(
  "afterResolutionCheck refuses when DNS returned nothing at all",
  !afterResolutionCheck("www.hostgator.com", []).ok
);
check(
  "one bad address among several is enough to refuse the whole connection",
  !afterResolutionCheck("www.hostgator.com", [
    { address: "93.184.216.34", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]).ok
);

// --- Part 2: live server smoke test ------------------------------------------

function connectThrough(proxyPort, targetHostPort) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: targetHostPort, timeout: 8000,
    });
    req.on("connect", (res, socket) => { socket.destroy(); resolve({ statusCode: res.statusCode }); });
    req.on("response", (res) => resolve({ statusCode: res.statusCode })); // 405 for non-CONNECT-style rejection paths
    req.on("error", (err) => resolve({ error: err.message }));
    req.on("timeout", () => { req.destroy(); resolve({ error: "timeout" }); });
    req.end();
  });
}

function getThrough(proxyPort) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method: "GET", path: "/", timeout: 5000 }, (res) => {
      resolve({ statusCode: res.statusCode });
      res.resume();
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

// Mirrors how Chrome actually talks to an explicit HTTP proxy for a plain
// http:// URL: the request line carries the ABSOLUTE URI (what
// isOwnAdminHealthCheck's `new URL(req.url, ...)` parses), not a bare path.
function getAbsoluteThrough(proxyPort, method, absoluteUrl) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, method, path: absoluteUrl, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on("error", (err) => resolve({ error: err.message }));
    req.end();
  });
}

// Well clear of every port this project already uses (18765/18766/18775/
// 18787/18788/18789/18795/18796/18798/18799) - 18799 was tried first and hit
// a live EADDRINUSE against the real KM BOT desktop app's TOTP endpoint
// running on this very machine, which is exactly the kind of collision this
// choice needs to avoid.
const TEST_PORT = 19787;
const TEST_ADMIN_PORT = 19788;

// A fake "extension's own paired hub admin" server, standing in for the real
// one on 18788, so the narrow GET /admin/status exception can be proven end
// to end without touching the real portal hub.
const fakeAdmin = http.createServer((req, res) => {
  if (req.url === "/admin/status") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true,"fake":true}'); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => fakeAdmin.listen(TEST_ADMIN_PORT, "127.0.0.1", resolve));

const child = spawn(process.execPath, [path.join(__dirname, "..", "host", "portal-egress-proxy.mjs")], {
  env: { ...process.env, PORTAL_EGRESS_PROXY_PORT: String(TEST_PORT), PORTAL_OWN_ADMIN_PORT: String(TEST_ADMIN_PORT) },
  stdio: ["ignore", "ignore", "pipe"],
});
let ready = false;
child.stderr.on("data", (d) => { if (String(d).includes("listening on")) ready = true; });
const deadline = Date.now() + 5000;
while (!ready && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
check("the proxy process actually started and logged its listen line", ready);

if (ready) {
  const plainGet = await getThrough(TEST_PORT);
  check("a plain GET (not CONNECT) is refused with 405, not silently proxied", plainGet.statusCode === 405);

  const disallowed = await connectThrough(TEST_PORT, "evil.test:443");
  check("CONNECT to a disallowed host is refused (no 200)", disallowed.statusCode !== 200);

  const wrongPort = await connectThrough(TEST_PORT, "www.hostgator.com:8443");
  check("CONNECT to an allowed host on a non-443 port is refused", wrongPort.statusCode !== 200);

  const ipLiteral = await connectThrough(TEST_PORT, "127.0.0.1:443");
  check("CONNECT to a bare IP literal is refused", ipLiteral.statusCode !== 200);

  // Real DNS + real TCP connect to a real allowed host - proves the happy
  // path actually works end to end, not just in the pure-function checks.
  const allowed = await connectThrough(TEST_PORT, "www.hostgator.com:443");
  check(
    "CONNECT to a real allowed host on 443 succeeds (live DNS + live TCP connect)",
    allowed.statusCode === 200,
    allowed
  );

  // The narrow admin-health-check exception (security review fix, 30-Sep-2026):
  // GET http://127.0.0.1:<OWN_ADMIN_PORT>/admin/status must pass through to the
  // fake admin server; everything else plain-HTTP stays refused exactly as before.
  const healthOk = await getAbsoluteThrough(TEST_PORT, "GET", `http://127.0.0.1:${TEST_ADMIN_PORT}/admin/status`);
  check(
    "the extension's own hub-health probe (GET /admin/status) is passed through, proving the fix actually closes the 5-minute-respawn bug",
    healthOk.statusCode === 200 && healthOk.body.includes('"fake":true'),
    healthOk
  );
  const wrongPath = await getAbsoluteThrough(TEST_PORT, "GET", `http://127.0.0.1:${TEST_ADMIN_PORT}/admin/shutdown`);
  check("a DIFFERENT admin path (not /admin/status) is still refused - the exception is not a general admin-port bypass", wrongPath.statusCode === 405, wrongPath);
  const wrongMethod = await getAbsoluteThrough(TEST_PORT, "POST", `http://127.0.0.1:${TEST_ADMIN_PORT}/admin/status`);
  check("POST to /admin/status is still refused - GET only", wrongMethod.statusCode === 405, wrongMethod);
  const wrongPort2 = await getAbsoluteThrough(TEST_PORT, "GET", `http://127.0.0.1:${TEST_PORT}/admin/status`);
  check("the SAME path on a DIFFERENT port (not the configured admin port) is still refused", wrongPort2.statusCode === 405, wrongPort2);
}
child.kill();
fakeAdmin.close();

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); }
console.log(`\n${checks.length} checks, ${bad} wrong`);
process.exit(bad ? 1 : 0);
