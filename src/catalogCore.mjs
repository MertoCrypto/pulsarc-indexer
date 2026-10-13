// Pure helpers for catalog.mjs (no I/O, no network, import-safe).
//
// Generates a token/NFT catalogue from labels + discover data and eth_call probe results.

// Infrastructure kinds that are excluded from the catalogue entirely.
const INFRA_KINDS = new Set(['infra', 'account-abstraction'])

/**
 * Build a deduplicated, sorted list of candidate addresses to probe.
 *
 * Includes:
 *   - Every address in `appTokenAddresses` (kind==='token' anchors from apps.<NET>.json).
 *     These are ALWAYS included and sorted FIRST (priority tier 2 — highest).
 *   - Every address in `labels` whose `symbol` is a non-empty string,
 *     UNLESS its `kind` is 'infra' or 'account-abstraction'.
 *   - Every address in `discover.contracts`,
 *     UNLESS its address appears in `labels` with an infra kind.
 *
 * Returns lowercase addresses sorted:
 *   1. App-token addresses first (regardless of discover txs)
 *   2. discover txs descending (addresses not in discover get txs = 0)
 *   3. address ascending (tie-break)
 *
 * @param {Record<string, {contract?: boolean, name?: string|null, symbol?: string|null, kind?: string}>} labels
 * @param {{ contracts: { address: string, txs: number }[] }} discover
 * @param {string[]} [appTokenAddresses]  - Lowercase token anchor addresses from apps.<NET>.json
 * @returns {string[]}
 */
export function candidateAddresses(labels, discover, appTokenAddresses = []) {
  // Build a txs lookup from discover (lowercase keys)
  const discoverTxs = new Map()
  for (const c of discover?.contracts ?? []) {
    discoverTxs.set(c.address.toLowerCase(), c.txs)
  }

  // Build a set of app-token addresses for priority sorting
  const appTokenSet = new Set(appTokenAddresses.map((a) => a.toLowerCase()))

  const seen = new Set()

  // From appTokenAddresses: always include (priority tier)
  for (const a of appTokenSet) {
    seen.add(a)
  }

  // From labels: addresses with a non-empty string symbol, excluding infra kinds
  for (const [addr, entry] of Object.entries(labels)) {
    const a = addr.toLowerCase()
    if (INFRA_KINDS.has(entry.kind)) continue
    if (entry.symbol && typeof entry.symbol === 'string' && entry.symbol.length > 0) {
      seen.add(a)
    }
  }

  // From discover: all contract addresses, excluding those labelled as infra
  for (const c of discover?.contracts ?? []) {
    const a = c.address.toLowerCase()
    const labelEntry = labels[a]
    if (labelEntry && INFRA_KINDS.has(labelEntry.kind)) continue
    seen.add(a)
  }

  // Sort:
  //   1. app-token addresses first (isAppToken desc)
  //   2. discover txs descending
  //   3. address ascending (tie-break)
  return [...seen].sort((a, b) => {
    const appA = appTokenSet.has(a) ? 1 : 0
    const appB = appTokenSet.has(b) ? 1 : 0
    if (appB !== appA) return appB - appA
    const txsA = discoverTxs.get(a) ?? 0
    const txsB = discoverTxs.get(b) ?? 0
    if (txsB !== txsA) return txsB - txsA
    return a < b ? -1 : a > b ? 1 : 0
  })
}

/**
 * Classify a token probe result.
 *
 * @param {{
 *   name: string|null,
 *   symbol: string|null,
 *   decimals: string|null,   // raw hex from eth_call, e.g. '0x0000...0006', or null
 *   totalSupply: string|null, // raw hex from eth_call, or null
 *   is721: boolean|null,     // true if supportsInterface(0x80ac58cd) returned true
 *   is1155: boolean|null,    // true if supportsInterface(0xd9b67a26) returned true
 * }} probe
 * @returns {{ kind: 'erc20'|'erc721'|'erc1155'|'other' }}
 */
export function classify(probe) {
  const { decimals, totalSupply, is721, is1155 } = probe

  // ERC-1155 wins first
  if (is1155 === true) return { kind: 'erc1155' }

  // ERC-721 next
  if (is721 === true) return { kind: 'erc721' }

  // ERC-20: valid decimals (0..36 integer) AND valid totalSupply (non-null non-empty hex)
  const dec = decodeDecimals(decimals)
  if (dec !== null && hasValidSupply(totalSupply)) return { kind: 'erc20' }

  return { kind: 'other' }
}

/**
 * Decode a decimals eth_call result to a number, returning null if invalid.
 * Valid: integer in range 0..36 (inclusive).
 *
 * @param {string|null} hex
 * @returns {number|null}
 */
