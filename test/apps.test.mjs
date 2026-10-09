import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// node:assert has no closeTo — use a small helper
function assertNear(actual, expected, delta, msg) {
  assert.ok(Math.abs(actual - expected) <= delta, `${msg ?? ''}: expected ${actual} ≈ ${expected} (±${delta})`)
}
import { accumulateApps, compactApps } from '../src/apps.mjs'

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO_PAD = (addr) => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase()
const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// ── Fixture addresses ──────────────────────────────────────────────────────
const TOKEN_A   = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'  // usd token anchor
const TOKEN_B   = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'  // non-usd token anchor (same app)
const CONTRACT_C = '0xcccccccccccccccccccccccccccccccccccccccc' // contract anchor (separate app)
const SENDER_1  = '0x1111111111111111111111111111111111111111'
const SENDER_2  = '0x2222222222222222222222222222222222222222'

const APPS_CONFIG = {
  apps: [
    {
      id: 'app-multi',
      anchors: [
        { address: TOKEN_A, kind: 'token', usd: true },
        { address: TOKEN_B, kind: 'token' },
      ],
    },
    {
      id: 'app-contract',
      anchors: [
        { address: CONTRACT_C, kind: 'contract' },
      ],
    },
  ],
}

const DECIMALS = {
  [TOKEN_A.toLowerCase()]: 6,
}

// Helper: build a minimal hourBucket as emptyHour() does.
function emptyHour() {
  return { blocks: 0, txs: 0, failed: 0, gas: 0, fees: 0, senders: {}, contracts: {} }
}

// Helper: build a Transfer log with 3 topics (ERC-20).
function transferLog(tokenAddr, from, to, amountHex) {
  return {
    address: tokenAddr,
    topics: [TRANSFER, ZERO_PAD(from), ZERO_PAD(to)],
    data: amountHex,
  }
}

// Helper: build an NFT Transfer log with 4 topics (must be ignored).
function nftTransferLog(tokenAddr, from, to, tokenId) {
  return {
    address: tokenAddr,
    topics: [TRANSFER, ZERO_PAD(from), ZERO_PAD(to), ZERO_PAD(tokenId)],
    data: '0x',
  }
}

// Helper: build a minimal receipt.
function receipt({ to = null, from = SENDER_1, gasUsed = '0x5208', effectiveGasPrice = '0x4a817c800', logs = [] } = {}) {
  return { to, from, gasUsed, effectiveGasPrice, logs, status: '0x1' }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('token anchor — ERC-20 Transfer with 3 topics', () => {
  it('counts tx and both wallets, computes usd volume', () => {
    const h = emptyHour()
    const amount = BigInt(10_000_000) // 10 USDC at 6 decimals
    const amountHex = '0x' + amount.toString(16).padStart(64, '0')

    const r = receipt({
      logs: [transferLog(TOKEN_A, SENDER_1, SENDER_2, amountHex)],
    })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)

    assert.equal(h.apps['app-multi'].tx, 1, 'tx should be 1')
    assert.equal(h.apps['app-multi'].wallets.size, 2, 'both sender and receiver should be counted')
    assert.ok(h.apps['app-multi'].wallets.has(SENDER_1), 'from wallet included')
    assert.ok(h.apps['app-multi'].wallets.has(SENDER_2), 'to wallet included')
    assertNear(h.apps['app-multi'].vol, 10, 0.0001, 'volume should be 10 USDC')
  })
})

describe('token anchor — NFT Transfer with 4 topics must be ignored', () => {
  it('does not count the NFT transfer', () => {
    const h = emptyHour()
    const r = receipt({
      logs: [nftTransferLog(TOKEN_A, SENDER_1, SENDER_2, '0x' + '1'.padStart(40, '0'))],
    })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)
    // app-multi should not exist or have zero tx
    assert.ok(!h.apps?.['app-multi'] || h.apps['app-multi'].tx === 0, 'NFT transfer must not be counted')
  })
})

describe('contract anchor', () => {
  it('counts tx, fee, sender wallet; vol stays 0', () => {
    const h = emptyHour()
    // gasUsed = 21000 (0x5208), effectiveGasPrice = 20 Gwei (0x4a817c800)
    // fee = 21000 * 20e9 / 1e18 = 0.00042 USDC
    const r = receipt({ to: CONTRACT_C, from: SENDER_1 })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)

    const a = h.apps['app-contract']
    assert.ok(a, 'app-contract should be present')
    assert.equal(a.tx, 1)
    assert.equal(a.wallets.size, 1)
    assert.ok(a.wallets.has(SENDER_1))
    assertNear(a.fee, 0.00042, 1e-8)
    assert.equal(a.vol, 0, 'contract anchor vol is always 0')
  })

  it('excludes the anchor address itself from wallets', () => {
    const h = emptyHour()
    const r = receipt({ to: CONTRACT_C, from: CONTRACT_C })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)
    assert.equal(h.apps['app-contract'].wallets.size, 0, 'self-send should not count as a wallet')
  })
})

