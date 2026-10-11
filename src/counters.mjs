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

// ── T3b Constants ─────────────────────────────────────────────────────────────

/**
 * EURC token address per network (testnet: apps.testnet.json anchor; mainnet: apps.mainnet.json anchor,
 * symbol() checked on-chain as "EURC"). EURC follows the NET environment variable like run.mjs does.
 */
export const EURC_BY_NET = {
  testnet: '0x89b50855aa3be2f677cd6303cec089b5f319d72a',
  mainnet: '0xbef5f6d51cb62b58e6a8f77868681825c6fe21c1',
}
export const EURC = EURC_BY_NET[process.env.NET === 'mainnet' ? 'mainnet' : 'testnet']

/**
 * CCTP v2 TokenMessenger contract addresses (one per network).
 * Source: provided in spec as verified.
 */
export const TOKEN_MESSENGER_V2 = {
  testnet: '0x8fe6b999dc680ccfdd5bf7eb0974218be2542daa',
  mainnet: '0x28b5a0e9c621a5badaa536219b3a228c8168cf5d',
}

/**
 * CCTP v2 MessageTransmitter contract addresses (one per network).
 * Source: provided in spec as verified.
 */
export const MESSAGE_TRANSMITTER_V2 = {
  testnet: '0xe737e5cebeeba77efe34d4aa090756590b1ce275',
  mainnet: '0x81d40f21f12a8f0e3252bccb954d722d4c464b64',
}

/**
 * Topic0 for ERC-20 Transfer(address indexed from, address indexed to, uint256 value).
 * Already exported internally; re-export for T3b tests.
 */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * Topic0 for Blacklisted(address indexed _account). VERIFIED (provided in spec).
 */
export const BLACKLISTED_TOPIC = '0xffa4e6181777692565cf28528fc88fd1516ea86b56da075235fa575af6a4b855'

/**
 * Topic0 for UnBlacklisted(address indexed _account). VERIFIED (provided in spec).
 */
export const UNBLACKLISTED_TOPIC = '0x117e3210bb9aa7d9baff172026820255c6f6c30ba8999d1c2fd88e2848137c4e'

/**
 * Topic0 for CCTP v2 TokenMessenger DepositForBurn. VERIFIED (provided in spec).
 */
export const DEPOSIT_FOR_BURN_TOPIC = '0x0c8c1cbdc5190613ebd485511d4e2812cfa45eecb79d845893331fedad5130a5'

/**
 * Topic0 for CCTP v2 MessageTransmitter MessageReceived. VERIFIED (provided in spec).
 */
export const MESSAGE_RECEIVED_TOPIC = '0xff48c13eda96b1cceacc6b9edeedc9e9db9d6226afbc30146b720c19d3addb1c'

/**
 * Big-transfer threshold in USDC. Transfers >= this value are tracked individually.
 */
export const BIG_TRANSFER_USDC = 5_000_000

// ── T3b Part 1: big transfers ──────────────────────────────────────────────────

/**
 * Scan a receipt's logs for USDC Transfer logs >= BIG_TRANSFER_USDC.
 * Returns { tx, amt, from, to } for each qualifying log.
 * `from` / `to` are the last 20 bytes of topics[1] / topics[2] (lowercased).
 *
 * @param {object[]} logs          Receipt logs
 * @param {string}   txHash        Receipt transactionHash
 * @param {string}   usdcAddr      Lowercased USDC contract address
 * @param {number}   decimals      USDC decimals (6)
 * @returns {{ tx: string, amt: number, from: string, to: string }[]}
 */
export function bigTransfers(logs, txHash, usdcAddr, decimals) {
  const out = []
  for (const log of logs ?? []) {
    if (!log.topics || log.topics.length !== 3) continue
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue
    if (!log.address || log.address.toLowerCase() !== usdcAddr.toLowerCase()) continue
    try {
      const amt = Number(BigInt(log.data)) / 10 ** decimals
      if (amt < BIG_TRANSFER_USDC) continue
      const addrFrom = ('0x' + log.topics[1].slice(-40)).toLowerCase()
      const addrTo   = ('0x' + log.topics[2].slice(-40)).toLowerCase()
      out.push({ tx: txHash, amt, from: addrFrom, to: addrTo })
    } catch { /* malformed — skip */ }
  }
  return out
}

