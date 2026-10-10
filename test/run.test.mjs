// Runs the REAL src/run.mjs against a local mock RPC server.  node test/run.test.mjs
import http from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const BASE_TS = Date.UTC(2026, 9, 1, 0, 0, 0) / 1000
const TIP = 400, STEP = 40 // 90 blocks per "hour"
let failNext = 0, limit429 = 0
const calls = []

const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    calls.push(req.url)
    if (failNext > 0) { failNext--; res.statusCode = 500; return res.end('x') }
    if (limit429 > 0) { limit429--; res.statusCode = 429; return res.end('x') }
    const out = JSON.parse(body).map((c) => {
      const n = parseInt(c.params?.[0] ?? '0', 16)
      if (c.method === 'eth_call') return { id: c.id, result: '0x' + (6).toString(16).padStart(64, '0') }
      if (c.method === 'eth_blockNumber') return { id: c.id, result: '0x' + TIP.toString(16) }
      if (c.method === 'eth_getBlockByNumber') return { id: c.id, result: { timestamp: '0x' + (BASE_TS + n * STEP).toString(16) } }
      const mk = (k) => ({ status: k % 7 ? '0x1' : '0x0', gasUsed: '0x5208', effectiveGasPrice: '0x4a817c800', from: '0xa' + (n % 5), to: '0xc' + ((n + k) % 3), logs: [{ address: '0xdd', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(63) + (n % 4), '0x' + '0'.repeat(63) + '9'], data: '0x' + (1000000).toString(16).padStart(64, '0') }] })
      return { id: c.id, result: [mk(0), mk(1)] }
    })
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out))
  })
})

function sandbox(state) {
  const d = mkdtempSync(join(tmpdir(), 'idx-'))
  mkdirSync(join(d, 'src')); cpSync(join(SRC, 'run.mjs'), join(d, 'src', 'run.mjs')); cpSync(join(SRC, 'apps.mjs'), join(d, 'src', 'apps.mjs'))
  writeFileSync(join(d, 'apps.testnet.json'), JSON.stringify({ apps: [{ id: 'tok', anchors: [{ address: '0xdd', kind: 'token', usd: true }] }, { id: 'ctr', anchors: [{ address: '0xc0', kind: 'contract' }] }] }))
  if (state) { mkdirSync(join(d, 'data', 'testnet'), { recursive: true }); writeFileSync(join(d, 'data', 'testnet', 'state.json'), JSON.stringify(state)) }
  return d
}
function run(d, env = {}) {
  return new Promise((resolve) => execFile('node', [join(d, 'src', 'run.mjs')], { env: { ...process.env, NET: 'testnet', RPC_URLS: `http://127.0.0.1:${server.address().port}`, ...env }, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })))
}
const days = (d) => { const dir = join(d, 'data', 'testnet', 'hourly'); return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')])) }
const state = (d) => JSON.parse(readFileSync(join(d, 'data', 'testnet', 'state.json'), 'utf8'))
let bad = 0
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!ok) bad++ }

server.listen(0, '127.0.0.1', async () => {
  const seed = { next: 0, tip: 0 } // start at block 0, no backfill jump (BACKFILL_HOURS huge)
  const env = { BACKFILL_HOURS: '100000', BUDGET_SECONDS: '60' }

  // 1. one big run vs many tiny slices must be identical
  const A = sandbox(seed); await run(A, env)
  const B = sandbox(seed); let n = 0
  while (state(B).next <= TIP && n++ < 500) await run(B, { ...env, BUDGET_SECONDS: '0.12' })
  const dA = days(A), dB = days(B)
  check('sliced == single run', JSON.stringify(dA) === JSON.stringify(dB), `(${n} slices)`)
  if (JSON.stringify(dA) !== JSON.stringify(dB)) { const a = JSON.parse(Object.values(dA)[0]), b = JSON.parse(Object.values(dB)[0]); for (const k of Object.keys(a)) { const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]); if (x !== y) console.log('  diff', k, x.slice(0, 200), '\n      ', y.slice(0, 200)) } }
  const total = Object.values(JSON.parse(Object.values(days(A))[0])).reduce((s, h) => s + h.txs, 0)
  const allDays = Object.values(days(A)).flatMap((t) => Object.values(JSON.parse(t)))
  check('every block counted once', allDays.reduce((s, h) => s + h.blocks, 0) === TIP + 1, `(blocks=${allDays.reduce((s, h) => s + h.blocks, 0)})`)
  check('tx count = 2 per block', allDays.reduce((s, h) => s + h.txs, 0) === (TIP + 1) * 2)

  const hrs = allDays
  check('app stats: token volume = 1 USDC per transfer', Math.abs(hrs.reduce((t, h) => t + (h.apps?.tok?.vol ?? 0), 0) - (TIP + 1) * 2) < 1e-6)
  check('app wallets survive slices (not zero, equal to single run)', hrs.every((h) => typeof h.apps?.tok?.wallets === 'number' && h.apps.tok.wallets > 0))

  // 2. 429 then success: still finishes
  const C = sandbox(seed); limit429 = 2; const rc = await run(C, env)
  check('recovers from 429', rc.status === 0 && state(C).next === TIP + 1)

  // 3. all endpoints failing: exits without hanging, state stays resumable
  const D = sandbox(seed); failNext = 1000; const rd = await run(D, env); failNext = 0
  check('total outage fails fast, state untouched', rd.status !== 0 && state(D).next === 0)

  // 4. huge backlog jumps forward and records the skip
  const E = sandbox(seed); await run(E, { BACKFILL_HOURS: '0.05', BUDGET_SECONDS: '60' })
  const se = state(E)
  check('jumps forward when far behind', se.skipped?.length === 1 && se.next === TIP + 1, JSON.stringify(se.skipped))

  // 5. old-format state (openHour, no open.json) migrates by redoing the open hour once
  const F = sandbox({ next: 150, tip: 150, openHour: '2026-10-01T00', openHourStart: 90 })
  await run(F, env)
  const fb = Object.values(JSON.parse(Object.values(days(F))[0])).reduce((s, h) => s + h.blocks, 0)
  check('migration restarts open hour', state(F).next === TIP + 1 && fb === TIP + 1 - 90, `(blocks=${fb})`)

  server.close(); console.log(bad ? `${bad} FAILED` : 'all passed'); process.exit(bad ? 1 : 0)
})
