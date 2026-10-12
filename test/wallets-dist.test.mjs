// Tests for src/wallets-dist.mjs
// Run: node --test test/wallets-dist.test.mjs
//
// NOTE: quantiles() requires its input to be SORTED ASCENDING.
// Passing an unsorted array produces undefined results; no test covers unsorted input.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, statSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  QUANTILE_POINTS,
  quantiles,
  percentileOf,
  buildDist,
  writeDist,
} from '../src/wallets-dist.mjs'

import {
  encodeShard,
  encodeRecord,
  emptyRecord,
} from '../src/wallets.mjs'

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'wd-test-'))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

function existsSync(p) {
  try { statSync(p); return true } catch { return false }
}

/**
 * Build an encoded record array using real encodeRecord/emptyRecord from wallets.mjs.
 * @param {{ day?: number, t?: number, o?: number, i?: number, d?: string }} opts
 */
function makeRecord({ day = 0, t = 0, o = 0, i = 0, d = '1' } = {}) {
  return encodeRecord({ ...emptyRecord(day), t, o, i, d })
}

/**
 * Write a meta.json and a set of shard files into dir.
 * wallets is an array of { addr, t, o, i, d } objects.
 */
async function setupDir(dir, { network = 'testnet', through = 5, wallets = [] } = {}) {
  await writeJson(join(dir, 'meta.json'), {
    network,
    version: 1,
    since: 0,
    through,
    gaps: [],
    walletCount: wallets.length,
    updatedAt: new Date().toISOString(),
  })

  // Group wallets into shards by their first 3 hex chars (after 0x)
  const shardMap = new Map()
  for (const w of wallets) {
    const shard = w.addr.slice(2, 5).toLowerCase()
    if (!shardMap.has(shard)) shardMap.set(shard, new Map())
    const rec = makeRecord({ day: 0, t: w.t ?? 0, o: w.o ?? 0, i: w.i ?? 0, d: w.d ?? '1' })
    shardMap.get(shard).set(w.addr.toLowerCase(), rec)
  }

  await mkdir(join(dir, 's'), { recursive: true })

  for (const [shard, entries] of shardMap) {
    // Build a plain object suitable for writeJson (keys → encoded arrays)
    const obj = {}
    for (const [addr, encoded] of entries) obj[addr] = encoded
    await writeJson(join(dir, 's', `${shard}.json`), obj)
  }
}

// Fixed addresses whose shard keys span at least 2 different prefixes
const ADDR = [
  '0x' + 'a1'.repeat(20),  // shard 'a1a'
  '0x' + 'a2'.repeat(20),  // shard 'a2a'
  '0x' + 'b1'.repeat(20),  // shard 'b1b'
  '0x' + 'b2'.repeat(20),  // shard 'b2b'
  '0x' + 'c1'.repeat(20),  // shard 'c1c'
  '0x' + 'c2'.repeat(20),  // shard 'c2c'
]

// ── quantiles ─────────────────────────────────────────────────────────────────

describe('quantiles — empty input', () => {
  it('returns [] for an empty array', () => {
    assert.deepEqual(quantiles([]), [])
  })
})

describe('quantiles — single value', () => {
  it('returns 101 identical values for a single-element array', () => {
    const q = quantiles([42])
    assert.equal(q.length, QUANTILE_POINTS)
    assert.ok(q.every((v) => v === 42), 'all 101 values must equal 42')
  })
})

describe('quantiles — 1..101 gives q[k] === arr[floor(k/100*100)]', () => {
  it('q[0]=1, q[100]=101, each q[k] matches the spec formula', () => {
    // arr = [1, 2, ..., 101]
    const arr = Array.from({ length: 101 }, (_, i) => i + 1)  // [1,2,...,101]
    const q = quantiles(arr)
    assert.equal(q.length, QUANTILE_POINTS)
    assert.equal(q[0],   1,   'q[0]   = min = 1')
    assert.equal(q[100], 101, 'q[100] = max = 101')
    // For n=101, the spec formula is: idx = floor(k/100 * (n-1)) = floor(k/100 * 100).
    // Due to IEEE-754 floating point, some k values (e.g. 29, 57, 58) round DOWN
    // rather than staying at k, so q[k] = arr[idx] may differ from arr[k].
    // We verify every q[k] exactly matches the formula.
    for (let k = 0; k < 101; k++) {
      const idx = Math.floor(k / 100 * (arr.length - 1))
      const expected = arr[idx]
      assert.equal(q[k], expected, `q[${k}] should be arr[${idx}]=${expected}`)
    }
  })
})

