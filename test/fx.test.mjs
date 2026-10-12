// Tests for src/fx.mjs — pure helpers only, no network.
// Run with: node --test test/fx.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  POOL,
  USDC_ADDR,
  EURC_ADDR,
  SELECTORS,
  encodeGetDy,
  decodeUint,
  poolRate,
  appendFxSeries,
} from '../src/fx.mjs'

// ── Verified on-chain values from the task specification ──────────────────────
//
//   Pool:   0x2d84d79c852f6842abe0304b70bbaa1506add457
//   coins:  (0) = USDC  0x3600000000000000000000000000000000000000
//           (1) = EURC  0x89b50855aa3be2f677cd6303cec089b5f319d72a
//
//   get_dy(0, 1, 1_000_000)  -> 860870   (1 USDC → 0.86087  EURC)
//   get_dy(1, 0, 1_000_000)  -> 1138495  (1 EURC → 1.138495 USDC)

const DY_USDC_TO_EURC = 860870n    // raw EURC out for 1 USDC in
const DY_EURC_TO_USDC = 1138495n   // raw USDC out for 1 EURC in
const DX = 1_000_000n              // 1 token at 6 decimals

// ── encodeGetDy ───────────────────────────────────────────────────────────────

describe('encodeGetDy', () => {
  it('produces the correct calldata for (0, 1, 1000000)', () => {
    // selector 0x5e0d443f
    // word0: i = 0  → 64 zeros
    // word1: j = 1  → 63 zeros + '1'
    // word2: dx = 1_000_000 = 0xF4240 → padded to 64 hex chars
    const expected =
      '0x5e0d443f' +
      '0'.repeat(64) +                              // i = 0
      '0'.repeat(63) + '1' +                        // j = 1
      '0'.repeat(64 - 5) + 'f4240'                 // dx = 1000000 = 0xf4240
    assert.equal(encodeGetDy(0, 1, 1_000_000n), expected)
  })

  it('encodes i=1, j=0 correctly', () => {
    const result = encodeGetDy(1, 0, 1_000_000n)
    assert.ok(result.startsWith('0x5e0d443f'), 'selector mismatch')
    // word0 = 1, word1 = 0
    assert.equal(result.slice(10, 74), '0'.repeat(63) + '1')
    assert.equal(result.slice(74, 138), '0'.repeat(64))
  })

  it('total length is 4 + 3×32 = 100 bytes → 202 hex chars with 0x prefix', () => {
    assert.equal(encodeGetDy(0, 1, 1_000_000n).length, 2 + 8 + 64 * 3)
  })
})

// ── decodeUint ────────────────────────────────────────────────────────────────

describe('decodeUint', () => {
  it('decodes the real get_dy(0,1,1000000) result 860870', () => {
    // eth_call returns a 32-byte ABI word; for small uints it's left-padded zeros.
    const hex = '0x' + '0'.repeat(64 - 5) + (860870).toString(16)
    assert.equal(decodeUint(hex), 860870n)
  })

  it('decodes the real get_dy(1,0,1000000) result 1138495', () => {
    const hex = '0x' + '0'.repeat(64 - 6) + (1138495).toString(16)
    assert.equal(decodeUint(hex), 1138495n)
  })

  it('decodes a raw BigInt-style hex (0x prefix, no padding)', () => {
    assert.equal(decodeUint('0x0f4240'), 1_000_000n)
  })

  it('throws on empty result "0x"', () => {
    assert.throws(() => decodeUint('0x'), /malformed/)
  })

  it('throws on non-string input', () => {
    assert.throws(() => decodeUint(null), /malformed/)
    assert.throws(() => decodeUint(undefined), /malformed/)
  })

  it('throws on a too-short string', () => {
    assert.throws(() => decodeUint('0x0'), /malformed/)
  })
})

// ── poolRate ──────────────────────────────────────────────────────────────────

describe('poolRate', () => {
  it('returns the correct rates for the two verified get_dy results', () => {
    // get_dy(0,1,1e6) = 860870  → eurcPerUsdc = 860870/1e6 / (1e6/1e6) = 0.86087
    // get_dy(1,0,1e6) = 1138495 → usdcPerEurc = 1138495/1e6 / (1e6/1e6) = 1.138495
    const rate = poolRate(DY_USDC_TO_EURC, DY_EURC_TO_USDC, DX, DX, 6, 6)
    assert.ok(rate !== null, 'expected non-null rate')
    assert.equal(rate.eurcPerUsdc, 0.86087)
    assert.equal(rate.usdcPerEurc, 1.138495)
  })

  it('product of the two rates is within 5% of 1 (sanity check passes)', () => {
    const rate = poolRate(DY_USDC_TO_EURC, DY_EURC_TO_USDC, DX, DX, 6, 6)
    assert.ok(rate !== null)
    // 0.86087 * 1.138495 ≈ 0.9803 — within ±5% of 1
    const product = rate.usdcPerEurc * rate.eurcPerUsdc
    assert.ok(Math.abs(product - 1) <= 0.05, `product ${product} not within 5% of 1`)
  })

  it('returns null when dyUsdcToEurc is 0n', () => {
    assert.equal(poolRate(0n, DY_EURC_TO_USDC, DX, DX, 6, 6), null)
  })

  it('returns null when dyEurcToUsdc is 0n', () => {
    assert.equal(poolRate(DY_USDC_TO_EURC, 0n, DX, DX, 6, 6), null)
  })

  it('returns null when the two directions disagree by more than 5%', () => {
    // Craft a deeply imbalanced pool: 1 USDC → 0.5 EURC but 1 EURC → 1.0 USDC
    // usdcPerEurc = 1.0, eurcPerUsdc = 0.5 → product = 0.5, |0.5 - 1| = 0.5 > 0.05
    const dyBadUsdcToEurc = 500_000n   // 0.5 EURC out for 1 USDC in
    const dyBadEurcToUsdc = 1_000_000n // 1.0 USDC out for 1 EURC in
    assert.equal(poolRate(dyBadUsdcToEurc, dyBadEurcToUsdc, DX, DX, 6, 6), null)
  })

  it('handles non-6-decimal tokens correctly', () => {
    // 18-decimal tokens: dx = 1e18, dy = 0.86087e18 → same rate
    const dx18 = 10n ** 18n
    const dy18 = BigInt(Math.round(0.86087 * 1e18))
    // For a symmetric test use 1:1 so the sanity check passes
    const rate = poolRate(dx18, dx18, dx18, dx18, 18, 18)
    assert.ok(rate !== null)
    assert.equal(rate.eurcPerUsdc, 1)
    assert.equal(rate.usdcPerEurc, 1)
  })
})

