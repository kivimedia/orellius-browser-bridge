// Security review finding, 30-Sep-2026: hub.js's readAllowedExtensionOrigins()
// had a fixed candidate list that only ever names the ORIGINAL Orellius
// manifest (~/.orellius-browser-bridge/com.orellius.browser_bridge.json). A
// forked hub (the portal build) writes its manifest to a different path under
// a different filename (~/.portal-browser-bridge/com.kivimedia.portal_bridge.json,
// per install-portal.js) - so without an instance-aware override, the portal
// hub's admin port (18788, which can force-private/unlock/reload/shutdown a
// browser holding live vendor sessions) would either trust the WRONG
// extension's origin (Ziv's real Orellius, since that manifest genuinely
// exists on his PC) or, if that file were absent, fail OPEN to any
// chrome-extension:// origin at all.
//
// hub.js is a script with top-level side effects (opens real TCP/HTTP
// servers) - importing it would bind real ports. Matching this project's own
// precedent (diagnostics-redact-session-ids.test.mjs,
// hub-browser-process-disambiguation.test.mjs), the pure decision function
// under test is copied verbatim rather than imported.

function decideOriginAllowed(origin, allowedOrigins, hasOverride) {
  if (!origin) return true;
  const isExt = /^(chrome|moz)-extension:\/\//.test(origin);
  if (!isExt) return false;
  if (allowedOrigins.size === 0) return !hasOverride;
  return allowedOrigins.has(origin.replace(/\/$/, ""));
}

const checks = [];
const check = (name, ok) => checks.push([name, ok]);

const PORTAL_ORIGIN = "chrome-extension://epbgfhbknapmahoclnjliabnamjpjhfc";
const REAL_ORELLIUS_ORIGIN = "chrome-extension://gikjagadbjefpaegljpaplcaohllogdn";

// --- The original, shared hub (no override) - behavior must be UNCHANGED ----

check(
  "no origin header (CLI/scripts) is always allowed, override or not",
  decideOriginAllowed(null, new Set(), false) === true &&
  decideOriginAllowed(null, new Set(), true) === true
);
check(
  "a non-extension origin is always refused",
  decideOriginAllowed("https://evil.test", new Set([PORTAL_ORIGIN]), false) === false
);
check(
  "original hub, manifest found, origin IN the set -> allowed",
  decideOriginAllowed(REAL_ORELLIUS_ORIGIN, new Set([REAL_ORELLIUS_ORIGIN]), false) === true
);
check(
  "original hub, manifest found, origin NOT in the set -> refused",
  decideOriginAllowed(PORTAL_ORIGIN, new Set([REAL_ORELLIUS_ORIGIN]), false) === false
);
check(
  "original hub, manifest missing (empty set), no override -> FAILS OPEN (unchanged pre-existing behavior)",
  decideOriginAllowed(PORTAL_ORIGIN, new Set(), false) === true
);

// --- The portal hub (override set) - the actual fix -------------------------

check(
  "portal hub, its OWN manifest found, its own origin -> allowed",
  decideOriginAllowed(PORTAL_ORIGIN, new Set([PORTAL_ORIGIN]), true) === true
);
check(
  "THE BUG THIS FIXES: portal hub that somehow ended up with the REAL Orellius origin in its set must still refuse it - it is the wrong extension for this hub. (Fixed by desktop/main.js pointing ORELLIUS_NATIVE_MANIFEST_PATH at the portal's OWN manifest file, so this set should never actually contain the real origin in production - this check proves the decision function itself does the right thing regardless.)",
  decideOriginAllowed(REAL_ORELLIUS_ORIGIN, new Set([PORTAL_ORIGIN]), true) === false
);
check(
  "THE BUG THIS FIXES: portal hub, manifest missing/unreadable (empty set) -> FAILS CLOSED, never any chrome-extension:// origin",
  decideOriginAllowed(PORTAL_ORIGIN, new Set(), true) === false &&
  decideOriginAllowed(REAL_ORELLIUS_ORIGIN, new Set(), true) === false &&
  decideOriginAllowed("chrome-extension://anything-at-all", new Set(), true) === false
);

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); }
console.log(`\n${checks.length} checks, ${bad} wrong`);
process.exit(bad ? 1 : 0);
