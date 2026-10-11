// src/wallets-backfill.mjs — USDC-Transfer-log backfill for the wallet index.
//
// WHY eth_getLogs and NOT eth_getBlockReceipts:
//   eth_getBlockReceipts is rate-limited to ~3 blocks/s on Arc mainnet.
//   At 166,000 blocks/day that would take months.  eth_getLogs for the USDC
//   Transfer topic over a 5,000-block window answers in ~0.8 s with ~4,000
//   logs and no errors; 10,000 blocks returned 10,300 logs (no hard cap seen).
//
// LITE RECORDS:
//   Because we only have Transfer logs (not full receipts), we can only populate:
//     f, l  — first/last active day
//     d     — active-days bit array
//     o     — USDC sent (Transfer.from)
//     i     — USDC received (Transfer.to)
//   All other fields (t, x, e, a, bo, bi) stay 0 / '0'.
//   Transfer logs where from == zero address (mints) skip the zero side.
//   Transfer logs where to == zero address (burns) skip the zero side.
//   This matches the walletDeltas zero-address handling in wallets.mjs.
//
// BLOCKDAEMON NOTE:
//   Blockdaemon returns EMPTY arrays for old blocks without any error, so it
//   MUST NOT be used for backfill.  The CLI refuses to start when any RPC URL
//   contains "blockdaemon".
//
// CLI:
//   NET=mainnet RPC_URLS=... node src/wallets-backfill.mjs \
//     --out <dir> --from-block N --until-block M [--span 5000] [--live-pending <file>]
//   Where M is the first block the live indexer covers.
//   Runs runBackfill for all complete days before M's day, then runPartialDay
//   for the part of M's day before M.  Prints one summary line per day and
//   a final line.  Exit 1 on error; a rerun resumes.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { USDC, TRANSFER_TOPIC } from './counters.mjs'
import {
  emptyRecord,
  mergeInto,
  mergeRecords,
  encodeRecord,
  decodeRecord,
  dayOf,
  EPOCH_S,
} from './wallets.mjs'
import { publish } from './wallets-publish.mjs'

// ── Constants ─────────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x' + '0'.repeat(40)

// Default RPC URLs for mainnet (no Blockdaemon).
const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.arc.io',
  'https://rpc.quicknode.mainnet.arc.io',
]

// Rate-limit JSON-RPC error code.
const RATE_LIMIT_CODE = -32005

// Maximum back-off sleep in ms for rate-limit retries.
const MAX_BACKOFF_MS = 5000

// ── JSON helpers ──────────────────────────────────────────────────────────────

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJsonAtomic(path, value) {
  const tmp = path + '.tmp'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

// ── 1. findDayStarts ─────────────────────────────────────────────────────────

/**
 * Return a Map<day, firstBlockNumber> for each UTC day in [fromDay, toDay].
 *
 * The returned block number is the FIRST block whose timestamp falls on that
 * day (i.e. timestamp >= day * 86400 + EPOCH_S).  If all blocks in [lo, hi]
 * belong to a day earlier than a requested day, that day maps to lo.
 *
 * Binary-search uses the injected async `getTimestamp(blockNumber)` so that
 * tests can supply a synthetic chain without network calls.
 *
 * @param {{
 *   getTimestamp: (n: number) => Promise<number>,
 *   lo: number,
 *   hi: number,
 *   fromDay: number,
 *   toDay: number,
 * }} opts
 * @returns {Promise<Map<number, number>>}
 */
export async function findDayStarts({ getTimestamp, lo, hi, fromDay, toDay }) {
  const result = new Map()

  // Helper: timestamp → day number
  const tsToDay = (ts) => Math.floor((ts - EPOCH_S) / 86400)

  // Binary search: find the first block in [searchLo, searchHi] whose
  // timestamp is >= targetTs.  Returns that block number, or hi+1 if none.
  async function firstBlockOnOrAfter(searchLo, searchHi, targetTs) {
    if (searchLo > searchHi) return searchHi + 1
    let left = searchLo
    let right = searchHi
    let answer = searchHi + 1  // sentinel: no block found
    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const ts = await getTimestamp(mid)
      if (ts >= targetTs) {
        answer = mid
        right = mid - 1
      } else {
        left = mid + 1
      }
    }
    return answer
  }

  for (let day = fromDay; day <= toDay; day++) {
    const dayStartTs = EPOCH_S + day * 86400
    const block = await firstBlockOnOrAfter(lo, hi, dayStartTs)
    // If no block in [lo,hi] reaches this day, map to lo.
    result.set(day, block > hi ? lo : block)
  }

  return result
}

