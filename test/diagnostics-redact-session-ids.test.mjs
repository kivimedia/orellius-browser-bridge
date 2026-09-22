// The two redactions, driven with the same shapes background.js produces.
// Fake chrome API: two windows, each with a Claude group owned by a different
// session, one of them the caller's.
const MINE = "6dc43406", OTHER = "a1b2c3d4";
const T = (id) => `\u{1F512} Claude · ${id}`;
globalThis.chrome = {
  windows: { getAll: async () => ([
    { id: 1, state: "normal", focused: true,  tabs: [{ id: 11, groupId: 101 }] },
    { id: 2, state: "normal", focused: false, tabs: [{ id: 22, groupId: 202 }] },
  ])},
  tabGroups: { get: async (g) => ({ title: g === 101 ? T(MINE) : T(OTHER) }) },
};
const OWNERS = { 1: MINE, 2: OTHER };
const findOwnerOfWindow = (id) => OWNERS[id] || null;

async function _debugWindowsOverview(mySessionId) {
  const myGroupTitle = mySessionId ? `\u{1F512} Claude · ${String(mySessionId).slice(0, 8)}` : null;
  const wins = await chrome.windows.getAll({ populate: true });
  const lines = [];
  for (const w of wins) {
    let claude = 0, human = 0; const groups = new Set();
    for (const t of w.tabs || []) {
      let isClaude = false;
      if (t.groupId !== undefined && t.groupId !== -1) {
        const g = await chrome.tabGroups.get(t.groupId);
        if ((g.title || "").startsWith("\u{1F512} Claude")) {
          isClaude = true;
          groups.add(g.title === myGroupTitle ? g.title : "\u{1F512} Claude · <other session>");
        }
      }
      if (isClaude) claude++; else human++;
    }
    const owner = findOwnerOfWindow(w.id);
    lines.push(`window ${w.id}: claude=${claude} human=${human}${owner ? ` claimedBy=${owner === mySessionId ? owner : "<other session>"}` : ""}${groups.size ? ` groups=[${[...groups].join(" | ")}]` : ""}`);
  }
  return lines.join("\n");
}

const census = await _debugWindowsOverview(MINE);
console.log(census);
const ring = [{ api: "tabs.update", session: MINE }, { api: "windows.update", session: OTHER }];
const trace = ring.map((e) => JSON.stringify(e.session === MINE ? e : { ...e, session: "<other session>" })).join("\n");
console.log(trace);
const all = census + "\n" + trace;
const checks = [
  ["caller sees its OWN id",            all.includes(MINE)],
  ["other session id is GONE",          !all.includes(OTHER)],
  ["census still counts other windows", /window 2: claude=1/.test(census)],
  ["trace still names the API",         all.includes("windows.update")],
];
let bad = 0;
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); }
console.log(`\n${checks.length} checks, ${bad} wrong`);
process.exit(bad ? 1 : 0);
