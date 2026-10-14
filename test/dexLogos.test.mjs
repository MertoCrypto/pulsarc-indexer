import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { parseImageId, extractLogos, mergeLogos, chunk } from '../src/dexLogos.mjs'

// ── Fixtures ───────────────────────────────────────────────────────────────

const VALID_URL   = 'https://cdn.dexscreener.com/cms/images/UFEZCviZkGZAdWmq?width=800&height=800&quality=95&format=auto'
const VALID_ID    = 'UFEZCviZkGZAdWmq'

const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const ADDR_C = '0xcccccccccccccccccccccccccccccccccccccccc'

function makePair(address, imageUrl) {
  return {
    baseToken: { address },
    info:      { imageUrl },
  }
}

// ── parseImageId ───────────────────────────────────────────────────────────

describe('parseImageId — valid input', () => {
  it('extracts the id from the canonical CDN URL', () => {
    assert.equal(parseImageId(VALID_URL), VALID_ID)
  })

  it('accepts a URL with no query string', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/AbCdEf12'),
      'AbCdEf12',
    )
  })

  it('accepts ids with underscores and hyphens', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/aB3-xy_Z00'),
      'aB3-xy_Z00',
    )
  })

  it('accepts a 6-character id (minimum length)', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/Abc123'),
      'Abc123',
    )
  })

  it('accepts a 64-character id (maximum length)', () => {
    const id64 = 'A'.repeat(64)
    assert.equal(
      parseImageId(`https://cdn.dexscreener.com/cms/images/${id64}`),
      id64,
    )
  })
})

describe('parseImageId — hostile / invalid input', () => {
  it('returns null for a non-string value', () => {
    assert.equal(parseImageId(42), null)
    assert.equal(parseImageId(null), null)
    assert.equal(parseImageId(undefined), null)
    assert.equal(parseImageId({}), null)
    assert.equal(parseImageId([]), null)
  })

  it('returns null for an empty string', () => {
    assert.equal(parseImageId(''), null)
  })

  it('returns null for a javascript: URI', () => {
    assert.equal(parseImageId('javascript:alert(1)'), null)
  })

  it('returns null for http (non-https)', () => {
    assert.equal(
      parseImageId('http://cdn.dexscreener.com/cms/images/UFEZCviZkGZAdWmq'),
      null,
    )
  })

  it('returns null for a wrong host', () => {
    assert.equal(
      parseImageId('https://evil.example.com/cms/images/UFEZCviZkGZAdWmq'),
      null,
    )
  })

  it('returns null for a subdomain of the CDN host', () => {
    assert.equal(
      parseImageId('https://sub.cdn.dexscreener.com/cms/images/UFEZCviZkGZAdWmq'),
      null,
    )
  })

  it('returns null for a path traversal attempt', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/../etc/passwd'),
      null,
    )
  })

  it('returns null for a path traversal attempt with encoded slashes', () => {
    // %2F is decoded by URL parser to / — the extra segment makes slashIdx !== -1
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/UFEZCviZkGZAdWmq/extra'),
      null,
    )
  })

  it('returns null when the path does not start with /cms/images/', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/images/UFEZCviZkGZAdWmq'),
      null,
    )
  })

  it('returns null for an id that is too short (< 6 chars)', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/Ab1'),
      null,
    )
  })

  it('returns null for an id that is too long (> 64 chars)', () => {
    const id65 = 'A'.repeat(65)
    assert.equal(
      parseImageId(`https://cdn.dexscreener.com/cms/images/${id65}`),
      null,
    )
  })

  it('returns null for an id with disallowed characters (dot)', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/UFEZCviZ.Gmq'),
      null,
    )
  })

  it('returns null for an id with a space', () => {
    assert.equal(
      parseImageId('https://cdn.dexscreener.com/cms/images/UFEZ CviZkGZA'),
      null,
    )
  })

  it('returns null for a plain relative path string', () => {
    assert.equal(parseImageId('/cms/images/UFEZCviZkGZAdWmq'), null)
  })

  it('returns null for a totally arbitrary string', () => {
    assert.equal(parseImageId('not-a-url-at-all'), null)
  })
})

// ── extractLogos ───────────────────────────────────────────────────────────

describe('extractLogos — valid pairs', () => {
  it('returns an empty object for an empty array', () => {
    assert.deepEqual(extractLogos([]), {})
  })

  it('extracts a single logo from a realistic pair', () => {
    const pairs = [makePair(ADDR_A, VALID_URL)]
    const result = extractLogos(pairs)
    assert.deepEqual(result, { [ADDR_A.toLowerCase()]: VALID_ID })
  })

  it('lowercases the address key', () => {
    const mixed = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    const pairs = [makePair(mixed, VALID_URL)]
    const result = extractLogos(pairs)
    assert.ok(Object.keys(result)[0] === mixed.toLowerCase())
  })

  it('extracts logos from multiple pairs', () => {
    const urlB = 'https://cdn.dexscreener.com/cms/images/AnotherID1a?width=100'
    const pairs = [
      makePair(ADDR_A, VALID_URL),
      makePair(ADDR_B, urlB),
    ]
    const result = extractLogos(pairs)
    assert.equal(result[ADDR_A.toLowerCase()], VALID_ID)
    assert.equal(result[ADDR_B.toLowerCase()], 'AnotherID1a')
  })
})

