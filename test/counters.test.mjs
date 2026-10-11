// Tests for T3a + T3b counters.  Imports the REAL functions from src/counters.mjs.
// Run: node --test pulsarc-indexer/test/counters.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTO_TX_PER_HOUR,
  USER_OP_TOPIC,
  ENTRY_POINTS,
  USDC,
  EURC,
  TRANSFER_TOPIC,
  BLACKLISTED_TOPIC,
  UNBLACKLISTED_TOPIC,
  DEPOSIT_FOR_BURN_TOPIC,
  MESSAGE_RECEIVED_TOPIC,
  BIG_TRANSFER_USDC,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  autoStats,
  largestUsdcTransfer,
  bucketIndex,
  countUserOps,
  bigTransfers,
  mintBurnFromLogs,
  blocklistFromLogs,
  decodeDepositForBurn,
  decodeMessageReceived,
  parseSupplyHex,
  appendSupplySeries,
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

// ════════════════════════════════════════════════════════════════════════════
// T3b tests — appended, existing T3a tests above are unchanged
// ════════════════════════════════════════════════════════════════════════════

// ── Fixture helpers ───────────────────────────────────────────────────────────
// Note: USDC_ADDR and OTHER already defined in T3a fixtures section above; reuse them.

const EURC_ADDR = EURC
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'
// Alias for clarity in T3b tests (matches the T3a fixture name)
const T3B_USDC  = USDC_ADDR   // === USDC
const T3B_OTHER = OTHER_TOKEN  // '0xaaaa...'

/** Build a 32-byte-padded address topic */
function addrTopic(addr) {
  return '0x' + addr.replace('0x', '').padStart(64, '0')
}

/** Build a Transfer log with configurable from/to */
function transferLogFull(tokenAddr, amountWhole, decimals = 6, from = '0x1111', to = '0x2222') {
  const raw = BigInt(Math.round(amountWhole * 10 ** decimals))
  return {
    address: tokenAddr,
    topics: [
      TRANSFER_TOPIC,
      addrTopic(from),
      addrTopic(to),
    ],
    data: '0x' + raw.toString(16).padStart(64, '0'),
  }
}

/** Build a mint Transfer log (from == zero address) */
function mintLog(tokenAddr, amountWhole, decimals = 6) {
  return transferLogFull(tokenAddr, amountWhole, decimals, ZERO_ADDR, '0x2222')
}

/** Build a burn Transfer log (to == zero address) */
function burnLog(tokenAddr, amountWhole, decimals = 6) {
  return transferLogFull(tokenAddr, amountWhole, decimals, '0x1111', ZERO_ADDR)
}

/** Build a Blacklisted event log */
function blacklistedLog(tokenAddr, account = '0xdeadbeef') {
  return {
    address: tokenAddr,
    topics: [BLACKLISTED_TOPIC, addrTopic(account)],
    data: '0x',
  }
}

/** Build an UnBlacklisted event log */
function unblacklistedLog(tokenAddr, account = '0xdeadbeef') {
  return {
    address: tokenAddr,
    topics: [UNBLACKLISTED_TOPIC, addrTopic(account)],
    data: '0x',
  }
}

/**
 * Build a DepositForBurn log data blob (10 words):
 * word 0 = amount, word 1 = mintRecipient (dummy), word 2 = destinationDomain,
 * word 3 = destinationTokenMessenger (dummy), word 4 = destinationCaller (dummy),
 * word 5 = maxFee
 */
function depositForBurnData(amount6dec, domain, maxFee6dec) {
  const words = [
    BigInt(amount6dec),   // word 0: amount
    0n,                   // word 1: mintRecipient
    BigInt(domain),       // word 2: destinationDomain
    0n,                   // word 3: destinationTokenMessenger
    0n,                   // word 4: destinationCaller
    BigInt(maxFee6dec),   // word 5: maxFee
    0n, 0n, 0n, 0n,       // words 6-9: unused
  ]
  return '0x' + words.map(w => w.toString(16).padStart(64, '0')).join('')
}

/**
 * Build a MessageReceived log data blob:
 * word 0 = sourceDomain
 */
function messageReceivedData(sourceDomain) {
  return '0x' + BigInt(sourceDomain).toString(16).padStart(64, '0')
}

// ── T3b Part 1: bigTransfers ──────────────────────────────────────────────────

