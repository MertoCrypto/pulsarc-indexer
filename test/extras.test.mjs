import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeAnomalies, CFG as A } from '../src/anomalies.mjs'
import { computeDigest } from '../src/digest.mjs'
import { scanAgents, slimUri, decodeString, decodeAddress, SEL_OWNER_OF, SEL_TOKEN_URI } from '../src/agents.mjs'

const NOW = Date.parse('2026-10-10T12:30:00Z')
const keyOf = (t) => new Date(t).toISOString().slice(0, 13)
// build `n` hours ending with the hour that finished at 12:00 (key 11)
function series(n, fn) {
  const out = {}
  const lastStart = Date.parse('2026-10-10T11:00:00Z')
  for (let i = n - 1; i >= 0; i--) out[keyOf(lastStart - i * 3_600_000)] = fn(n - 1 - i, i)
  return out
}
const flat = (apps) => (i, back) => ({ txs: Object.values(apps(back)).reduce((s, a) => s + a.tx, 0), apps: apps(back) })

describe('anomalies', () => {
  it('flags a spike >= 2x the 24h median', () => {
    const h = series(30, flat((back) => ({ usdc: { tx: back === 0 ? 1000 : 400 }, memo: { tx: 300 } })))
    const r = computeAnomalies(h, NOW)
    assert.equal(r.status, 'ok')
    assert.deepEqual(r.items.map((i) => [i.app, i.kind]), [['usdc', 'spike']])
    assert.equal(r.items[0].ratio, 2.5)
    assert.equal(r.items[0].baseline, 400)
  })
  it('flags a 70% drop', () => {
    const h = series(30, flat((back) => ({ usdc: { tx: back === 0 ? 100 : 1000 } })))
    const r = computeAnomalies(h, NOW)
    assert.deepEqual(r.items.map((i) => [i.app, i.kind, i.ratio]), [['usdc', 'drop', 0.1]])
  })
  it('1.9x is not a spike, 31% of median is not a drop', () => {
    assert.equal(computeAnomalies(series(30, flat((b) => ({ a: { tx: b === 0 ? 760 : 400 } }))), NOW).items.length, 0)
    assert.equal(computeAnomalies(series(30, flat((b) => ({ a: { tx: b === 0 ? 310 : 1000 } }))), NOW).items.length, 0)
  })
  it('ignores small apps (below the 200 tx floor)', () => {
    const h = series(30, flat((b) => ({ tiny: { tx: b === 0 ? 150 : 20 } })))
    assert.equal(computeAnomalies(h, NOW).items.length, 0)
  })
  it('warms up with fewer than 12 baseline hours', () => {
    const r = computeAnomalies(series(10, flat((b) => ({ a: { tx: b === 0 ? 5000 : 100 } }))), NOW)
    assert.equal(r.status, 'warming-up'); assert.equal(r.items.length, 0)
  })
  it('legacy hours without apps do not count as baseline', () => {
    const h = series(30, (i, back) => (back > 5 ? { txs: 1 } : { txs: 1, apps: { a: { tx: back === 0 ? 5000 : 100 } } }))
    assert.equal(computeAnomalies(h, NOW).status, 'warming-up')
  })
  it('stale data is not shown', () => {
    const h = series(30, flat(() => ({ a: { tx: 500 } })))
    assert.equal(computeAnomalies(h, NOW + 5 * 3_600_000).status, 'stale')
  })
  it('caps at 5 items, strongest first', () => {
    const h = series(30, flat((b) => Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`a${k}`, { tx: b === 0 ? 1000 * (k + 3) : 300 }]))))
    const r = computeAnomalies(h, NOW)
    assert.equal(r.items.length, A.maxItems); assert.equal(r.items[0].app, 'a7')
  })
  it('a brand-new app jumping from zero is capped at 99x', () => {
    const h = series(30, (i, back) => ({ txs: 1, apps: back === 0 ? { x: { tx: 900 } } : { y: { tx: 10 } } }))
    assert.equal(computeAnomalies(h, NOW).items[0].ratio, 99)
  })
})

