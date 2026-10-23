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
 * Topic0 for CCTP v2 TokenMessenger MintAndWithdraw(address indexed mintRecipient, uint256 amount,
 * address indexed mintToken, uint256 feeCollected).
 * = keccak256("MintAndWithdraw(address,uint256,address,uint256)")
 * VERIFIED: confirmed from Arc Mainnet inbound receipt (logIndex 0x8 in
 * 0xef0b4c5631df763e79c2160ec7f590c16e32754ba362ccc8f76f0c8921c5ba89).
 */
export const MINT_AND_WITHDRAW_TOPIC = '0x50c55e915134d457debfa58eb6f4342956f8b0616d51a89a3659360178e1ab63'

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
    if (raw.length < 6 * 64) return null  // amount .. maxFee are words 0-5
    const word = (i) => BigInt('0x' + raw.slice(i * 64, (i + 1) * 64))
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
    if (raw.length < 64) return null
    const sourceDomain = Number(BigInt('0x' + raw.slice(0, 64)))
    return { sourceDomain }
  } catch { return null }
}

/**
 * Decode a MintAndWithdraw log from TOKEN_MESSENGER_V2.
 * Non-indexed fields in data: amount(uint256) word 0, feeCollected(uint256) word 1.
 * (mintRecipient and mintToken are indexed topics, not in data.)
 *
 * Returns { amount, fee } or null on parse error / short data.
 * amount = toFixed(2), fee = toFixed(6) — same style as decodeDepositForBurn.
 *
 * @param {string} data      Log data hex string
 * @param {number} decimals  USDC decimals
 * @returns {{ amount: number, fee: number } | null}
 */
export function decodeMintAndWithdraw(data, decimals) {
  try {
    const raw = data.startsWith('0x') ? data.slice(2) : data
    if (raw.length < 2 * 64) return null  // need words 0 (amount) and 1 (feeCollected)
    const word  = (i) => BigInt('0x' + raw.slice(i * 64, (i + 1) * 64))
    const amount = Number(word(0)) / 10 ** decimals
    const fee    = Number(word(1)) / 10 ** decimals
    return { amount: +amount.toFixed(2), fee: +fee.toFixed(6) }
  } catch { return null }
}

/**
 * Scan a single receipt's logs and return all USDC inbound CCTP mints paired with their
 * source domain.  Each item in the returned array corresponds to one MintAndWithdraw log
 * whose mintToken matches the USDC address (case-insensitive) and whose emitting contract
 * is the tokenMessenger address (case-insensitive).
 *
 * Pairing strategy: for each qualifying MintAndWithdraw log, look for the FIRST
 * MessageReceived log (from messageTransmitter, appearing AFTER the MintAndWithdraw)
 * that has not already been consumed.  If found, attach its sourceDomain; otherwise
 * domain is null (the MessageReceived was absent or already consumed).
 *
 * Returns an empty array when the receipt has no qualifying USDC MintAndWithdraw logs.
 * A MessageReceived with no matching MintAndWithdraw (e.g. non-USDC message) is silently
 * ignored — the existing in[0] counter in run.mjs continues to count all MessageReceived
 * events unchanged.
 *
 * @param {object[]} logs
 * @param {{ tokenMessenger: string, messageTransmitter: string, usdc: string, decimals: number }} opts
 * @returns {{ usdc: number, fee: number, domain: number|null }[]}
 */
export function bridgeInsFromReceipt(logs, { tokenMessenger, messageTransmitter, usdc, decimals }) {
  const tmLc  = tokenMessenger.toLowerCase()
  const mtLc  = messageTransmitter.toLowerCase()
  const usdcLc = usdc.toLowerCase()

  // First pass: collect MintAndWithdraw entries (USDC only) with their log index position
  const mints = []
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]
    if (!log.topics?.length) continue
    if (log.address?.toLowerCase() !== tmLc) continue
    if (log.topics[0].toLowerCase() !== MINT_AND_WITHDRAW_TOPIC) continue
    // topics[2] = mintToken (padded address); last 40 hex chars = address
    if (!log.topics[2]) continue
    const mintToken = ('0x' + log.topics[2].slice(-40)).toLowerCase()
    if (mintToken !== usdcLc) continue
    const decoded = decodeMintAndWithdraw(log.data, decimals)
    if (!decoded) continue
    mints.push({ logIdx: i, usdc: decoded.amount, fee: decoded.fee })
  }

  if (mints.length === 0) return []

  // Second pass: build an ordered list of MessageReceived log positions
  const mrPositions = []
  for (let i = 0; i < logs.length; i++) {
    const log = logs[i]
    if (!log.topics?.length) continue
    if (log.address?.toLowerCase() !== mtLc) continue
    if (log.topics[0].toLowerCase() !== MESSAGE_RECEIVED_TOPIC) continue
    const decoded = decodeMessageReceived(log.data)
    mrPositions.push({ logIdx: i, sourceDomain: decoded?.sourceDomain ?? null })
  }

  // Pair each mint with the first unconsumed MessageReceived that appears after it
  const usedMr = new Set()
  const result = []
  for (const mint of mints) {
    let paired = null
    for (let j = 0; j < mrPositions.length; j++) {
      if (usedMr.has(j)) continue
      if (mrPositions[j].logIdx > mint.logIdx) {
        paired = mrPositions[j]
        usedMr.add(j)
        break
      }
    }
    // If no MessageReceived found after, also try any unconsumed one (before) for robustness
    if (!paired) {
      for (let j = 0; j < mrPositions.length; j++) {
        if (usedMr.has(j)) continue
        paired = mrPositions[j]
        usedMr.add(j)
        break
      }
    }
    result.push({
      usdc:   mint.usdc,
      fee:    mint.fee,
      domain: paired ? paired.sourceDomain : null,
    })
  }
  return result
}