describe('quantiles — duplicates', () => {
  it('handles an array of identical values', () => {
    const q = quantiles([7, 7, 7, 7, 7])
    assert.equal(q.length, QUANTILE_POINTS)
    assert.ok(q.every((v) => v === 7))
  })

  it('handles array with some duplicates: [1,1,2,3,3]', () => {
    const q = quantiles([1, 1, 2, 3, 3])
    assert.equal(q.length, QUANTILE_POINTS)
    assert.equal(q[0], 1, 'min = 1')
    assert.equal(q[100], 3, 'max = 3')
    // q[50]: index = floor(50/100 * 4) = floor(2.0) = 2 → arr[2] = 2
    assert.equal(q[50], 2, 'q[50] = 2')
  })
})

describe('quantiles — 2-element array', () => {
  it('q[0]=min, q[100]=max, q[50]=min for [3,9]', () => {
    // n=2: q[k] = arr[ floor(k/100 * 1) ]
    // k<100 → index 0 → 3; k=100 → index 1 → 9
    const q = quantiles([3, 9])
    assert.equal(q[0], 3)
    assert.equal(q[100], 9)
    assert.equal(q[50], 3)
    assert.equal(q[99], 3)
  })
})

// ── percentileOf ──────────────────────────────────────────────────────────────

describe('percentileOf — basic edge cases', () => {
  const q = quantiles(Array.from({ length: 101 }, (_, i) => i))  // [0..100]

  it('value at or below min returns 0', () => {
    assert.equal(percentileOf(q, 0), 0)
    assert.equal(percentileOf(q, -1), 0)
  })

  it('value above max returns 100', () => {
    assert.equal(percentileOf(q, 101), 100)
    assert.equal(percentileOf(q, 999), 100)
  })

  it('empty quantile array returns 0', () => {
    assert.equal(percentileOf([], 5), 0)
  })
})

describe('percentileOf — known case on [1..101]', () => {
  // q[k] = k+1 for k=0..100  (from the quantiles test above)
  const arr = Array.from({ length: 101 }, (_, i) => i + 1)
  const q = quantiles(arr)

  it('value=1 (the minimum) → 0', () => {
    assert.equal(percentileOf(q, 1), 0)
  })

  it('value=102 (above max) → 100', () => {
    assert.equal(percentileOf(q, 102), 100)
  })

  it('value=51 → below count matches expectation', () => {
    // q = [1,2,...,101]; strictly less than 51 are q[0..49] (50 values)
    // below=50, result = max(0, 50-1) = 49
    assert.equal(percentileOf(q, 51), 49)
  })
})

describe('percentileOf — monotonic non-decreasing over a sweep', () => {
  it('percentileOf is non-decreasing as value increases from 0 to 110', () => {
    const q = quantiles(Array.from({ length: 101 }, (_, i) => i + 1))
    let prev = percentileOf(q, 0)
    for (let v = 1; v <= 110; v++) {
      const cur = percentileOf(q, v)
      assert.ok(cur >= prev, `percentileOf at ${v} (${cur}) < at ${v - 1} (${prev})`)
      prev = cur
    }
  })
})

// ── buildDist ─────────────────────────────────────────────────────────────────

describe('buildDist — returns null for missing meta.json', () => {
  it('returns null when meta.json does not exist', async () => {
    const dir = tmpDir()
    const result = await buildDist(dir)
    assert.equal(result, null)
  })
})

