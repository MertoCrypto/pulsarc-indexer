// Tests for src/wallets.mjs — T4a.
// Run: node --test pulsarc-indexer/test/wallets.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  EPOCH_S,
  shardOf, dayOf, emptyRecord,
  buildAppIndex, bridgeAddrs,
  walletDeltas, mergeRecords, mergeInto,
  encodeRecord, decodeRecord, encodeShard, decodeShard,
  activeDayCount, ageDays, appsOf,
  SET_CAP, extCounts, hourBucket,
} from '../src/wallets.mjs'

import {
  USDC,
  TRANSFER_TOPIC,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  DEPOSIT_FOR_BURN_TOPIC,
  MESSAGE_RECEIVED_TOPIC,
} from '../src/counters.mjs'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const A  = '0x' + 'a'.repeat(40)
const B  = '0x' + 'b'.repeat(40)
const C  = '0x' + 'c'.repeat(40)
const ZERO = '0x' + '0'.repeat(40)

/** 40-char address padded to 64-char topic (32 bytes) */
function addrTopic(addr) {
  return '0x' + addr.replace('0x', '').padStart(64, '0')
}

/** Make a USDC Transfer log */
function usdcTransfer(from, to, amountUsdc, decimals = 6) {
  const raw = BigInt(Math.round(amountUsdc * 10 ** decimals))
  return {
    address: USDC,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
    data: '0x' + raw.toString(16).padStart(64, '0'),
  }
}

/** Minimal passing receipt */
function receipt(overrides = {}) {
  return {
    from: A,
    to:   B,
    status: '0x1',
    gasUsed: '0x5208',           // 21000
    effectiveGasPrice: '0x1',    // 1 wei → fee = 21000/1e18
    logs: [],
    ...overrides,
  }
}

/** appsConfig with 3 apps */
const APPS = {
  apps: [
    { id: 'usdc',   anchors: [{ address: USDC,              kind: 'token'    }] },
    { id: 'app1',   anchors: [{ address: B,                 kind: 'contract' }] },
    { id: 'app2',   anchors: [{ address: C,                 kind: 'contract' }] },
  ],
}

const APP_INDEX = buildAppIndex(APPS)

/** ctx for walletDeltas tests */
const ctx = { day: 0, usdcDecimals: 6, appIndex: APP_INDEX, net: 'testnet' }

// ── shardOf ───────────────────────────────────────────────────────────────────

describe('shardOf', () => {
  it('lower-cases and returns first 3 chars after 0x', () => {
    assert.equal(shardOf('0xAbC123def456789012345678901234567890abcd'), 'abc')
  })

  it('all-lowercase address', () => {
    assert.equal(shardOf(A), 'aaa')
  })

  it('throws on non-string', () => {
    assert.throws(() => shardOf(null), /Invalid/)
    assert.throws(() => shardOf(42),   /Invalid/)
  })

  it('throws on wrong length', () => {
    assert.throws(() => shardOf('0xabc'), /Invalid/)
  })

  it('throws on non-hex chars', () => {
    assert.throws(() => shardOf('0x' + 'g'.repeat(40)), /Invalid/)
  })

  it('0x prefix is required', () => {
    assert.throws(() => shardOf('a'.repeat(42)), /Invalid/)
  })
})

// ── dayOf ─────────────────────────────────────────────────────────────────────

describe('dayOf', () => {
  it('2026-01-01T00:00:00Z → day 0', () => {
    assert.equal(dayOf(EPOCH_S), 0)
  })

  it('2026-01-01T23:59:59Z → still day 0', () => {
    assert.equal(dayOf(EPOCH_S + 86399), 0)
  })

  it('2026-01-02T00:00:00Z → day 1', () => {
    assert.equal(dayOf(EPOCH_S + 86400), 1)
  })

  it('7 full days later → day 7', () => {
    assert.equal(dayOf(EPOCH_S + 7 * 86400), 7)
  })

  it('EPOCH_S matches 2026-01-01T00:00:00Z', () => {
    // Verify the constant against Date.UTC
    assert.equal(EPOCH_S, Date.UTC(2026, 0, 1) / 1000)
  })
})

// ── sender with one ok and one failed tx ──────────────────────────────────────

describe('walletDeltas — basic sender', () => {
  it('counts t=2, x=1 for one ok and one failed tx', () => {
    const receipts = [
      receipt({ from: A, status: '0x1' }),
      receipt({ from: A, status: '0x0' }),
    ]
    const map = walletDeltas(receipts, ctx)
    const r = map.get(A.toLowerCase())
    assert.ok(r, 'sender must have a delta')
    assert.equal(r.t, 2, 'two txs sent')
    assert.equal(r.x, 1, 'one failed')
  })

  it('fee is computed from gasUsed × effectiveGasPrice / 1e18', () => {
    // gasUsed = 21000 (0x5208), effectiveGasPrice = 1e12 wei (0xe8d4a51000)
    // fee = 21000 × 1e12 / 1e18 = 0.000021 USDC — visible at 6 decimal places
    const r = receipt({ from: A, gasUsed: '0x5208', effectiveGasPrice: '0xe8d4a51000' })
    const map = walletDeltas([r], ctx)
    const delta = map.get(A.toLowerCase())
    const expected = +(21000 * 1e12 / 1e18).toFixed(6)  // 0.000021
    assert.equal(delta.e, expected, `fee expected ${expected}, got ${delta.e}`)
  })

  it('active day bit is set for sender', () => {
    const map = walletDeltas([receipt({ from: A })], ctx)
    const r = map.get(A.toLowerCase())
    assert.equal(r.d, '1', 'bit 0 must be set (day offset 0)')
  })
})

// ── USDC send/receive amounts with decimals 6 ─────────────────────────────────