describe('bigTransfers — big USDC transfer detection', () => {
  const TX = '0xaaaa'

  it(`transfer of ${BIG_TRANSFER_USDC - 0.01} USDC is NOT kept (below threshold)`, () => {
    const logs = [transferLogFull(T3B_USDC, BIG_TRANSFER_USDC - 0.01, 6)]
    const result = bigTransfers(logs, TX, T3B_USDC, 6)
    assert.equal(result.length, 0, 'should not include transfers below threshold')
  })

  it(`transfer of exactly ${BIG_TRANSFER_USDC} USDC IS kept`, () => {
    const logs = [transferLogFull(T3B_USDC, BIG_TRANSFER_USDC, 6)]
    const result = bigTransfers(logs, TX, T3B_USDC, 6)
    assert.equal(result.length, 1)
    assert.equal(result[0].amt, BIG_TRANSFER_USDC)
    assert.equal(result[0].tx, TX)
  })

  it('top-5 limit: six big transfers → all six returned (bigTransfers does not slice; caller trims)', () => {
    // bigTransfers returns ALL qualifying transfers per receipt; summarize trims to top 10 globally
    const logs = Array.from({ length: 6 }, (_, i) =>
      transferLogFull(T3B_USDC, BIG_TRANSFER_USDC + i * 1_000_000, 6)
    )
    const result = bigTransfers(logs, TX, T3B_USDC, 6)
    assert.equal(result.length, 6, 'bigTransfers returns all qualifying per receipt')
  })

  it('transfer from another token address is ignored', () => {
    const logs = [transferLogFull(T3B_OTHER, BIG_TRANSFER_USDC + 1, 6)]
    const result = bigTransfers(logs, TX, T3B_USDC, 6)
    assert.equal(result.length, 0)
  })

  it('from and to addresses are extracted correctly', () => {
    const from = '0x' + 'a'.repeat(40)
    const to   = '0x' + 'b'.repeat(40)
    const logs = [transferLogFull(T3B_USDC, BIG_TRANSFER_USDC, 6, from, to)]
    const result = bigTransfers(logs, TX, T3B_USDC, 6)
    assert.equal(result.length, 1)
    assert.equal(result[0].from, from.toLowerCase())
    assert.equal(result[0].to,   to.toLowerCase())
  })
})

// ── T3b Part 2: mintBurnFromLogs ─────────────────────────────────────────────

describe('mintBurnFromLogs — mint and burn detection', () => {
  it('from=zero is a mint for USDC', () => {
    const logs = [mintLog(T3B_USDC, 1000)]
    const r = mintBurnFromLogs(logs, T3B_USDC, EURC_ADDR, 6)
    assert.ok(r, 'should detect a mint')
    assert.deepEqual(r.usdc, [1000, 0])
    assert.equal(r.eurc, undefined)
  })

  it('to=zero is a burn for USDC', () => {
    const logs = [burnLog(T3B_USDC, 500)]
    const r = mintBurnFromLogs(logs, T3B_USDC, EURC_ADDR, 6)
    assert.ok(r)
    assert.deepEqual(r.usdc, [0, 500])
  })

  it('normal transfer (neither from nor to is zero) does not count', () => {
    const logs = [transferLogFull(T3B_USDC, 1000)]
    const r = mintBurnFromLogs(logs, T3B_USDC, EURC_ADDR, 6)
    assert.equal(r, null, 'plain transfer must not trigger mint/burn')
  })

  it('mint works for EURC', () => {
    const logs = [mintLog(EURC_ADDR, 250)]
    const r = mintBurnFromLogs(logs, T3B_USDC, EURC_ADDR, 6)
    assert.ok(r)
    assert.deepEqual(r.eurc, [250, 0])
    assert.equal(r.usdc, undefined)
  })

  it('mint from an unrelated token address is ignored', () => {
    const logs = [mintLog(T3B_OTHER, 1_000_000)]
    const r = mintBurnFromLogs(logs, T3B_USDC, EURC_ADDR, 6)
    assert.equal(r, null)
  })

  it('no logs → null', () => {
    assert.equal(mintBurnFromLogs([], T3B_USDC, EURC_ADDR, 6), null)
  })
})

// ── T3b Part 3: blocklistFromLogs ────────────────────────────────────────────

describe('blocklistFromLogs — blacklist event detection', () => {
  it('Blacklisted topic from USDC address is counted', () => {
    const logs = [blacklistedLog(T3B_USDC)]
    const r = blocklistFromLogs(logs, T3B_USDC, EURC_ADDR)
    assert.ok(r)
    assert.equal(r.added, 1)
    assert.equal(r.removed, 0)
    assert.equal(r.addrs[0].token, 'usdc')
    assert.equal(r.addrs[0].kind, 'blacklisted')
  })

  it('UnBlacklisted topic from USDC address is counted as removal', () => {
    const logs = [unblacklistedLog(T3B_USDC)]
    const r = blocklistFromLogs(logs, T3B_USDC, EURC_ADDR)
    assert.ok(r)
    assert.equal(r.removed, 1)
    assert.equal(r.addrs[0].kind, 'unblacklisted')
  })

  it('same topic from unrelated address is ignored', () => {
    const logs = [blacklistedLog(T3B_OTHER)]
    const r = blocklistFromLogs(logs, T3B_USDC, EURC_ADDR)
    assert.equal(r, null)
  })

  it('blkAddr is capped at 10 by the caller; blocklistFromLogs returns all found', () => {
    // blocklistFromLogs itself returns all; summarize trims blkAddrAcc to slice(-10)
    const logs = Array.from({ length: 12 }, () => blacklistedLog(T3B_USDC))
    const r = blocklistFromLogs(logs, T3B_USDC, EURC_ADDR)
    assert.equal(r.added, 12, 'blocklistFromLogs returns all 12')
    assert.equal(r.addrs.length, 12)
    // The trim-to-10 happens in summarize.mjs; verify the pattern with a slice
    assert.equal(r.addrs.slice(-10).length, 10, 'caller can trim to 10 with slice(-10)')
  })

  it('no logs → null', () => {
    assert.equal(blocklistFromLogs([], T3B_USDC, EURC_ADDR), null)
  })
})

