import net from 'node:net'
const SID = 'verify-emulate-' + process.pid
const sock = net.connect(18765, '127.0.0.1')
let buf = '', id = 0
const pending = new Map()
let registered

sock.on('data', d => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.type === 'registered') { registered && registered(); continue }
    if (m.type === 'heartbeat') continue
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id)
      m.type === 'tool_error' ? p.rej(new Error(m.error || 'tool error')) : p.res(m.result)
    }
  }
})
sock.on('error', e => { console.error('socket:', e.message); process.exit(2) })

const call = (tool, args = {}) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, { res, rej })
  setTimeout(() => { if (pending.delete(n)) rej(new Error(tool + ' timed out')) }, 45000)
  sock.write(JSON.stringify({ id: n, sessionId: SID, type: 'tool_request', tool, args, browser: 'chromium' }) + '\n')
})
const txt = r => (r?.content || []).map(c => c.text).filter(Boolean).join(' ')

await new Promise(r => { registered = r; sock.once('connect', () =>
  sock.write(JSON.stringify({ type: 'register_mcp_client', sessionId: SID }) + '\n')) })
console.log('registered with hub as', SID)

const ctx = await call('tabs_context_mcp', { createIfEmpty: true })
console.log('tabs_context:', txt(ctx).slice(0, 160))
const tabId = Number((txt(ctx).match(/\b(\d{3,})\b/) || [])[1])
if (!tabId) { console.error('no tabId found'); process.exit(2) }
console.log('using tabId', tabId)

const page = 'http://localhost:47800/drop/_emulate-probe.html'
await call('navigate', { url: page, tabId })
await new Promise(r => setTimeout(r, 900))

const probe = `(() => JSON.stringify({dark:matchMedia('(prefers-color-scheme: dark)').matches,rt:matchMedia('(prefers-reduced-transparency: reduce)').matches,bg:getComputedStyle(document.body).backgroundColor,bf:getComputedStyle(document.querySelector('.g')).backdropFilter,mo:getComputedStyle(document.querySelector('.m')).transitionDuration}))()`
const read = async () => txt(await call('javascript_tool', { action: 'javascript_exec', text: probe, tabId }))

console.log('\nBEFORE :', (await read()).slice(-120))
const r1 = await call('emulate', { tabId, colorScheme: 'dark', reducedTransparency: 'reduce', reducedMotion: 'reduce' })
console.log('EMULATE:', txt(r1).slice(0, 240))
const after = await read()
console.log('AFTER  :', after.slice(-120))
const st = await call('emulate', { tabId, mode: 'status' })
console.log('STATUS :', txt(st).slice(0, 160))
const cl = await call('emulate', { tabId, mode: 'clear' })
console.log('CLEAR  :', txt(cl).slice(0, 120))
const cleared = await read()
console.log('CLEARED:', cleared.slice(-120))
const noop = await call('emulate', { tabId })
console.log('NO-OP  :', txt(noop).slice(0, 100))

const g = s => {
  // javascript_tool hands back a JSON-encoded STRING, so the payload is
  // double-encoded. Unwrap until it stops being a string.
  let v = s.trim()
  for (let i = 0; i < 3; i++) {
    const m = String(v).match(/[\[{"].*[\]}"]/s)
    if (!m) break
    try { v = JSON.parse(m[0]) } catch { break }
    if (typeof v === 'object') return v
  }
  return typeof v === 'object' ? v : {}
}
const a = g(after), pre = g(cleared)
const checks = [
  ['dark forced on',            a.dark === true],
  ['page repainted black',      a.bg === 'rgb(0, 0, 0)'],
  ['reduced-transparency on',   a.rt === true],
  ['reduced-motion killed transition', a.mo === '0s'],
  ['backdrop-filter went none', a.bf === 'none'],
  ['status reports the state',  /prefers-color-scheme/.test(txt(st))],
  ['clear restored light',      pre.dark === false && pre.bg === 'rgb(255, 255, 255)'],
  ['clear restored the blur',   /blur/.test(pre.bf || '')],
  ['empty request refused',     /Nothing to emulate/.test(txt(noop))],
  ['readback reported',         /Page now reports/.test(txt(r1))],
]
let bad = 0
console.log()
for (const [n, ok] of checks) { console.log((ok ? 'PASS  ' : 'FAIL  ') + n); if (!ok) bad++ }
console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED - emulate round-tripped through the real bridge')
try { await call('tabs_close_mcp', { tabId }) } catch {}
sock.end(); process.exit(bad ? 1 : 0)