describe('walletDeltas — USDC transfer', () => {
  it('sender gets o += amount, receiver gets i += amount', () => {
    const log = usdcTransfer(A, B, 100)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    assert.ok(Math.abs(map.get(A.toLowerCase()).o - 100) < 1e-9, 'o should be 100')
    assert.ok(Math.abs(map.get(B.toLowerCase()).i - 100) < 1e-9, 'i should be 100')
  })

  it('zero address is skipped for both from and to', () => {
    const mintLog  = usdcTransfer(ZERO, B, 50)   // mint: from=zero
    const burnLog  = usdcTransfer(A, ZERO, 50)   // burn: to=zero
    const map = walletDeltas([receipt({ from: A, logs: [mintLog, burnLog] })], ctx)
    // B gets i=50 (mint receiver), zero address must not appear
    assert.ok(!map.has(ZERO), 'zero address must not appear in deltas')
    // A sent to zero → gets o=50
    assert.ok(Math.abs(map.get(A.toLowerCase()).o - 50) < 1e-9)
    // B receives from zero → gets i=50
    assert.ok(Math.abs(map.get(B.toLowerCase()).i - 50) < 1e-9)
  })
})

// ── App mask from receipt.to anchor and from a log emitter ────────────────────

describe('walletDeltas — app mask', () => {
  it('app bit set from receipt.to matching a contract anchor', () => {
    // B is app1 (index 1)
    const map = walletDeltas([receipt({ from: A, to: B })], ctx)
    const r = map.get(A.toLowerCase())
    const mask = BigInt('0x' + r.a)
    assert.ok((mask >> 1n) & 1n, 'bit 1 (app1) must be set for sender A')
  })

  it('app bit set from log emitter address', () => {
    // C is app2 (index 2); emit a log from C inside A's receipt
    const log = { address: C, topics: ['0xdeadbeef'], data: '0x' }
    const map = walletDeltas([receipt({ from: A, to: '0x' + '9'.repeat(40), logs: [log] })], ctx)
    const r = map.get(A.toLowerCase())
    const mask = BigInt('0x' + r.a)
    assert.ok((mask >> 2n) & 1n, 'bit 2 (app2) must be set for sender A')
  })

  it('unknown address gives no app bit', () => {
    const unknown = '0x' + '1'.repeat(40)
    const map = walletDeltas([receipt({ from: A, to: unknown })], ctx)
    const r = map.get(A.toLowerCase())
    assert.equal(r.a, '0', 'app mask should be 0 for unknown address')
  })

  it('app index >= 64 is ignored', () => {
    // Build a config with 65 apps (indices 0-64); app at index 64 must not set a bit
    const manyApps = {
      apps: Array.from({ length: 65 }, (_, k) => ({
        id: `app${k}`,
        anchors: [{ address: '0x' + k.toString(16).padStart(40, '0'), kind: 'contract' }],
      })),
    }
    const idx64addr = '0x' + (64).toString(16).padStart(40, '0')
    const bigIndex = buildAppIndex(manyApps)
    assert.ok(!bigIndex.has(idx64addr), 'index 64 must not be in the index (0-based, 64 exceeds 63)')
  })

  it('failed tx logs are ignored for app bits', () => {
    // C is app2; receipt fails — no logs should be read
    const log = { address: C, topics: ['0xdeadbeef'], data: '0x' }
    const map = walletDeltas([receipt({ from: A, status: '0x0', logs: [log] })], ctx)
    const r = map.get(A.toLowerCase())
    // to=B gives app1 even on failure (receipt.to is read before status check)
    // but log emitters are NOT read on failure
    const mask = BigInt('0x' + r.a)
    assert.ok(!((mask >> 2n) & 1n), 'bit 2 (app2 from log) must NOT be set for failed tx')
    assert.ok((mask >> 1n) & 1n,    'bit 1 (app1 from to=B) IS set even for failed tx')
  })
})

// ── Bridge-out ────────────────────────────────────────────────────────────────

describe('walletDeltas — bridge-out', () => {
  const TM = TOKEN_MESSENGER_V2.testnet.toLowerCase()

  it('bo+1 for the depositor when DepositForBurn log from TOKEN_MESSENGER_V2', () => {
    const log = {
      address: TM,
      topics: [
        DEPOSIT_FOR_BURN_TOPIC,
        '0x' + '0'.repeat(64),  // nonce or burnToken (not checked here)
        addrTopic(A),            // depositor = topics[2]
      ],
      data: '0x' + '0'.repeat(640),
    }
    const map = walletDeltas([receipt({ from: A, to: TM, logs: [log] })], ctx)
    assert.equal(map.get(A.toLowerCase()).bo, 1)
  })

  it('DepositForBurn log from wrong address does NOT give bo', () => {
    const wrongAddr = '0x' + 'f'.repeat(40)
    const log = {
      address: wrongAddr,
      topics: [DEPOSIT_FOR_BURN_TOPIC, '0x' + '0'.repeat(64), addrTopic(A)],
      data: '0x',
    }
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    assert.equal(map.get(A.toLowerCase()).bo, 0, 'wrong emitter must not give bo')
  })
})

// ── Bridge-in ─────────────────────────────────────────────────────────────────

