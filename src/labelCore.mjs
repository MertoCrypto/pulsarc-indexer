// Pure helpers for label.mjs (no I/O, import-safe).

// Well-known singletons that exist at the same address on every EVM chain.
export const KNOWN = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', kind: 'infra' },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { name: 'ERC-4337 EntryPoint v0.7', kind: 'account-abstraction' },
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { name: 'ERC-4337 EntryPoint v0.6', kind: 'account-abstraction' },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', kind: 'infra' },
  '0x3600000000000000000000000000000000000000': { name: 'USDC', kind: 'token' },
}

// Invisible / direction-changing Unicode code points that must be stripped from
// any name read from the chain to prevent homoglyph / direction-spoofing attacks.
// Ranges stripped (inclusive):
//   U+0000-U+001F  C0 controls
//   U+007F-U+009F  DEL + C1 controls
//   U+00AD         soft hyphen (invisible in most renderers)
//   U+061C         Arabic letter mark
//   U+200B-U+200F  zero-width space, joiners, direction marks
//   U+202A-U+202E  LTR/RTL embedding and override characters
//   U+2060-U+2069  word joiner, invisible operators, isolate marks
//   U+FEFF         BOM / zero-width no-break space
const STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/gu

/**
 * Sanitise a string read from the chain:
 *  - Returns null when `s` is not a string.
 *  - Strips all invisible / direction-changing code points listed above.
 *  - Collapses consecutive whitespace to a single U+0020 and trims.
 *  - Returns null when the result is empty.
 *  - Truncates to at most 80 Unicode code points (surrogate-pair-aware).
 *  - Does NOT apply NFKC normalisation (intentional).
 */
export function cleanName(s) {
  if (typeof s !== 'string') return null
  const stripped = s.replace(STRIP_RE, '')
  const collapsed = stripped.replace(/\s+/gu, ' ').trim()
  if (collapsed.length === 0) return null
  // Spread to a code-point array so surrogate pairs count as one unit.
  const codePoints = [...collapsed]
  return codePoints.length <= 80 ? collapsed : codePoints.slice(0, 80).join('')
}

/**
 * Decodes an ABI-encoded string return value; returns null for anything that is
 * not a well-formed, printable, non-spoofed string.
 *
 * Pipeline: decode -> 80-byte length guard -> printable-range regex ->
 *           cleanName (strips invisible/directional chars, collapses spaces,
 *           enforces 80 code-point limit).
 */
export function decodeString(hex) {
  if (!hex || hex === '0x' || hex.length < 130) return null
  try {
    const bytes = Buffer.from(hex.slice(2), 'hex')
    const offset = Number(BigInt('0x' + bytes.subarray(0, 32).toString('hex')))
    const len = Number(BigInt('0x' + bytes.subarray(offset, offset + 32).toString('hex')))
    if (len === 0 || len > 80) return null
    const s = bytes.subarray(offset + 32, offset + 32 + len).toString('utf8')
    // Existing guard: reject C0 controls and anything outside U+0020-U+FFFD.
    if (!/^[\u0020-\u007e\u00a0-\ufffd]+$/.test(s)) return null
    return cleanName(s.trim())
  } catch { return null }
}
