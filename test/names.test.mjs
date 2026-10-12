import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { NAMES, appName } from '../src/names.mjs'

// ---------------------------------------------------------------------------
// NAMES map
// ---------------------------------------------------------------------------
describe('NAMES', () => {
  it('is a plain object', () => {
    assert.equal(typeof NAMES, 'object')
    assert.notEqual(NAMES, null)
    assert.ok(!Array.isArray(NAMES))
  })

  it('contains all well-known ids', () => {
    const expected = [
      'usdc', 'eurc', 'usyc', 'cirbtc', 'weth', 'stablefx', 'memo',
      'multicall', 'cctp', 'gateway', 'erc8004', 'erc8183', 'wusdc',
      'arc-dollar', 'xylonet', 'curve-usdc-eurc', 'swaparc', 'synthra',
      'unitflow', 'arcflow', 'axpha', 'onmifun', 'uniswap', 'across',
    ]
    for (const id of expected) {
      assert.ok(id in NAMES, `NAMES missing key: ${id}`)
    }
  })

  it('has exact values for spot-checked ids', () => {
    assert.equal(NAMES['usdc'], 'USDC')
    assert.equal(NAMES['eurc'], 'EURC')
    assert.equal(NAMES['cctp'], 'CCTP v2')
    assert.equal(NAMES['gateway'], 'Circle Gateway')
    assert.equal(NAMES['erc8004'], 'ERC-8004 Identity')
    assert.equal(NAMES['erc8183'], 'Agentic Commerce')
    assert.equal(NAMES['arc-dollar'], 'Arc Dollar')
    assert.equal(NAMES['curve-usdc-eurc'], 'Curve USDC/EURC')
    assert.equal(NAMES['multicall'], 'Multicall3From')
    assert.equal(NAMES['uniswap'], 'Uniswap')
    assert.equal(NAMES['across'], 'Across')
  })

  it('does not contain keys that were never added', () => {
    assert.equal(NAMES['bitcoin'], undefined)
    assert.equal(NAMES['ethereum'], undefined)
    assert.equal(NAMES['USDC'], undefined)   // keys are lowercase
  })
})

// ---------------------------------------------------------------------------
// appName()
// ---------------------------------------------------------------------------
describe('appName — known ids', () => {
  it('returns the mapped display name for every entry in NAMES', () => {
    for (const [id, expected] of Object.entries(NAMES)) {
      assert.equal(appName(id), expected, `appName('${id}') should be '${expected}'`)
    }
  })

  it('usdc → USDC', () => assert.equal(appName('usdc'), 'USDC'))
  it('arc-dollar → Arc Dollar', () => assert.equal(appName('arc-dollar'), 'Arc Dollar'))
  it('curve-usdc-eurc → Curve USDC/EURC', () => assert.equal(appName('curve-usdc-eurc'), 'Curve USDC/EURC'))
})

describe('appName — unknown ids fall back to capitalised id', () => {
  it('capitalises first letter of a simple unknown id', () => {
    assert.equal(appName('foobar'), 'Foobar')
  })

  it('capitalises only the first character, leaves the rest intact', () => {
    assert.equal(appName('myApp'), 'MyApp')
  })

  it('single-character id is capitalised', () => {
    assert.equal(appName('x'), 'X')
  })

  it('already-capitalised id is returned unchanged', () => {
    assert.equal(appName('Foobar'), 'Foobar')
  })

  it('id that starts with a digit: charAt(0).toUpperCase() is a no-op digit', () => {
    // documents current behaviour: '0abc' → '0abc' (digit toUpperCase is itself)
    assert.equal(appName('0abc'), '0abc')
  })

  it('empty string: charAt(0) is empty string, toUpperCase is "", slice(1) is "" → ""', () => {
    // documents current behaviour: appName('') === ''
    assert.equal(appName(''), '')
  })

  it('unknown id with hyphens is capitalised at first char only', () => {
    assert.equal(appName('my-protocol'), 'My-protocol')
  })

  it('unknown id that looks like a known id but differs in case is not found in NAMES', () => {
    // NAMES keys are lowercase; 'USDC' is not a key, so falls back
    assert.equal(appName('USDC'), 'USDC') // charAt(0).toUpperCase() of 'U' is 'U'
  })
})

describe('appName — non-string inputs', () => {
  it('number is converted via String(id)', () => {
    assert.equal(appName(42), '42')
  })

  it('null is converted to the string "null"', () => {
    assert.equal(appName(null), 'null')
  })

  it('undefined is converted to the string "undefined"', () => {
    assert.equal(appName(undefined), 'undefined')
  })

  it('boolean true → "true"', () => {
    assert.equal(appName(true), 'true')
  })

  it('boolean false → "false"', () => {
    assert.equal(appName(false), 'false')
  })

  it('object → "[object Object]"', () => {
    assert.equal(appName({}), '[object Object]')
  })

  it('array → its toString, e.g. ["a"] → "a"', () => {
    assert.equal(appName(['a']), 'a')
  })

  it('zero → "0"', () => {
    assert.equal(appName(0), '0')
  })
})

describe('appName — lookup is case-sensitive', () => {
  it('upper-case id is not found in NAMES, falls back to the id itself', () => {
    assert.equal(appName('UNISWAP'), 'UNISWAP')
    assert.equal(appName('Across'), 'Across')
  })
})