describe('digest', () => {
  const week = (n, fn) => series(n, (i, back) => ({ txs: 0, apps: fn(back) }))
  const full = (fn) => {
    const h = week(336, fn)
    for (const k of Object.keys(h)) h[k].txs = Object.values(h[k].apps).reduce((s, a) => s + a.tx, 0)
    return h
  }
  it('warming-up with under 14 days, with a readyAt', () => {
    const d = computeDigest(week(100, () => ({ a: { tx: 10 } })), 'mainnet', NOW)
    assert.equal(d.status, 'warming-up'); assert.equal(d.hoursHeld, 100)
    assert.equal(d.readyAt, new Date(Date.parse('2026-10-10T11:00:00Z') - 99 * 3_600_000 + 336 * 3_600_000).toISOString())
  })
  it('ranks growers and fallers week over week', () => {
    const h = full((back) => (back < 168
      ? { up: { tx: 20 }, down: { tx: 5 }, flat: { tx: 10 } }      // this week
      : { up: { tx: 10 }, down: { tx: 10 }, flat: { tx: 10 } }))   // last week
    const d = computeDigest(h, 'mainnet', NOW)
    assert.equal(d.status, 'ok')
    assert.equal(d.growers[0].app, 'up'); assert.equal(d.growers[0].change, 100)
    assert.equal(d.fallers[0].app, 'down'); assert.equal(d.fallers[0].change, -50)
    assert.equal(d.network_txs, 168 * 35); assert.equal(d.network_prev_txs, 168 * 30)
    assert.match(d.shareText, /^Arc this week: 5\.9K transactions \(\+17% vs last week\)\. Fastest growing: up \+100%/)
    assert.match(d.shareText, /pulsarc\.vercel\.app$/)
  })
  it('does not rank dust apps', () => {
    const h = full((back) => ({ big: { tx: 10 }, dust: { tx: back < 168 ? 2 : 1 } }))
    const d = computeDigest(h, 'mainnet', NOW)
    assert.ok(!d.growers.some((g) => g.app === 'dust'))
  })
})

describe('agents scanner', () => {
  const pad = (n) => '0x' + '0'.repeat(24) + n.toString(16).padStart(40, '0')
  const str = (s) => { const b = Buffer.from(s).toString('hex'); return '0x' + '20'.padStart(64, '0') + s.length.toString(16).padStart(64, '0') + b.padEnd(Math.ceil(b.length / 64) * 64, '0') }
  // registry with ids 1..N (id 3 burned = revert)
  const fake = (N, burned = []) => async (calls) => calls.map((c) => {
    const id = Number(BigInt('0x' + c.data.slice(10)))
    if (id > N || burned.includes(id)) return { error: 'execution reverted' }
    return c.data.startsWith(SEL_OWNER_OF) ? { result: pad(id + 0xabc) } : { result: str(`https://a/${id}`) }
  })
  const REG = '0xreg'
  it('decodes strings and addresses', () => {
    assert.equal(decodeString(str('hello')), 'hello')
    assert.equal(decodeString('0x'), null)
    assert.equal(decodeAddress(pad(0)), null)
    assert.equal(decodeAddress(pad(1)), '0x' + '0'.repeat(39) + '1')
  })
  it('slimUri decodes inline profiles, keeps short links, drops the rest', () => {
    const b64 = Buffer.from(JSON.stringify({ name: 'Bot\u0007 One', description: 'x'.repeat(500), image: 'data:...huge' })).toString('base64')
    const s = slimUri(`data:application/json;base64,${b64}`)
    assert.equal(s.name, 'Bot One'); assert.equal(s.description.length, 160); assert.equal(s.image, undefined)
    assert.deepEqual(slimUri('https://a.io/x.json'), { uri: 'https://a.io/x.json' })
    assert.deepEqual(slimUri('ipfs://bafy'), { uri: 'ipfs://bafy' })
    assert.deepEqual(slimUri('https://a.io/' + 'x'.repeat(400)), {})
    assert.deepEqual(slimUri('javascript:alert(1)'), {})
    assert.deepEqual(slimUri('data:application/json;base64,!!!notjson'), {})
    assert.deepEqual(slimUri(null), {})
  })
  it('walks ids until the gap and records owner + uri', async () => {
    const r = await scanAgents({ registry: REG, state: { lastId: 0, agents: [] }, ethCall: fake(55, [3]), chunk: 10 })
    assert.equal(r.done, true); assert.equal(r.lastId, 55); assert.equal(r.agents.length, 54)
    assert.ok(!r.agents.some((a) => a.id === 3))
    assert.equal(r.agents[0].uri, 'https://a/1')
  })
  it('resumes from lastId and only adds new agents', async () => {
    const first = await scanAgents({ registry: REG, state: { lastId: 0, agents: [] }, ethCall: fake(30), chunk: 10 })
    const second = await scanAgents({ registry: REG, state: first, ethCall: fake(37), chunk: 10 })
    assert.equal(second.agents.length, 37); assert.equal(second.lastId, 37)
    assert.equal(new Set(second.agents.map((a) => a.id)).size, 37)
  })
  it('maxPerRun spreads a big backfill over several runs', async () => {
    let s = { lastId: 0, agents: [] }; let runs = 0
    for (;;) { s = await scanAgents({ registry: REG, state: s, ethCall: fake(120), chunk: 10, maxPerRun: 50 }); runs++; if (s.done) break; assert.ok(runs < 10) }
    assert.equal(s.agents.length, 120); assert.ok(runs >= 3)
  })
  it('a revert only on tokenURI keeps the agent with uri null', async () => {
    const call = async (calls) => calls.map((c) => (Number(BigInt('0x' + c.data.slice(10))) > 2 ? { error: 'r' } : c.data.startsWith(SEL_TOKEN_URI) ? { error: 'r' } : { result: pad(9) }))
    const r = await scanAgents({ registry: REG, state: { lastId: 0, agents: [] }, ethCall: call, chunk: 5 })
    assert.deepEqual(r.agents.map((a) => a.uri), [undefined, undefined])
  })
})
