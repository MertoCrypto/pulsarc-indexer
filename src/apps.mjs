// Pure app-stats accumulator for the Pulsarc indexer.
//
// accumulateApps(hourBucket, receipts, appsConfig, decimalsMap)
//   Mutates hourBucket.apps — called from apply() in run.mjs for each block's receipts.
//   No I/O; no side effects beyond the mutation.
//
// compactApps(hourBucket)
//   Converts each app's wallet Set → count, trims floats. Called from compact() in run.mjs.

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const ZERO = '0x0000000000000000000000000000000000000000'

/** Pads / normalises a raw topic or address field to a checksumless lowercase 0x address. */
function topicToAddress(topic) {
  // topics[1] and topics[2] are 32-byte padded; take the last 20 bytes (40 hex chars)
  return '0x' + topic.slice(-40).toLowerCase()
}

/**
 * Accumulate per-app metrics from one block's receipts into hourBucket.apps.
 *
 * @param {object}   hourBucket   - The live hour object (has .contracts, .senders, etc.)
 * @param {object[]} receipts     - Array of receipt objects from eth_getBlockReceipts
 * @param {object}   appsConfig   - Parsed apps.<net>.json: { apps: [{ id, anchors }] }
 * @param {object}   decimalsMap  - { <lowercaseAddress>: number } — cached decimals per token
 */
export function accumulateApps(hourBucket, receipts, appsConfig, decimalsMap) {
  if (!appsConfig?.apps?.length) return

  // Build lookup maps once per call (cheap; appsConfig is small)
  // contractAnchors: address → Set of appIds
  // tokenAnchors:    address → Set of appIds
  const contractAnchors = new Map() // lc address → Set<appId>
  const tokenAnchors    = new Map() // lc address → Set<appId>
  const anchorUsd       = new Set() // lc addresses that are usd:true

  for (const app of appsConfig.apps) {
    for (const anchor of app.anchors) {
      const addr = anchor.address.toLowerCase()
      if (anchor.kind === 'contract') {
        if (!contractAnchors.has(addr)) contractAnchors.set(addr, new Set())
        contractAnchors.get(addr).add(app.id)
      } else {
        if (!tokenAnchors.has(addr)) tokenAnchors.set(addr, new Set())
        tokenAnchors.get(addr).add(app.id)
        if (anchor.usd) anchorUsd.add(addr)
      }
    }
  }

  // Ensure hourBucket.apps exists; use Map internally for wallets (Set) during accumulation.
  // Shape while live: { <appId>: { tx, wallets: Set<addr>, vol, fee } }
  const apps = (hourBucket.apps ??= {})

  function getApp(id) {
    if (!apps[id]) apps[id] = { tx: 0, wallets: new Set(), vol: 0, fee: 0 }
    // Upgrade from already-compacted count back to Set if somehow mixed (shouldn't happen in normal flow)
    if (typeof apps[id].wallets === 'number') {
      apps[id]._walletCount = apps[id].wallets
      apps[id].wallets = new Set()
    }
    return apps[id]
  }

  for (const receipt of receipts) {
    const to = receipt.to ? receipt.to.toLowerCase() : null

    // ── Contract anchors ────────────────────────────────────────────────────
    if (to && contractAnchors.has(to)) {
      const fee = Number(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)) / 1e18
      const sender = receipt.from ? receipt.from.toLowerCase() : null
      for (const appId of contractAnchors.get(to)) {
        const a = getApp(appId)
        a.tx++
        a.fee += fee
        if (sender && sender !== to) a.wallets.add(sender)
      }
    }

    // ── Token anchors — scan logs ────────────────────────────────────────────
    for (const log of receipt.logs ?? []) {
      // Must be a Transfer log: exactly 3 topics, first topic is Transfer sig
      if (!log.topics || log.topics.length !== 3) continue
      if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue

      const logAddr = log.address ? log.address.toLowerCase() : null
      if (!logAddr || !tokenAnchors.has(logAddr)) continue

      const from = topicToAddress(log.topics[1])
      const toAddr = topicToAddress(log.topics[2])

      for (const appId of tokenAnchors.get(logAddr)) {
        const a = getApp(appId)
        a.tx++
        // Both from and to count as wallets, excluding zero address and the anchor itself
        if (from !== ZERO && from !== logAddr) a.wallets.add(from)
        if (toAddr !== ZERO && toAddr !== logAddr) a.wallets.add(toAddr)

        // Volume: only for usd anchors with a known decimals value
        if (anchorUsd.has(logAddr)) {
          const dec = decimalsMap[logAddr]
          if (typeof dec === 'number') {
            // log.data is a 0x-prefixed hex uint256
            try {
              const raw = BigInt(log.data)
              a.vol += Number(raw) / 10 ** dec
            } catch {
              // malformed data — skip silently
            }
          }
        }
      }
    }
  }
}

/**
 * Compact hourBucket.apps: convert each wallet Set to a count, round floats.
 * Called from compact() after accumulateApps has finished for the hour.
 * Safe to call on hours that have no `apps` field (legacy hours).
 */
export function compactApps(hourBucket) {
  if (!hourBucket.apps) return
  for (const [id, a] of Object.entries(hourBucket.apps)) {
    if (a.wallets instanceof Set) {
      a.wallets = a.wallets.size + (a._walletCount ?? 0)
      delete a._walletCount
    }
    a.vol  = +a.vol.toFixed(4)
    a.fee  = +a.fee.toFixed(6)
    hourBucket.apps[id] = a
  }
}