// ── 2. planWindows ────────────────────────────────────────────────────────────

/**
 * Divide [fromBlock, toBlock] inclusive into windows of at most `span` blocks.
 *
 * @param {number} fromBlock
 * @param {number} toBlock
 * @param {number} span  Maximum blocks per window (inclusive range size)
 * @returns {[number, number][]}  Array of [from, to] pairs
 */
export function planWindows(fromBlock, toBlock, span) {
  if (fromBlock > toBlock) return []
  const windows = []
  for (let f = fromBlock; f <= toBlock; f += span) {
    windows.push([f, Math.min(f + span - 1, toBlock)])
  }
  return windows
}

// ── 3. recordsFromLogs ────────────────────────────────────────────────────────

/**
 * Build a Map<lowercase address, lite record> from an array of eth_getLogs
 * entries (Transfer logs from the USDC contract).
 *
 * Only o (USDC sent) and i (USDC received) are populated; t, x, e, a, bo, bi
 * stay 0 / '0' (lite records from Transfer logs only).
 *
 * Transfer logs where from == zero address (mints) skip the zero-address sender.
 * Transfer logs where to == zero address (burns) skip the zero-address recipient.
 * Malformed logs are silently skipped.
 *
 * @param {object[]} logs         eth_getLogs entries
 * @param {(blockNumber: number) => number} dayOfBlock  block number → day
 * @param {number} decimals       USDC decimals (6)
 * @returns {Map<string, object>}
 */
export function recordsFromLogs(logs, dayOfBlock, decimals) {
  const map = new Map()

  for (const log of logs) {
    // Validate log shape: need exactly 3 topics (Transfer has indexed from+to)
    if (!log || !Array.isArray(log.topics) || log.topics.length !== 3) continue
    if (!log.data || !log.blockNumber) continue

    // Parse block number (may be hex string or number)
    let blockNum
    try {
      blockNum = typeof log.blockNumber === 'number'
        ? log.blockNumber
        : Number(BigInt(log.blockNumber))
    } catch { continue }

    const day = dayOfBlock(blockNum)
    if (typeof day !== 'number' || !isFinite(day)) continue

    // Parse amount
    let amount
    try {
      amount = Number(BigInt(log.data)) / 10 ** decimals
    } catch { continue }

    // Parse addresses from topics[1] and topics[2]
    let fromAddr, toAddr
    try {
      fromAddr = ('0x' + log.topics[1].slice(-40)).toLowerCase()
      toAddr   = ('0x' + log.topics[2].slice(-40)).toLowerCase()
    } catch { continue }

    // Validate they look like addresses (40 hex chars after 0x)
    if (!/^0x[0-9a-f]{40}$/.test(fromAddr) || !/^0x[0-9a-f]{40}$/.test(toAddr)) continue

    // Sender side (skip zero address = mints)
    if (fromAddr !== ZERO_ADDR) {
      if (!map.has(fromAddr)) {
        const r = emptyRecord(day)
        r.d = '1'
        map.set(fromAddr, r)
      }
      const r = map.get(fromAddr)
      r.o = +(r.o + amount).toFixed(decimals)
      // Update f/l/d
      _markDay(r, day)
    }

    // Recipient side (skip zero address = burns)
    if (toAddr !== ZERO_ADDR) {
      if (!map.has(toAddr)) {
        const r = emptyRecord(day)
        r.d = '1'
        map.set(toAddr, r)
      }
      const r = map.get(toAddr)
      r.i = +(r.i + amount).toFixed(decimals)
      _markDay(r, day)
    }
  }

  return map
}

/**
 * Mark a record as active on `day`, updating f, l, and the d bit-array.
 * @param {object} r
 * @param {number} day
 */
