// hub.js decides "is the browser already running?" by counting OS processes
// with the browser's image name (chrome.exe). That broke the day a second,
// isolated Chrome (the portal browser) started running continuously alongside
// whatever browser a given hub manages: hub A would see hub B's chrome.exe in
// the process list, conclude "chrome.exe is running", and silently stop
// relaunching its OWN browser - forever, for as long as hub B's Chrome stayed
// up. Fix: each hub managing an isolated profile registers its
// --user-data-dir; every hub's count excludes processes matching ANOTHER
// hub's registered directory, and pays zero cost when no foreign marker is
// registered at all (today's status quo for every hub except the portal's).
//
// hub.js is a script with top-level side effects (opens a TCP server, an HTTP
// admin server, timers) - importing it here would bind real ports and could
// collide with an actual hub already running on this machine. So, matching
// diagnostics-redact-session-ids.test.mjs's own precedent, the two PURE
// functions under test are copied verbatim from host/hub.js rather than
// imported. Keep this in sync with hub.js's filterExcludedCommandLines /
// liveOtherUserDataDirs if either changes.

function filterExcludedCommandLines(commandLines, excludeDirs) {
  if (!excludeDirs.length) return commandLines.length;
  const lowerDirs = excludeDirs.map((d) => d.toLowerCase());
  return commandLines.filter((l) => !lowerDirs.some((d) => l.toLowerCase().includes(d))).length;
}

function liveOtherUserDataDirs(all, ownPort, now) {
  const BROWSER_TAG_STALE_MS = 5 * 60 * 1000;
  return Object.entries(all || {})
    .filter(([port, info]) => port !== String(ownPort) && info && info.userDataDir && (now - (info.updatedAt || 0)) < BROWSER_TAG_STALE_MS)
    .map(([, info]) => info.userDataDir);
}

const checks = [];
const check = (name, ok) => checks.push([name, ok]);

// --- filterExcludedCommandLines --------------------------------------------

check(
  "no foreign marker registered -> unchanged count (today's behavior for every existing hub)",
  filterExcludedCommandLines(
    [`"C:\\...\\chrome.exe" --profile-directory=Default`, `"C:\\...\\chrome.exe" --type=renderer`],
    []
  ) === 2
);

check(
  "a foreign hub's portal Chrome is excluded by its exact --user-data-dir",
  filterExcludedCommandLines(
    [
      `"C:\\...\\chrome.exe" --profile-directory=Default`, // Ziv's real Chrome
      `"C:\\...\\chrome.exe" --user-data-dir=C:\\kmbot-portal\\profile --headless=new`, // portal Chrome
    ],
    ["C:\\kmbot-portal\\profile"]
  ) === 1
);

check(
  "excluding everyone still counts zero correctly, not a falsy miscount",
  filterExcludedCommandLines(
    [`"C:\\...\\chrome.exe" --user-data-dir=C:\\kmbot-portal\\profile --headless=new`],
    ["C:\\kmbot-portal\\profile"]
  ) === 0
);

check(
  "directory match is case-insensitive (Windows paths)",
  filterExcludedCommandLines(
    [`"C:\\...\\chrome.exe" --user-data-dir=C:\\KMBOT-PORTAL\\Profile`],
    ["c:\\kmbot-portal\\profile"]
  ) === 0
);

check(
  "a real chrome.exe that merely SHARES A PREFIX with the excluded dir is still excluded (substring match is intentional - a command line containing the exact registered dir string is that hub's Chrome, full stop)",
  filterExcludedCommandLines(
    [`"C:\\...\\chrome.exe" --user-data-dir=C:\\kmbot-portal\\profile-old-backup`],
    ["C:\\kmbot-portal\\profile"]
  ) === 0
);

// --- liveOtherUserDataDirs ---------------------------------------------------

const NOW = 1_800_000_000_000; // fixed instant, no Date.now() (would break workflow resume elsewhere; irrelevant here but keep the habit)

check(
  "a fresh foreign registration is live",
  JSON.stringify(liveOtherUserDataDirs(
    { "18787": { userDataDir: "C:\\kmbot-portal\\profile", updatedAt: NOW - 1000 } },
    18765, NOW
  )) === JSON.stringify(["C:\\kmbot-portal\\profile"])
);

check(
  "this hub's OWN port is never returned as a foreign dir",
  liveOtherUserDataDirs(
    { "18765": { userDataDir: "C:\\ziv\\profile", updatedAt: NOW - 1000 } },
    18765, NOW
  ).length === 0
);

check(
  "a stale registration (hub gone, stopped refreshing) is dropped",
  liveOtherUserDataDirs(
    { "18787": { userDataDir: "C:\\kmbot-portal\\profile", updatedAt: NOW - 6 * 60 * 1000 } },
    18765, NOW
  ).length === 0
);

check(
  "no file / empty registry -> no exclusions, the pre-patch fast path fires",
  liveOtherUserDataDirs({}, 18765, NOW).length === 0
);

check(
  "an entry with no userDataDir (a hub that never opted in) is ignored, not treated as a match-everything wildcard",
  liveOtherUserDataDirs(
    { "18787": { updatedAt: NOW - 1000 } },
    18765, NOW
  ).length === 0
);

let bad = 0;
for (const [name, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`); }
console.log(`\n${checks.length} checks, ${bad} wrong`);
process.exit(bad ? 1 : 0);