// ── T3b Part 5b: accumulateBridge ────────────────────────────────────────────

/**
 * Accumulate CCTP bridge events from a single receipt's logs into the hour
 * accumulator `h._bridge`.  Mutates `h` in place; creates `h._bridge` when
 * absent.  Tolerates an old restored `_bridge` shape with `in:[n]` and no
 * `byDomainIn` key.
 *
 * Logic is identical to the inline bridge block in run.mjs apply():
 *   - DepositForBurn from tokenMessenger  → out[0]++, out[1]+=amount, out[2]+=maxFee,
 *                                           byDomain[domain]++/+=amount (20-domain cap)
 *   - MessageReceived from messageTransmitter → in[0]++
 *   - bridgeInsFromReceipt (MintAndWithdraw) → in[1]+=usdc, in[2]+=fee,
 *                                               byDomainIn[domain]++/+=usdc (20-domain cap)
 *
 * @param {object}   h       Hour accumulator (mutated in place)
 * @param {object[]} logs    Receipt logs array
 * @param {{ tokenMessenger: string, messageTransmitter: string, usdc: string, decimals: number }} opts
 */
export function accumulateBridge(h, logs, { tokenMessenger, messageTransmitter, usdc, decimals }) {
  const tmLc = tokenMessenger.toLowerCase()
  const mtLc = messageTransmitter.toLowerCase()

  for (const log of logs ?? []) {
    if (!log.topics?.length) continue

    // Outgoing: DepositForBurn from TokenMessenger
    if (log.address?.toLowerCase() === tmLc &&
        log.topics[0].toLowerCase() === DEPOSIT_FOR_BURN_TOPIC) {
      const decoded = decodeDepositForBurn(log.data, decimals)
      if (decoded) {
        const br = h._bridge ?? (h._bridge = { out: [0, 0, 0], in: [0, 0, 0], byDomain: {}, byDomainIn: {} })
        br.out[0]++
        br.out[1] = +(br.out[1] + decoded.amount).toFixed(2)
        br.out[2] = +(br.out[2] + decoded.maxFee).toFixed(6)
        const dk = String(decoded.domain)
        br.byDomain[dk] ??= [0, 0]
        br.byDomain[dk][0]++
        br.byDomain[dk][1] = +(br.byDomain[dk][1] + decoded.amount).toFixed(2)
        // Keep at most 20 domains
        const domKeys = Object.keys(br.byDomain)
        if (domKeys.length > 20) {
          const oldest = domKeys[0]; delete br.byDomain[oldest]
        }
      }
    }

    // Incoming count: MessageReceived from MessageTransmitter (in[0] only, for backwards compat)
    if (log.address?.toLowerCase() === mtLc &&
        log.topics[0].toLowerCase() === MESSAGE_RECEIVED_TOPIC) {
      const br = h._bridge ?? (h._bridge = { out: [0, 0, 0], in: [0, 0, 0], byDomain: {}, byDomainIn: {} })
      br.in[0]++
    }
  }

  // Incoming USDC amounts and source domains via MintAndWithdraw pairing
  const brIns = bridgeInsFromReceipt(logs ?? [], { tokenMessenger, messageTransmitter, usdc, decimals })
  for (const item of brIns) {
    const br = h._bridge ?? (h._bridge = { out: [0, 0, 0], in: [0, 0, 0], byDomain: {}, byDomainIn: {} })
    // Ensure in array is at least length 3 (tolerate old in:[n] shape loaded from open.json)
    while (br.in.length < 3) br.in.push(0)
    br.in[1] = +(((br.in[1] ?? 0) + item.usdc)).toFixed(2)
    br.in[2] = +(((br.in[2] ?? 0) + item.fee)).toFixed(6)
    const dk = String(item.domain ?? -1)
    br.byDomainIn ??= {}
    br.byDomainIn[dk] ??= [0, 0]
    br.byDomainIn[dk][0]++
    br.byDomainIn[dk][1] = +(br.byDomainIn[dk][1] + item.usdc).toFixed(2)
    // Keep at most 20 domains
    const domInKeys = Object.keys(br.byDomainIn)
    if (domInKeys.length > 20) {
      const oldest = domInKeys[0]; delete br.byDomainIn[oldest]
    }
  }
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


// ── Receipt sanity check (Blockdaemon returns EMPTY receipts for pruned blocks without any error) ──

/**
 * Indexes (into a fetchBatch result: [block0, receipts0, block1, receipts1, ...]) whose receipts do not
 * match the block's transaction list. A correct node returns exactly one receipt per transaction; an
 * endpoint that has pruned a block answers [] (or null) with no error, which would silently be indexed
 * as "0 transactions". Blocks without a `transactions` array are not checked.
 * @param {number} count  number of blocks in the batch
 * @param {any[]}  out    interleaved block/receipts results
 * @returns {number[]}
 */
export function badReceiptIndexes(count, out) {
  const bad = []
  for (let i = 0; i < count; i++) {
    const block = out[i * 2]
    const receipts = out[i * 2 + 1]
    if (!block || !Array.isArray(block.transactions)) continue
    const have = Array.isArray(receipts) ? receipts.length : 0
    if (have !== block.transactions.length) bad.push(i)
  }
  return bad
}