function _markDay(r, day) {
  if (day < r.f) {
    // Earlier day: shift existing d bits right and set bit 0
    const shift = r.f - day
    const old = BigInt('0x' + (r.d || '0'))
    r.d = ((old << BigInt(shift)) | 1n).toString(16)
    r.f = day
  } else if (day > r.l) {
    // Later day: set the appropriate bit
    const bitIndex = day - r.f
    const old = BigInt('0x' + (r.d || '0'))
    r.d = (old | (1n << BigInt(bitIndex))).toString(16)
    r.l = day
  } else {
    // Within range: set the bit
    const bitIndex = day - r.f
    const old = BigInt('0x' + (r.d || '0'))
    r.d = (old | (1n << BigInt(bitIndex))).toString(16)
  }
}

// ── 4. fetchWindow ────────────────────────────────────────────────────────────

// Error messages that indicate the response range is too large.
const TOO_LARGE_RE = /too many|limit|range|result/i

/**
 * Fetch all Transfer logs for USDC over [from, to] (inclusive) block range.
 *
 * Splitting: if the response has >= 9,500 logs or the RPC returns a
 * "too many results / limit / range" error, the window is split in two and
 * each half is fetched recursively.  Splitting down to a single block is
 * allowed; a single block with >= 9,500 logs is an unrecoverable error.
 *
 * Rate-limit (JSON-RPC code -32005): retried with growing back-off (doubles
 * each attempt, capped at MAX_BACKOFF_MS), rotating the endpoint on each retry.
 *
 * @param {{
 *   rpc: (method: string, params: any[]) => Promise<any>,
 *   from: number,
 *   to: number,
 * }} opts
 * @returns {Promise<object[]>}  All log entries
 */
export async function fetchWindow({ rpc, from, to }) {
  let backoff = 200  // ms, grows on rate-limit

  async function attempt(f, t) {
    let result
    try {
      result = await rpc('eth_getLogs', [{
        address: USDC,
        topics: [TRANSFER_TOPIC],
        fromBlock: '0x' + f.toString(16),
        toBlock:   '0x' + t.toString(16),
      }])
    } catch (err) {
      // Check for rate-limit (JSON-RPC error object with code -32005)
      const code = err?.code ?? err?.error?.code
      const msg  = err?.message ?? err?.error?.message ?? String(err)

      if (code === RATE_LIMIT_CODE || /rate.?limit/i.test(msg)) {
        const sleep = Math.min(backoff, MAX_BACKOFF_MS)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        await new Promise((r) => setTimeout(r, sleep))
        return attempt(f, t)
      }

      // Too-many-results style error → split
      if (TOO_LARGE_RE.test(msg)) {
        if (f === t) throw new Error(`eth_getLogs single block ${f} exceeded limit: ${msg}`)
        const mid = Math.floor((f + t) / 2)
        const [a, b] = await Promise.all([attempt(f, mid), attempt(mid + 1, t)])
        return [...a, ...b]
      }

      throw err
    }

    if (!Array.isArray(result)) {
      throw new Error(`eth_getLogs returned non-array for blocks ${f}-${t}`)
    }

    // Too many logs → split
    if (result.length >= 9500) {
      if (f === t) throw new Error(`eth_getLogs single block ${f} returned ${result.length} logs (>= 9500 limit)`)
      const mid = Math.floor((f + t) / 2)
      const [a, b] = await Promise.all([attempt(f, mid), attempt(mid + 1, t)])
      return [...a, ...b]
    }

    return result
  }

  return attempt(from, to)
}

// ── 5. runBackfill ────────────────────────────────────────────────────────────

/**
 * Process one complete UTC day at a time in ascending order, writing shard
 * files via publish() after each day.
 *
 * Resumable: reads meta.json `through` and skips days <= through.
 * After each day, writes `meta.lite = { from, through: D }` into meta.json.
 *
 * Day boundaries are binary-searched once and cached in
 * `<outDir>/backfill-days.json` to avoid re-searching on restart.
 *
 * Memory is bounded to one day at a time: each day's records are written and
 * then discarded before processing the next day.
 *
 * @param {{
 *   rpc: (method: string, params: any[]) => Promise<any>,
 *   outDir: string,
 *   pendingDir: string,
 *   fromBlock: number,
 *   toBlock: number,
 *   span?: number,
 *   decimals?: number,
 *   log?: (...args: any[]) => void,
 * }} opts
 * @returns {Promise<{ days: number, wallets: number, calls: number }>}
 */
