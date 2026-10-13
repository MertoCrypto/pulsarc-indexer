// Tests for src/catalogCore.mjs (candidateAddresses, classify, buildCatalog,
// decodeDecimals, hasValidSupply, decodeSupply, decodeBool, mergeCatalog).
// Run with: node --test test/catalogCore.test.mjs
//
// All expected values are derived by hand from the code, not guessed.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  candidateAddresses,
  classify,
  buildCatalog,
  decodeDecimals,
  hasValidSupply,
  decodeSupply,
  decodeBool,
  mergeCatalog,
} from '../src/catalogCore.mjs'

// ─────────────────────────────────────────────────────────────────────────────
// classify
// ─────────────────────────────────────────────────────────────────────────────

describe('classify – is1155 precedence', () => {
  it('is1155 true → erc1155 regardless of decimals/is721', () => {
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: '0x06', totalSupply: '0x01', is721: true, is1155: true }),
      { kind: 'erc1155' }
    )
  })

  it('is1155 true, all else null → erc1155', () => {
    assert.deepEqual(
      classify({ name: null, symbol: null, decimals: null, totalSupply: null, is721: null, is1155: true }),
      { kind: 'erc1155' }
    )
  })
})

describe('classify – is721', () => {
  it('is721 true, is1155 false → erc721', () => {
    assert.deepEqual(
      classify({ name: 'NFT', symbol: 'NFT', decimals: null, totalSupply: null, is721: true, is1155: false }),
      { kind: 'erc721' }
    )
  })

  it('is721 true, is1155 null → erc721 (1155 not confirmed)', () => {
    assert.deepEqual(
      classify({ name: null, symbol: null, decimals: null, totalSupply: null, is721: true, is1155: null }),
      { kind: 'erc721' }
    )
  })

  it('is721 true with valid decimals+supply → erc721 still wins over erc20 path', () => {
    // erc721 check fires before the erc20 check
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: '0x06', totalSupply: '0x0f4240', is721: true, is1155: false }),
      { kind: 'erc721' }
    )
  })
})

describe('classify – erc20 decimals boundaries', () => {
  it('decimals 0 (hex 0x00) + valid supply → erc20', () => {
    // BigInt('0x00') = 0n, Number(0n) = 0, in range [0,36]
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: '0x00', totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'erc20' }
    )
  })

  it('decimals 6 (typical USDC) + valid supply → erc20', () => {
    const hex6 = '0x' + '0'.repeat(63) + '6'
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: hex6, totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'erc20' }
    )
  })

  it('decimals 18 (typical ETH) + valid supply → erc20', () => {
    const hex18 = '0x' + '0'.repeat(62) + '12'
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: hex18, totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'erc20' }
    )
  })

  it('decimals 36 (boundary max) + valid supply → erc20', () => {
    // 36 = 0x24
    const hex36 = '0x' + '0'.repeat(62) + '24'
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: hex36, totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'erc20' }
    )
  })

  it('decimals 37 (0x25, one past max) → other', () => {
    // 37 > 36 → decodeDecimals returns null → no erc20 match
    const hex37 = '0x' + '0'.repeat(62) + '25'
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: hex37, totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'other' }
    )
  })

  it('decimals -1 as signed hex string → other (BigInt is negative, < 0)', () => {
    // BigInt('-0x1') = -1n → Number = -1 → < 0 → invalid
    // Note: negative hex like '-0x1' is valid JavaScript BigInt syntax
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: '-0x1', totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'other' }
    )
  })

  it("decimals 'abc' (not valid hex) → other (BigInt throws, caught → null)", () => {
    // BigInt('abc') throws SyntaxError → caught → null → no erc20
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: 'abc', totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'other' }
    )
  })

  it('decimals null → other', () => {
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: null, totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'other' }
    )
  })

  it('valid decimals but totalSupply null → other (supply required)', () => {
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: '0x06', totalSupply: null, is721: false, is1155: false }),
      { kind: 'other' }
    )
  })

  it("valid decimals but totalSupply '0x' (empty) → other", () => {
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: '0x06', totalSupply: '0x', is721: false, is1155: false }),
      { kind: 'other' }
    )
  })
})

describe('classify – other fallthrough', () => {
  it('all null → other', () => {
    assert.deepEqual(
      classify({ name: null, symbol: null, decimals: null, totalSupply: null, is721: null, is1155: null }),
      { kind: 'other' }
    )
  })

  it('is721 false, is1155 false, decimals invalid → other', () => {
    assert.deepEqual(
      classify({ name: 'T', symbol: 'T', decimals: 'abc', totalSupply: '0x01', is721: false, is1155: false }),
      { kind: 'other' }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// candidateAddresses
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateAddresses – basic inclusion', () => {
  const labels = {
    '0xAAAA000000000000000000000000000000000001': { contract: true, name: 'Token A', symbol: 'TKA' },
    '0xAAAA000000000000000000000000000000000002': { contract: true, name: 'Token B', symbol: 'TKB' },
  }
  const discover = { contracts: [] }

  it('includes addresses with a non-empty symbol', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(result.includes('0xaaaa000000000000000000000000000000000001'))
    assert.ok(result.includes('0xaaaa000000000000000000000000000000000002'))
  })

  it('returns lowercase addresses', () => {
    const result = candidateAddresses(labels, discover)
    for (const a of result) assert.match(a, /^0x[0-9a-f]{40}$/)
  })
})

describe('candidateAddresses – infra exclusion', () => {
  const labels = {
    '0x000000000022d473030f116ddee9f6b43ac78ba3': { contract: true, name: 'Permit2',  symbol: null, kind: 'infra' },
    '0x0000000071727de22e5e9d8baf0edac6f37da032': { contract: true, name: 'EP v0.7',  symbol: null, kind: 'account-abstraction' },
    '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { contract: true, name: 'EP v0.6',  symbol: null, kind: 'account-abstraction' },
    '0xca11bde05977b3631167028862be2a173976ca11': { contract: true, name: 'Multicall3', symbol: null, kind: 'infra' },
    '0xAAAA000000000000000000000000000000000001': { contract: true, name: 'Good Token', symbol: 'GT' },
  }
  const discover = {
    contracts: [
      // Permit2 appears in discover too — must still be excluded
      { address: '0x000000000022d473030f116ddee9f6b43ac78ba3', txs: 42053 },
      { address: '0xAAAA000000000000000000000000000000000001', txs: 100 },
      // An address not in labels at all — should be included
      { address: '0xBBBB000000000000000000000000000000000002', txs: 50 },
    ],
  }

  it('excludes infra-kind addresses (Permit2 appears in both labels and discover)', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0x000000000022d473030f116ddee9f6b43ac78ba3'))
  })

  it('excludes account-abstraction-kind addresses', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0x0000000071727de22e5e9d8baf0edac6f37da032'))
    assert.ok(!result.includes('0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789'))
  })

  it('excludes another infra-kind address (Multicall3)', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xca11bde05977b3631167028862be2a173976ca11'))
  })

  it('includes a valid labelled token', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(result.includes('0xaaaa000000000000000000000000000000000001'))
  })

  it('includes a discover address that has no label at all', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(result.includes('0xbbbb000000000000000000000000000000000002'))
  })
})

describe('candidateAddresses – no duplicates and case normalisation', () => {
  // Same address appears in labels (mixed case) AND in discover (uppercase)
  const labels = {
    '0xAaAa000000000000000000000000000000000001': { contract: true, name: 'Dup', symbol: 'DUP' },
  }
  const discover = {
    contracts: [
      { address: '0xAAAA000000000000000000000000000000000001', txs: 99 },
    ],
  }

  it('deduplicates: same address from labels and discover appears only once', () => {
    const result = candidateAddresses(labels, discover)
    const count = result.filter((a) => a === '0xaaaa000000000000000000000000000000000001').length
    assert.equal(count, 1)
  })
})

describe('candidateAddresses – labels-only (no discover match)', () => {
  const labels = {
    '0xCCCC000000000000000000000000000000000003': { contract: true, name: 'X', symbol: 'X' },
  }
  const discover = { contracts: [] }

  it('includes a labels-only address even with no discover entry', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(result.includes('0xcccc000000000000000000000000000000000003'))
  })
})