describe('buildDist — returns null when no shards', () => {
  it('returns null when s/ dir is empty', async () => {
    const dir = tmpDir()
    await writeJson(join(dir, 'meta.json'), {
      network: 'testnet', version: 1, since: 0, through: 1, gaps: [], walletCount: 0,
      updatedAt: new Date().toISOString(),
    })
    await mkdir(join(dir, 's'), { recursive: true })
    const result = await buildDist(dir)
    assert.equal(result, null)
  })
})

describe('buildDist — 6 distinct wallets, checks q[0], q[50], q[100]', () => {
  // 6 wallets with distinct tx/active-days/usdc values:
  //   addr[0]: t=1, o=10, i=100, d='1'   → activeDays=1
  //   addr[1]: t=2, o=20, i=200, d='3'   → activeDays=2  (bits 0 and 1)
  //   addr[2]: t=3, o=30, i=300, d='7'   → activeDays=3
  //   addr[3]: t=4, o=40, i=400, d='f'   → activeDays=4
  //   addr[4]: t=5, o=50, i=500, d='1f'  → activeDays=5
  //   addr[5]: t=6, o=60, i=600, d='3f'  → activeDays=6

  const wallets = [
    { addr: ADDR[0], t: 1, o: 10,  i: 100, d: '1' },
    { addr: ADDR[1], t: 2, o: 20,  i: 200, d: '3' },
    { addr: ADDR[2], t: 3, o: 30,  i: 300, d: '7' },
    { addr: ADDR[3], t: 4, o: 40,  i: 400, d: 'f' },
    { addr: ADDR[4], t: 5, o: 50,  i: 500, d: '1f' },
    { addr: ADDR[5], t: 6, o: 60,  i: 600, d: '3f' },
  ]

  it('walletCount, tx q[0]/q[100], activeDays q[0]/q[100]', async () => {
    const dir = tmpDir()
    await setupDir(dir, { wallets })
    const dist = await buildDist(dir, new Date('2026-01-10T00:00:00Z'))

    assert.ok(dist !== null, 'buildDist must not return null')
    assert.equal(dist.version, 1)
    assert.equal(dist.net, 'testnet')
    assert.equal(dist.walletCount, 6)

    // tx: sorted [1,2,3,4,5,6], n=6
    // q[0]  = arr[floor(0/100*5)]  = arr[0] = 1
    // q[100]= arr[floor(100/100*5)]= arr[5] = 6
    // q[50] = arr[floor(50/100*5)] = arr[2] = 3  (floor(2.5)=2)
    assert.ok(dist.metrics.tx, 'metrics.tx must be present')
    assert.equal(dist.metrics.tx[0],   1, 'tx q[0] = 1')
    assert.equal(dist.metrics.tx[100], 6, 'tx q[100] = 6')
    assert.equal(dist.metrics.tx[50],  3, 'tx q[50] = 3')

    // activeDays: sorted [1,2,3,4,5,6] — same as tx
    assert.ok(dist.metrics.activeDays, 'metrics.activeDays must be present')
    assert.equal(dist.metrics.activeDays[0],   1, 'activeDays q[0] = 1')
    assert.equal(dist.metrics.activeDays[100], 6, 'activeDays q[100] = 6')
    assert.equal(dist.metrics.activeDays[50],  3, 'activeDays q[50] = 3')

    // usdcSent: sorted [10,20,30,40,50,60]
    assert.ok(dist.metrics.usdcSent, 'metrics.usdcSent must be present')
    assert.equal(dist.metrics.usdcSent[0],   10,  'usdcSent q[0] = 10')
    assert.equal(dist.metrics.usdcSent[100], 60,  'usdcSent q[100] = 60')
    assert.equal(dist.metrics.usdcSent[50],  30,  'usdcSent q[50] = 30')

    // usdcReceived: sorted [100,200,300,400,500,600]
    assert.ok(dist.metrics.usdcReceived, 'metrics.usdcReceived must be present')
    assert.equal(dist.metrics.usdcReceived[0],   100, 'usdcReceived q[0] = 100')
    assert.equal(dist.metrics.usdcReceived[100], 600, 'usdcReceived q[100] = 600')
    assert.equal(dist.metrics.usdcReceived[50],  300, 'usdcReceived q[50] = 300')
  })
})

