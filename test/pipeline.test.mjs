// Runs the REAL src/summarize.mjs and src/supply.mjs on a temp data folder.  node test/pipeline.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function sandbox(hours) {
  const d = mkdtempSync(join(tmpdir(), 'pipe-'))
  mkdirSync(join(d, 'src'))
  for (const f of ['summarize.mjs', 'supply.mjs', 'counters.mjs']) cpSync(join(SRC, f), join(d, 'src', f))
  const dir = join(d, 'data', 'testnet', 'hourly')
  mkdirSync(dir, { recursive: true })
  const byDay = {}
  for (const [k, h] of Object.entries(hours)) (byDay[k.slice(0, 10)] ??= {})[k] = h
  for (const [day, v] of Object.entries(byDay)) writeFileSync(join(dir, `${day}.json`), JSON.stringify(v))
  return d
}
const base = { blocks: 10, txs: 100, failed: 1, gas: 1, fees: 0.1, senderCount: 5, top: [] }
const run = (d, file, env = {}) => new Promise((resolve) =>
  execFile('node', [join(d, 'src', file)], { env: { ...process.env, NET: 'testnet', ...env }, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })))
const read = (d, f) => JSON.parse(readFileSync(join(d, 'data', 'testnet', f), 'utf8'))

// Hours end at "now" so they fall into the 1h / 24h windows.
const hk = (back) => new Date(Date.now() - back * 3_600_000).toISOString().slice(0, 13)

describe('summarize.mjs end to end', () => {
  it('sums the new T3a/T3b fields across hours and tolerates old hours without them', async () => {
    const d = sandbox({
      [hk(3)]: { ...base }, // old hour: none of the new keys
      [hk(2)]: { ...base, auto: { senders: 2, tx: 150 }, aa: 4, aaTx: 3, buckets: [[10, 50], [2, 600], [1, 20000]],
        big: [{ tx: '0x1', amt: 6_000_000, from: '0xa', to: '0xb' }], mb: { usdc: [10, 4] }, blk: [1, 0],
        blkAddr: [{ token: 'usdc', addr: '0xdead', kind: 'added' }],
        bridge: { out: [2, 30, 0.5], in: [1], byDomain: { 0: [2, 30] } } },
      [hk(1)]: { ...base, auto: { senders: 1, tx: 70 }, aa: 1, buckets: [[5, 25], [0, 0], [0, 0]],
        big: [{ tx: '0x2', amt: 9_000_000, from: '0xc', to: '0xd' }], mb: { usdc: [1, 1], eurc: [2, 0] },
        bridge: { out: [1, 5, 0], in: [2], byDomain: { 0: [1, 5], 6: [1, 5] } } },
    })
    const r = await run(d, 'summarize.mjs')
    assert.equal(r.status, 0, r.stderr)
    const w = read(d, 'latest.json').windows['24h']
    assert.deepEqual(w.auto, { senders: 3, tx: 220 })
    assert.equal(w.autoCoverageHours, 2)
    assert.equal(w.aa, 5)
    assert.deepEqual(w.buckets[0], [15, 75])
    assert.deepEqual(w.buckets[2], [1, 20000])
    assert.equal(w.bucketsCoverageHours, 2)
    assert.equal(w.big[0].amt, 9_000_000) // largest first
    assert.equal(w.big.length, 2)
    assert.deepEqual(w.mb.usdc, [11, 5])
    assert.deepEqual(w.mb.eurc, [2, 0])
    assert.deepEqual(w.blk.slice(0, 2), [1, 0])
    assert.deepEqual(w.bridge.out.slice(0, 2), [3, 35])
    assert.deepEqual(w.bridge.in, [3])
    assert.deepEqual(w.bridge.byDomain['0'], [3, 35])
    assert.equal(w.bridgeCoverageHours, 2)
  })

  it('writes bridge.json with 1h/24h/7d windows and a series', async () => {
    const d = sandbox({
      [hk(2)]: { ...base, bridge: { out: [2, 30, 0.5], in: [1], byDomain: { 0: [2, 30] } } },
      [hk(1)]: { ...base },
    })
    const r = await run(d, 'summarize.mjs')
    assert.equal(r.status, 0, r.stderr)
    const b = read(d, 'bridge.json')
    assert.equal(b.network, 'testnet')
    assert.deepEqual(Object.keys(b.windows).sort(), ['1h', '24h', '7d'])
    assert.equal(b.windows['24h'].out[0], 2)
    assert.ok(Array.isArray(b.series) && b.series.length >= 1)
  })

  it('hours with only old keys produce no new fields', async () => {
    const d = sandbox({ [hk(2)]: { ...base }, [hk(1)]: { ...base } })
    const r = await run(d, 'summarize.mjs')
    assert.equal(r.status, 0, r.stderr)
    const w = read(d, 'latest.json').windows['24h']
    for (const k of ['auto', 'aa', 'buckets', 'big', 'mb', 'blk', 'bridge']) assert.equal(k in w, false, k)
  })
})

describe('supply.mjs end to end', () => {
  it('keeps the old supply.json and exits 0 when no RPC answers', async () => {
    const d = sandbox({ [hk(1)]: { ...base } })
    const file = join(d, 'data', 'testnet', 'supply.json')
    const original = JSON.stringify({ tokens: { usdc: { supply: 999, series: [] } } })
    writeFileSync(file, original)
    const r = await run(d, 'supply.mjs', { RPC_URLS: 'http://127.0.0.1:1' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(readFileSync(file, 'utf8'), original)
  })
})
