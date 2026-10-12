// Tests for src/balances.mjs — pure helpers only, no network.
// Run with: node --test test/balances.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXCLUDE_APPS,
  holderAddresses,
  encodeBalanceOf,
  rawToNumber,
  buildBalances,
} from '../src/balances.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Load real apps files once ─────────────────────────────────────────────────

const testnetConfig  = JSON.parse(await readFile(join(ROOT, 'apps.testnet.json'),  'utf8'))
const mainnetConfig  = JSON.parse(await readFile(join(ROOT, 'apps.mainnet.json'),  'utf8'))

// ── EXCLUDE_APPS ──────────────────────────────────────────────────────────────

describe('EXCLUDE_APPS', () => {
  it('is a Set containing the six token app ids', () => {
    assert.ok(EXCLUDE_APPS instanceof Set)
    for (const id of ['usdc', 'eurc', 'usyc', 'cirbtc', 'weth', 'wusdc']) {
      assert.ok(EXCLUDE_APPS.has(id), `expected EXCLUDE_APPS to contain '${id}'`)
    }
  })

  it('has exactly 6 entries', () => {
    assert.equal(EXCLUDE_APPS.size, 6)
  })
})

// ── holderAddresses — real apps.testnet.json ──────────────────────────────────

describe('holderAddresses(testnet)', () => {
  const holders = holderAddresses(testnetConfig)

  it('returns at least 5 apps', () => {
    assert.ok(holders.length >= 5, `got only ${holders.length} apps`)
  })

  it('excluded ids are absent', () => {
    const ids = holders.map((h) => h.id)
    for (const excluded of EXCLUDE_APPS) {
      assert.ok(!ids.includes(excluded), `excluded id '${excluded}' should not appear`)
    }
  })

  it('all addresses are lowercase', () => {
    for (const { id, addresses } of holders) {
      for (const addr of addresses) {
        assert.equal(addr, addr.toLowerCase(), `app '${id}': address '${addr}' is not lowercase`)
      }
    }
  })

  it('no duplicate addresses within a single app', () => {
    for (const { id, addresses } of holders) {
      const set = new Set(addresses)
      assert.equal(set.size, addresses.length, `app '${id}' has duplicate addresses`)
    }
  })

  it('preserves config order (stablefx appears before memo)', () => {
    const ids = holders.map((h) => h.id)
    const iStablefx = ids.indexOf('stablefx')
    const iMemo     = ids.indexOf('memo')
    assert.ok(iStablefx !== -1, 'stablefx not found')
    assert.ok(iMemo !== -1,     'memo not found')
    assert.ok(iStablefx < iMemo, `stablefx (${iStablefx}) should come before memo (${iMemo})`)
  })

  it('each app has at least one address', () => {
    for (const { id, addresses } of holders) {
      assert.ok(addresses.length > 0, `app '${id}' has no addresses`)
    }
  })
})

// ── holderAddresses — real apps.mainnet.json ──────────────────────────────────

describe('holderAddresses(mainnet)', () => {
  const holders = holderAddresses(mainnetConfig)

  it('returns at least 5 apps', () => {
    assert.ok(holders.length >= 5, `got only ${holders.length} apps`)
  })

  it('excluded ids are absent', () => {
    const ids = holders.map((h) => h.id)
    for (const excluded of EXCLUDE_APPS) {
      assert.ok(!ids.includes(excluded), `excluded id '${excluded}' should not appear`)
    }
  })

  it('all addresses are lowercase', () => {
    for (const { id, addresses } of holders) {
      for (const addr of addresses) {
        assert.equal(addr, addr.toLowerCase(), `app '${id}': address '${addr}' is not lowercase`)
      }
    }
  })

  it('no duplicate addresses within a single app', () => {
    for (const { id, addresses } of holders) {
      const set = new Set(addresses)
      assert.equal(set.size, addresses.length, `app '${id}' has duplicate addresses`)
    }
  })
})

// ── holderAddresses — repeated address in a hand-made config ─────────────────