export function decodeDecimals(hex) {
  if (!hex || hex === '0x') return null
  try {
    const n = Number(BigInt(hex))
    if (!Number.isInteger(n) || n < 0 || n > 36) return null
    return n
  } catch {
    return null
  }
}

/**
 * Check whether a totalSupply eth_call result looks valid (non-null, non-empty hex).
 *
 * @param {string|null} hex
 * @returns {boolean}
 */
export function hasValidSupply(hex) {
  return typeof hex === 'string' && hex.length > 0 && hex !== '0x'
}

/**
 * Decode a totalSupply (or any uint256) eth_call hex result to a decimal string.
 * Returns null if the input is null, '0x', or not a valid hex string.
 *
 * @param {string|null} hex
 * @returns {string|null}  decimal integer string, e.g. '1000000000000000000'
 */
export function decodeSupply(hex) {
  if (!hex || hex === '0x') return null
  try {
    return BigInt(hex).toString(10)
  } catch {
    return null
  }
}

/**
 * Decode a bool eth_call result; returns true/false/null.
 * Returns null on revert (null/error input), false for 0x00...00, true for 0x00...01.
 *
 * @param {string|null|{code:number,message:string}} hexOrError
 * @returns {boolean|null}
 */
export function decodeBool(hexOrError) {
  if (!hexOrError || typeof hexOrError !== 'string' || hexOrError === '0x') return null
  try {
    return BigInt(hexOrError) === 1n
  } catch {
    return null
  }
}

/**
 * Merge a previous catalog with newly-probed entries into a fresh catalog document.
 *
 * Strategy:
 *   - Existing tokens[] and nfts[] from `previous` are kept as-is (address is the key).
 *   - `newlyProbedEntries` are classified and decoded; they upsert (add or replace) by address.
 *   - The `probed` map from `previous` is extended with the new kinds.
 *   - maxTokens / maxNfts caps are applied after sorting.
 *
 * This is the single authoritative merge path. catalog.mjs must call this instead of
 * re-synthesising probes for already-known addresses.
 *
 * @param {object|null} previous           - The previous catalog.json content, or null.
 * @param {Array<{
 *   address: string,
 *   probe: {
 *     name: string|null,
 *     symbol: string|null,
 *     decimals: string|null,
 *     totalSupply: string|null,
 *     is721: boolean|null,
 *     is1155: boolean|null,
 *   },
 *   discoverTxs?: number,
 *   appToken?: boolean,
 * }>} newlyProbedEntries                  - Fresh probe results from this run.
 * @param {{
 *   network: string,
 *   generatedAt: string,
 *   maxTokens?: number,
 *   maxNfts?: number,
 * }} opts
 * @returns {{
 *   network: string,
 *   generatedAt: string,
 *   coverage: string,
 *   tokens: Array<{address:string, name:string|null, symbol:string|null, decimals:number|null, totalSupply:string|null}>,
 *   nfts: Array<{address:string, name:string|null, symbol:string|null, kind:'ERC-721'|'ERC-1155'}>,
 *   probed: Record<string, string>,
 * }}
 */