describe('extractLogos — hostile / invalid input', () => {
  it('returns empty object for non-array input', () => {
    assert.deepEqual(extractLogos(null), {})
    assert.deepEqual(extractLogos(undefined), {})
    assert.deepEqual(extractLogos({}), {})
    assert.deepEqual(extractLogos('string'), {})
    assert.deepEqual(extractLogos(42), {})
  })

  it('skips pairs with no baseToken.address', () => {
    const pair = { info: { imageUrl: VALID_URL } }
    assert.deepEqual(extractLogos([pair]), {})
  })

  it('skips pairs with an empty address', () => {
    assert.deepEqual(extractLogos([makePair('', VALID_URL)]), {})
  })

  it('skips pairs with an invalid imageUrl (wrong host)', () => {
    const pair = makePair(ADDR_A, 'https://evil.com/cms/images/UFEZCviZkGZAdWmq')
    assert.deepEqual(extractLogos([pair]), {})
  })

  it('skips pairs with a javascript: imageUrl', () => {
    const pair = makePair(ADDR_A, 'javascript:alert(1)')
    assert.deepEqual(extractLogos([pair]), {})
  })

  it('skips pairs with null imageUrl', () => {
    const pair = makePair(ADDR_A, null)
    assert.deepEqual(extractLogos([pair]), {})
  })

  it('skips pairs with missing info', () => {
    const pair = { baseToken: { address: ADDR_A } }
    assert.deepEqual(extractLogos([pair]), {})
  })

  it('skips null elements in the array without crashing', () => {
    const pairs = [null, makePair(ADDR_A, VALID_URL), undefined]
    const result = extractLogos(pairs)
    assert.equal(result[ADDR_A.toLowerCase()], VALID_ID)
    assert.equal(Object.keys(result).length, 1)
  })

  it('only keeps the last value when the same address appears twice', () => {
    const urlB = 'https://cdn.dexscreener.com/cms/images/SecondIDxx1a'
    const pairs = [
      makePair(ADDR_A, VALID_URL),
      makePair(ADDR_A, urlB),
    ]
    const result = extractLogos(pairs)
    // Last write wins
    assert.equal(result[ADDR_A.toLowerCase()], 'SecondIDxx1a')
    assert.equal(Object.keys(result).length, 1)
  })
})

// ── mergeLogos ─────────────────────────────────────────────────────────────

describe('mergeLogos', () => {
  it('returns an empty object when both inputs are empty', () => {
    assert.deepEqual(mergeLogos({}, {}), {})
  })

  it('keeps entries from prev when next is empty', () => {
    const prev = { [ADDR_A]: 'OldID1234567' }
    assert.deepEqual(mergeLogos(prev, {}), prev)
  })

  it('adds entries from next when prev is empty', () => {
    const next = { [ADDR_B]: 'NewID1234567' }
    assert.deepEqual(mergeLogos({}, next), next)
  })

  it('merges prev and next without dropping prev-only entries', () => {
    const prev = { [ADDR_A]: 'IDforA123456', [ADDR_C]: 'IDforC123456' }
    const next = { [ADDR_B]: 'IDforB123456' }
    const result = mergeLogos(prev, next)
    assert.equal(result[ADDR_A], 'IDforA123456')
    assert.equal(result[ADDR_B], 'IDforB123456')
    assert.equal(result[ADDR_C], 'IDforC123456')
  })

  it('overwrites prev entry with next value for the same key', () => {
    const prev = { [ADDR_A]: 'OldID1234567' }
    const next = { [ADDR_A]: 'NewID1234567' }
    const result = mergeLogos(prev, next)
    assert.equal(result[ADDR_A], 'NewID1234567')
  })

  it('does not mutate either input', () => {
    const prev = { [ADDR_A]: 'OldID1234567' }
    const next = { [ADDR_B]: 'NewID1234567' }
    mergeLogos(prev, next)
    assert.equal(Object.keys(prev).length, 1)
    assert.equal(Object.keys(next).length, 1)
  })
})

// ── chunk ──────────────────────────────────────────────────────────────────

describe('chunk', () => {
  it('returns an empty array for an empty input', () => {
    assert.deepEqual(chunk([], 10), [])
  })

  it('returns a single chunk when array length < n', () => {
    assert.deepEqual(chunk([1, 2, 3], 10), [[1, 2, 3]])
  })

  it('returns a single chunk when array length equals n', () => {
    assert.deepEqual(chunk([1, 2, 3], 3), [[1, 2, 3]])
  })

  it('splits evenly', () => {
    assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
  })

  it('puts the remainder in the last chunk', () => {
    const result = chunk([1, 2, 3, 4, 5], 2)
    assert.deepEqual(result, [[1, 2], [3, 4], [5]])
  })

  it('works with batch size of 30 (realistic)', () => {
    const addrs = Array.from({ length: 75 }, (_, i) => `0x${String(i).padStart(40, '0')}`)
    const result = chunk(addrs, 30)
    assert.equal(result.length, 3)
    assert.equal(result[0].length, 30)
    assert.equal(result[1].length, 30)
    assert.equal(result[2].length, 15)
  })

  it('returns [] for non-array input', () => {
    assert.deepEqual(chunk(null, 10), [])
    assert.deepEqual(chunk(undefined, 10), [])
  })

  it('returns [] for n < 1', () => {
    assert.deepEqual(chunk([1, 2, 3], 0), [])
    assert.deepEqual(chunk([1, 2, 3], -1), [])
  })

  it('does not mutate the input array', () => {
    const arr = [1, 2, 3]
    chunk(arr, 2)
    assert.deepEqual(arr, [1, 2, 3])
  })
})