describe('usd token — zero-address mint must not count as a wallet', () => {
  it('skips zero address in from position', () => {
    const h = emptyHour()
    const amountHex = '0x' + BigInt(5_000_000).toString(16).padStart(64, '0')
    const r = receipt({
      logs: [transferLog(TOKEN_A, ZERO_ADDR, SENDER_2, amountHex)],
    })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)
    const a = h.apps['app-multi']
    assert.ok(!a.wallets.has(ZERO_ADDR), 'zero address must not be a wallet')
    assert.equal(a.wallets.size, 1, 'only the receiver counts')
    assert.ok(a.wallets.has(SENDER_2))
  })
})

describe('two anchors on one app — wallets are the union', () => {
  it('union of token_a and token_b wallets', () => {
    const h = emptyHour()
    const amountHex = '0x' + BigInt(1_000_000).toString(16).padStart(64, '0')
    // SENDER_1 sends via TOKEN_A; SENDER_2 sends via TOKEN_B
    const receipts = [
      receipt({ logs: [transferLog(TOKEN_A, SENDER_1, SENDER_2, amountHex)] }),
      receipt({ logs: [transferLog(TOKEN_B, SENDER_2, SENDER_1, '0x0')] }),
    ]
    accumulateApps(h, receipts, APPS_CONFIG, DECIMALS)
    const a = h.apps['app-multi']
    assert.equal(a.tx, 2, 'two transfer events = two txs')
    // Wallets: SENDER_1 and SENDER_2 both appear across both logs
    assert.equal(a.wallets.size, 2, 'union should have 2 distinct wallets')
  })
})

describe('compactApps — converts Sets to counts, rounds floats', () => {
  it('replaces wallet Sets with counts', () => {
    const h = emptyHour()
    const amountHex = '0x' + BigInt(1_500_000).toString(16).padStart(64, '0')
    const r = receipt({ logs: [transferLog(TOKEN_A, SENDER_1, SENDER_2, amountHex)] })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)
    compactApps(h)
    const a = h.apps['app-multi']
    assert.equal(typeof a.wallets, 'number', 'wallets should be a number after compact')
    assert.equal(a.wallets, 2)
    assert.equal(typeof a.vol, 'number')
    assertNear(a.vol, 1.5, 0.0001)
  })

  it('is safe on hours with no apps field (legacy hours)', () => {
    const h = emptyHour()
    assert.doesNotThrow(() => compactApps(h))
    assert.ok(!h.apps)
  })
})

describe('usd volume skipped when decimals unknown', () => {
  it('vol stays 0 when decimals not in cache', () => {
    const h = emptyHour()
    const amountHex = '0x' + BigInt(1_000_000).toString(16).padStart(64, '0')
    const r = receipt({ logs: [transferLog(TOKEN_A, SENDER_1, SENDER_2, amountHex)] })
    // Pass empty decimals map — TOKEN_A not present
    accumulateApps(h, [r], APPS_CONFIG, {})
    assert.equal(h.apps['app-multi'].vol, 0, 'vol must be 0 when decimals unknown')
    // tx and wallets still count
    assert.equal(h.apps['app-multi'].tx, 1)
  })
})

describe('non-usd token anchor — vol always 0', () => {
  it('TOKEN_B (no usd flag) never accumulates volume', () => {
    const h = emptyHour()
    const amountHex = '0x' + BigInt(999_000_000).toString(16).padStart(64, '0')
    const r = receipt({ logs: [transferLog(TOKEN_B, SENDER_1, SENDER_2, amountHex)] })
    accumulateApps(h, [r], APPS_CONFIG, DECIMALS)
    assert.equal(h.apps['app-multi'].vol, 0)
  })
})

describe('empty or missing appsConfig — no-op', () => {
  it('does nothing when apps array is empty', () => {
    const h = emptyHour()
    const r = receipt({ to: CONTRACT_C })
    accumulateApps(h, [r], { apps: [] }, DECIMALS)
    assert.ok(!h.apps, 'no apps field should be created')
  })

  it('does nothing when appsConfig is null', () => {
    const h = emptyHour()
    const r = receipt({ to: CONTRACT_C })
    accumulateApps(h, [r], null, DECIMALS)
    assert.ok(!h.apps)
  })
})