export async function runBackfill({
  rpc,
  outDir,
  pendingDir,
  fromBlock,
  toBlock,
  span = 5000,
  decimals = 6,
  log = console.log,
  net = process.env.NET === 'mainnet' ? 'mainnet' : 'testnet',
}) {
  await mkdir(outDir, { recursive: true })
  await mkdir(pendingDir, { recursive: true })

  const metaPath    = join(outDir, 'meta.json')
  const daysCachePath = join(outDir, 'backfill-days.json')
  const pendingPath = join(pendingDir, 'wallets-pending.json')

  // ── Check resumption point ────────────────────────────────────────────────

  const meta = await readJson(metaPath, null)
  const throughAlready = meta?.through ?? -1

  // ── Determine the day range ───────────────────────────────────────────────

  // getTimestamp: fetches a block's timestamp via eth_getBlockByNumber
  let callCount = 0
  async function getTimestamp(blockNum) {
    callCount++
    const block = await rpc('eth_getBlockByNumber', ['0x' + blockNum.toString(16), false])
    if (!block || !block.timestamp) throw new Error(`no timestamp for block ${blockNum}`)
    return typeof block.timestamp === 'number'
      ? block.timestamp
      : Number(BigInt(block.timestamp))
  }

  // Fetch timestamps for fromBlock and toBlock to determine day range
  const fromTs  = await getTimestamp(fromBlock)
  const toTs    = await getTimestamp(toBlock)
  const firstDay = dayOf(fromTs)
  // untilDay = day of toBlock (exclusive: last complete day before toBlock's day)
  const untilDay = dayOf(toTs)  // days < untilDay are complete

  if (firstDay >= untilDay) {
    log(`backfill: fromBlock day ${firstDay} >= untilDay ${untilDay}; nothing to do`)
    return { days: 0, wallets: 0, calls: callCount }
  }

  // ── Load or build the day-starts cache ────────────────────────────────────

  let daysCache = await readJson(daysCachePath, {})
  // daysCache: { "<day>": blockNumber }

  // Find any days not yet cached
  const missingDays = []
  for (let d = firstDay; d < untilDay; d++) {
    if (daysCache[String(d)] === undefined) missingDays.push(d)
  }
  // Also need the start of untilDay to know the last complete day's end block
  if (daysCache[String(untilDay)] === undefined) missingDays.push(untilDay)

  if (missingDays.length > 0) {
    const needed = [...new Set(missingDays)]
    const lo = needed[0]
    const hi = needed[needed.length - 1]
    const newStarts = await findDayStarts({
      getTimestamp,
      lo: fromBlock,
      hi: toBlock,
      fromDay: lo,
      toDay: hi,
    })
    for (const [day, block] of newStarts) {
      daysCache[String(day)] = block
    }
    await writeJsonAtomic(daysCachePath, daysCache)
  }

  // ── Process each complete day ─────────────────────────────────────────────

  let totalDays = 0
  let totalWallets = 0
  let firstBackfilledDay = null

  for (let day = firstDay; day < untilDay; day++) {
    // Skip already-published days
    if (day <= throughAlready) continue

    const dayStart = daysCache[String(day)] ?? fromBlock
    const nextDayStart = daysCache[String(day + 1)] ?? (toBlock + 1)
    // The last block of this day is the block just before the next day starts.
    const dayEnd = nextDayStart - 1

    if (dayStart > dayEnd) {
      log(`backfill: day ${day} has no blocks (${dayStart} > ${dayEnd}); skipping`)
      continue
    }

    const t0 = Date.now()
    const windows = planWindows(dayStart, dayEnd, span)

    // Collect all logs for this day
    const allLogs = []
    for (const [wFrom, wTo] of windows) {
      callCount++
      const logs = await fetchWindow({ rpc, from: wFrom, to: wTo })
      allLogs.push(...logs)
    }

    // Build lite records
    const dayMap = recordsFromLogs(allLogs, () => day, decimals)

    // Encode into pending shape
    const encoded = {}
    for (const [addr, rec] of dayMap) {
      encoded[addr] = encodeRecord(rec)
    }

    // Write pending file for this single day
    const pending = { version: 1, dropped: 0, days: { [String(day)]: encoded } }
    await writeJsonAtomic(pendingPath, pending)

    // Publish this day
    await publish({ pendingPath, outDir, today: day + 1, net })

    // Update meta.lite
    if (firstBackfilledDay === null) firstBackfilledDay = day
    const newMeta = await readJson(metaPath, {})
    newMeta.lite = { from: firstBackfilledDay, through: day }
    await writeJsonAtomic(metaPath, newMeta)

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
    const walletCount = dayMap.size
    totalWallets += walletCount
    totalDays++

    log(`backfill: day=${day} wallets=${walletCount} logs=${allLogs.length} secs=${elapsed}`)
  }

  log(`backfill: done days=${totalDays} wallets=${totalWallets} calls=${callCount}`)
  return { days: totalDays, wallets: totalWallets, calls: callCount }
}