describe('walletDeltas — bridge-in', () => {
  const MT = MESSAGE_TRANSMITTER_V2.testnet.toLowerCase()

  it('bi+1 for mint receiver when MessageReceived + USDC mint in same receipt', () => {
    const mrLog = {
      address: MT,
      topics: [MESSAGE_RECEIVED_TOPIC, '0x' + '0'.repeat(64)],
      data: '0x' + '7'.padStart(64, '0'),   // sourceDomain = 7
    }
    const mintLog = usdcTransfer(ZERO, B, 200)   // from=zero = CCTP mint
    const map = walletDeltas([receipt({ from: A, to: MT, logs: [mrLog, mintLog] })], ctx)
    assert.equal(map.get(B.toLowerCase()).bi, 1, 'B is the mint receiver → bi=1')
    // A does not get bi
    assert.equal(map.get(A.toLowerCase()).bi, 0)
  })

  it('MessageReceived alone (no USDC mint) gives no bi', () => {
    const mrLog = {
      address: MT,
      topics: [MESSAGE_RECEIVED_TOPIC],
      data: '0x' + '3'.padStart(64, '0'),
    }
    const map = walletDeltas([receipt({ from: A, logs: [mrLog] })], ctx)
    // Nobody gets bi
    for (const [, r] of map) assert.equal(r.bi, 0)
  })
})

// ── mergeRecords ──────────────────────────────────────────────────────────────

describe('mergeRecords', () => {
  it('different f: new f is the minimum', () => {
    const a = { ...emptyRecord(10), t: 5, d: '1' }
    const b = { ...emptyRecord(20), t: 3, d: '1' }
    const m = mergeRecords(a, b)
    assert.equal(m.f, 10)
    assert.equal(m.l, 20)
    assert.equal(m.t, 8)
  })

  it('same f: numeric fields summed, d OR-ed (same offset)', () => {
    const a = { ...emptyRecord(5), t: 2, d: '1', o: 10, i: 5  }
    const b = { ...emptyRecord(5), t: 3, d: '2', o:  0, i: 15 }
    const m = mergeRecords(a, b)
    assert.equal(m.f, 5)
    assert.equal(m.t, 5)
    assert.equal(m.d, '3',  'd should be OR of 1 and 2 = 3')
    assert.equal(m.o, 10)
    assert.equal(m.i, 20)
  })

  it('d bits are shifted to align on new f', () => {
    // a: f=0, d='1' (bit 0 = day 0 active)
    // b: f=9, d='1' (bit 0 = day 9 active)
    // Merge: f=0; b's bit 0 becomes bit 9 in the merged d
    // Expected: bits 0 and 9 set → 1 + 512 = 513 = 0x201
    const a = { ...emptyRecord(0), d: '1' }
    const b = { ...emptyRecord(9), d: '1' }
    const m = mergeRecords(a, b)
    assert.equal(m.f, 0)
    const val = Number(BigInt('0x' + m.d))
    assert.ok((val & 1),   'bit 0 must be set (day 0)')
    assert.ok((val >> 9) & 1, 'bit 9 must be set (day 9)')
  })

  it('inputs are not mutated', () => {
    const a = { ...emptyRecord(0), t: 1, e: 0.5 }
    const b = { ...emptyRecord(0), t: 2, e: 0.3 }
    const aCopy = { ...a }
    const bCopy = { ...b }
    mergeRecords(a, b)
    assert.deepEqual(a, aCopy, 'a must not be mutated')
    assert.deepEqual(b, bCopy, 'b must not be mutated')
  })

  it('associativity: (a+b)+c == a+(b+c)', () => {
    const r1 = { ...emptyRecord(0),  t: 3, e: 1.0, o: 50, i: 0, x: 1, bo: 1, bi: 0, a: '1', d: '1' }
    const r2 = { ...emptyRecord(5),  t: 2, e: 0.5, o:  0, i: 30, x: 0, bo: 0, bi: 1, a: '2', d: '1' }
    const r3 = { ...emptyRecord(10), t: 7, e: 2.0, o: 10, i: 10, x: 2, bo: 0, bi: 0, a: '4', d: '1' }
    const ab_c = mergeRecords(mergeRecords(r1, r2), r3)
    const a_bc = mergeRecords(r1, mergeRecords(r2, r3))
    assert.equal(ab_c.t, a_bc.t,   't must be equal')
    assert.equal(ab_c.e, a_bc.e,   'e must be equal')
    assert.equal(ab_c.f, a_bc.f,   'f must be equal')
    assert.equal(ab_c.l, a_bc.l,   'l must be equal')
    assert.equal(ab_c.d, a_bc.d,   'd must be equal')
    assert.equal(ab_c.a, a_bc.a,   'a must be equal')
    assert.equal(ab_c.bo + ab_c.bi, a_bc.bo + a_bc.bi, 'bridge counts must be equal')
  })

  it('rounding: e is rounded to 6 decimals', () => {
    const a = { ...emptyRecord(0), e: 0.000001 }
    const b = { ...emptyRecord(0), e: 0.000002 }
    const m = mergeRecords(a, b)
    assert.equal(m.e, 0.000003)
  })
})

// ── encode / decode round-trip ────────────────────────────────────────────────

describe('encodeRecord / decodeRecord round trip', () => {
  it('round trip is identity', () => {
    const rec = {
      f: 10, l: 20, d: '3f', t: 42, x: 1, e: 0.001234, o: 99.5, i: 0, a: 'ff', bo: 3, bi: 1,
    }
    const rt = decodeRecord(encodeRecord(rec))
    for (const k of Object.keys(rec)) {
      assert.equal(rt[k], rec[k], `key ${k} must round-trip`)
    }
  })
})

describe('encodeShard / decodeShard round trip', () => {
  it('produces sorted addresses and round-trips back to the same map', () => {
    const map = new Map()
    map.set(B.toLowerCase(), { ...emptyRecord(5),  t: 2, o: 10, i: 5,  a: '2', d: '1', x: 0, e: 0, bo: 0, bi: 0 })
    map.set(A.toLowerCase(), { ...emptyRecord(10), t: 5, o:  0, i: 50, a: '1', d: '3', x: 1, e: 0.1, bo: 1, bi: 0 })
    const obj = encodeShard(map)
    const keys = Object.keys(obj)
    assert.deepEqual(keys, [...keys].sort(), 'shard must be sorted by address')
    const rt = decodeShard(obj)
    for (const [addr, rec] of map) {
      const rtRec = rt.get(addr)
      assert.ok(rtRec, `${addr} must survive the round trip`)
      assert.equal(rtRec.t, rec.t)
      assert.equal(rtRec.o, rec.o)
    }
  })
})

