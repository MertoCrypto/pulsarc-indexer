// Pure helpers for T3a counters: automated-sender detection, payment-size buckets,
// and ERC-4337 UserOp counting.
//
// No top-level await, no I/O.  Imported by run.mjs; tested by test/counters.test.mjs.

// ── Constants ────────────────────────────────────────────────────────────────

/** A sender is "automated" when its tx count in a single hour reaches this threshold. */
export const AUTO_TX_PER_HOUR = 60

/**
 * topic0 for ERC-4337 UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256).
 * UNVERIFIED: cannot compute Ethereum-legacy keccak256 with plain Node crypto (Node uses
 * NIST SHA-3, not Ethereum's Keccak-256 variant).  Must be checked against a real
 * EntryPoint log on testnet before relying on this value.
 * The value 0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f was
 * confirmed in a previous session by reading the EntryPoint source / ABI.
 */
export const USER_OP_TOPIC = '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f'

/**
 * Canonical ERC-4337 EntryPoint addresses (lowercased).
 * Taken from label.mjs KNOWN map which is the authoritative source in this repo.
 */
export const ENTRY_POINTS = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',  // v0.6
  '0x0000000071727de22e5e9d8baf0edac6f37da032',  // v0.7
])

/**
 * USDC token address on Arc (mainnet and testnet share the same address).
 * Taken from label.mjs KNOWN map: { '0x3600000000000000000000000000000000000000': { name: 'USDC', ... } }
 * USDC decimals on Arc ERC-20: 6 (verified in the decimals cache fetched at run startup; the
 * constant 6 is used as a fallback in tests only — production always reads from metaCache).
 */
export const USDC = '0x3600000000000000000000000000000000000000'

// ── Part 1: automated-sender stats ──────────────────────────────────────────

/**
 * Given the `senders` map { address: count } (already a counter map after T3a),
 * return { senders: N, tx: M } where N = senders with count >= AUTO_TX_PER_HOUR
 * and M = their combined tx count.
 *
 * Also accepts the old shape where values are 1 (all senders below threshold).
 *
 * @param {Record<string,number>} sendersMap
 * @returns {{ senders: number, tx: number }}
 */
export function autoStats(sendersMap) {
  let senders = 0, tx = 0
  for (const count of Object.values(sendersMap)) {
    const n = typeof count === 'number' ? count : 1  // backwards compat: old shape value=1
    if (n >= AUTO_TX_PER_HOUR) {
      senders++
      tx += n
    }
  }
  return { senders, tx }
}

// ── Part 2: payment-size buckets ─────────────────────────────────────────────

/**
 * Bucket boundaries for the largest USDC transfer per transaction:
 *   [0]  amount < 250
 *   [1]  250 <= amount <= 10_000
 *   [2]  amount > 10_000
 *
 * @param {number} amount  USDC amount (human units, e.g. 1.5 for 1.5 USDC)
 * @returns {0|1|2}
 */
export function bucketIndex(amount) {
  if (amount < 250) return 0
  if (amount <= 10_000) return 1
  return 2
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Find the largest USDC ERC-20 Transfer amount in a receipt's log array.
 * Only counts ERC-20 Transfer logs (exactly 3 topics, topics[0] = TRANSFER_TOPIC)
 * whose log.address matches usdcAddress (case-insensitive).
 *
 * Returns the amount in human units (divided by 10^decimals), or null when no
 * matching log exists.
 *
 * @param {object[]} logs          Receipt logs array
 * @param {string}   usdcAddress   Lowercased USDC contract address
 * @param {number}   decimals      Token decimals (6 for Arc USDC ERC-20)
 * @returns {number|null}
 */
export function largestUsdcTransfer(logs, usdcAddress, decimals) {
  if (!logs?.length) return null
  const target = usdcAddress.toLowerCase()
  let max = null
  for (const log of logs) {
    if (!log.topics || log.topics.length !== 3) continue
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue
    if (!log.address || log.address.toLowerCase() !== target) continue
    try {
      const raw = Number(BigInt(log.data))
      const amount = raw / 10 ** decimals
      if (max === null || amount > max) max = amount
    } catch {
      // malformed data — skip
    }
  }
  return max
}

// ── Part 3: ERC-4337 UserOp counting ─────────────────────────────────────────

/**
 * Count UserOperationEvent logs in a single receipt.
 *
 * A log counts when:
 *   - log.address (lowercased) is in ENTRY_POINTS
 *   - log.topics[0] === USER_OP_TOPIC
 *
 * @param {object} receipt  Single receipt from eth_getBlockReceipts
 * @returns {number}        Number of UserOp events found (0 if none)
 */
export function countUserOps(receipt) {
  let count = 0
  for (const log of receipt.logs ?? []) {
    if (!log.topics?.length) continue
    if (log.topics[0].toLowerCase() !== USER_OP_TOPIC) continue
    if (!log.address || !ENTRY_POINTS.has(log.address.toLowerCase())) continue
    count++
  }
  return count
}