// ── 6. runPartialDay ─────────────────────────────────────────────────────────

/**
 * Fetch Transfer logs for [fromBlock, toBlock] (all within `day`) and merge
 * lite records into the standard live pending file at days[day].
 *
 * Creates the file if missing.  Merges into any existing days[day] records
 * using mergeRecords (so existing live-indexer data for the same addresses is
 * preserved).
 *
 * Used once for the part of the cut-over day the live indexer did not see.
 *
 * @param {{
 *   rpc: (method: string, params: any[]) => Promise<any>,
 *   pendingPath: string,
 *   day: number,
 *   fromBlock: number,
 *   toBlock: number,
 *   span?: number,
 *   decimals?: number,
 * }} opts
 * @returns {Promise<{ wallets: number, logs: number }>}
 */
export async function runPartialDay({
  rpc,
  pendingPath,
  day,
  fromBlock,
  toBlock,
  span = 5000,
  decimals = 6,
}) {
  // Collect logs
  const windows = planWindows(fromBlock, toBlock, span)
  const allLogs = []
  for (const [wFrom, wTo] of windows) {
    const logs = await fetchWindow({ rpc, from: wFrom, to: wTo })
    allLogs.push(...logs)
  }

  // Build lite records for this partial day
  const newMap = recordsFromLogs(allLogs, () => day, decimals)

  // Load existing pending file (or create empty one)
  let pending = await readJson(pendingPath, null)
  if (!pending || pending.version !== 1 || typeof pending.days !== 'object') {
    pending = { version: 1, dropped: 0, days: {} }
  }

  // Merge new lite records into existing days[day]
  const existingDayData = pending.days[String(day)] ?? {}

  for (const [addr, newRec] of newMap) {
    if (existingDayData[addr]) {
      // Decode, merge, re-encode
      const existing = decodeRecord(existingDayData[addr])
      existingDayData[addr] = encodeRecord(mergeRecords(existing, newRec))
    } else {
      existingDayData[addr] = encodeRecord(newRec)
    }
  }

  pending.days[String(day)] = existingDayData
  await mkdir(dirname(pendingPath), { recursive: true })
  await writeJsonAtomic(pendingPath, pending)

  return { wallets: newMap.size, logs: allLogs.length }
}

// ── RPC factory (used in CLI) ─────────────────────────────────────────────────

/**
 * Build a rotating RPC caller from a list of endpoint URLs.
 * Rotates on error, backs off on JSON-RPC -32005.
 *
 * @param {string[]} urls
 * @returns {(method: string, params: any[]) => Promise<any>}
 */
export function buildRpc(urls) {
  let idx = 0
  function current() { return urls[idx % urls.length] }

  return async function rpc(method, params) {
    let backoff = 200

    for (let attempt = 0; attempt <= urls.length * 4; attempt++) {
      const url = current()
      let res
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch (e) {
        idx++
        console.warn(`[rpc] rotate to ${current()} (network error: ${e.message})`)
        continue
      }

      if (res.status === 429) {
        idx++
        const sleep = Math.min(backoff, MAX_BACKOFF_MS)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        console.warn(`[rpc] 429 rate-limit; sleeping ${sleep}ms, rotating to ${current()}`)
        await new Promise((r) => setTimeout(r, sleep))
        continue
      }

      if (res.status >= 500) {
        idx++
        console.warn(`[rpc] HTTP ${res.status}; rotating to ${current()}`)
        await new Promise((r) => setTimeout(r, 500))
        continue
      }

      let body
      try { body = await res.json() } catch (e) {
        idx++
        console.warn(`[rpc] bad JSON response; rotating`)
        continue
      }

      if (body.error) {
        const code = body.error.code
        const msg  = body.error.message ?? String(body.error)
        if (code === RATE_LIMIT_CODE || /rate.?limit/i.test(msg)) {
          idx++
          const sleep = Math.min(backoff, MAX_BACKOFF_MS)
          backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
          console.warn(`[rpc] rate-limit error; sleeping ${sleep}ms, rotating to ${current()}`)
          await new Promise((r) => setTimeout(r, sleep))
          // Throw a structured error that fetchWindow can catch
          const err = new Error(msg)
          err.code = code
          throw err
        }
        throw new Error(msg)
      }

      return body.result
    }
    throw new Error('all RPC endpoints failed')
  }
}