// ── activeDayCount / ageDays / appsOf ─────────────────────────────────────────

describe('activeDayCount', () => {
  it('d="0" → 0 active days', () => assert.equal(activeDayCount({ d: '0' }), 0))
  it('d="1" → 1 active day',  () => assert.equal(activeDayCount({ d: '1' }), 1))
  it('d="3" → 2 active days (bits 0 and 1)', () => assert.equal(activeDayCount({ d: '3' }), 2))
  it('d="7" → 3 active days', () => assert.equal(activeDayCount({ d: '7' }), 3))
})

describe('ageDays', () => {
  it('today - f gives the age', () => {
    const rec = emptyRecord(10)
    assert.equal(ageDays(rec, 50), 40)
    assert.equal(ageDays(rec, 10), 0)
  })
})

describe('appsOf', () => {
  it('mask 0 → empty list', () => {
    const rec = { ...emptyRecord(0), a: '0' }
    assert.deepEqual(appsOf(rec, APPS), [])
  })

  it('mask "2" → bit 1 → app1', () => {
    const rec = { ...emptyRecord(0), a: '2' }
    assert.deepEqual(appsOf(rec, APPS), ['app1'])
  })

  it('mask "7" → bits 0,1,2 → usdc, app1, app2', () => {
    const rec = { ...emptyRecord(0), a: '7' }
    assert.deepEqual(appsOf(rec, APPS), ['usdc', 'app1', 'app2'])
  })
})

// ── Bit layout example (hand-computed) ───────────────────────────────────────

describe('bit layout — active on day f, f+1, f+9', () => {
  it('produces hex "203"', () => {
    // bit 0 (day f):   value 1
    // bit 1 (day f+1): value 2
    // bit 9 (day f+9): value 512 = 0x200
    // total: 1 + 2 + 512 = 515 = 0x203
    const expected = '203'
    const n = 1n | 2n | (1n << 9n)
    assert.equal(n.toString(16), expected)
    assert.equal(activeDayCount({ d: expected }), 3)
  })
})