// ── T3b Part 2: mint and burn ──────────────────────────────────────────────────

/**
 * Scan a receipt's logs for USDC/EURC mints (from == zero address) and burns
 * (to == zero address). Returns { usdc: [mintAmt, burnAmt], eurc: [mintAmt, burnAmt] }
 * or null when no mint/burn logs are found.
 *
 * @param {object[]} logs        Receipt logs
 * @param {string}   usdcAddr    Lowercased USDC address
 * @param {string}   eurcAddr    Lowercased EURC address
 * @param {number}   decimals    Token decimals (6 for both on Arc)
 * @returns {{ usdc?: [number,number], eurc?: [number,number] } | null}
 */
export function mintBurnFromLogs(logs, usdcAddr, eurcAddr, decimals) {
  const ZERO = '0x' + '0'.repeat(40)
  let usdcMint = 0, usdcBurn = 0, eurcMint = 0, eurcBurn = 0
  let found = false
  for (const log of logs ?? []) {
    if (!log.topics || log.topics.length !== 3) continue
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue
    const addr = log.address?.toLowerCase()
    const isUsdc = addr === usdcAddr.toLowerCase()
    const isEurc = addr === eurcAddr.toLowerCase()
    if (!isUsdc && !isEurc) continue
    const from = ('0x' + log.topics[1].slice(-40)).toLowerCase()
    const to   = ('0x' + log.topics[2].slice(-40)).toLowerCase()
    const isMint = from === ZERO
    const isBurn = to   === ZERO
    if (!isMint && !isBurn) continue
    try {
      const amt = +(Number(BigInt(log.data)) / 10 ** decimals).toFixed(2)
      found = true
      if (isUsdc) { if (isMint) usdcMint += amt; else usdcBurn += amt }
      else        { if (isMint) eurcMint += amt; else eurcBurn += amt }
    } catch { /* malformed */ }
  }
  if (!found) return null
  const result = {}
  if (usdcMint > 0 || usdcBurn > 0) result.usdc = [+usdcMint.toFixed(2), +usdcBurn.toFixed(2)]
  if (eurcMint > 0 || eurcBurn > 0) result.eurc = [+eurcMint.toFixed(2), +eurcBurn.toFixed(2)]
  return Object.keys(result).length ? result : null
}

// ── T3b Part 3: blocklist ─────────────────────────────────────────────────────

/**
 * Scan a receipt's logs for USDC/EURC Blacklisted / UnBlacklisted events.
 * Returns { added: number, removed: number, addrs: [{token, addr, kind}] } or null.
 *
 * @param {object[]} logs
 * @param {string}   usdcAddr
 * @param {string}   eurcAddr
 * @returns {{ added: number, removed: number, addrs: {token: string, addr: string, kind: string}[] } | null}
 */
export function blocklistFromLogs(logs, usdcAddr, eurcAddr) {
  let added = 0, removed = 0
  const addrs = []
  for (const log of logs ?? []) {
    if (!log.topics?.length) continue
    const addr = log.address?.toLowerCase()
    const isUsdc = addr === usdcAddr.toLowerCase()
    const isEurc = addr === eurcAddr.toLowerCase()
    if (!isUsdc && !isEurc) continue
    const t0 = log.topics[0].toLowerCase()
    const isAdd = t0 === BLACKLISTED_TOPIC
    const isRem = t0 === UNBLACKLISTED_TOPIC
    if (!isAdd && !isRem) continue
    if (isAdd) added++
    else       removed++
    if (log.topics[1]) {
      addrs.push({
        token: isUsdc ? 'usdc' : 'eurc',
        addr:  ('0x' + log.topics[1].slice(-40)).toLowerCase(),
        kind:  isAdd ? 'blacklisted' : 'unblacklisted',
      })
    }
  }
  if (added === 0 && removed === 0) return null
  return { added, removed, addrs }
}