/**
 * Block range of the partial cut-over day: from the first block of `untilDay` up to the block BEFORE
 * `untilBlock` (the live indexer covers untilBlock onward). Returns null when there is nothing to scan
 * (the cut falls exactly on the day start, or the day start is unknown).
 * @param {Record<string, number>} dayStarts  day -> first block of that day
 */
export function partialDayRange(dayStarts, untilDay, untilBlock) {
  const start = dayStarts?.[String(untilDay)] ?? dayStarts?.[untilDay]
  if (!Number.isFinite(start) || start >= untilBlock) return null
  return [start, untilBlock - 1]
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const net = process.env.NET === 'mainnet' ? 'mainnet' : 'testnet'

  // Parse CLI args
  const args = process.argv.slice(2)
  function argVal(flag) {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }

  const outDir     = argVal('--out')
  const fromBlockS = argVal('--from-block')
  const untilBlockS = argVal('--until-block')
  const spanS      = argVal('--span')

  if (!outDir || !fromBlockS || !untilBlockS) {
    console.error('Usage: NET=mainnet RPC_URLS=... node src/wallets-backfill.mjs --out <dir> --from-block N --until-block M [--span 5000]')
    process.exit(1)
  }

  const fromBlock  = Number(fromBlockS)
  const untilBlock = Number(untilBlockS)
  const span       = spanS ? Number(spanS) : 5000

  if (!isFinite(fromBlock) || !isFinite(untilBlock) || !isFinite(span)) {
    console.error('--from-block, --until-block, and --span must be integers')
    process.exit(1)
  }

  // Build RPC URL list — refuse blockdaemon
  const rawUrls = process.env.RPC_URLS
    ? process.env.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_RPC_URLS

  const hasBd = rawUrls.some((u) => u.toLowerCase().includes('blockdaemon'))
  if (hasBd) {
    console.error('ERROR: Blockdaemon RPC URLs are not allowed for backfill. ' +
      'Blockdaemon returns empty arrays for old blocks without any error, ' +
      'which would silently produce wrong results. Remove Blockdaemon URLs from RPC_URLS.')
    process.exit(1)
  }

  const rpc = buildRpc(rawUrls)
  const pendingDir = join(outDir, 'pending')

  try {
    // Determine untilDay (day of untilBlock)
    const rpcForTs = buildRpc(rawUrls)
    const untilBlock0 = untilBlock
    const untilTs = await (async () => {
      const b = await rpcForTs('eth_getBlockByNumber', ['0x' + untilBlock0.toString(16), false])
      if (!b || !b.timestamp) throw new Error(`no timestamp for block ${untilBlock0}`)
      return typeof b.timestamp === 'number' ? b.timestamp : Number(BigInt(b.timestamp))
    })()
    const untilDay = dayOf(untilTs)

    // 1. Run backfill for all complete days before untilDay
    await runBackfill({
      rpc,
      outDir,
      pendingDir,
      fromBlock,
      toBlock: untilBlock - 1,
      span,
      net,
    })

    // 2. Run partial day for the part of untilDay's blocks before untilBlock
    // (the live indexer covers untilBlock onward; we handle [dayStart .. untilBlock-1]).
    // --live-pending lets the cut-over merge straight into the live indexer's pending file.
    const pendingPath = argVal('--live-pending') || join(pendingDir, 'wallets-pending.json')
    const dayStarts = await readJson(join(outDir, 'backfill-days.json'), {})
    const range = partialDayRange(dayStarts, untilDay, untilBlock)
    const result = range
      ? await runPartialDay({ rpc, pendingPath, day: untilDay, fromBlock: range[0], toBlock: range[1], span })
      : { wallets: 0, logs: 0 }
    console.log(`backfill: partial day=${untilDay} wallets=${result.wallets} logs=${result.logs}`)
  } catch (e) {
    console.error(`backfill error: ${e.message}`)
    process.exit(1)
  }
}