describe('holderAddresses(synthetic — repeated address)', () => {
  const addr1 = '0x1111111111111111111111111111111111111111'
  const addr2 = '0x2222222222222222222222222222222222222222'
  const ADDR1_UC = '0x1111111111111111111111111111111111111111'  // already lc

  const config = {
    apps: [
      // excluded
      { id: 'usdc', anchors: [{ address: addr1, kind: 'token' }] },
      // first holder with a duplicate anchor (same address twice)
      { id: 'app-a', anchors: [
        { address: ADDR1_UC, kind: 'contract' },
        { address: addr1,    kind: 'contract' },   // same after lowercase
        { address: addr2,    kind: 'contract' },
      ]},
      // second holder reuses addr1 — that's fine (cross-app NOT deduped)
      { id: 'app-b', anchors: [{ address: addr1, kind: 'contract' }] },
      // excluded
      { id: 'wusdc', anchors: [{ address: addr2, kind: 'token' }] },
    ],
  }

  const holders = holderAddresses(config)

  it('returns exactly 2 apps (usdc and wusdc excluded)', () => {
    assert.equal(holders.length, 2)
    assert.equal(holders[0].id, 'app-a')
    assert.equal(holders[1].id, 'app-b')
  })

  it('app-a deduplicates the repeated address (should have 2, not 3)', () => {
    const appA = holders.find((h) => h.id === 'app-a')
    assert.equal(appA.addresses.length, 2)
    assert.ok(appA.addresses.includes(addr1))
    assert.ok(appA.addresses.includes(addr2))
  })

  it('app-b still has addr1 (cross-app dedup does NOT happen)', () => {
    const appB = holders.find((h) => h.id === 'app-b')
    assert.equal(appB.addresses.length, 1)
    assert.equal(appB.addresses[0], addr1)
  })

  it('addresses are lowercase', () => {
    for (const { addresses } of holders) {
      for (const addr of addresses) {
        assert.equal(addr, addr.toLowerCase())
      }
    }
  })
})

// ── encodeBalanceOf ───────────────────────────────────────────────────────────

describe('encodeBalanceOf', () => {
  it('produces the exact calldata for the USDC token address', () => {
    // balanceOf(0x3600000000000000000000000000000000000000)
    // selector: 0x70a08231
    // address padded to 32 bytes: 000...000 3600000000000000000000000000000000000000
    const addr = '0x3600000000000000000000000000000000000000'
    const expected =
      '0x70a08231' +
      '000000000000000000000000' +          // 12 zero bytes = 24 hex chars
      '3600000000000000000000000000000000000000'
    assert.equal(encodeBalanceOf(addr), expected)
  })

  it('handles a mixed-case address, outputting lowercase', () => {
    const mixed = '0xAbCd000000000000000000000000000000001234'
    const result = encodeBalanceOf(mixed)
    assert.ok(result.startsWith('0x70a08231'))
    assert.ok(result.endsWith('000000000000000000000000abcd000000000000000000000000000000001234'))
  })

  it('total length is 4 + 32 = 36 bytes → 74 chars with 0x prefix', () => {
    assert.equal(encodeBalanceOf('0x3600000000000000000000000000000000000000').length, 74)
  })

  it('throws on an address without 0x prefix', () => {
    assert.throws(
      () => encodeBalanceOf('3600000000000000000000000000000000000000'),
      /invalid address/,
    )
  })

  it('throws on an address that is too short', () => {
    assert.throws(
      () => encodeBalanceOf('0x360000000000000000000000000000000000000'),  // 39 hex chars
      /invalid address/,
    )
  })

  it('throws on an address that is too long', () => {
    assert.throws(
      () => encodeBalanceOf('0x36000000000000000000000000000000000000000'),  // 41 hex chars
      /invalid address/,
    )
  })

  it('throws on a non-hex address', () => {
    assert.throws(
      () => encodeBalanceOf('0x3600000000000000000000000000000000zzzzzz'),
      /invalid address/,
    )
  })

  it('throws on null', () => {
    assert.throws(() => encodeBalanceOf(null), /invalid address/)
  })
})

// ── rawToNumber ───────────────────────────────────────────────────────────────

describe('rawToNumber', () => {
  it('returns 0 for 0n at 6 decimals', () => {
    assert.equal(rawToNumber(0n, 6), 0)
  })

  it('returns 0.000001 rounded to 0 for 1n at 6 decimals', () => {
    // 1 / 1_000_000 = 0.000001 → rounds to 0.00
    assert.equal(rawToNumber(1n, 6), 0)
  })

  it('returns 123.46 for 123456789n at 6 decimals', () => {
    // 123456789 / 1000000 = 123.456789 → rounds to 123.46
    assert.equal(rawToNumber(123456789n, 6), 123.46)
  })

  it('handles a value above 2^53 exactly via bigint division', () => {
    // 10_000_001_000_000n / 1_000_000 = 10_000_001.0 → 10000001
    const raw = 10_000_001_000_000n
    assert.equal(rawToNumber(raw, 6), 10000001)
  })

  it('returns 1 for 1_000_000n at 6 decimals', () => {
    assert.equal(rawToNumber(1_000_000n, 6), 1)
  })

  it('returns 0.5 for 500_000n at 6 decimals', () => {
    assert.equal(rawToNumber(500_000n, 6), 0.5)
  })

  it('rounds to exactly 2 decimal places', () => {
    // 999_999n / 1_000_000 = 0.999999 → rounds to 1.00
    assert.equal(rawToNumber(999_999n, 6), 1)
    // 499_994n → 0.499994 → rounds to 0.50
    assert.equal(rawToNumber(499_994n, 6), 0.5)
    // 499_999n → 0.499999 → rounds to 0.50
    assert.equal(rawToNumber(499_999n, 6), 0.5)
  })
})

