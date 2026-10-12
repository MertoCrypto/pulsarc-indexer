// Pure helpers for label.mjs (no I/O, import-safe).

// Well-known singletons that exist at the same address on every EVM chain.
export const KNOWN = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', kind: 'infra' },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { name: 'ERC-4337 EntryPoint v0.7', kind: 'account-abstraction' },
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { name: 'ERC-4337 EntryPoint v0.6', kind: 'account-abstraction' },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', kind: 'infra' },
  '0x3600000000000000000000000000000000000000': { name: 'USDC', kind: 'token' },
}

/** Decodes an ABI-encoded string return value; returns null for anything that is not one. */
export function decodeString(hex) {
  if (!hex || hex === '0x' || hex.length < 130) return null
  try {
    const bytes = Buffer.from(hex.slice(2), 'hex')
    const offset = Number(BigInt('0x' + bytes.subarray(0, 32).toString('hex')))
    const len = Number(BigInt('0x' + bytes.subarray(offset, offset + 32).toString('hex')))
    if (len === 0 || len > 80) return null
    const s = bytes.subarray(offset + 32, offset + 32 + len).toString('utf8')
    return /^[\x20-\x7e -￿]+$/.test(s) ? s.trim() : null
  } catch { return null }
}