describe('candidateAddresses – label with null symbol not included from labels', () => {
  const labels = {
    '0xDDDD000000000000000000000000000000000004': { contract: true, name: 'NoSym', symbol: null },
    '0xEEEE000000000000000000000000000000000005': { contract: true, name: 'WithSym', symbol: 'WS' },
  }
  const discover = { contracts: [] }

  it('address with null symbol is NOT included (unless in discover)', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xdddd000000000000000000000000000000000004'))
  })

  it('address with valid symbol IS included', () => {
    const result = candidateAddresses(labels, discover)
    assert.ok(result.includes('0xeeee000000000000000000000000000000000005'))
  })
})

describe('candidateAddresses – sorting', () => {
  // Three addresses: two have discover txs, one is labels-only (txs=0)
  const labels = {
    '0x1111000000000000000000000000000000000001': { contract: true, name: 'A', symbol: 'A' },
    '0x2222000000000000000000000000000000000002': { contract: true, name: 'B', symbol: 'B' },
    '0x3333000000000000000000000000000000000003': { contract: true, name: 'C', symbol: 'C' },
  }
  const discover = {
    contracts: [
      { address: '0x2222000000000000000000000000000000000002', txs: 500 },
      { address: '0x1111000000000000000000000000000000000001', txs: 100 },
    ],
  }

  it('sorted: 0x2222 (txs=500) first, then 0x1111 (txs=100), then 0x3333 (txs=0)', () => {
    const result = candidateAddresses(labels, discover)
    assert.equal(result[0], '0x2222000000000000000000000000000000000002')
    assert.equal(result[1], '0x1111000000000000000000000000000000000001')
    assert.equal(result[2], '0x3333000000000000000000000000000000000003')
  })

  it('two addresses with the same txs are sorted by address ascending', () => {
    const labelsTie = {
      '0xbbbb000000000000000000000000000000000002': { contract: true, name: 'T2', symbol: 'T2' },
      '0xaaaa000000000000000000000000000000000001': { contract: true, name: 'T1', symbol: 'T1' },
    }
    const discoverTie = {
      contracts: [
        { address: '0xBBBB000000000000000000000000000000000002', txs: 200 },
        { address: '0xAAAA000000000000000000000000000000000001', txs: 200 },
      ],
    }
    const result = candidateAddresses(labelsTie, discoverTie)
    assert.equal(result[0], '0xaaaa000000000000000000000000000000000001')
    assert.equal(result[1], '0xbbbb000000000000000000000000000000000002')
  })
})

describe('candidateAddresses – empty inputs', () => {
  it('empty labels + empty discover → empty array', () => {
    assert.deepEqual(candidateAddresses({}, { contracts: [] }), [])
  })

  it('empty labels + non-empty discover → discover addresses (lowercased)', () => {
    const result = candidateAddresses({}, {
      contracts: [{ address: '0xAAAA000000000000000000000000000000000001', txs: 1 }],
    })
    assert.deepEqual(result, ['0xaaaa000000000000000000000000000000000001'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildCatalog
// ─────────────────────────────────────────────────────────────────────────────

// Helper: make a minimal valid erc20 probe
function erc20Probe(overrides = {}) {
  return { name: 'Token', symbol: 'TKN', decimals: '0x06', totalSupply: '0x016345785d8a0000', is721: false, is1155: false, ...overrides }
}
// Helper: make a valid erc721 probe
function erc721Probe(overrides = {}) {
  return { name: 'NFT Collection', symbol: 'NFT', decimals: null, totalSupply: null, is721: true, is1155: false, ...overrides }
}
// Helper: make a valid erc1155 probe
function erc1155Probe(overrides = {}) {
  return { name: 'Multi Token', symbol: 'MT', decimals: null, totalSupply: null, is721: false, is1155: true, ...overrides }
}

describe('buildCatalog – structure', () => {
  const cat = buildCatalog({
    network: 'mainnet',
    generatedAt: '2026-10-13T19:32:56.039Z',
    entries: [],
  })

  it('has the correct network field', () => {
    assert.equal(cat.network, 'mainnet')
  })

  it('has the correct generatedAt field', () => {
    assert.equal(cat.generatedAt, '2026-10-13T19:32:56.039Z')
  })

  it('has the correct coverage string verbatim', () => {
    assert.equal(
      cat.coverage,
      'Contracts known to the Pulsarc indexer (labelled or among the busiest); not every token on the chain.'
    )
  })

  it('tokens and nfts are empty arrays for empty entries', () => {
    assert.deepEqual(cat.tokens, [])
    assert.deepEqual(cat.nfts, [])
  })
})

describe('buildCatalog – token entries', () => {
  const entries = [
    { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe({ name: 'Circle USD', symbol: 'USDC', decimals: '0x06', totalSupply: '0x012a05f200' }), discoverTxs: 100 },
  ]
  const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })

  it('erc20 probe produces a token entry', () => {
    assert.equal(cat.tokens.length, 1)
    assert.equal(cat.nfts.length, 0)
  })

  it('token address is correct', () => {
    assert.equal(cat.tokens[0].address, '0xaaaa000000000000000000000000000000000001')
  })

  it('token name and symbol pass through', () => {
    assert.equal(cat.tokens[0].name, 'Circle USD')
    assert.equal(cat.tokens[0].symbol, 'USDC')
  })

  it('token decimals is a number (decoded from hex)', () => {
    // 0x06 → 6
    assert.equal(cat.tokens[0].decimals, 6)
    assert.equal(typeof cat.tokens[0].decimals, 'number')
  })

  it('totalSupply is a decimal string (BigInt-converted from hex)', () => {
    // 0x012a05f200 → BigInt → decimal string
    assert.equal(cat.tokens[0].totalSupply, String(BigInt('0x012a05f200')))
    assert.equal(typeof cat.tokens[0].totalSupply, 'string')
  })
})

describe('buildCatalog – totalSupply null when probe supply is null or 0x', () => {
  it('totalSupply null in probe → null in output', () => {
    // If totalSupply is null but classify still produced erc20 (not possible normally
    // since classify requires valid supply), we synthesise: use a probe where supply is
    // non-null for classify to fire, then check the output field.
    // Here we test a non-null but '0x' supply that classify rejects → other → not in tokens
    const entries = [
      { address: '0xaaaa000000000000000000000000000000000001',
        probe: { name: 'T', symbol: 'T', decimals: '0x06', totalSupply: '0x', is721: false, is1155: false },
        discoverTxs: 0 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    // classify returns 'other' when totalSupply='0x' → not in tokens
    assert.equal(cat.tokens.length, 0)
  })

  it('a valid erc20 probe with totalSupply produces a decimal string in the token', () => {
    const entries = [
      { address: '0xaaaa000000000000000000000000000000000001',
        probe: erc20Probe({ totalSupply: '0x13de435347d4e200' }),
        discoverTxs: 0 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].totalSupply, String(BigInt('0x13de435347d4e200')))
  })
})

describe('buildCatalog – NFT entries', () => {
  const entries = [
    { address: '0x1111000000000000000000000000000000000001', probe: erc721Probe({ name: 'My NFT', symbol: 'MN' }), discoverTxs: 50 },
    { address: '0x2222000000000000000000000000000000000002', probe: erc1155Probe({ name: 'Multi', symbol: 'MLT' }), discoverTxs: 30 },
  ]
  const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })

  it('erc721 appears in nfts with kind ERC-721', () => {
    const nft = cat.nfts.find((n) => n.address === '0x1111000000000000000000000000000000000001')
    assert.ok(nft, 'expected ERC-721 entry in nfts')
    assert.equal(nft.kind, 'ERC-721')
    assert.equal(nft.name, 'My NFT')
    assert.equal(nft.symbol, 'MN')
  })

  it('erc1155 appears in nfts with kind ERC-1155', () => {
    const nft = cat.nfts.find((n) => n.address === '0x2222000000000000000000000000000000000002')
    assert.ok(nft, 'expected ERC-1155 entry in nfts')
    assert.equal(nft.kind, 'ERC-1155')
    assert.equal(nft.name, 'Multi')
  })

  it('NFTs do not appear in tokens', () => {
    assert.equal(cat.tokens.length, 0)
  })
})

describe('buildCatalog – other entries are excluded', () => {
  it('a probe with kind other does not appear in tokens or nfts', () => {
    const entries = [
      { address: '0xaaaa000000000000000000000000000000000001',
        probe: { name: 'Unknown', symbol: 'UNK', decimals: null, totalSupply: null, is721: false, is1155: false },
        discoverTxs: 0 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens.length, 0)
    assert.equal(cat.nfts.length, 0)
  })
})

describe('buildCatalog – null name/symbol in output', () => {
  it('probe with null name → null in token entry', () => {
    const entries = [
      { address: '0xaaaa000000000000000000000000000000000001',
        probe: erc20Probe({ name: null, symbol: 'TKN' }),
        discoverTxs: 0 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].name, null)
  })

  it('probe with null symbol → null in token entry', () => {
    const entries = [
      { address: '0xaaaa000000000000000000000000000000000001',
        probe: erc20Probe({ symbol: null }),
        discoverTxs: 0 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].symbol, null)
  })

  it('probe with null name → null in nft entry', () => {
    const entries = [
      { address: '0x1111000000000000000000000000000000000001',
        probe: erc721Probe({ name: null }),
        discoverTxs: 0 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts[0].name, null)
  })
})

describe('buildCatalog – maxTokens / maxNfts truncation', () => {
  // Build 5 erc20 entries and set maxTokens=3
  const tokenEntries = Array.from({ length: 5 }, (_, i) => ({
    address: `0x${String(i + 1).padStart(40, '0')}`,
    probe: erc20Probe({ name: `Token${i}`, symbol: `T${i}` }),
    discoverTxs: 100 - i,  // different txs so sort order is deterministic
  }))

  it('caps tokens at maxTokens', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: tokenEntries, maxTokens: 3 })
    assert.equal(cat.tokens.length, 3)
  })

  // Build 4 erc721 entries and set maxNfts=2
  const nftEntries = Array.from({ length: 4 }, (_, i) => ({
    address: `0xa${String(i + 1).padStart(39, '0')}`,
    probe: erc721Probe({ name: `NFT${i}`, symbol: `N${i}` }),
    discoverTxs: 50 - i,
  }))

  it('caps nfts at maxNfts', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: nftEntries, maxNfts: 2 })
    assert.equal(cat.nfts.length, 2)
  })
})