describe('mergeRecords — every numeric field is summed', () => {
  it('adds t, x, e, o, i, bo and bi and ORs the apps mask', () => {
    const a = { ...emptyRecord(10), t: 1, x: 1, e: 0.5, o: 2, i: 3, bo: 1, bi: 2, a: '1' }
    const b = { ...emptyRecord(10), t: 4, x: 2, e: 0.25, o: 5, i: 7, bo: 3, bi: 4, a: '2' }
    const m = mergeRecords(a, b)
    assert.equal(m.t, 5)
    assert.equal(m.x, 3)
    assert.equal(m.e, 0.75)
    assert.equal(m.o, 7)
    assert.equal(m.i, 10)
    assert.equal(m.bo, 4)
    assert.equal(m.bi, 6)
    assert.equal(m.a, '3')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// NEW TESTS: backward compat
// ════════════════════════════════════════════════════════════════════════════════

describe('backward compat — emptyRecord has exactly 11 keys', () => {
  it('emptyRecord returns no ext and exactly the 11 expected keys', () => {
    const rec = emptyRecord(0)
    const keys = Object.keys(rec)
    assert.deepEqual(keys.sort(), ['a', 'bi', 'bo', 'd', 'e', 'f', 'i', 'l', 'o', 't', 'x'].sort())
    assert.ok(!('ext' in rec), 'ext must not be present on an empty record')
  })
})

describe('backward compat — old 11-element arrays decode/encode unchanged', () => {
  it('encodeRecord without ext produces exactly 11 elements', () => {
    const rec = { f: 1, l: 2, d: 'a', t: 5, x: 1, e: 0.5, o: 10, i: 3, a: 'f', bo: 2, bi: 1 }
    const arr = encodeRecord(rec)
    assert.equal(arr.length, 11)
    assert.deepEqual(arr, [1, 2, 'a', 5, 1, 0.5, 10, 3, 'f', 2, 1])
  })

  it('decodeRecord on 11-element array produces no ext', () => {
    const arr = [1, 2, 'a', 5, 1, 0.5, 10, 3, 'f', 2, 1]
    const rec = decodeRecord(arr)
    assert.ok(!('ext' in rec), 'ext must not appear when arr has 11 elements')
    assert.equal(rec.f, 1)
    assert.equal(rec.bi, 1)
  })

  it('round-trip: old record encodes to same 11-element array as before', () => {
    const rec = { f: 10, l: 20, d: '3f', t: 42, x: 1, e: 0.001234, o: 99.5, i: 0, a: 'ff', bo: 3, bi: 1 }
    const arr = encodeRecord(rec)
    assert.equal(arr.length, 11)
    const rt = decodeRecord(arr)
    for (const k of Object.keys(rec)) {
      assert.equal(rt[k], rec[k], `${k} must survive round-trip`)
    }
    assert.ok(!('ext' in rt))
  })

  it('12-element round-trip preserves ext', () => {
    const rec = { f: 0, l: 1, d: '1', t: 3, x: 0, e: 0, o: 0, i: 0, a: '0', bo: 0, bi: 0,
                  ext: { dp: 2, tt: 5, ut: ['aabbccdd'] } }
    const arr = encodeRecord(rec)
    assert.equal(arr.length, 12, '12th element must be present when ext is non-empty')
    assert.deepEqual(arr[11], rec.ext)
    const rt = decodeRecord(arr)
    assert.ok(rt.ext, 'ext must survive round-trip')
    assert.equal(rt.ext.dp, 2)
    assert.equal(rt.ext.tt, 5)
    assert.deepEqual(rt.ext.ut, ['aabbccdd'])
  })

  it('decodeRecord on length-12 array with null ext does not set rec.ext', () => {
    const base = [0, 1, '1', 3, 0, 0, 0, 0, '0', 0, 0]
    const arr = base.concat([null])
    assert.equal(arr.length, 12)
    const rec = decodeRecord(arr)
    assert.ok(!('ext' in rec), 'null ext must not be set on rec')
  })

  it('encodeRecord with empty ext object does not emit 12th element', () => {
    const rec = { f: 0, l: 0, d: '0', t: 0, x: 0, e: 0, o: 0, i: 0, a: '0', bo: 0, bi: 0,
                  ext: {} }
    const arr = encodeRecord(rec)
    assert.equal(arr.length, 11, 'empty ext must not produce a 12th element')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// NEW TESTS: hourBucket
// ════════════════════════════════════════════════════════════════════════════════

describe('hourBucket', () => {
  it('hour 0 → bucket 0', ()  => assert.equal(hourBucket(0),  0))
  it('hour 5 → bucket 0', ()  => assert.equal(hourBucket(5),  0))
  it('hour 6 → bucket 1', ()  => assert.equal(hourBucket(6),  1))
  it('hour 11 → bucket 1', () => assert.equal(hourBucket(11), 1))
  it('hour 12 → bucket 2', () => assert.equal(hourBucket(12), 2))
  it('hour 17 → bucket 2', () => assert.equal(hourBucket(17), 2))
  it('hour 18 → bucket 3', () => assert.equal(hourBucket(18), 3))
  it('hour 23 → bucket 3', () => assert.equal(hourBucket(23), 3))
  it('hour -1 → -1 (invalid)', () => assert.equal(hourBucket(-1), -1))
  it('hour 24 → -1 (invalid)', () => assert.equal(hourBucket(24), -1))
  it('hour 1.5 → -1 (non-integer)', () => assert.equal(hourBucket(1.5), -1))
  it('"3" (string) → -1', ()         => assert.equal(hourBucket('3'), -1))
})

// ════════════════════════════════════════════════════════════════════════════════
// NEW TESTS: walletDeltas — ext facts
// ════════════════════════════════════════════════════════════════════════════════

// ── ext.dp — contract deployments ────────────────────────────────────────────

describe('walletDeltas — ext.dp (deployments)', () => {
  it('successful deploy increments dp for sender', () => {
    const r = receipt({ from: A, contractAddress: '0x' + 'c'.repeat(40), status: '0x1' })
    const map = walletDeltas([r], ctx)
    const rec = map.get(A.toLowerCase())
    assert.equal(rec.ext?.dp, 1)
  })

  it('failed receipt with contractAddress does NOT increment dp', () => {
    // spec says: receipt.contractAddress is non-null AND receipt.status === '0x1'
    // a failed tx has status '0x0' so dp should not increment
    const r = receipt({ from: A, contractAddress: '0x' + 'c'.repeat(40), status: '0x0' })
    const map = walletDeltas([r], ctx)
    const rec = map.get(A.toLowerCase())
    // dp must be absent or 0
    assert.ok(!rec.ext?.dp, 'dp must not be set for failed deploy')
  })

  it('plain call (no contractAddress) does not set dp', () => {
    const r = receipt({ from: A, to: B, status: '0x1' })
    const map = walletDeltas([r], ctx)
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.dp, 'no dp for plain call')
  })

  it('two deploys in same block → dp=2', () => {
    const r1 = receipt({ from: A, contractAddress: '0x' + '1'.repeat(40), status: '0x1' })
    const r2 = receipt({ from: A, contractAddress: '0x' + '2'.repeat(40), status: '0x1' })
    const map = walletDeltas([r1, r2], ctx)
    assert.equal(map.get(A.toLowerCase()).ext?.dp, 2)
  })
})

// ── ext.h — hour bucket counts ────────────────────────────────────────────────

describe('walletDeltas — ext.h (hour buckets)', () => {
  it('ctx.hour absent → no h recorded', () => {
    const map = walletDeltas([receipt({ from: A })], ctx)   // ctx has no .hour
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.h, 'h must not appear when ctx.hour is absent')
  })

  it('ctx.hour=0 (bucket 0) → h=[1,0,0,0]', () => {
    const map = walletDeltas([receipt({ from: A })], { ...ctx, hour: 0 })
    const rec = map.get(A.toLowerCase())
    assert.deepEqual(rec.ext.h, [1, 0, 0, 0])
  })

  it('ctx.hour=7 (bucket 1) → h=[0,1,0,0]', () => {
    const map = walletDeltas([receipt({ from: A })], { ...ctx, hour: 7 })
    const rec = map.get(A.toLowerCase())
    assert.deepEqual(rec.ext.h, [0, 1, 0, 0])
  })

  it('ctx.hour=23 (bucket 3) → h=[0,0,0,1]', () => {
    const map = walletDeltas([receipt({ from: A })], { ...ctx, hour: 23 })
    const rec = map.get(A.toLowerCase())
    assert.deepEqual(rec.ext.h, [0, 0, 0, 1])
  })

  it('burst of 3 tx in bucket 2 → h=[0,0,3,0]', () => {
    const rs = [
      receipt({ from: A }),
      receipt({ from: A }),
      receipt({ from: A }),
    ]
    const map = walletDeltas(rs, { ...ctx, hour: 12 })
    assert.deepEqual(map.get(A.toLowerCase()).ext.h, [0, 0, 3, 0])
  })

  it('failed tx still counts in h', () => {
    const rs = [
      receipt({ from: A, status: '0x1' }),
      receipt({ from: A, status: '0x0' }),   // failed
    ]
    const map = walletDeltas(rs, { ...ctx, hour: 0 })
    // both tx by sender should be counted (h tracks ALL sent tx)
    assert.deepEqual(map.get(A.toLowerCase()).ext.h, [2, 0, 0, 0])
  })

  it('ctx.hour=24 (invalid) → no h recorded', () => {
    const map = walletDeltas([receipt({ from: A })], { ...ctx, hour: 24 })
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.h, 'h must not appear for invalid hour')
  })

  it('ctx.hour=1.5 (non-integer) → no h recorded', () => {
    const map = walletDeltas([receipt({ from: A })], { ...ctx, hour: 1.5 })
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.h, 'h must not appear for non-integer hour')
  })
})

// ── ext.tt / ext.ut / ext.un — Transfer-log counts and token sets ─────────────

// Helper: make a generic ERC-20 Transfer log (any token contract)
function erc20TransferLog(tokenAddr, from, to) {
  return {
    address: tokenAddr,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to)],
    data: '0x' + '0'.repeat(64),
  }
}

// Helper: make an ERC-721 Transfer log (4 topics; topics[3] = tokenId)
function erc721TransferLog(nftAddr, from, to) {
  return {
    address: nftAddr,
    topics: [TRANSFER_TOPIC, addrTopic(from), addrTopic(to), '0x' + '1'.padStart(64, '0')],
    data: '0x',
  }
}

const TOK1 = '0x' + '1'.repeat(40)   // a fictional ERC-20
const TOK2 = '0x' + '2'.repeat(40)   // another ERC-20
const NFT1 = '0x' + 'd'.repeat(40)   // a fictional ERC-721

describe('walletDeltas — ext.tt / ext.ut / ext.un (Transfer logs)', () => {
  it('ERC-20 Transfer: both parties get tt=1 and ut with the token prefix', () => {
    const log = erc20TransferLog(TOK1, A, B)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    const rA = map.get(A.toLowerCase())
    const rB = map.get(B.toLowerCase())
    assert.equal(rA.ext?.tt, 1, 'A tt')
    assert.equal(rB.ext?.tt, 1, 'B tt')
    const prefix = TOK1.slice(2, 10)   // '11111111'
    assert.ok(rA.ext?.ut?.includes(prefix), 'A ut has TOK1 prefix')
    assert.ok(rB.ext?.ut?.includes(prefix), 'B ut has TOK1 prefix')
  })

  it('ERC-721 Transfer: both parties get tt=1 and un (not ut) with the contract prefix', () => {
    const log = erc721TransferLog(NFT1, A, B)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    const rA = map.get(A.toLowerCase())
    const rB = map.get(B.toLowerCase())
    assert.equal(rA.ext?.tt, 1, 'A tt')
    assert.equal(rB.ext?.tt, 1, 'B tt')
    const prefix = NFT1.slice(2, 10)
    assert.ok(rA.ext?.un?.includes(prefix), 'A un has NFT1 prefix')
    assert.ok(rB.ext?.un?.includes(prefix), 'B un has NFT1 prefix')
    // ut must NOT be set
    assert.ok(!(rA.ext?.ut?.includes(prefix)), 'A ut must NOT have NFT1 prefix')
  })

  it('self-transfer (from === to, non-zero) is counted exactly once', () => {
    const log = erc20TransferLog(TOK1, A, A)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    const rA = map.get(A.toLowerCase())
    assert.equal(rA.ext?.tt, 1, 'self-transfer counted once')
    assert.equal(rA.ext?.ut?.length, 1, 'ut has exactly one entry')
  })

  it('zero-address as from is ignored (mint-style)', () => {
    const log = erc20TransferLog(TOK1, ZERO, B)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    assert.ok(!map.has(ZERO), 'zero address must not get a delta')
    // B still gets tt=1 because it is a non-zero party
    assert.equal(map.get(B.toLowerCase()).ext?.tt, 1)
  })

  it('zero-address as to is ignored (burn-style)', () => {
    const log = erc20TransferLog(TOK1, A, ZERO)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    assert.ok(!map.has(ZERO), 'zero address must not get a delta')
    assert.equal(map.get(A.toLowerCase()).ext?.tt, 1)
  })

  it('both parties zero → no party gets tt', () => {
    const log = erc20TransferLog(TOK1, ZERO, ZERO)
    const map = walletDeltas([receipt({ from: A, logs: [log] })], ctx)
    // Neither zero-address party should appear; sender A gets nothing from the log
    assert.ok(!map.get(A.toLowerCase())?.ext?.tt)
  })

  it('Transfer log on failed receipt does not count', () => {
    const log = erc20TransferLog(TOK1, A, B)
    const map = walletDeltas([receipt({ from: A, status: '0x0', logs: [log] })], ctx)
    const rA = map.get(A.toLowerCase())
    assert.ok(!rA.ext?.tt, 'tt must not be set from failed receipt logs')
  })
})

// ── ext.uc — called contracts ─────────────────────────────────────────────────

const CONTRACT1 = '0x' + 'e'.repeat(40)   // a fictional contract

describe('walletDeltas — ext.uc (called contracts)', () => {
  it('contract call: receipt.to emits a log → uc gets to prefix', () => {
    const log = { address: CONTRACT1, topics: ['0xdeadbeef'], data: '0x' }
    const map = walletDeltas([receipt({ from: A, to: CONTRACT1, logs: [log] })], ctx)
    const rec = map.get(A.toLowerCase())
    const prefix = CONTRACT1.slice(2, 10)
    assert.ok(rec.ext?.uc?.includes(prefix), 'uc must contain CONTRACT1 prefix')
  })

  it('receipt.to === sender → uc rule does NOT apply', () => {
    // When the sender calls themselves (to === from), uc should not be set
    const log = { address: A, topics: ['0xdeadbeef'], data: '0x' }
    const map = walletDeltas([receipt({ from: A, to: A, logs: [log] })], ctx)
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.uc?.length, 'uc must not be set when to === sender')
  })

  it('receipt.to has no log in the receipt → uc not set', () => {
    // Contract1 is the target but the only log is from a different address
    const log = { address: B, topics: ['0xdeadbeef'], data: '0x' }
    const map = walletDeltas([receipt({ from: A, to: CONTRACT1, logs: [log] })], ctx)
    const rec = map.get(A.toLowerCase())
    const prefix = CONTRACT1.slice(2, 10)
    assert.ok(!(rec.ext?.uc?.includes(prefix)), 'uc must not be set when to emits no log')
  })

  it('receipt.to is null (deploy) → uc not set', () => {
    const r = receipt({ from: A, to: null, contractAddress: '0x' + '9'.repeat(40), status: '0x1' })
    const map = walletDeltas([r], ctx)
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.uc?.length, 'uc must not be set for deploy (to=null)')
  })

  it('failed receipt: uc not set even if to emits a log', () => {
    const log = { address: CONTRACT1, topics: ['0xdeadbeef'], data: '0x' }
    const map = walletDeltas([receipt({ from: A, to: CONTRACT1, status: '0x0', logs: [log] })], ctx)
    const rec = map.get(A.toLowerCase())
    assert.ok(!rec.ext?.uc?.length, 'uc must not be set for failed receipt')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// NEW TESTS: mergeRecords with ext
// ════════════════════════════════════════════════════════════════════════════════

describe('mergeRecords — ext handling', () => {
  it('both sides lack ext → result has no ext', () => {
    const a = emptyRecord(0)
    const b = emptyRecord(0)
    const m = mergeRecords(a, b)
    assert.ok(!('ext' in m), 'no ext when both sides lack it')
  })

  it('only one side has ext → result carries it', () => {
    const a = { ...emptyRecord(0), ext: { dp: 3 } }
    const b = emptyRecord(0)
    const m1 = mergeRecords(a, b)
    assert.equal(m1.ext?.dp, 3)
    const m2 = mergeRecords(b, a)
    assert.equal(m2.ext?.dp, 3)
  })

  it('dp is summed across sides', () => {
    const a = { ...emptyRecord(0), ext: { dp: 2 } }
    const b = { ...emptyRecord(0), ext: { dp: 5 } }
    const m = mergeRecords(a, b)
    assert.equal(m.ext.dp, 7)
  })

  it('tt is summed across sides', () => {
    const a = { ...emptyRecord(0), ext: { tt: 10 } }
    const b = { ...emptyRecord(0), ext: { tt: 4 } }
    const m = mergeRecords(a, b)
    assert.equal(m.ext.tt, 14)
  })

  it('h arrays are element-wise summed', () => {
    const a = { ...emptyRecord(0), ext: { h: [1, 2, 3, 4] } }
    const b = { ...emptyRecord(0), ext: { h: [10, 0, 5, 1] } }
    const m = mergeRecords(a, b)
    assert.deepEqual(m.ext.h, [11, 2, 8, 5])
  })

  it('h: one side missing h → treated as [0,0,0,0]', () => {
    const a = { ...emptyRecord(0), ext: { h: [3, 0, 0, 0] } }
    const b = { ...emptyRecord(0), ext: { dp: 1 } }   // no h
    const m = mergeRecords(a, b)
    assert.deepEqual(m.ext.h, [3, 0, 0, 0])
  })

  it('ut sets are unioned and sorted', () => {
    const a = { ...emptyRecord(0), ext: { ut: ['cccccccc', 'aaaaaaaa'] } }
    const b = { ...emptyRecord(0), ext: { ut: ['bbbbbbbb', 'aaaaaaaa'] } }
    const m = mergeRecords(a, b)
    assert.deepEqual(m.ext.ut, ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
  })

  it('un sets are unioned', () => {
    const a = { ...emptyRecord(0), ext: { un: ['dddddddd'] } }
    const b = { ...emptyRecord(0), ext: { un: ['eeeeeeee'] } }
    const m = mergeRecords(a, b)
    assert.deepEqual(m.ext.un, ['dddddddd', 'eeeeeeee'])
  })

  it('uc sets are unioned', () => {
    const a = { ...emptyRecord(0), ext: { uc: ['11111111'] } }
    const b = { ...emptyRecord(0), ext: { uc: ['22222222'] } }
    const m = mergeRecords(a, b)
    assert.deepEqual(m.ext.uc, ['11111111', '22222222'])
  })

  it('set capped at 64 with deterministic truncation (lexicographic first 64)', () => {
    // Build two sets of 40 prefixes each with 16 in common → union = 64 entries
    // prefixes are hex-sortable 8-char strings
    const make = (start, count) =>
      Array.from({ length: count }, (_, i) =>
        (start + i).toString(16).padStart(8, '0')
      )
    const aSet = make(0, 40)
    const bSet = make(24, 40)   // overlaps aSet[24..39], adds 24 new entries above 39
    const a = { ...emptyRecord(0), ext: { ut: aSet } }
    const b = { ...emptyRecord(0), ext: { ut: bSet } }
    const m = mergeRecords(a, b)
    assert.equal(m.ext.ut.length, SET_CAP, 'union must be capped at SET_CAP')
    // The kept entries are the lexicographically smallest SET_CAP items
    const allUnion = Array.from(new Set([...aSet, ...bSet])).sort()
    const expected = allUnion.slice(0, SET_CAP)
    assert.deepEqual(m.ext.ut, expected)
  })

  it('inputs are not mutated when both have ext', () => {
    const a = { ...emptyRecord(0), ext: { dp: 1, ut: ['aaaaaaaa'] } }
    const b = { ...emptyRecord(0), ext: { dp: 2, ut: ['bbbbbbbb'] } }
    const aCopy = JSON.parse(JSON.stringify(a))
    const bCopy = JSON.parse(JSON.stringify(b))
    mergeRecords(a, b)
    assert.deepEqual(a, aCopy, 'a must not be mutated')
    assert.deepEqual(b, bCopy, 'b must not be mutated')
  })

  it('merged ext with all-zero/empty fields does not appear in result', () => {
    // If two sides both have ext but with all zeros, the merged ext is empty → absent
    // (In practice this is unusual, but mergeExt should handle it)
    const a = { ...emptyRecord(0), ext: { dp: 0, tt: 0 } }
    const b = { ...emptyRecord(0), ext: { dp: 0 } }
    const m = mergeRecords(a, b)
    // dp and tt are both 0 → falsy → not written to out
    assert.ok(!m.ext || Object.keys(m.ext).length === 0, 'no non-zero ext fields expected')
  })
})

// ════════════════════════════════════════════════════════════════════════════════
// NEW TESTS: extCounts
// ════════════════════════════════════════════════════════════════════════════════

describe('extCounts', () => {
  it('no ext → all zeros, hours null, no capped flags', () => {
    const rec = emptyRecord(0)
    const c = extCounts(rec)
    assert.equal(c.deployments, 0)
    assert.equal(c.transfers, 0)
    assert.equal(c.tokens, 0)
    assert.equal(c.nfts, 0)
    assert.equal(c.contracts, 0)
    assert.equal(c.tokensCapped, false)
    assert.equal(c.nftsCapped, false)
    assert.equal(c.contractsCapped, false)
    assert.equal(c.hours, null)
  })

  it('ext with dp, tt, h → correct deployments, transfers, hours', () => {
    const rec = { ...emptyRecord(0), ext: { dp: 3, tt: 7, h: [1, 2, 3, 4] } }
    const c = extCounts(rec)
    assert.equal(c.deployments, 3)
    assert.equal(c.transfers, 7)
    assert.deepEqual(c.hours, [1, 2, 3, 4])
  })

  it('tokens/nfts/contracts counted from set lengths', () => {
    const rec = {
      ...emptyRecord(0),
      ext: {
        ut: ['aabbccdd', '11223344'],
        un: ['eeff0011'],
        uc: ['deadbeef', 'cafebabe', '12345678'],
      },
    }
    const c = extCounts(rec)
    assert.equal(c.tokens, 2)
    assert.equal(c.nfts, 1)
    assert.equal(c.contracts, 3)
  })

  it('tokensCapped is true when ut.length === SET_CAP', () => {
    const ut = Array.from({ length: SET_CAP }, (_, i) => i.toString(16).padStart(8, '0'))
    const rec = { ...emptyRecord(0), ext: { ut } }
    const c = extCounts(rec)
    assert.equal(c.tokensCapped, true)
  })

  it('nftsCapped is true when un.length === SET_CAP', () => {
    const un = Array.from({ length: SET_CAP }, (_, i) => i.toString(16).padStart(8, '0'))
    const rec = { ...emptyRecord(0), ext: { un } }
    const c = extCounts(rec)
    assert.equal(c.nftsCapped, true)
  })

  it('contractsCapped is true when uc.length === SET_CAP', () => {
    const uc = Array.from({ length: SET_CAP }, (_, i) => i.toString(16).padStart(8, '0'))
    const rec = { ...emptyRecord(0), ext: { uc } }
    const c = extCounts(rec)
    assert.equal(c.contractsCapped, true)
  })

  it('tokensCapped is false when ut.length < SET_CAP', () => {
    const rec = { ...emptyRecord(0), ext: { ut: ['aabbccdd'] } }
    const c = extCounts(rec)
    assert.equal(c.tokensCapped, false)
  })
})

// ── Pinning tests (added after mutation check) ───────────────────────────────

describe('ext pinning', () => {
  it('SET_CAP is 64', () => {
    assert.equal(SET_CAP, 64)
  })

  it('merge of two full-and-different sets truncates to the 64 smallest', () => {
    const make = (start, count) =>
      Array.from({ length: count }, (_, i) => (start + i).toString(16).padStart(8, '0'))
    const aSet = make(0, 64)
    const bSet = make(100, 64)
    const m = mergeRecords(
      { ...emptyRecord(0), ext: { uc: aSet } },
      { ...emptyRecord(0), ext: { uc: bSet } },
    )
    assert.equal(m.ext.uc.length, 64)
    assert.deepEqual(m.ext.uc, aSet)
  })

  it('hour buckets add element-wise in merge (all four positions)', () => {
    const m = mergeRecords(
      { ...emptyRecord(0), ext: { h: [1, 2, 3, 4] } },
      { ...emptyRecord(0), ext: { h: [10, 20, 30, 40] } },
    )
    assert.deepEqual(m.ext.h, [11, 22, 33, 44])
  })

  it('receipt with contractAddress: null is not a deployment', () => {
    const map = walletDeltas([receipt({ from: A, contractAddress: null })], ctx)
    assert.equal(map.get(A.toLowerCase()).ext?.dp, undefined)
  })

  it('decodeRecord ignores an array in the 12th slot', () => {
    const arr = [...encodeRecord(emptyRecord(0)), [1, 2]]
    assert.equal('ext' in decodeRecord(arr), false)
  })

  it('the same token seen twice is stored once', () => {
    const logs = [erc20TransferLog(TOK1, A, B), erc20TransferLog(TOK1, A, B)]
    const map = walletDeltas([receipt({ from: A, to: C, logs })], ctx)
    assert.deepEqual(map.get(A.toLowerCase()).ext.ut, ['11111111'])
    assert.equal(map.get(A.toLowerCase()).ext.tt, 2)
  })
})