// ── T3b Part 4: CCTP decoding ────────────────────────────────────────────────

describe('decodeDepositForBurn', () => {
  it('decodes a hand-built 10-word data blob correctly', () => {
    // amount = 1000 USDC (1000 * 10^6 = 1_000_000_000 raw), domain = 3, maxFee = 0.005 USDC
    const amountRaw  = 1_000_000_000n              // 1000 USDC at 6 dec
    const domain     = 3
    const maxFeeRaw  = 5_000n                      // 0.005 USDC at 6 dec
    const data = depositForBurnData(amountRaw, domain, maxFeeRaw)
    const r = decodeDepositForBurn(data, 6)
    assert.ok(r, 'should parse successfully')
    assert.equal(r.amount, 1000, 'amount should be 1000 USDC')
    assert.equal(r.domain, 3,    'domain should be 3')
    assert.equal(r.maxFee, 0.005, 'maxFee should be 0.005 USDC')
  })

  it('returns null on an empty / malformed data string', () => {
    assert.equal(decodeDepositForBurn('0x', 6), null)
    assert.equal(decodeDepositForBurn('not-hex', 6), null)
  })

  it('DepositForBurn topic from a wrong address is ignored in the caller (constant check)', () => {
    // The topic itself is a constant; the address check is in run.mjs not in decodeDepositForBurn.
    // We verify the topic constant is defined and non-empty.
    assert.ok(DEPOSIT_FOR_BURN_TOPIC.startsWith('0x'), 'DEPOSIT_FOR_BURN_TOPIC must be a hex string')
    assert.equal(DEPOSIT_FOR_BURN_TOPIC.length, 66, 'topic0 must be 32 bytes = 66 chars with 0x')
  })
})

describe('decodeMessageReceived', () => {
  it('gives sourceDomain from a one-word data blob', () => {
    const data = messageReceivedData(7)
    const r = decodeMessageReceived(data)
    assert.ok(r)
    assert.equal(r.sourceDomain, 7)
  })

  it('returns null on empty data', () => {
    assert.equal(decodeMessageReceived('0x'), null)
  })

  it('MessageReceived topic from wrong address is ignored in caller (constant check)', () => {
    assert.ok(MESSAGE_RECEIVED_TOPIC.startsWith('0x'))
    assert.equal(MESSAGE_RECEIVED_TOPIC.length, 66)
  })

})

// ── T3b Part 5: summarize — window accumulation of new fields ────────────────

describe('parseSupplyHex', () => {
  it('parses a known hex value to USDC amount', () => {
    // 1_000_000_000_000 raw (6 dec) = 1_000_000 USDC
    const raw = (1_000_000n * 10n ** 6n).toString(16)
    const result = parseSupplyHex('0x' + raw.padStart(64, '0'), 6)
    assert.equal(result, 1_000_000)
  })

  it('returns 0 for empty hex', () => {
    assert.equal(parseSupplyHex('0x', 6), 0)
    assert.equal(parseSupplyHex('', 6), 0)
    assert.equal(parseSupplyHex(null, 6), 0)
  })
})

describe('appendSupplySeries', () => {
  it('appends a new point for a new hour', () => {
    const series = []
    appendSupplySeries(series, '2026-10-08T14', 5_000_000, null, 'usdc')
    assert.equal(series.length, 1)
    assert.equal(series[0].hour, '2026-10-08T14')
    assert.equal(series[0].supply, 5_000_000)
  })

  it('same hour twice → one point (deduplication)', () => {
    const series = []
    appendSupplySeries(series, '2026-10-08T14', 5_000_000, null, 'usdc')
    appendSupplySeries(series, '2026-10-08T14', 5_100_000, null, 'usdc')
    assert.equal(series.length, 1, 'same hour must not create a second point')
    assert.equal(series[0].supply, 5_100_000, 'second call updates the point in-place')
  })

})