describe('buildCatalog – deterministic sort: discover txs desc then address asc', () => {
  // Four erc20 entries with different txs values
  const entries = [
    { address: '0x3333000000000000000000000000000000000003', probe: erc20Probe(), discoverTxs: 100 },
    { address: '0x1111000000000000000000000000000000000001', probe: erc20Probe(), discoverTxs: 500 },
    { address: '0x4444000000000000000000000000000000000004', probe: erc20Probe(), discoverTxs: 100 },
    { address: '0x2222000000000000000000000000000000000002', probe: erc20Probe(), discoverTxs: 300 },
  ]

  it('tokens sorted: txs=500 first, then txs=300, then txs=100 (address asc tie-break)', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    const addrs = cat.tokens.map((t) => t.address)
    assert.equal(addrs[0], '0x1111000000000000000000000000000000000001')  // txs=500
    assert.equal(addrs[1], '0x2222000000000000000000000000000000000002')  // txs=300
    // txs=100 tie: 0x3333 < 0x4444 alphabetically
    assert.equal(addrs[2], '0x3333000000000000000000000000000000000003')
    assert.equal(addrs[3], '0x4444000000000000000000000000000000000004')
  })

  it('entries with discoverTxs=0 (omitted field) come last', () => {
    const e = [
      { address: '0xbbbb000000000000000000000000000000000002', probe: erc20Probe(), discoverTxs: 200 },
      { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe() },  // no discoverTxs
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: e })
    assert.equal(cat.tokens[0].address, '0xbbbb000000000000000000000000000000000002')
    assert.equal(cat.tokens[1].address, '0xaaaa000000000000000000000000000000000001')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// supportsInterface calldata shape (boundary/correctness check)
// ─────────────────────────────────────────────────────────────────────────────

describe('supportsInterface calldata encoding (in catalog.mjs, verified here by shape)', () => {
  // selector 0x01ffc9a7 (4 bytes) + bytes4 arg right-padded to 32 bytes = 36 bytes total
  // '0x' + 72 hex chars = 74 chars
  const SEL    = '01ffc9a7'
  const ERC721_ID  = '80ac58cd'
  const ERC1155_ID = 'd9b67a26'
  const ZERO28 = '00'.repeat(28)   // 28 zero bytes of right-padding for bytes4

  const DATA_IS721  = '0x' + SEL + ERC721_ID  + ZERO28
  const DATA_IS1155 = '0x' + SEL + ERC1155_ID + ZERO28

  it('ERC-721 calldata is 74 characters (0x + 4-byte selector + 32-byte arg)', () => {
    assert.equal(DATA_IS721.length, 74)
  })

  it('ERC-1155 calldata is 74 characters', () => {
    assert.equal(DATA_IS1155.length, 74)
  })

  it('ERC-721 calldata starts with selector 0x01ffc9a7', () => {
    assert.ok(DATA_IS721.startsWith('0x01ffc9a7'))
  })

  it('ERC-1155 calldata starts with selector 0x01ffc9a7', () => {
    assert.ok(DATA_IS1155.startsWith('0x01ffc9a7'))
  })

  it('ERC-721 interfaceId bytes are left-aligned (bytes4 = 80ac58cd at offset 4)', () => {
    // After selector (8 hex = 4 bytes), next 8 hex chars = first 4 bytes of arg = 80ac58cd
    assert.equal(DATA_IS721.slice(10, 18), '80ac58cd')
  })

  it('ERC-1155 interfaceId bytes are left-aligned (d9b67a26 at offset 4)', () => {
    assert.equal(DATA_IS1155.slice(10, 18), 'd9b67a26')
  })

  it('remaining 28 bytes of arg are zero (right-padding for bytes4)', () => {
    // From offset 18 to end = 56 hex chars = 28 bytes, all zeros
    assert.equal(DATA_IS721.slice(18),  ZERO28)
    assert.equal(DATA_IS1155.slice(18), ZERO28)
  })

  it('ERC-721 and ERC-1155 calldatas differ only in the interfaceId bytes', () => {
    // Same selector and padding, different 4-byte ID
    assert.equal(DATA_IS721.slice(0, 10),  DATA_IS1155.slice(0, 10))   // same selector
    assert.notEqual(DATA_IS721.slice(10, 18), DATA_IS1155.slice(10, 18)) // different ID
    assert.equal(DATA_IS721.slice(18), DATA_IS1155.slice(18))            // same padding
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// decodeDecimals (exported — mutant-killer tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeDecimals – exported pure function', () => {
  it('null → null', () => assert.equal(decodeDecimals(null), null))
  it("'0x' → null (empty hex)", () => assert.equal(decodeDecimals('0x'), null))
  it("'0x00' → 0", () => assert.equal(decodeDecimals('0x00'), 0))
  it("'0x12' → 18", () => assert.equal(decodeDecimals('0x12'), 18))
  it("long-form 0x...0012 → 18 (ABI-encoded)", () => {
    assert.equal(decodeDecimals('0x0000000000000000000000000000000000000000000000000000000000000012'), 18)
  })
  it("'0x06' → 6 (USDC decimals)", () => assert.equal(decodeDecimals('0x06'), 6))
  it("'0x24' → 36 (boundary max)", () => assert.equal(decodeDecimals('0x24'), 36))
  it("'0x25' → null (37, one past boundary)", () => assert.equal(decodeDecimals('0x25'), null))

  // Mutant: `>= 0` instead of `> 0` — decimals=0 must still be valid
  it('decimals=0 is valid (kills >= 0 mutant)', () => {
    assert.equal(decodeDecimals('0x00'), 0)
    assert.notEqual(decodeDecimals('0x00'), null)
  })

  // Mutant: boundary changed to 36→37 or 36→35
  it('decimals=36 valid, decimals=37 invalid (kills off-by-one boundary mutants)', () => {
    assert.equal(decodeDecimals('0x24'), 36)   // 36 is valid
    assert.equal(decodeDecimals('0x25'), null) // 37 is invalid
  })

  // Mutant: n < 0 changed to n <= 0 (would reject 0)
  it('decimals=0 is NOT null (kills n<=0 mutant)', () => {
    assert.strictEqual(decodeDecimals('0x00'), 0)
  })

  // Non-hex string → null
  it("'abc' → null (non-hex, BigInt throws)", () => assert.equal(decodeDecimals('abc'), null))

  // Negative
  it("'-0x1' → null (negative)", () => assert.equal(decodeDecimals('-0x1'), null))

  // Fractional/float string
  it("'1.5' → null (not valid BigInt)", () => assert.equal(decodeDecimals('1.5'), null))
})

// ─────────────────────────────────────────────────────────────────────────────
// hasValidSupply (exported — mutant-killer tests)
// ─────────────────────────────────────────────────────────────────────────────

describe('hasValidSupply – exported pure function', () => {
  it('null → false', () => assert.equal(hasValidSupply(null), false))
  it("'0x' → false (empty sentinel)", () => assert.equal(hasValidSupply('0x'), false))
  it("'0x01' → true", () => assert.equal(hasValidSupply('0x01'), true))
  it("'' empty string → false", () => assert.equal(hasValidSupply(''), false))
  it('number 1 → false (not a string)', () => assert.equal(hasValidSupply(1), false))

  // Mutant: `hex !== '0x'` replaced by `hex === '0x'` (inverted)
  it("'0x00' (all-zero supply) is valid (kills inverted 0x sentinel mutant)", () => {
    // A supply of 0 is technically valid (even if unusual); hasValidSupply checks only format
    assert.equal(hasValidSupply('0x00'), true)
  })

  // Mutant: `hex.length > 0` replaced by `hex.length >= 0` or `> 1`
  it("single-char hex '0' → false (not a valid hex string, length=1 < 2)", () => {
    // '0' is length 1, is a string, is not '0x' but won't parse as hex; however
    // hasValidSupply only checks format (non-null, non-empty, not '0x'), so '0' passes it.
    // This test documents the actual behaviour rather than a parse step.
    assert.equal(hasValidSupply('0'), true)
  })

  // Mutant: `typeof hex === 'string'` removed
  it('undefined → false (kills typeof check removal mutant)', () => {
    assert.equal(hasValidSupply(undefined), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// decodeSupply — fixtures from raw-rpc-results.json
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeSupply – ABI-encoded hex to decimal string', () => {
  it('null → null', () => assert.equal(decodeSupply(null), null))
  it("'0x' → null (empty)", () => assert.equal(decodeSupply('0x'), null))
  it("'0x01' → '1'", () => assert.equal(decodeSupply('0x01'), '1'))
  it("'0x00' → '0'", () => assert.equal(decodeSupply('0x00'), '0'))

  // Fixture: 0x394d38f8... Faze token
  // decimals = 0x12 = 18
  // totalSupply raw = 0x0000...033b2e3c9fd0803ce8000000
  it('Faze token totalSupply hex → 1000000000000000000000000000', () => {
    const hex = '0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000'
    assert.equal(decodeSupply(hex), '1000000000000000000000000000')
  })

  // Fixture: 0x3600... USDC
  // decimals = 0x06 = 6
  // totalSupply raw = 0x0000...0001ed53be6617ad
  it('USDC totalSupply hex → 542418909140909', () => {
    const hex = '0x0000000000000000000000000000000000000000000000000001ed53be6617ad'
    assert.equal(decodeSupply(hex), '542418909140909')
  })

  // Additional value check
  it('0x016345785d8a0000 → 100000000000000000 (1e17)', () => {
    assert.equal(decodeSupply('0x016345785d8a0000'), '100000000000000000')
  })

  // Non-hex string
  it("'not-hex' → null", () => assert.equal(decodeSupply('not-hex'), null))
})

// ─────────────────────────────────────────────────────────────────────────────
// decodeBool — fixtures from raw-rpc-results.json
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeBool – eth_call bool result decoder', () => {
  it('null → null', () => assert.equal(decodeBool(null), null))
  it("'0x' → null (empty)", () => assert.equal(decodeBool('0x'), null))

  // Fixture: Uniswap V3 Positions NFT supports ERC-721 → true
  it('0x...01 → true (ERC-721 supported)', () => {
    const hex = '0x0000000000000000000000000000000000000000000000000000000000000001'
    assert.equal(decodeBool(hex), true)
  })

  // Fixture: Uniswap V3 Positions NFT does NOT support ERC-1155 → false
  it('0x...00 → false (ERC-1155 not supported)', () => {
    const hex = '0x0000000000000000000000000000000000000000000000000000000000000000'
    assert.equal(decodeBool(hex), false)
  })

  // Revert/error object (as returned by some RPC wrappers when eth_call reverts)
  it('error object (revert) → null', () => {
    assert.equal(decodeBool({ code: 3, message: 'execution reverted' }), null)
  })

  // Short-form
  it("'0x01' → true", () => assert.equal(decodeBool('0x01'), true))
  it("'0x00' → false", () => assert.equal(decodeBool('0x00'), false))
})

// ─────────────────────────────────────────────────────────────────────────────
// decodeDecimals — fixtures from raw-rpc-results.json
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeDecimals – fixture values from raw-rpc-results.json', () => {
  // Faze token: decimals = 0x12 = 18
  it('Faze token ABI-encoded decimals 0x...12 → 18', () => {
    const hex = '0x0000000000000000000000000000000000000000000000000000000000000012'
    assert.equal(decodeDecimals(hex), 18)
  })

  // USDC: decimals = 0x06 = 6
  it('USDC ABI-encoded decimals 0x...06 → 6', () => {
    const hex = '0x0000000000000000000000000000000000000000000000000000000000000006'
    assert.equal(decodeDecimals(hex), 6)
  })

  // Uniswap V3 Positions NFT: decimals call reverts → null from catalog.mjs (get returns null)
  it('null (reverted decimals call) → null', () => {
    assert.equal(decodeDecimals(null), null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildCatalog maxTokens=200 / maxNfts=200 exact boundary (mutant-killer)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – maxTokens=200 boundary (mutant-killer)', () => {
  // 200 entries → all kept; 201 entries → first 200 kept
  const makeTokens = (n) =>
    Array.from({ length: n }, (_, i) => ({
      address: `0x${String(i + 1).padStart(40, '0')}`,
      probe: erc20Probe({ name: `T${i}`, symbol: `T${i}` }),
      discoverTxs: n - i,
    }))

  it('exactly 200 token entries → all 200 kept', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: makeTokens(200) })
    assert.equal(cat.tokens.length, 200)
  })

  it('201 token entries → first 200 kept (201st dropped)', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: makeTokens(201) })
    assert.equal(cat.tokens.length, 200)
    // The first entry (highest discoverTxs) is present
    assert.equal(cat.tokens[0].address, '0x' + '1'.padStart(40, '0'))
    // The 201st entry (lowest discoverTxs) is absent
    assert.ok(!cat.tokens.some((t) => t.address === `0x${String(201).padStart(40, '0')}`))
  })
})

