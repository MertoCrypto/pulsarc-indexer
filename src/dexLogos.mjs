/**
 * dexLogos.mjs
 *
 * Fetches DexScreener logo imageIds for ERC-20 tokens on Arc and writes
 * data/<NET>/logos.json.
 *
 * NET env (default: mainnet). On testnet: no-op exit 0 (DexScreener has no
 * testnet data). Merges with any existing logos.json — never drops entries.
 *
 * Pure helpers exported for tests: parseImageId, extractLogos, mergeLogos, chunk.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Constants ──────────────────────────────────────────────────────────────

const BATCH_SIZE      = 30
const DELAY_MS        = 250
const TIMEOUT_MS      = 10_000
const USER_AGENT      = 'pulsarc-indexer'
const DEXSCREENER_API = 'https://api.dexscreener.com/tokens/v1/arc'
const CDN_HOST        = 'cdn.dexscreener.com'
const IMAGE_ID_RE     = /^[A-Za-z0-9_-]{6,64}$/

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Extract the imageId from a DexScreener CDN URL.
 *
 * Accepts only URLs whose host is exactly cdn.dexscreener.com and whose path
 * starts with /cms/images/<id>. The id must match /^[A-Za-z0-9_-]{6,64}$/.
 * Returns null for anything else (wrong host, path traversal, javascript:,
 * empty, non-string, etc.).
 *
 * @param {unknown} url
 * @returns {string|null}
 */
export function parseImageId(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Must be https and exactly the CDN host — no subdomain tricks
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname !== CDN_HOST) return null

  // Path must be /cms/images/<id>[?...]
  const path = parsed.pathname
  const prefix = '/cms/images/'
  if (!path.startsWith(prefix)) return null

  // The id is the segment after the prefix, up to the next slash (if any)
  const rest = path.slice(prefix.length)
  // Reject if there is a slash (path traversal attempt like ../../etc)
  const slashIdx = rest.indexOf('/')
  const rawId = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
  if (!rawId || slashIdx !== -1) return null

  if (!IMAGE_ID_RE.test(rawId)) return null
  return rawId
}

/**
 * Extract a { lowercaseAddress -> imageId } map from a DexScreener pairs array.
 *
 * Each element of `pairs` must have `baseToken.address` and `info.imageUrl`.
 * Entries with an invalid imageUrl are silently skipped.
 *
 * @param {unknown} pairs  - Raw DexScreener API response (array of pair objects)
 * @returns {Record<string, string>}
 */
export function extractLogos(pairs) {
  const out = {}
  if (!Array.isArray(pairs)) return out
  for (const pair of pairs) {
    if (!pair || typeof pair !== 'object') continue
    const addr = pair.baseToken?.address
    if (typeof addr !== 'string' || addr.length === 0) continue
    const imageUrl = pair.info?.imageUrl
    const id = parseImageId(imageUrl)
    if (id === null) continue
    out[addr.toLowerCase()] = id
  }
  return out
}

/**
 * Merge two logos maps. `next` overwrites `prev` for the same address key;
 * entries present only in `prev` are kept.
 *
 * @param {Record<string, string>} prev
 * @param {Record<string, string>} next
 * @returns {Record<string, string>}
 */
export function mergeLogos(prev, next) {
  return { ...prev, ...next }
}

/**
 * Split an array into chunks of at most `n` elements.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
export function chunk(arr, n) {
  if (!Array.isArray(arr) || n < 1) return []
  const out = []
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n))
  }
  return out
}

// ── I/O helpers ────────────────────────────────────────────────────────────

/**
 * Read and defensively parse catalog.json.
 *
 * Accepts either { tokens: [...] } or a bare array of rows.
 * Returns an array of address strings (lowercase), or null on any failure.
 *
 * @param {string} filePath
 * @returns {string[]|null}
 */
function readCatalogAddresses(filePath) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  let rows
  if (Array.isArray(parsed)) {
    rows = parsed
  } else if (parsed && Array.isArray(parsed.tokens)) {
    rows = parsed.tokens
  } else {
    return null
  }

  const addrs = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const a = row.address
    if (typeof a === 'string' && a.length > 0) {
      addrs.push(a.toLowerCase())
    }
  }
  return addrs
}

/**
 * Read an existing logos.json, returning { logos: {} } if missing/invalid.
 *
 * @param {string} filePath
 * @returns {{ generatedAt?: string, logos: Record<string, string> }}
 */
