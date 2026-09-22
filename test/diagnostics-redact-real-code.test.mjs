// Diagnostics redaction, run against the REAL extension/background.js.
//
// 22-Sep-2026. diagnostics-redact-session-ids.test.mjs re-implements the logic
// it checks, so it passed 4/4 while the shipped code still printed a second
// agent's session id in RECENT-LOGS and in every FOCUS-TRACE entry (measured
// live with two agent sessions on one hub). This one pulls the redactor out of
// the shipped file, feeds it the exact lines the live probe returned, and checks
// that the diagnostics assembly routes BOTH channels through it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "background.js"), "utf8");
const start = SRC.indexOf("const _seenSessionIds = new Set();");
const end = SRC.indexOf("async function _debugWindowsOverview(");
if (start < 0 || end < start) { console.log("FAIL could not find the redactor in background.js"); process.exit(1); }
const { _seenSessionIds, _redactOtherSessions } =
  new Function(SRC.slice(start, end) + "\nreturn { _seenSessionIds, _redactOtherSessions };")();

const MINE = "eff9cd99", OTHER = "15c7cfb0", RECOVERED = "b309592f";
_seenSessionIds.add(MINE); _seenSessionIds.add(OTHER);
const logs = [
  "11:00:18.331 Tool request: tabs_context_mcp (id: eff9cd99_1, session: eff9cd99)",
  "11:00:18.810 session eff9cd99 claimed window 1837020176",
  "11:00:18.912 Tool request: tabs_context_mcp (id: 15c7cfb0_1, session: 15c7cfb0)",
  "11:00:19.499 session 15c7cfb0 claimed window 1837020178",
  `11:00:20.000 Recovered group 🔒 Claude · ${RECOVERED} (id: ${RECOVERED}_4)`,
].join("\n");
const trace = [
  JSON.stringify({ api: "tabs.update", tabId: 1837020177, t: 1790000000000, session: MINE }),
  JSON.stringify({ api: "windows.update", windowId: 1837020178, t: 1790000000001, session: OTHER }),
].join("\n");
const outLogs = _redactOtherSessions(logs, MINE);
const outTrace = _redactOtherSessions(trace, MINE);
console.log(outLogs + "\n" + outTrace);
const all = outLogs + "\n" + outTrace;

const diag = SRC.slice(SRC.indexOf("const _trace = args.diagnostics"), SRC.indexOf("===RECENT-LOGS===") + 200);
const checks = [
  ["caller keeps its own id",                    outLogs.includes("session: eff9cd99") && outTrace.includes(`"session":"${MINE}"`)],
  ["a served session's id is gone (logs+trace)", !all.includes(OTHER)],
  ["an id seen only in a log line is gone",      !all.includes(RECOVERED)],
  ["tab and window ids survive",                 all.includes("1837020176") && all.includes("1837020178") && all.includes("1837020177")],
  ["timestamps survive",                         all.includes("1790000000001") && all.includes("11:00:19.499")],
  ["FOCUS-TRACE is routed through the redactor", /_redactOtherSessions\(_focusTrace/.test(diag)],
  ["RECENT-LOGS is routed through the redactor", /_redactOtherSessions\(_logRing/.test(diag)],
  ["every served session id is recorded",        /handleToolRequest\([^)]*\)\s*\{\s*if \(sessionId\) _seenSessionIds\.add/.test(SRC)],
];
let bad = 0;
for (const [n, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"} ${n}`); }
console.log(`\n${checks.length} checks, ${bad} wrong`);
process.exit(bad ? 1 : 0);