// ── T3b Part 4: CCTP bridge ──────────────────────────────────────────────────

/**
 * Decode a DepositForBurn log from TOKEN_MESSENGER_V2.
 * Non-indexed fields in data: amount(uint256), mintRecipient(bytes32), destinationDomain(uint32),
 * destinationTokenMessenger(bytes32), destinationCaller(bytes32), maxFee(uint256), ...
 * word 0 = amount, word 2 = destinationDomain, word 5 = maxFee.
 *
 * Returns { amount, domain, maxFee } or null on parse error.
 *
 * @param {string} data   Log data hex string
 * @param {number} decimals  USDC decimals
 * @returns {{ amount: number, domain: number, maxFee: number } | null}
 */
export function decodeDepositForBurn(data, decimals) {
  // data is 0x-prefixed hex; each word is 32 bytes = 64 hex chars
  try {
    const raw = data.startsWith('0x') ? data.slice(2) : data
    const word = (i) => BigInt('0x' + (raw.slice(i * 64, (i + 1) * 64) || '0'))
    const amount  = Number(word(0)) / 10 ** decimals
    const domain  = Number(word(2))     // destinationDomain uint32 in word 2
    const maxFee  = Number(word(5)) / 10 ** decimals  // maxFee uint256 in word 5
    return { amount: +amount.toFixed(2), domain, maxFee: +maxFee.toFixed(6) }
  } catch { return null }
}

/**
 * Decode a MessageReceived log from MESSAGE_TRANSMITTER_V2.
 * Non-indexed fields: sourceDomain(uint32), sender(bytes32), ...
 * word 0 = sourceDomain.
 *
 * Returns { sourceDomain } or null on parse error.
 *
 * @param {string} data  Log data hex string
 * @returns {{ sourceDomain: number } | null}
 */
export function decodeMessageReceived(data) {
  try {
    const raw = data.startsWith('0x') ? data.slice(2) : data
    const sourceDomain = Number(BigInt('0x' + (raw.slice(0, 64) || '0')))
    return { sourceDomain }
  } catch { return null }
}

// ── T3b Part 6: supply series helpers ────────────────────────────────────────

/**
 * Parse a totalSupply() return value (hex-encoded uint256) into a human-readable
 * token amount using the given decimals.
 *
 * @param {string} hex       0x-prefixed hex (the eth_call return value)
 * @param {number} decimals  Token decimals
 * @returns {number}
 */
export function parseSupplyHex(hex, decimals) {
  if (!hex || hex === '0x') return 0
  return +(Number(BigInt(hex)) / 10 ** decimals).toFixed(decimals)
}

/**
 * Append a new hourly supply point to a series array, keeping at most 168 points.
 * Deduplicates by UTC hour key — if the same hour is already at the tail, updates it.
 *
 * @param {object[]} series   Existing series array (mutated in-place)
 * @param {string}   hourKey  UTC hour key like '2026-10-08T14'
 * @param {number}   supply   Token supply at this hour
 * @param {object}   [mb]     Optional mb entry for this hour { usdc?, eurc? }
 * @param {string}   token    'usdc' or 'eurc'
 * @returns {object[]}        Same array reference
 */
export function appendSupplySeries(series, hourKey, supply, mb, token) {
  const pt = { hour: hourKey, supply }
  // Attach mint/burn if the mb field has data for this token
  const mbToken = mb?.[token]
  if (mbToken) { pt.mint = mbToken[0]; pt.burn = mbToken[1] }

  if (series.length > 0 && series[series.length - 1].hour === hourKey) {
    series[series.length - 1] = pt   // update in-place (same hour, new call)
  } else {
    series.push(pt)
  }
  // Keep at most 168 points (7 days × 24 hours)
  if (series.length > 168) series.splice(0, series.length - 168)
  return series
}

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
    if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue  // uses exported TRANSFER_TOPIC
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
