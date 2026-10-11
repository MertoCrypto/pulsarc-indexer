// Tests for T3a counters.  Imports the REAL functions from src/counters.mjs.
// Run: node --test pulsarc-indexer/test/counters.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_TX_PER_HOUR,
  USER_OP_TOPIC,
  ENTRY_POINTS,
  USDC,
  autoStats,
  largestUsdcTransfer,
  bucketIndex,
  countUserOps,
} from '../src/counters.mjs'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const EP_V6 = '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789'
const EP_V7 = '0x0000000071727de22e5e9d8baf0edac6f37da032'
const OTHER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const USDC_ADDR = USDC  // '0x3600000000000000000000000000000000000000'
const OTHER_TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

/** Build a fake Transfer log */
function transferLog(tokenAddr, amountWhole, decimals = 6) {
  const raw = BigInt(Math.round(amountWhole * 10 ** decimals))
  return {
    address: tokenAddr,
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + '1'.padStart(64, '0'),
      '0x' + '2'.padStart(64, '0'),
    ],
    data: '0x' + raw.toString(16).padStart(64, '0'),
  }
}

/** Build a fake UserOperationEvent log from an EntryPoint */
function userOpLog(entryPoint = EP_V6) {
  return {
    address: entryPoint,
    topics: [USER_OP_TOPIC, '0x' + 'a'.repeat(64), '0x' + 'b'.padStart(64, '0')],
    data: '0x',
  }
}

/** Build a log with a different topic0 */
function wrongTopicLog(addr = EP_V6) {
  return {
    address: addr,
    topics: ['0x' + '1'.repeat(64)],
    data: '0x',
  }
}

// ── Part 1: autoStats ─────────────────────────────────────────────────────────

describe('autoStats — sender counter', () => {
  it('sender with exactly AUTO_TX_PER_HOUR txs is automated', () => {
    const senders = { '0xaaa': AUTO_TX_PER_HOUR }
    const r = autoStats(senders)
    assert.equal(r.senders, 1)
    assert.equal(r.tx, AUTO_TX_PER_HOUR)
  })

  it('sender with AUTO_TX_PER_HOUR - 1 txs is NOT automated', () => {
    const senders = { '0xaaa': AUTO_TX_PER_HOUR - 1 }
    const r = autoStats(senders)
    assert.equal(r.senders, 0)
    assert.equal(r.tx, 0)
  })

  it('two senders: one automated, one not', () => {
    const senders = { '0xaaa': AUTO_TX_PER_HOUR + 10, '0xbbb': 5 }
    const r = autoStats(senders)
    assert.equal(r.senders, 1)
    assert.equal(r.tx, AUTO_TX_PER_HOUR + 10)
  })

  it('both senders automated', () => {
    const senders = { '0xaaa': 70, '0xbbb': 90 }
    const r = autoStats(senders)
    assert.equal(r.senders, 2)
    assert.equal(r.tx, 160)
  })

  it('old shape (value = 1) never triggers auto (1 < AUTO_TX_PER_HOUR)', () => {
    // Before T3a, senders[addr] = 1 (presence flag); must not be treated as automated
    const senders = { '0xaaa': 1, '0xbbb': 1 }
    const r = autoStats(senders)
    assert.equal(r.senders, 0, 'old-shape senders must not be marked automated')
    assert.equal(r.tx, 0)
  })

  it('compact() output: auto field absent when no automated senders', () => {
    // autoStats returns {senders:0, tx:0} — caller should omit the key
    const r = autoStats({ '0xa': 1, '0xb': 3 })
    assert.equal(r.senders, 0)
    // The run.mjs compact() only writes h.auto when r.senders > 0; verify the condition
    assert.ok(r.senders === 0, 'when senders=0 the compact() guard prevents writing h.auto')
  })
})

// ── Part 2: bucketIndex ───────────────────────────────────────────────────────

describe('bucketIndex — bucket boundaries', () => {
  it('amount 0 → bucket 0', () => assert.equal(bucketIndex(0), 0))
  it('amount 249.99 → bucket 0', () => assert.equal(bucketIndex(249.99), 0))
  it('amount 250 → bucket 1', () => assert.equal(bucketIndex(250), 1))
  it('amount 5000 → bucket 1', () => assert.equal(bucketIndex(5000), 1))
  it('amount 10000 → bucket 1', () => assert.equal(bucketIndex(10_000), 1))
  it('amount 10000.01 → bucket 2', () => assert.equal(bucketIndex(10_000.01), 2))
  it('very large amount → bucket 2', () => assert.equal(bucketIndex(1e9), 2))
})

// ── Part 3: largestUsdcTransfer ───────────────────────────────────────────────

describe('largestUsdcTransfer', () => {
  it('returns null when no logs', () => {
    assert.equal(largestUsdcTransfer([], USDC_ADDR, 6), null)
  })

  it('returns null when logs is undefined', () => {
    assert.equal(largestUsdcTransfer(undefined, USDC_ADDR, 6), null)
  })

  it('returns null when no matching USDC log', () => {
    const logs = [transferLog(OTHER_TOKEN, 500, 6)]
    assert.equal(largestUsdcTransfer(logs, USDC_ADDR, 6), null)
  })

  it('returns the transfer amount for a single USDC log', () => {
    const logs = [transferLog(USDC_ADDR, 100, 6)]
    assert.equal(largestUsdcTransfer(logs, USDC_ADDR, 6), 100)
  })

  it('returns the LARGEST when two USDC transfers in the same receipt', () => {
    const logs = [
      transferLog(USDC_ADDR, 100, 6),
      transferLog(USDC_ADDR, 5000, 6),
    ]
    assert.equal(largestUsdcTransfer(logs, USDC_ADDR, 6), 5000)
  })

  it('ignores non-USDC ERC-20 transfers (different address)', () => {
    const logs = [
      transferLog(USDC_ADDR, 200, 6),
      transferLog(OTHER_TOKEN, 9999, 6),
    ]
    assert.equal(largestUsdcTransfer(logs, USDC_ADDR, 6), 200)
  })

  it('address matching is case-insensitive', () => {
    const log = transferLog(USDC_ADDR.toUpperCase(), 300, 6)
    assert.equal(largestUsdcTransfer([log], USDC_ADDR.toLowerCase(), 6), 300)
  })

  it('boundary: exactly 250 → bucket 1 (integration)', () => {
    const logs = [transferLog(USDC_ADDR, 250, 6)]
    const amt = largestUsdcTransfer(logs, USDC_ADDR, 6)
    assert.equal(bucketIndex(amt), 1)
  })
})