function readExistingLogos(filePath) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return { logos: {} }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { logos: {} }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { generatedAt: parsed.generatedAt, logos: parsed.logos ?? {} }
  }
  return { logos: {} }
}

// ── Network fetch with retry ───────────────────────────────────────────────

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch a URL with a timeout and one retry on 429 / 5xx.
 *
 * @param {string} url
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url) {
  const doFetch = () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    return fetch(url, {
      signal:  controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    }).finally(() => clearTimeout(timer))
  }

  let res
  try {
    res = await doFetch()
  } catch (err) {
    throw new Error(`fetch error: ${err?.message ?? err}`)
  }

  if (res.status === 429 || res.status >= 500) {
    // One retry after a short back-off
    await sleep(DELAY_MS * 4)
    try {
      res = await doFetch()
    } catch (err) {
      throw new Error(`fetch retry error: ${err?.message ?? err}`)
    }
  }

  return res
}

/**
 * Query DexScreener for one batch of addresses.
 * Returns an array of pair objects, or null on any error.
 *
 * @param {string[]} addrs
 * @returns {Promise<unknown[]|null>}
 */
async function fetchBatch(addrs) {
  const url = `${DEXSCREENER_API}/${addrs.join(',')}`
  let res
  try {
    res = await fetchWithRetry(url)
  } catch (err) {
    console.error(`[dexLogos] fetch failed: ${err?.message ?? err}`)
    return null
  }
  if (!res.ok) {
    console.error(`[dexLogos] HTTP ${res.status} for batch starting ${addrs[0]}`)
    return null
  }
  let body
  try {
    body = await res.json()
  } catch (err) {
    console.error(`[dexLogos] JSON parse error: ${err?.message ?? err}`)
    return null
  }
  if (!Array.isArray(body)) {
    console.error(`[dexLogos] unexpected response shape (not array) for batch starting ${addrs[0]}`)
    return null
  }
  return body
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const net = (process.env.NET ?? 'mainnet').toLowerCase()

  // DexScreener only indexes mainnet
  if (net !== 'mainnet') {
    console.log(`[dexLogos] NET=${net} — testnet skipped (DexScreener has no testnet data)`)
    process.exit(0)
  }

  const __dir = dirname(fileURLToPath(import.meta.url))
  const dataDir = join(__dir, '..', 'data', net)
  const catalogPath = join(dataDir, 'catalog.json')
  const logosPath   = join(dataDir, 'logos.json')

  // Read catalog
  const addresses = readCatalogAddresses(catalogPath)
  if (addresses === null) {
    console.log(`[dexLogos] catalog.json missing or unparseable at ${catalogPath} — exiting 0`)
    process.exit(0)
  }
  if (addresses.length === 0) {
    console.log('[dexLogos] No addresses in catalog — nothing to do')
    process.exit(0)
  }

  // Load existing logos (never drop existing entries)
  const existing = readExistingLogos(logosPath)
  let merged = { ...existing.logos }

  // Fetch in batches
  const batches = chunk(addresses, BATCH_SIZE)
  console.log(`[dexLogos] Fetching logos for ${addresses.length} addresses in ${batches.length} batches`)

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]
    if (i > 0) await sleep(DELAY_MS)

    const pairs = await fetchBatch(batch)
    if (pairs === null) {
      console.error(`[dexLogos] Batch ${i + 1}/${batches.length} failed — keeping existing entries`)
      continue
    }
    const batchLogos = extractLogos(pairs)
    const count = Object.keys(batchLogos).length
    console.log(`[dexLogos] Batch ${i + 1}/${batches.length}: ${count} logo(s) found`)
    merged = mergeLogos(merged, batchLogos)
  }

  // Write output
  const output = {
    generatedAt: new Date().toISOString(),
    logos:       merged,
  }

  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(logosPath, JSON.stringify(output, null, 2) + '\n', 'utf8')
    console.log(`[dexLogos] Wrote ${Object.keys(merged).length} logo(s) to ${logosPath}`)
  } catch (err) {
    console.error(`[dexLogos] Failed to write logos.json: ${err?.message ?? err}`)
  }
}

// Run when executed directly
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === (
    process.argv[1].startsWith('/') ? process.argv[1] : join(process.cwd(), process.argv[1])
  )

if (isMain) {
  main().catch((err) => {
    console.error('[dexLogos] Unexpected error:', err)
    process.exit(0) // exit 0 always
  })
}