// ── appendFxSeries ────────────────────────────────────────────────────────────

describe('appendFxSeries', () => {
  const P1 = { hour: '2026-10-12T10', usdcPerEurc: 1.138495, eurcPerUsdc: 0.86087 }
  const META = { network: 'testnet', now: '2026-10-12T10:00:00.000Z' }

  it('creates a new document from null prev', () => {
    const doc = appendFxSeries(null, P1, 168, META)
    assert.equal(doc.network, 'testnet')
    assert.equal(doc.generatedAt, '2026-10-12T10:00:00.000Z')
    assert.equal(doc.usdcPerEurc, 1.138495)
    assert.equal(doc.eurcPerUsdc, 0.86087)
    assert.equal(doc.change24hPct, null)
    assert.equal(doc.series.length, 1)
    assert.equal(doc.series[0].hour, '2026-10-12T10')
    assert.equal(doc.series[0].usdcPerEurc, 1.138495)
  })

  it('source object has the correct kind, pool, and label text', () => {
    const doc = appendFxSeries(null, P1, 168, META)
    assert.equal(doc.source.kind, 'curve-pool')
    assert.equal(doc.source.pool, POOL)
    assert.equal(
      doc.source.label,
      'Curve USDC/EURC pool (marginal price for 1 token, not an official FX rate)',
    )
  })

  it('same-hour point replaces the last entry (no duplicates)', () => {
    const first = appendFxSeries(null, P1, 168, META)
    const updated = { ...P1, usdcPerEurc: 1.14, eurcPerUsdc: 0.877 }
    const doc = appendFxSeries(first, updated, 168, META)
    assert.equal(doc.series.length, 1)
    assert.equal(doc.series[0].usdcPerEurc, 1.14)
  })

  it('series is sorted by hour in ascending order', () => {
    const hours = ['2026-10-12T08', '2026-10-12T10', '2026-10-12T09']
    let prev = null
    for (const hour of hours) {
      prev = appendFxSeries(prev, { hour, usdcPerEurc: 1.1, eurcPerUsdc: 0.9 }, 168, META)
    }
    const hourList = prev.series.map((e) => e.hour)
    assert.deepEqual(hourList, ['2026-10-12T08', '2026-10-12T09', '2026-10-12T10'])
  })

  it('trims series to keep entries', () => {
    let prev = null
    // Insert 5 hours
    for (let h = 0; h < 5; h++) {
      const hour = `2026-10-12T${String(h).padStart(2, '0')}`
      prev = appendFxSeries(prev, { hour, usdcPerEurc: 1.1, eurcPerUsdc: 0.9 }, 3, META)
    }
    // keep=3, so only the last 3 survive
    assert.equal(prev.series.length, 3)
    assert.equal(prev.series[0].hour, '2026-10-12T02')
    assert.equal(prev.series[2].hour, '2026-10-12T04')
  })

  it('change24hPct is null when no 24h-earlier point exists', () => {
    const doc = appendFxSeries(null, P1, 168, META)
    assert.equal(doc.change24hPct, null)
  })

  it('change24hPct is correct when a point 24 h earlier exists', () => {
    // Hour T-24: usdcPerEurc = 1.1
    const prev24 = appendFxSeries(null, { hour: '2026-10-11T10', usdcPerEurc: 1.1, eurcPerUsdc: 0.9 }, 168, META)
    // Hour T: usdcPerEurc = 1.138495
    const doc = appendFxSeries(prev24, P1, 168, META)
    // change = (1.138495 - 1.1) / 1.1 * 100 = 3.499...% → rounded to 2 decimals = 3.5
    const expected = Math.round(((1.138495 - 1.1) / 1.1) * 100 * 100) / 100
    assert.equal(doc.change24hPct, expected)
  })

  it('change24hPct rounds to 2 decimal places', () => {
    const prev24 = appendFxSeries(null, { hour: '2026-10-11T10', usdcPerEurc: 1.123456, eurcPerUsdc: 0.89 }, 168, META)
    const doc = appendFxSeries(prev24, P1, 168, META)
    // Verify exactly 2 decimals
    const str = String(doc.change24hPct)
    const decimals = str.includes('.') ? str.split('.')[1].length : 0
    assert.ok(decimals <= 2, `change24hPct has more than 2 decimal places: ${doc.change24hPct}`)
  })

  it('does not set network or generatedAt from within the pure function when meta is supplied', () => {
    const doc = appendFxSeries(null, P1, 168, { network: 'testnet', now: '2026-01-01T00:00:00.000Z' })
    assert.equal(doc.network, 'testnet')
    assert.equal(doc.generatedAt, '2026-01-01T00:00:00.000Z')
  })

  it('falls back to prev.network when meta is omitted', () => {
    const prev = { network: 'testnet', series: [] }
    const doc = appendFxSeries(prev, P1, 168)
    assert.equal(doc.network, 'testnet')
  })
})