export function mergeCatalog(previous, newlyProbedEntries, opts) {
  const { network, generatedAt, maxTokens = 200, maxNfts = 200 } = opts

  // Start from the previous tokens/nfts indexed by address
  const tokenMap = new Map()
  const nftMap   = new Map()

  for (const t of previous?.tokens ?? []) tokenMap.set(t.address, t)
  for (const n of previous?.nfts   ?? []) nftMap.set(n.address, n)

  // Carry forward the previous probed map; we will upsert new results into it
  const probed = { ...(previous?.probed ?? {}) }

  // Process newly-probed entries
  for (const entry of newlyProbedEntries) {
    const addr  = entry.address
    const probe = entry.probe
    const { kind } = classify(probe)

    probed[addr] = kind

    if (kind === 'erc20') {
      tokenMap.set(addr, {
        address:     addr,
        name:        probe.name        ?? null,
        symbol:      probe.symbol      ?? null,
        decimals:    decodeDecimals(probe.decimals),
        totalSupply: decodeSupply(probe.totalSupply),
      })
      // Remove from nfts if it was previously misclassified
      nftMap.delete(addr)
    } else if (kind === 'erc721') {
      nftMap.set(addr, {
        address: addr,
        name:    probe.name   ?? null,
        symbol:  probe.symbol ?? null,
        kind:    'ERC-721',
      })
      tokenMap.delete(addr)
    } else if (kind === 'erc1155') {
      nftMap.set(addr, {
        address: addr,
        name:    probe.name   ?? null,
        symbol:  probe.symbol ?? null,
        kind:    'ERC-1155',
      })
      tokenMap.delete(addr)
    } else {
      // 'other': remove from both if previously present, keep in probed
      tokenMap.delete(addr)
      nftMap.delete(addr)
    }
  }

  // Build per-entry discoverTxs and appToken lookup so we can sort
  const discoverTxsLookup = new Map()
  const appTokenLookup    = new Set()
  for (const e of newlyProbedEntries) {
    if (e.discoverTxs != null) discoverTxsLookup.set(e.address, e.discoverTxs)
    if (e.appToken) appTokenLookup.add(e.address)
  }
  // Also carry forward discoverTxs that were stored in previous (not accessible directly,
  // so we reconstruct from the previous catalog's order: earlier = higher rank, but we
  // do not have the exact number. Use 0 as a safe default; catalog.mjs should pass
  // discoverTxs for ALL entries it builds, not just the new ones).

  // Helper sort comparator:
  //   1. app-token addresses first
  //   2. discover txs descending
  //   3. address ascending
  const getTxs = (addr) => discoverTxsLookup.get(addr) ?? 0
  const addrCmp = (a, b) => {
    const appA = appTokenLookup.has(a.address) ? 1 : 0
    const appB = appTokenLookup.has(b.address) ? 1 : 0
    if (appB !== appA) return appB - appA
    const d = getTxs(b.address) - getTxs(a.address)
    if (d !== 0) return d
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0
  }

  const tokens = [...tokenMap.values()].sort(addrCmp).slice(0, maxTokens)
  const nfts   = [...nftMap.values()].sort(addrCmp).slice(0, maxNfts)

  return {
    network,
    generatedAt,
    coverage: 'Contracts known to the Pulsarc indexer (labelled or among the busiest); not every token on the chain.',
    tokens,
    nfts,
    probed,
  }
}

/**
 * Build the final catalogue document from classified entries.
 *
 * Sorting within each list:
 *   1. App-token addresses first (appToken flag set)
 *   2. discover txs descending  (entries not in discoverTxs get 0)
 *   3. address ascending        (tie-break, deterministic)
 *
 * @param {{
 *   network: string,
 *   generatedAt: string,
 *   entries: Array<{
 *     address: string,
 *     probe: { name:string|null, symbol:string|null, decimals:string|null,
 *              totalSupply:string|null, is721:boolean|null, is1155:boolean|null },
 *     discoverTxs?: number,
 *     appToken?: boolean,
 *   }>,
 *   maxTokens?: number,
 *   maxNfts?: number,
 * }} opts
 * @returns {{
 *   network: string,
 *   generatedAt: string,
 *   coverage: string,
 *   tokens: Array<{address:string, name:string|null, symbol:string|null, decimals:number|null, totalSupply:string|null}>,
 *   nfts: Array<{address:string, name:string|null, symbol:string|null, kind:'ERC-721'|'ERC-1155'}>,
 * }}
 */
export function buildCatalog({ network, generatedAt, entries, maxTokens = 200, maxNfts = 200 }) {
  const tokens = []
  const nfts   = []

  // Sort entries first: app-token first, then discoverTxs desc, then address asc
  const sorted = [...entries].sort((a, b) => {
    const appA = a.appToken ? 1 : 0
    const appB = b.appToken ? 1 : 0
    if (appB !== appA) return appB - appA
    const txsA = a.discoverTxs ?? 0
    const txsB = b.discoverTxs ?? 0
    if (txsB !== txsA) return txsB - txsA
    return a.address < b.address ? -1 : a.address > b.address ? 1 : 0
  })

  for (const entry of sorted) {
    const { address, probe } = entry
    const result = classify(probe)

    if (result.kind === 'erc20') {
      if (tokens.length >= maxTokens) continue
      const dec = decodeDecimals(probe.decimals)
      tokens.push({
        address,
        name:        probe.name        ?? null,
        symbol:      probe.symbol      ?? null,
        decimals:    dec,
        totalSupply: decodeSupply(probe.totalSupply),
      })
    } else if (result.kind === 'erc721') {
      if (nfts.length >= maxNfts) continue
      nfts.push({
        address,
        name:   probe.name   ?? null,
        symbol: probe.symbol ?? null,
        kind:   'ERC-721',
      })
    } else if (result.kind === 'erc1155') {
      if (nfts.length >= maxNfts) continue
      nfts.push({
        address,
        name:   probe.name   ?? null,
        symbol: probe.symbol ?? null,
        kind:   'ERC-1155',
      })
    }
    // 'other' and infra kinds: skip
  }

  return {
    network,
    generatedAt,
    coverage: 'Contracts known to the Pulsarc indexer (labelled or among the busiest); not every token on the chain.',
    tokens,
    nfts,
  }
}