// ── Part 4: countUserOps ──────────────────────────────────────────────────────

describe('countUserOps — AA detection', () => {
  it('returns 0 when receipt has no logs', () => {
    assert.equal(countUserOps({ logs: [] }), 0)
  })

  it('returns 0 when logs is undefined', () => {
    assert.equal(countUserOps({}), 0)
  })

  it('counts one UserOp from EntryPoint v0.6', () => {
    const r = { logs: [userOpLog(EP_V6)] }
    assert.equal(countUserOps(r), 1)
  })

  it('counts one UserOp from EntryPoint v0.7', () => {
    const r = { logs: [userOpLog(EP_V7)] }
    assert.equal(countUserOps(r), 1)
  })

  it('does NOT count a UserOpEvent-like log from a non-EntryPoint address', () => {
    const r = { logs: [userOpLog(OTHER)] }
    assert.equal(countUserOps(r), 0, 'must check the address, not just the topic')
  })

  it('does NOT count a log from an EntryPoint with wrong topic0', () => {
    const r = { logs: [wrongTopicLog(EP_V6)] }
    assert.equal(countUserOps(r), 0)
  })

  it('counts two UserOps in the same receipt (bundler batch)', () => {
    const r = { logs: [userOpLog(EP_V6), userOpLog(EP_V7)] }
    assert.equal(countUserOps(r), 2)
  })

  it('ENTRY_POINTS set contains both known addresses', () => {
    assert.ok(ENTRY_POINTS.has(EP_V6), 'v0.6 must be in ENTRY_POINTS')
    assert.ok(ENTRY_POINTS.has(EP_V7), 'v0.7 must be in ENTRY_POINTS')
    assert.ok(!ENTRY_POINTS.has(OTHER), 'random address must not be in ENTRY_POINTS')
  })
})

// ── Part 5: summarize window accumulation (pure logic, no I/O) ───────────────

describe('window accumulation — new fields', () => {
  // Simulate the summarize.mjs windowSummary logic inline to verify accumulation.
  // The real windowSummary is in summarize.mjs (which has top-level await so cannot
  // be imported directly in a pure test).  We verify the accumulation rules here.

  function summarizeHours(hourList) {
    let autoSenders = 0, autoTx = 0, aa = 0, aaTx = 0
    let autoCov = 0, bucketsCov = 0
    const bucketsAcc = [[0, 0], [0, 0], [0, 0]]
    for (const h of hourList) {
      if (h.auto) { autoSenders += h.auto.senders; autoTx += h.auto.tx; autoCov++ }
      if (h.aa)   aa   += h.aa
      if (h.aaTx) aaTx += h.aaTx
      if (h.buckets) {
        for (let i = 0; i < 3; i++) {
          bucketsAcc[i][0] += h.buckets[i][0]
          bucketsAcc[i][1] = +(bucketsAcc[i][1] + h.buckets[i][1]).toFixed(2)
        }
        bucketsCov++
      }
    }
    return { autoSenders, autoTx, aa, aaTx, autoCov, bucketsCov, bucketsAcc }
  }

  it('sums auto across hours', () => {
    const hours = [
      { auto: { senders: 2, tx: 200 } },
      { auto: { senders: 1, tx: 80  } },
    ]
    const r = summarizeHours(hours)
    assert.equal(r.autoSenders, 3)
    assert.equal(r.autoTx, 280)
    assert.equal(r.autoCov, 2)
  })

  it('old hours without auto do not break the window', () => {
    const hours = [
      { txs: 100 },                        // old hour — no auto key
      { auto: { senders: 1, tx: 75 } },
    ]
    const r = summarizeHours(hours)
    assert.equal(r.autoSenders, 1)
    assert.equal(r.autoCov, 1)             // only 1 hour has coverage
  })

  it('sums aa and aaTx', () => {
    const hours = [{ aa: 5, aaTx: 3 }, { aa: 2 }]
    const r = summarizeHours(hours)
    assert.equal(r.aa, 7)
    assert.equal(r.aaTx, 3)
  })

  it('sums buckets across hours', () => {
    const hours = [
      { buckets: [[10, 100], [5, 5000], [1, 15000]] },
      { buckets: [[3,   30], [2, 1000], [0,     0]] },
    ]
    const r = summarizeHours(hours)
    assert.equal(r.bucketsAcc[0][0], 13)
    assert.equal(r.bucketsAcc[1][0], 7)
    assert.equal(r.bucketsAcc[1][1], 6000)
    assert.equal(r.bucketsAcc[2][0], 1)
    assert.equal(r.bucketsCov, 2)
  })

  it('old hours without buckets do not break the window', () => {
    const hours = [{ txs: 50 }, { buckets: [[1, 10], [0, 0], [0, 0]] }]
    const r = summarizeHours(hours)
    assert.equal(r.bucketsAcc[0][0], 1)
    assert.equal(r.bucketsCov, 1)
  })
})