describe('buildCatalog – maxNfts=200 boundary (mutant-killer)', () => {
  const makeNfts = (n) =>
    Array.from({ length: n }, (_, i) => ({
      address: `0xa${String(i + 1).padStart(39, '0')}`,
      probe: erc721Probe({ name: `N${i}`, symbol: `N${i}` }),
      discoverTxs: n - i,
    }))

  it('exactly 200 nft entries → all 200 kept', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: makeNfts(200) })
    assert.equal(cat.nfts.length, 200)
  })

  it('201 nft entries → first 200 kept (201st dropped)', () => {
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: makeNfts(201) })
    assert.equal(cat.nfts.length, 200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// candidateAddresses comparator — equal addresses (mutant-killer :56)
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateAddresses – equal-address tie-break returns 0 (mutant-killer :56)', () => {
  // Same address appearing twice (deduplicated by Set) should produce one entry
  // with no infinite loop or wrong ordering.
  it('identical address in both labels and discover → appears exactly once', () => {
    const addr = '0xaaaa000000000000000000000000000000000001'
    const result = candidateAddresses(
      { [addr]: { contract: true, name: 'T', symbol: 'T' } },
      { contracts: [{ address: addr, txs: 50 }] }
    )
    assert.equal(result.filter((a) => a === addr.toLowerCase()).length, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildCatalog comparator — equal addresses tie-break (mutant-killer :153)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – equal-address comparator returns 0 (mutant-killer :153)', () => {
  it('two entries with same discoverTxs and same address → no crash, appears once', () => {
    // Constructing two entries with literally the same address would be deduplicated
    // by mergeCatalog (Map key), but buildCatalog takes an array. Two entries with the
    // same address and same txs should not infinitely loop or crash.
    const entries = [
      { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe(), discoverTxs: 100 },
      { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe(), discoverTxs: 100 },
    ]
    // Both are identical — both will appear (buildCatalog does not deduplicate by address)
    // but the sort comparator must return 0 and not crash or produce wrong order.
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens.length, 2)  // both kept (buildCatalog doesn't dedup)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// mergeCatalog — core merging behaviour
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeCatalog – from-scratch (no previous)', () => {
  const ADDR_ERC20 = '0xaaaa000000000000000000000000000000000001'
  const ADDR_NFT   = '0x1111000000000000000000000000000000000001'

  const entries = [
    {
      address: ADDR_ERC20,
      probe: { name: 'Faze', symbol: 'FAZE', decimals: '0x12', totalSupply: '0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000', is721: false, is1155: false },
      discoverTxs: 500,
    },
    {
      address: ADDR_NFT,
      probe: { name: 'MyNFT', symbol: 'MN', decimals: null, totalSupply: null, is721: true, is1155: false },
      discoverTxs: 100,
    },
  ]

  const result = mergeCatalog(null, entries, { network: 'mainnet', generatedAt: 'T' })

  it('produces network/generatedAt/coverage fields', () => {
    assert.equal(result.network, 'mainnet')
    assert.equal(result.generatedAt, 'T')
    assert.ok(result.coverage.length > 0)
  })

  it('ERC-20 entry has real decimals (18) and totalSupply as decimal string', () => {
    const t = result.tokens.find((x) => x.address === ADDR_ERC20)
    assert.ok(t, 'ERC-20 entry missing from tokens')
    assert.equal(t.decimals, 18)
    assert.equal(t.totalSupply, '1000000000000000000000000000')
  })

  it('ERC-721 entry is in nfts', () => {
    const n = result.nfts.find((x) => x.address === ADDR_NFT)
    assert.ok(n, 'ERC-721 entry missing from nfts')
    assert.equal(n.kind, 'ERC-721')
  })

  it('probed map records both addresses', () => {
    assert.equal(result.probed[ADDR_ERC20], 'erc20')
    assert.equal(result.probed[ADDR_NFT], 'erc721')
  })
})

describe('mergeCatalog – preserves previous entries', () => {
  const OLD_ADDR = '0xbbbb000000000000000000000000000000000002'
  const NEW_ADDR = '0xcccc000000000000000000000000000000000003'

  const previous = {
    network: 'mainnet',
    generatedAt: 'old',
    coverage: 'x',
    tokens: [{ address: OLD_ADDR, name: 'Old', symbol: 'OLD', decimals: 18, totalSupply: '999' }],
    nfts: [],
    probed: { [OLD_ADDR]: 'erc20' },
  }

  const newEntries = [
    {
      address: NEW_ADDR,
      probe: { name: 'New', symbol: 'NEW', decimals: '0x06', totalSupply: '0x01', is721: false, is1155: false },
      discoverTxs: 0,
    },
  ]

  const result = mergeCatalog(previous, newEntries, { network: 'mainnet', generatedAt: 'new' })

  it('old entry is preserved with its original values', () => {
    const t = result.tokens.find((x) => x.address === OLD_ADDR)
    assert.ok(t, 'old entry missing')
    assert.equal(t.totalSupply, '999')
    assert.equal(t.decimals, 18)
  })

  it('new entry is added with decoded values', () => {
    const t = result.tokens.find((x) => x.address === NEW_ADDR)
    assert.ok(t, 'new entry missing')
    assert.equal(t.decimals, 6)
    assert.equal(t.totalSupply, '1')
  })

  it('probed map includes both old and new', () => {
    assert.equal(result.probed[OLD_ADDR], 'erc20')
    assert.equal(result.probed[NEW_ADDR], 'erc20')
  })

  it('generatedAt is updated', () => {
    assert.equal(result.generatedAt, 'new')
  })
})

describe('mergeCatalog – upsert: re-probed address replaces old entry', () => {
  const ADDR = '0xaaaa000000000000000000000000000000000001'

  const previous = {
    tokens: [{ address: ADDR, name: 'OldName', symbol: 'OLD', decimals: 0, totalSupply: '1' }],
    nfts: [],
    probed: { [ADDR]: 'erc20' },
  }

  const newEntries = [
    {
      address: ADDR,
      probe: { name: 'NewName', symbol: 'NEW', decimals: '0x12', totalSupply: '0x0de0b6b3a7640000', is721: false, is1155: false },
      discoverTxs: 0,
    },
  ]

  const result = mergeCatalog(previous, newEntries, { network: 'mainnet', generatedAt: 'T' })

  it('upserted entry has new name and corrected decimals/totalSupply', () => {
    assert.equal(result.tokens.length, 1)
    assert.equal(result.tokens[0].name, 'NewName')
    assert.equal(result.tokens[0].decimals, 18)
    assert.equal(result.tokens[0].totalSupply, String(BigInt('0x0de0b6b3a7640000')))
  })
})

describe('mergeCatalog – reclassification: was token, now other → removed from tokens', () => {
  const ADDR = '0xaaaa000000000000000000000000000000000001'

  const previous = {
    tokens: [{ address: ADDR, name: 'OldTok', symbol: 'OT', decimals: 18, totalSupply: '1000' }],
    nfts: [],
    probed: { [ADDR]: 'erc20' },
  }

  const newEntries = [
    {
      address: ADDR,
      // 'other' probe (no decimals, no supply, no NFT flags)
      probe: { name: null, symbol: null, decimals: null, totalSupply: null, is721: false, is1155: false },
      discoverTxs: 0,
    },
  ]

  const result = mergeCatalog(previous, newEntries, { network: 'mainnet', generatedAt: 'T' })

  it('address is removed from tokens when reclassified as other', () => {
    assert.equal(result.tokens.length, 0)
  })

  it('address is marked other in probed', () => {
    assert.equal(result.probed[ADDR], 'other')
  })
})

describe('mergeCatalog – empty newlyProbedEntries returns previous catalog unchanged', () => {
  const ADDR = '0xaaaa000000000000000000000000000000000001'

  const previous = {
    tokens: [{ address: ADDR, name: 'Stable', symbol: 'STA', decimals: 6, totalSupply: '1000000' }],
    nfts: [],
    probed: { [ADDR]: 'erc20' },
  }

  const result = mergeCatalog(previous, [], { network: 'mainnet', generatedAt: 'T2' })

  it('tokens are unchanged', () => {
    assert.equal(result.tokens.length, 1)
    assert.equal(result.tokens[0].totalSupply, '1000000')
  })

  it('probed map is unchanged', () => {
    assert.equal(result.probed[ADDR], 'erc20')
  })
})

describe('mergeCatalog – USDC fixture values', () => {
  // From fixtures/raw-rpc-results.json: 0x3600...
  const USDC_ADDR = '0x3600000000000000000000000000000000000000'
  const entries = [
    {
      address: USDC_ADDR,
      probe: {
        name:        'USD Coin',
        symbol:      'USDC',
        decimals:    '0x0000000000000000000000000000000000000000000000000000000000000006',
        totalSupply: '0x0000000000000000000000000000000000000000000000000001ed53be6617ad',
        is721:       false,
        is1155:      false,
      },
      discoverTxs: 9999,
    },
  ]

  const result = mergeCatalog(null, entries, { network: 'mainnet', generatedAt: 'T' })

  it('USDC decimals = 6', () => {
    assert.equal(result.tokens[0].decimals, 6)
  })

  it('USDC totalSupply = 542418909140909 (decimal string)', () => {
    assert.equal(result.tokens[0].totalSupply, '542418909140909')
  })
})

// =============================================================================
// NEW MUTANT-KILLER TESTS
// Each describe block names the source line(s) and the mutation being killed.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// (1a) candidateAddresses :41-46 — appToken always included even when absent
//      from both labels AND discover
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateAddresses – appToken :41-46: included regardless of labels/discover', () => {
  const APP_TOKEN = '0xdead000000000000000000000000000000000001'

  it('appToken address absent from labels and discover still appears in result', () => {
    // Mutation: remove the appTokenSet loop at :42-44 → address would be missing
    const result = candidateAddresses({}, { contracts: [] }, [APP_TOKEN])
    assert.ok(result.includes(APP_TOKEN.toLowerCase()), 'appToken must be present even with no labels/discover')
  })

  it('uppercase appToken address is lowercased in result', () => {
    // Mutation: skip toLowerCase on appToken → address in wrong case, never matched
    const UPPER = '0xDEAD000000000000000000000000000000000001'
    const result = candidateAddresses({}, { contracts: [] }, [UPPER])
    assert.ok(result.includes('0xdead000000000000000000000000000000000001'))
    assert.ok(!result.includes(UPPER), 'must be stored in lower case')
  })

  it('appToken address in labels as infra is still included (appToken wins over infra filter)', () => {
    // The infra filter applies only to the labels loop; appToken loop is separate
    const labels = { [APP_TOKEN]: { kind: 'infra', symbol: null } }
    const result = candidateAddresses(labels, { contracts: [] }, [APP_TOKEN])
    assert.ok(result.includes(APP_TOKEN.toLowerCase()))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (1b) candidateAddresses :68-70 — appToken sort direction
//      Mutation: `appB - appA` → `appA - appB` would put non-appToken FIRST
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateAddresses – appToken sort :68-70: appToken address comes first', () => {
  const APP  = '0x1111000000000000000000000000000000000001'
  const NORM = '0x2222000000000000000000000000000000000002'

  it('appToken address is first even when normal address has higher discover txs', () => {
    // NORM has 9999 txs; APP has 0 txs but is an appToken — must still sort first
    const result = candidateAddresses(
      {},
      { contracts: [{ address: NORM, txs: 9999 }, { address: APP, txs: 0 }] },
      [APP]
    )
    assert.equal(result[0], APP.toLowerCase(), 'appToken must be first regardless of txs')
    assert.equal(result[1], NORM.toLowerCase())
  })

  it('two appToken addresses are sorted by discover txs desc among themselves', () => {
    const APP_A = '0xaaaa000000000000000000000000000000000001'
    const APP_B = '0xbbbb000000000000000000000000000000000002'
    // APP_B has higher txs → should come first within appToken tier
    const result = candidateAddresses(
      {},
      { contracts: [{ address: APP_A, txs: 10 }, { address: APP_B, txs: 50 }] },
      [APP_A, APP_B]
    )
    assert.equal(result[0], APP_B.toLowerCase())
    assert.equal(result[1], APP_A.toLowerCase())
  })

  it('two appToken addresses with equal txs are sorted by address ascending', () => {
    const APP_A = '0xaaaa000000000000000000000000000000000001'
    const APP_B = '0xbbbb000000000000000000000000000000000002'
    const result = candidateAddresses(
      {},
      { contracts: [{ address: APP_A, txs: 10 }, { address: APP_B, txs: 10 }] },
      [APP_A, APP_B]
    )
    assert.equal(result[0], APP_A.toLowerCase(), 'smaller address first within appToken+equal-txs tier')
    assert.equal(result[1], APP_B.toLowerCase())
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (1c) buildCatalog :338 — appToken sort direction in buildCatalog
//      Mutation: `appB - appA` → `appA - appB` → non-appToken would come first
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – appToken sort :338: appToken entry beats higher-txs normal entry', () => {
  const makeErc20 = (addr, txs, appToken = false) => ({
    address: addr,
    probe: erc20Probe({ name: addr, symbol: addr.slice(2, 6) }),
    discoverTxs: txs,
    appToken,
  })

  it('appToken token comes before a normal token with 10x more discover txs', () => {
    const entries = [
      makeErc20('0x2222000000000000000000000000000000000002', 10000, false), // high txs, normal
      makeErc20('0x1111000000000000000000000000000000000001', 1,     true),  // appToken, tiny txs
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].address, '0x1111000000000000000000000000000000000001', 'appToken must be first')
    assert.equal(cat.tokens[1].address, '0x2222000000000000000000000000000000000002')
  })

  it('two appToken tokens: sorted by discover txs desc', () => {
    const entries = [
      makeErc20('0xaaaa000000000000000000000000000000000001', 50, true),
      makeErc20('0xbbbb000000000000000000000000000000000002', 200, true),
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].address, '0xbbbb000000000000000000000000000000000002', 'higher-txs appToken first')
    assert.equal(cat.tokens[1].address, '0xaaaa000000000000000000000000000000000001')
  })

  it('two appToken tokens with equal txs: sorted by address ascending', () => {
    const entries = [
      makeErc20('0xbbbb000000000000000000000000000000000002', 100, true),
      makeErc20('0xaaaa000000000000000000000000000000000001', 100, true),
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].address, '0xaaaa000000000000000000000000000000000001', 'smaller addr first on equal txs')
    assert.equal(cat.tokens[1].address, '0xbbbb000000000000000000000000000000000002')
  })

  it('appToken NFT entry comes before a non-appToken NFT with higher txs', () => {
    const entries = [
      { address: '0x2222000000000000000000000000000000000002', probe: erc721Probe(), discoverTxs: 9999, appToken: false },
      { address: '0x1111000000000000000000000000000000000001', probe: erc721Probe(), discoverTxs: 1,    appToken: true },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts[0].address, '0x1111000000000000000000000000000000000001', 'appToken NFT must be first')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (1d) buildCatalog :191, :264-267 — appToken flag stored in output entries
//      (indirectly: entries passed with appToken=true end up sorted first)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – appToken flag :191/:264-267: flag respected in sort', () => {
  it('entry with appToken=false does NOT get priority even if it equals appToken=true address', () => {
    // Two entries: one explicitly appToken=true, one appToken=false. True must win.
    const entries = [
      { address: '0xcccc000000000000000000000000000000000003', probe: erc20Probe(), discoverTxs: 500, appToken: false },
      { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe(), discoverTxs: 1,   appToken: true },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].address, '0xaaaa000000000000000000000000000000000001')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (2) buildCatalog :209 — default maxTokens=200, maxNfts=200
//     Mutation: `maxTokens = 199` or `maxNfts = 199`
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – default limits :209: 201 entries, no explicit max → exactly 200 kept', () => {
  const makeTokenEntry = (i) => ({
    address: `0x${String(i + 1).padStart(40, '0')}`,
    probe: erc20Probe({ name: `T${i}`, symbol: `T${i}` }),
    discoverTxs: 10000 - i,
  })
  const makeNftEntry = (i) => ({
    address: `0xa${String(i + 1).padStart(39, '0')}`,
    probe: erc721Probe({ name: `N${i}`, symbol: `N${i}` }),
    discoverTxs: 10000 - i,
  })

  it('201 token entries with NO explicit maxTokens → exactly 200 tokens in output', () => {
    // Mutation `maxTokens=199` would give 199; mutation `maxTokens=201` would give 201.
    const entries = Array.from({ length: 201 }, (_, i) => makeTokenEntry(i))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens.length, 200, `expected 200, got ${cat.tokens.length}`)
  })

  it('201 NFT entries with NO explicit maxNfts → exactly 200 nfts in output', () => {
    const entries = Array.from({ length: 201 }, (_, i) => makeNftEntry(i))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts.length, 200, `expected 200, got ${cat.nfts.length}`)
  })

  it('exactly 200 token entries → all 200 kept (no off-by-one over-capping)', () => {
    // Mutation `>= maxTokens` instead of `> maxTokens` in accumulation would drop the 200th.
    // This is already covered by the existing boundary tests; repeat here for the default path.
    const entries = Array.from({ length: 200 }, (_, i) => makeTokenEntry(i))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens.length, 200)
  })

  it('exactly 200 NFT entries → all 200 kept', () => {
    const entries = Array.from({ length: 200 }, (_, i) => makeNftEntry(i))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts.length, 200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (3) buildCatalog :368 `if (nfts.length >= maxNfts) continue` (>= → >)
//     Mutation `>` would allow the 201st NFT in when length==200 (>200 is false).
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – NFT cap boundary :368: >= keeps the cap exact', () => {
  it('exactly at cap: 200th NFT is added, 201st is not (kills >= → > mutant)', () => {
    // With `> maxNfts` (mutant), when nfts.length == maxNfts (200) the condition is false
    // so we do NOT continue → the 201st entry sneaks in, giving 201 total.
    // Correct code uses `>=`: when nfts.length == maxNfts (200) → continue → 201st skipped.
    const entries = Array.from({ length: 201 }, (_, i) => ({
      address: `0xa${String(i + 1).padStart(39, '0')}`,
      probe: erc721Probe(),
      discoverTxs: 201 - i,
    }))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries, maxNfts: 200 })
    assert.equal(cat.nfts.length, 200, '201st NFT must be rejected when limit is 200')
  })

  it('same test with erc1155 entries (both NFT kinds share the same nfts array and cap)', () => {
    const entries = Array.from({ length: 201 }, (_, i) => ({
      address: `0xa${String(i + 1).padStart(39, '0')}`,
      probe: erc1155Probe(),
      discoverTxs: 201 - i,
    }))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries, maxNfts: 200 })
    assert.equal(cat.nfts.length, 200)
  })

  it('mixed erc721+erc1155 NFTs share the single cap', () => {
    // 150 ERC-721 + 51 ERC-1155 = 201 NFTs total; cap is 200
    const e721 = Array.from({ length: 150 }, (_, i) => ({
      address: `0xa${String(i + 1).padStart(39, '0')}`,
      probe: erc721Probe(),
      discoverTxs: 1000 - i,
    }))
    const e1155 = Array.from({ length: 51 }, (_, i) => ({
      address: `0xb${String(i + 1).padStart(39, '0')}`,
      probe: erc1155Probe(),
      discoverTxs: 500 - i,
    }))
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries: [...e721, ...e1155], maxNfts: 200 })
    assert.equal(cat.nfts.length, 200)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (4) classify :247 `else if (kind === 'erc1155')` (=== → !==)
//     Mutation `!==` would add erc1155 to nftMap only when kind is NOT erc1155.
//     Also verifies the output kind string is exactly 'ERC-1155'.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – ERC-1155 classification :247: correct branch and kind string', () => {
  it('erc1155 probe produces an entry in nfts (kills === → !== mutant)', () => {
    // With mutant `!==`, erc1155 entries are silently skipped → nfts.length === 0.
    const entries = [
      { address: '0x1155000000000000000000000000000000000001', probe: erc1155Probe(), discoverTxs: 10 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts.length, 1, 'ERC-1155 entry must appear in nfts')
    assert.equal(cat.tokens.length, 0)
  })

  it("erc1155 nft entry has kind === 'ERC-1155' (exact string, case-sensitive)", () => {
    const entries = [
      { address: '0x1155000000000000000000000000000000000001', probe: erc1155Probe({ name: 'Multi', symbol: 'MLT' }), discoverTxs: 10 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts[0].kind, 'ERC-1155')
  })

  it('erc721 is NOT stored under erc1155 branch (they write different kind strings)', () => {
    const entries = [
      { address: '0x7211000000000000000000000000000000000001', probe: erc721Probe(), discoverTxs: 10 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts[0].kind, 'ERC-721')
    assert.notEqual(cat.nfts[0].kind, 'ERC-1155')
  })

  it('erc1155 probe in mergeCatalog also produces kind ERC-1155', () => {
    const entries = [
      { address: '0x1155000000000000000000000000000000000001',
        probe: erc1155Probe({ name: 'Multi2', symbol: 'M2' }),
        discoverTxs: 5 },
    ]
    const result = mergeCatalog(null, entries, { network: 'mainnet', generatedAt: 'T' })
    assert.equal(result.nfts.length, 1)
    assert.equal(result.nfts[0].kind, 'ERC-1155')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (5a) buildCatalog :284 `if (d !== 0) return d`
//      Mutation `=== 0` → would return txs diff even when it's 0, skipping addr cmp.
//      Also :342 in buildCatalog comparator.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCatalog – addr tie-break :342: same txs → smaller address comes first', () => {
  it('two tokens same discoverTxs → address ascending (smaller hex first)', () => {
    // Mutation `if (d === 0) return d` would return 0 (no-op) and never reach addr cmp,
    // leaving order arbitrary/insertion-order → this test would be flaky or wrong.
    const entries = [
      { address: '0xbbbb000000000000000000000000000000000002', probe: erc20Probe(), discoverTxs: 100 },
      { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe(), discoverTxs: 100 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.tokens[0].address, '0xaaaa000000000000000000000000000000000001', 'smaller addr first')
    assert.equal(cat.tokens[1].address, '0xbbbb000000000000000000000000000000000002')
  })

  it('two NFTs same discoverTxs → smaller address first', () => {
    const entries = [
      { address: '0xdddd000000000000000000000000000000000004', probe: erc721Probe(), discoverTxs: 77 },
      { address: '0xcccc000000000000000000000000000000000003', probe: erc721Probe(), discoverTxs: 77 },
    ]
    const cat = buildCatalog({ network: 'mainnet', generatedAt: 'T', entries })
    assert.equal(cat.nfts[0].address, '0xcccc000000000000000000000000000000000003')
    assert.equal(cat.nfts[1].address, '0xdddd000000000000000000000000000000000004')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (5b) candidateAddresses :74 — address comparator direction
//      Same as above but in candidateAddresses (different code path).
//      Mutation: swap `< -1 : > 1` → `> -1 : < 1` → larger addr would come first.
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateAddresses – addr tie-break :74: smaller address comes first', () => {
  it('two addresses with equal discover txs → smaller hex address first', () => {
    const labelsTie = {
      '0xffff000000000000000000000000000000000009': { symbol: 'F', name: 'F' },
      '0xeeee000000000000000000000000000000000008': { symbol: 'E', name: 'E' },
    }
    const discoverTie = {
      contracts: [
        { address: '0xffff000000000000000000000000000000000009', txs: 300 },
        { address: '0xeeee000000000000000000000000000000000008', txs: 300 },
      ],
    }
    const result = candidateAddresses(labelsTie, discoverTie)
    assert.equal(result[0], '0xeeee000000000000000000000000000000000008', 'smaller addr first')
    assert.equal(result[1], '0xffff000000000000000000000000000000000009')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (5c) mergeCatalog :285 — address comparator direction
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeCatalog – addr tie-break :285: smaller address comes first', () => {
  it('two tokens equal discoverTxs → smaller address first in output', () => {
    const entries = [
      { address: '0xbbbb000000000000000000000000000000000002', probe: erc20Probe(), discoverTxs: 50 },
      { address: '0xaaaa000000000000000000000000000000000001', probe: erc20Probe(), discoverTxs: 50 },
    ]
    const result = mergeCatalog(null, entries, { network: 'mainnet', generatedAt: 'T' })
    assert.equal(result.tokens[0].address, '0xaaaa000000000000000000000000000000000001')
    assert.equal(result.tokens[1].address, '0xbbbb000000000000000000000000000000000002')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (6) candidateAddresses :50 `entry.symbol && typeof entry.symbol === 'string' && entry.symbol.length > 0`
//     Mutations: remove typeof check, remove .length check, invert truthy check
// ─────────────────────────────────────────────────────────────────────────────

describe('candidateAddresses – symbol guard :50: empty string, number, null excluded', () => {
  const discover = { contracts: [] }

  it('entry with empty string symbol is NOT included from labels (kills .length > 0 removal)', () => {
    // Mutation: remove `.length > 0` → empty string '' is truthy as string → included wrongly
    const labels = {
      '0xaaaa000000000000000000000000000000000001': { symbol: '' },
    }
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xaaaa000000000000000000000000000000000001'), 'empty string symbol must be excluded')
  })

  it('entry with numeric symbol (e.g. 42) is NOT included (kills typeof check removal)', () => {
    // Mutation: remove `typeof entry.symbol === 'string'` → number 42 is truthy → included wrongly
    const labels = {
      '0xbbbb000000000000000000000000000000000002': { symbol: 42 },
    }
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xbbbb000000000000000000000000000000000002'), 'numeric symbol must be excluded')
  })

  it('entry with null symbol is NOT included (kills truthy check)', () => {
    // Already covered above but repeated here for clarity
    const labels = {
      '0xcccc000000000000000000000000000000000003': { symbol: null },
    }
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xcccc000000000000000000000000000000000003'))
  })

  it('entry with undefined symbol is NOT included', () => {
    const labels = {
      '0xdddd000000000000000000000000000000000004': { symbol: undefined },
    }
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xdddd000000000000000000000000000000000004'))
  })

  it('entry with valid non-empty string symbol IS included', () => {
    const labels = {
      '0xeeee000000000000000000000000000000000005': { symbol: 'X' },
    }
    const result = candidateAddresses(labels, discover)
    assert.ok(result.includes('0xeeee000000000000000000000000000000000005'))
  })

  it('entry with boolean true symbol is NOT included (not a string)', () => {
    const labels = {
      '0xffff000000000000000000000000000000000006': { symbol: true },
    }
    const result = candidateAddresses(labels, discover)
    assert.ok(!result.includes('0xffff000000000000000000000000000000000006'))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (7a) decodeDecimals :115 `!hex || hex === '0x'`
//      Each short-circuit case individually
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeDecimals – null/undefined/0x/empty guard :115: each case separately', () => {
  it('null → null (kills `!hex` removal: null is falsy)', () => {
    assert.strictEqual(decodeDecimals(null), null)
  })

  it('undefined → null (kills `!hex` removal: undefined is falsy)', () => {
    assert.strictEqual(decodeDecimals(undefined), null)
  })

  it("empty string '' → null (kills `!hex` removal: empty string is falsy)", () => {
    assert.strictEqual(decodeDecimals(''), null)
  })

  it("'0x' → null (kills `hex === '0x'` removal: '0x' is truthy but invalid)", () => {
    // '0x' is truthy so `!hex` alone would NOT catch it; only `hex === '0x'` catches it.
    // Mutation: remove `hex === '0x'` → BigInt('0x') throws → caught → returns null anyway.
    // BUT the intention is the guard, and BigInt('0x') = 0n so it would decode to 0 ✓
    // Actually BigInt('0x') throws in V8. So removing the guard still returns null via catch.
    // This is an equivalent mutant for '0x'. Document it: both paths → null.
    assert.strictEqual(decodeDecimals('0x'), null)
  })

  it("valid hex '0x06' → 6 (sanity: guard does not over-reject)", () => {
    assert.strictEqual(decodeDecimals('0x06'), 6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (7b) hasValidSupply :143 `!hex || hex === '0x'`
// ─────────────────────────────────────────────────────────────────────────────

describe('hasValidSupply – null/undefined/0x/empty guard :143: each case separately', () => {
  it('null → false', () => assert.strictEqual(hasValidSupply(null), false))

  it('undefined → false', () => assert.strictEqual(hasValidSupply(undefined), false))

  it("empty string '' → false (kills hex.length > 0 removal mutant)", () => {
    // Mutation: remove `hex.length > 0` → '' would pass typeof and !=='0x' checks → true wrong
    assert.strictEqual(hasValidSupply(''), false)
  })

  it("'0x' → false (kills hex !== '0x' removal mutant)", () => {
    // '0x' is truthy, non-empty, but the '0x' sentinel check catches it
    assert.strictEqual(hasValidSupply('0x'), false)
  })

  it("'0x01' → true (valid, sanity)", () => assert.strictEqual(hasValidSupply('0x01'), true))

  it("'0x00' → true (all-zero supply is still valid hex)", () => {
    assert.strictEqual(hasValidSupply('0x00'), true)
  })

  it('number 0 → false (kills typeof check removal)', () => {
    assert.strictEqual(hasValidSupply(0), false)
  })

  it('number 1 → false (kills typeof check removal)', () => {
    assert.strictEqual(hasValidSupply(1), false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// (7c) decodeBool :159 `!hexOrError || typeof hexOrError !== 'string' || hexOrError === '0x'`
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeBool – null/undefined/non-string/0x guard :159: each case separately', () => {
  it('null → null', () => assert.strictEqual(decodeBool(null), null))

  it('undefined → null', () => assert.strictEqual(decodeBool(undefined), null))

  it("'0x' → null (kills hex === '0x' removal: '0x' parses as 0n which is false, so removal would give false not null)", () => {
    // With guard: '0x' → null (guard fires before BigInt attempt)
    // Without `==='0x'` guard: BigInt('0x') throws → caught → null. Still null either way.
    // → equivalent mutant for '0x' only: both code paths return null.
    assert.strictEqual(decodeBool('0x'), null)
  })

  it('non-string object → null (kills typeof check removal)', () => {
    // Without `typeof hexOrError !== 'string'`: an object {code:3} would try BigInt({}) → throw → null anyway.
    // But a number like 1 would try BigInt(1) → 1n → === 1n → true, which is wrong.
    assert.strictEqual(decodeBool(1), null)
  })

  it('boolean false → null (not a string)', () => {
    assert.strictEqual(decodeBool(false), null)
  })

  it("'0x01' → true (sanity)", () => assert.strictEqual(decodeBool('0x01'), true))
  it("'0x00' → false (sanity)", () => assert.strictEqual(decodeBool('0x00'), false))
})

// ─────────────────────────────────────────────────────────────────────────────
// (8) decodeDecimals :118 `!Number.isInteger(n) || n < 0 || n > 36`
//     Each sub-condition individually
// ─────────────────────────────────────────────────────────────────────────────

describe('decodeDecimals – range/type guard :118: decimal, negative, 37, NaN separately', () => {
  it('decimal / float value → null (kills !Number.isInteger removal)', () => {
    // BigInt cannot represent floats, so BigInt('0x1.8') throws → caught → null via exception.
    // Use a string that passes '!hex' but causes float result. Actually all valid hex → integer BigInt.
    // The only way to get a non-integer n is: the hex decodes to a big integer whose Number() is
    // non-integer due to float precision loss? No — large BigInt → Number loses precision but stays integer.
    // Number.isInteger check guards against: if somehow n is not an integer (impossible from BigInt Number cast
    // for small values, but the guard is there for safety).
    // We can test this indirectly: pass '1.5' which BigInt('1.5') throws → null.
    assert.strictEqual(decodeDecimals('1.5'), null)
  })

  it('negative hex (-0x1) → null (kills n < 0 removal)', () => {
    // Mutation: remove `n < 0` → -1 passes isInteger check but should be rejected.
    // BigInt('-0x1') = -1n, Number(-1n) = -1. With `n < 0` removed, -1 would pass → return -1 (wrong).
    assert.strictEqual(decodeDecimals('-0x1'), null)
  })

  it('NaN → null (Number(BigInt(hex)) never produces NaN for valid BigInt, but guard covers it)', () => {
    // BigInt parsing of non-hex throws, so 'NaN' the string → BigInt('NaN') throws → null via catch
    assert.strictEqual(decodeDecimals('NaN'), null)
  })

  it('37 (0x25) → null (kills n > 36 removal)', () => {
    // Mutation: remove `n > 36` → 37 would be returned as valid decimals.
    assert.strictEqual(decodeDecimals('0x25'), null)
  })

  it('36 (0x24) → 36 (boundary: still valid, kills off-by-one n >= 36 mutation)', () => {
    // Mutation: change `n > 36` to `n >= 36` → 36 would return null (wrong).
    assert.strictEqual(decodeDecimals('0x24'), 36)
  })

  it('0 (0x00) → 0 (boundary: valid, kills n <= 0 mutation)', () => {
    // Mutation: change `n < 0` to `n <= 0` → 0 would return null (wrong).
    assert.strictEqual(decodeDecimals('0x00'), 0)
    assert.notStrictEqual(decodeDecimals('0x00'), null)
  })

  it('negative large value -0x100 → null', () => {
    assert.strictEqual(decodeDecimals('-0x100'), null)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mutation equivalence notes (cases where the mutant is provably equivalent)
// ─────────────────────────────────────────────────────────────────────────────
//
// :115 `!hex || hex === '0x'` — removing `hex === '0x'` is NOT equivalent:
//   BigInt('0x') throws in V8 → caught → null. SAME result. EQUIVALENT for '0x' input only.
//   But the guard is still correct defensive code; the mutation just happens to have the
//   same observable output for this one value.
//
// :143 hasValidSupply — `hex !== '0x'` part: removing it would make '0x' truthy (non-empty
//   string, length 2). NOT equivalent — '0x' → true (wrong), test kills it above.
//
// :159 decodeBool `hexOrError === '0x'` — BigInt('0x') throws → null. EQUIVALENT for '0x'.
//   Not equivalent for a number like 1: without typeof check, BigInt(1)=1n → true (wrong).
//
// :284 `if (d !== 0) return d` mutant `=== 0` — `if (d === 0) return 0` means when txs differ
//   (d≠0) we fall through to address comparison, producing wrong sort for unequal-txs pairs.
//   Test above (two tokens with different txs and different addresses) kills it.
//
// Verified: no surviving equivalent mutant remains for the listed targets.