// ── buildBalances ─────────────────────────────────────────────────────────────

describe('buildBalances', () => {
  const META = { network: 'testnet', now: '2026-10-12T10:00:00.000Z' }
  const HOUR = '2026-10-12T10'

  const READING = {
    hour: HOUR,
    perApp: {
      gateway:  1000.5,
      cctp:     500.25,
      stablefx: 0,
      memo:     250.75,
    },
  }

  it('creates a document with correct shape from null prev', () => {
    const doc = buildBalances(null, READING, META)
    assert.equal(doc.network,     'testnet')
    assert.equal(doc.generatedAt, '2026-10-12T10:00:00.000Z')
    assert.equal(doc.token,       'USDC')
    assert.ok(typeof doc.total === 'number')
    assert.ok(typeof doc.apps   === 'object')
    assert.ok(Array.isArray(doc.series))
  })

  it('total = sum of perApp values rounded to 2 decimals', () => {
    const doc = buildBalances(null, READING, META)
    // 1000.5 + 500.25 + 0 + 250.75 = 1751.5
    assert.equal(doc.total, 1751.5)
  })

  it('apps are sorted by usdc descending then id ascending', () => {
    const doc = buildBalances(null, READING, META)
    const ids = Object.keys(doc.apps)
    // Expected order: gateway(1000.5) > cctp(500.25) > memo(250.75) > stablefx(0)
    assert.deepEqual(ids, ['gateway', 'cctp', 'memo', 'stablefx'])
  })

  it('apps with usdc = 0 are kept', () => {
    const doc = buildBalances(null, READING, META)
    assert.ok('stablefx' in doc.apps, 'app with 0 balance should be kept')
    assert.equal(doc.apps.stablefx.usdc, 0)
  })

  it('each app entry has a usdc key', () => {
    const doc = buildBalances(null, READING, META)
    for (const [id, entry] of Object.entries(doc.apps)) {
      assert.ok('usdc' in entry, `app '${id}' missing usdc key`)
    }
  })

  it('series has one entry on first run', () => {
    const doc = buildBalances(null, READING, META)
    assert.equal(doc.series.length, 1)
    assert.equal(doc.series[0].hour, HOUR)
    assert.equal(doc.series[0].total, doc.total)
  })

  it('same-hour reading replaces the existing series entry', () => {
    const first = buildBalances(null, READING, META)
    const updated = buildBalances(first, { hour: HOUR, perApp: { app: 999 } }, META)
    assert.equal(updated.series.length, 1)
    assert.equal(updated.series[0].total, 999)
  })

  it('series is sorted by hour ascending', () => {
    const hours = ['2026-10-12T08', '2026-10-12T10', '2026-10-12T09']
    let prev = null
    for (const h of hours) {
      prev = buildBalances(prev, { hour: h, perApp: { app: 1 } }, META)
    }
    const hourList = prev.series.map((e) => e.hour)
    assert.deepEqual(hourList, ['2026-10-12T08', '2026-10-12T09', '2026-10-12T10'])
  })

  it('series is trimmed to `keep` most-recent entries', () => {
    let prev = null
    for (let h = 0; h < 5; h++) {
      const hour = `2026-10-12T${String(h).padStart(2, '0')}`
      prev = buildBalances(prev, { hour, perApp: { app: h } }, META, 3)
    }
    // keep=3; should retain hours T02, T03, T04
    assert.equal(prev.series.length, 3)
    assert.equal(prev.series[0].hour, '2026-10-12T02')
    assert.equal(prev.series[2].hour, '2026-10-12T04')
  })

  it('default keep=168 is used when not supplied', () => {
    let prev = null
    for (let h = 0; h < 168; h++) {
      const d = Math.floor(h / 24)
      const hr = h % 24
      const hour = `2026-10-${String(d + 1).padStart(2, '0')}T${String(hr).padStart(2, '0')}`
      prev = buildBalances(prev, { hour, perApp: { app: 1 } }, META)
    }
    assert.equal(prev.series.length, 168)
    // Adding one more should trim to 168
    const extra = buildBalances(prev, { hour: '2026-11-07T00', perApp: { app: 1 } }, META)
    assert.equal(extra.series.length, 168)
  })

  it('total is 2 decimal places (no longer floating-point noise)', () => {
    const reading = {
      hour: HOUR,
      perApp: { a: 0.1, b: 0.2 },  // 0.1 + 0.2 = 0.30000000000000004 in raw float
    }
    const doc = buildBalances(null, reading, META)
    assert.equal(doc.total, 0.3)
  })

  it('apps with equal usdc are sorted by id ascending', () => {
    const reading = {
      hour: HOUR,
      perApp: { zebra: 100, alpha: 100, middle: 100 },
    }
    const doc = buildBalances(null, reading, META)
    const ids = Object.keys(doc.apps)
    assert.deepEqual(ids, ['alpha', 'middle', 'zebra'])
  })
})