describe('buildDist — all-zero tx omits the tx metric', () => {
  it('tx metric is omitted when all wallets have t=0', async () => {
    const dir = tmpDir()
    const wallets = [
      { addr: ADDR[0], t: 0, o: 5,  i: 10, d: '1' },
      { addr: ADDR[1], t: 0, o: 15, i: 20, d: '3' },
      { addr: ADDR[2], t: 0, o: 25, i: 30, d: '7' },
    ]
    await setupDir(dir, { wallets })
    const dist = await buildDist(dir)

    assert.ok(dist !== null)
    assert.equal(dist.walletCount, 3)
    assert.ok(!dist.metrics.tx, 'tx must be absent when all values are 0')
    // activeDays is always present
    assert.ok(dist.metrics.activeDays, 'activeDays must always be present')
  })
})

describe('buildDist — malformed shard entry is skipped, others counted', () => {
  it('a shard file with one bad entry still counts the good ones', async () => {
    const dir = tmpDir()
    // Write meta
    await writeJson(join(dir, 'meta.json'), {
      network: 'testnet', version: 1, since: 0, through: 5, gaps: [], walletCount: 3,
      updatedAt: new Date().toISOString(),
    })
    await mkdir(join(dir, 's'), { recursive: true })

    // One shard with 2 good records + 1 malformed (not an array)
    const goodRec1 = makeRecord({ t: 2, o: 5, i: 10, d: '1' })
    const goodRec2 = makeRecord({ t: 3, o: 8, i: 12, d: '3' })
    const shardObj = {
      [ADDR[0].toLowerCase()]: goodRec1,
      [ADDR[1].toLowerCase()]: goodRec2,
      [ADDR[2].toLowerCase()]: 'not-an-array',  // malformed
    }
    await writeJson(join(dir, 's', 'a1a.json'), shardObj)

    const dist = await buildDist(dir)
    assert.ok(dist !== null, 'buildDist must not return null')
    assert.equal(dist.walletCount, 2, 'only 2 valid records should be counted')
  })
})

describe('buildDist — generatedAt matches the passed Date', () => {
  it('generatedAt is the ISO string of the now argument', async () => {
    const dir = tmpDir()
    const wallets = [{ addr: ADDR[0], t: 1, o: 1, i: 1, d: '1' }]
    await setupDir(dir, { wallets })
    const now = new Date('2026-06-15T12:00:00.000Z')
    const dist = await buildDist(dir, now)
    assert.equal(dist.generatedAt, '2026-06-15T12:00:00.000Z')
  })
})

// ── writeDist ─────────────────────────────────────────────────────────────────

describe('writeDist — writes valid JSON equal to buildDist', () => {
  it('dist.json parses back equal to buildDist result (ignoring generatedAt)', async () => {
    const dir = tmpDir()
    const wallets = [
      { addr: ADDR[0], t: 3, o: 10, i: 50, d: '7' },
      { addr: ADDR[1], t: 7, o: 20, i: 80, d: '1f' },
    ]
    await setupDir(dir, { wallets })

    const now = new Date('2026-03-01T00:00:00.000Z')
    const written = await writeDist(dir, now)
    assert.equal(written, true, 'writeDist must return true')

    // Read back the file and compare
    const fromFile  = JSON.parse(await readFile(join(dir, 'dist.json'), 'utf8'))
    const fromBuild = await buildDist(dir, now)

    // They must match (generatedAt will be the same since we pass the same now)
    assert.deepEqual(fromFile, fromBuild)

    // No .tmp file left behind
    assert.ok(!existsSync(join(dir, 'dist.json.tmp')), 'no .tmp file must be left behind')
  })
})

describe('writeDist — returns false when buildDist returns null', () => {
  it('returns false and writes nothing when meta.json is missing', async () => {
    const dir = tmpDir()
    const result = await writeDist(dir)
    assert.equal(result, false)
    assert.ok(!existsSync(join(dir, 'dist.json')), 'dist.json must not be created')
  })
})
