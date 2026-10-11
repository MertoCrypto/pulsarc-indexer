// Pulsarc indexer v2 — reads Arc blocks and keeps small hourly aggregates.
//
// Resumes from data/<net>/state.json. Each run continues exactly where it stopped
// (open-hour accumulator persisted in data/<net>/open.json) so no blocks are
// re-processed and no work is lost between runs.
//
//   NET=mainnet node indexer/run.mjs
//   env:
//     NET              mainnet | testnet   (default mainnet)
//     RPC_URL          single endpoint override
//     RPC_URLS         comma-separated list of endpoints to rotate (overrides RPC_URL)
//     BACKFILL_HOURS   how far back to start on first run (default 24)
//     BUDGET_SECONDS   wall-clock budget (default 1200)

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accumulateApps, compactApps } from './apps.mjs'
import {
  dayOf  as walletDayOf,
  buildAppIndex,
  walletDeltas,
  mergeInto,
  encodeShard,
  encodeRecord,
  decodeRecord,
} from './wallets.mjs'
import {
  AUTO_TX_PER_HOUR, USER_OP_TOPIC, ENTRY_POINTS, USDC, autoStats,
  largestUsdcTransfer, bucketIndex, countUserOps,
  // T3b
  EURC, TOKEN_MESSENGER_V2, MESSAGE_TRANSMITTER_V2,
  DEPOSIT_FOR_BURN_TOPIC, MESSAGE_RECEIVED_TOPIC,
  bigTransfers, mintBurnFromLogs, blocklistFromLogs,
  decodeDepositForBurn, decodeMessageReceived,
  badReceiptIndexes,
} from './counters.mjs'

// ── Configuration ────────────────────────────────────────────────────────────

const NETWORKS = {
  mainnet: {
    rpc: 'https://rpc.mainnet.arc.io',
    // Verified from docs.arc.io/arc/references/rpc-endpoints
    rpcFallbacks: [
      'https://rpc.blockdaemon.mainnet.arc.io',
      'https://rpc.drpc.mainnet.arc.io',
      'https://rpc.quicknode.mainnet.arc.io',
    ],
    chainId: 5042,
  },
  testnet: {
    rpc: 'https://rpc.testnet.arc.io',
    // Verified from docs.arc.io/arc/references/rpc-endpoints (table, Provider column)
    rpcFallbacks: [
      'https://rpc.blockdaemon.testnet.arc.io',
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io',
    ],
    chainId: 5042002,
  },
}

const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'

// T3b: per-network contract addresses (lowercased)
const TOKEN_MESSENGER_ADDR     = TOKEN_MESSENGER_V2[NET]
const MESSAGE_TRANSMITTER_ADDR = MESSAGE_TRANSMITTER_V2[NET]
const BACKFILL_HOURS = Number(process.env.BACKFILL_HOURS || 24)
const BUDGET_MS = Number(process.env.BUDGET_SECONDS || 1200) * 1000
const TOP_PER_HOUR = 400
const BLOCK_SECONDS = 0.5
const REQUEST_TIMEOUT_MS = 10_000   // AbortSignal.timeout per request
const BATCH_MIN = 3
const BATCH_MAX = 40
const BATCH_INIT = 15
const PAUSE_MS = 80

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const INDEXER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Wallet index feature flag ────────────────────────────────────────────────
// Set WALLET_INDEX=1 to enable per-wallet accumulation. Default OFF so existing
// behaviour and tests are completely unchanged.
const WALLET_INDEX = process.env.WALLET_INDEX === '1'

/**
 * Maximum distinct wallets per day in the pending file. Beyond this, NEW wallets
 * are not added (dropped counter incremented); existing wallets are still updated.
 * At 400,000 wallets × ~90 bytes ≈ 36 MB pending file (acceptable for git).
 */
const WALLET_CAP = 400_000

const PENDING_PATH = join(ROOT, 'wallets-pending.json')

/** wallet index state: Map<day (int), Map<lc-addr, record>> */
let walletDays = new Map()
let walletDropped = 0
let walletCappedWarned = false
let walletAppIndex = new Map()  // built once in main()

// Build the endpoint rotation list from env or defaults
function buildEndpoints() {
  if (process.env.RPC_URLS) {
    return process.env.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  }
  if (process.env.RPC_URL) return [process.env.RPC_URL]
  return [NETWORKS[NET].rpc, ...NETWORKS[NET].rpcFallbacks]
}

const ENDPOINTS = buildEndpoints()
let endpointIdx = 0  // which endpoint is currently active
let batch = BATCH_INIT

function currentEndpoint() { return ENDPOINTS[endpointIdx % ENDPOINTS.length] }

function rotateEndpoint(reason) {
  endpointIdx++
  console.warn(`[rpc] rotate to ${currentEndpoint()} (reason: ${reason})`)
}

// ── App config ──────────────────────────────────────────────────────────────
// Loaded once at startup; a missing or empty file means no app stats (no error).
let APPS_CONFIG = { apps: [] }
try {
  APPS_CONFIG = JSON.parse(await readFile(join(INDEXER_ROOT, `apps.${NET}.json`), 'utf8'))
} catch {
  // file absent or unparseable — app stats disabled for this run
}
const HAS_APPS = APPS_CONFIG.apps.length > 0

// ── Decimals cache ───────────────────────────────────────────────────────────
// data/<net>/meta.json stores { decimals: { <lc-address>: n } } so we only
// call eth_call once per token address across all runs.
const META_PATH = join(ROOT, 'meta.json')
const DECIMALS_SELECTOR = '0x313ce567'

let metaCache = { decimals: {} }
try {
  metaCache = JSON.parse(await readFile(META_PATH, 'utf8'))
  if (!metaCache.decimals) metaCache.decimals = {}
} catch { /* first run */ }

// ── Utility ──────────────────────────────────────────────────────────────────

const hex = (n) => '0x' + n.toString(16)
const num = (h) => Number(BigInt(h))

/** hour key like 2026-10-08T14 (UTC) */
const hourKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 13)
const dayOf = (hk) => hk.slice(0, 10)

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

// ── RPC layer with rotation and adaptive batching ────────────────────────────

async function rpc(calls, attempt = 0) {
  if (attempt > ENDPOINTS.length * 3) throw new Error('all RPC endpoints failed')
  const endpoint = currentEndpoint()
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    // Network error or timeout — rotate and retry once immediately
    rotateEndpoint(e.message ?? 'network error')
    return rpc(calls, attempt + 1)
  }

  if (res.status === 429) {
    batch = Math.max(BATCH_MIN, Math.floor(batch / 2))
    rotateEndpoint(`429 rate-limit (batch→${batch})`)
    await new Promise((r) => setTimeout(r, 1000))
    return rpc(calls, attempt + 1)
  }
  if (res.status >= 500) {
    rotateEndpoint(`HTTP ${res.status}`)
    await new Promise((r) => setTimeout(r, 500))
    return rpc(calls, attempt + 1)
  }

  const out = await res.json()
  if (!Array.isArray(out)) {
    rotateEndpoint('bad batch response (non-array)')
    return rpc(calls, attempt + 1)
  }

  const failed = out.find((r) => r.error)
  if (failed) {
    const msg = failed.error?.message ?? 'rpc error'
    if (/rate.?limit/i.test(msg)) {
      batch = Math.max(BATCH_MIN, Math.floor(batch / 2))
      rotateEndpoint(`rate-limit in response (batch→${batch})`)
      await new Promise((r) => setTimeout(r, 1000))
      return rpc(calls, attempt + 1)
    }
    throw new Error(msg)
  }

  // Success — slowly grow batch back toward maximum
  batch = Math.min(BATCH_MAX, batch + 1)
  return out.sort((a, b) => a.id - b.id).map((r) => r.result)
}

/**
 * Fetch and cache the `decimals()` return value for every usd token anchor that
 * is not already in metaCache.decimals. Writes the updated cache to META_PATH.
 * Safe to call when HAS_APPS is false (no-op).
 */
async function fetchDecimals() {
  if (!HAS_APPS) return
  const needed = []
  for (const app of APPS_CONFIG.apps) {
    for (const anchor of app.anchors) {
      if (anchor.kind === 'token' && anchor.usd) {
        const addr = anchor.address.toLowerCase()
        if (!(addr in metaCache.decimals)) needed.push(addr)
      }
    }
  }
  if (!needed.length) return

  const calls = needed.map((addr, i) => ({
    jsonrpc: '2.0', id: i,
    method: 'eth_call',
    params: [{ to: addr, data: DECIMALS_SELECTOR }, 'latest'],
  }))
  let results
  try {
    results = await rpc(calls)
  } catch (e) {
    console.warn(`decimals fetch failed: ${e.message}`)
    return
  }
  for (let i = 0; i < needed.length; i++) {
    const hex = results[i]
    if (hex && hex !== '0x' && hex.length >= 66) {
      metaCache.decimals[needed[i]] = Number(BigInt(hex))
    } else {
      console.warn(`decimals() failed for ${needed[i]} — volume will be skipped`)
      // Leave absent so apps.mjs skips volume rather than dividing by wrong value
    }
  }
}

async function head() {
  const [h] = await rpc([{ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }])
  return num(h)
}

// ── Hour accumulator ─────────────────────────────────────────────────────────

function emptyHour() {
  // `senders` and contract `from` are plain objects during accumulation;
  // compact() converts them to counts before persisting.
  // T3a fields: `aa` and `aaTx` are accumulated as integers; `_buckets` is a live
  // [[count,vol],[count,vol],[count,vol]] array collapsed in compact().
  return { blocks: 0, txs: 0, failed: 0, gas: 0, fees: 0, senders: {}, contracts: {} }
}

// ── Day-file cache (for closed hours only) ───────────────────────────────────

const days = new Map()

async function dayFile(day) {
  if (!days.has(day)) days.set(day, await readJson(join(ROOT, 'hourly', `${day}.json`), {}))
  return days.get(day)
}

// ── Open-hour accumulator persisted between runs ─────────────────────────────

const OPEN_PATH = join(ROOT, 'open.json')

// Sets are not JSON: app wallet sets travel as arrays inside open.json and in the published copy.
function dumpHour(h) {
  const copy = { ...h }
  if (h.apps) {
    copy.apps = Object.fromEntries(Object.entries(h.apps).map(([id, a]) => [id, { ...a, wallets: a.wallets instanceof Set ? [...a.wallets] : a.wallets }]))
  }
  return JSON.parse(JSON.stringify(copy))
}
function reviveHour(h) {
  if (h.apps) {
    for (const a of Object.values(h.apps)) if (Array.isArray(a.wallets)) a.wallets = new Set(a.wallets)
  }
  return h
}

// Restore a compacted open.json back to live accumulator shape.
// compact() turns senders/from into counts; we reverse that here by wrapping
// counts in a dummy object so += still works correctly when we continue.
// After resuming, we re-count at compact() time.
async function loadOpen() {
  const saved = await readJson(OPEN_PATH, null)
  if (!saved) return null
  // Inflate: turn senderCount back into senders placeholder (we re-derive at compact time)
  // Stored as { hk, hour: <compacted hour> }; inflate contracts back from top array.
  const h = {
    blocks: saved.hour.blocks ?? 0,
    txs: saved.hour.txs ?? 0,
    failed: saved.hour.failed ?? 0,
    gas: saved.hour.gas ?? 0,
    fees: saved.hour.fees ?? 0,
    // _senders accepts BOTH old shape (value=1) and new (value=count); both work as counters
    senders: saved.hour._senders ?? {},
    contracts: {},
    first: saved.hour.first,
    ...(saved.hour._apps    ? { apps: saved.hour._apps }       : {}),
    // T3a: restore running totals (absent in old open.json files = start from 0, correct)
    ...(saved.hour._aa      ? { _aa: saved.hour._aa }          : {}),
    ...(saved.hour._aaTx    ? { _aaTx: saved.hour._aaTx }      : {}),
    ...(saved.hour._buckets ? { _buckets: saved.hour._buckets } : {}),
    // T3b: restore live fields (absent in old files = fine)
    ...(saved.hour._big     ? { _big:     saved.hour._big     } : {}),
    ...(saved.hour._mb      ? { _mb:      saved.hour._mb      } : {}),
    ...(saved.hour._blk     ? { _blk:     saved.hour._blk     } : {}),
    ...(saved.hour._blkAddr ? { _blkAddr: saved.hour._blkAddr } : {}),
    ...(saved.hour._bridge  ? { _bridge:  saved.hour._bridge  } : {}),
  }
  reviveHour(h)
  // Restore contracts from _contracts (raw) if present, else they are lost (acceptable: re-accumulation starts fresh)
  if (saved.hour._contracts) {
    h.contracts = saved.hour._contracts
  }
  return { hk: saved.hk, hour: h, blockCursor: saved.blockCursor }
}

// Save the open accumulator (still in live-shape, with senders as object).
// We store a _senders snapshot and _contracts snapshot so we can resume.
// T3a: also persist _aa, _aaTx, _buckets so those counts survive a mid-hour restart.
async function saveOpen(hk, hour, blockCursor) {
  await writeJson(OPEN_PATH, {
    hk,
    blockCursor,
    hour: {
      blocks: hour.blocks,
      txs: hour.txs,
      failed: hour.failed,
      gas: hour.gas,
      fees: hour.fees,
      first: hour.first,
      _senders: hour.senders,
      _contracts: hour.contracts,
      _apps: dumpHour(hour).apps,
      // T3a fields — only written when non-zero to keep old hours small
      ...(hour._aa      ? { _aa: hour._aa }         : {}),
      ...(hour._aaTx    ? { _aaTx: hour._aaTx }     : {}),
      ...(hour._buckets ? { _buckets: hour._buckets } : {}),
      // T3b fields
      ...(hour._big     ? { _big:     hour._big     } : {}),
      ...(hour._mb      ? { _mb:      hour._mb      } : {}),
      ...(hour._blk     ? { _blk:     hour._blk     } : {}),
      ...(hour._blkAddr ? { _blkAddr: hour._blkAddr } : {}),
      ...(hour._bridge  ? { _bridge:  hour._bridge  } : {}),
    },
  })
}

async function deleteOpen() {
  try { await writeJson(OPEN_PATH, null) } catch { /* ignore */ }
}

// ── Wallet-index helpers (active only when WALLET_INDEX=1) ───────────────────

/**
 * Load wallets-pending.json into walletDays / walletDropped.
 * On corrupt or missing file: start empty and log one warning.
 */
async function loadWalletPending() {
  let raw
  try {
    raw = JSON.parse(await readFile(PENDING_PATH, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn('[wallets] pending file unreadable; starting empty')
    return
  }
  if (!raw || raw.version !== 1 || typeof raw.days !== 'object') {
    console.warn('[wallets] pending file corrupt; starting empty')
    return
  }
  walletDropped = raw.dropped ?? 0
  for (const [dayStr, shardObj] of Object.entries(raw.days)) {
    const day = Number(dayStr)
    const map = new Map()
    for (const [addr, encoded] of Object.entries(shardObj)) {
      map.set(addr.toLowerCase(), decodeRecord(encoded))
    }
    walletDays.set(day, map)
  }
}

/**
 * Persist wallets-pending.json atomically (temp file + rename).
 *
 * TRADE-OFF: we write this BEFORE state.json. That means if we crash between
 * the two writes, state.json still points to the old cursor, so the next run
 * will re-process some blocks and call walletDeltas on them again. Because
 * mergeInto is idempotent for the same (day, addr, delta) only when the block
 * produces the same delta — which it will, since the RPC is deterministic —
 * this leads to at most one batch being double-counted for wallets, but never
 * lost.  The alternative (writing state.json first) would silently drop wallet
 * data on a crash, which is harder to detect.
 */
async function saveWalletPending() {
  const days = {}
  for (const [day, map] of walletDays) {
    const obj = {}
    for (const [addr, rec] of map) obj[addr] = encodeRecord(rec)
    days[String(day)] = obj
  }
  const tmp = PENDING_PATH + '.tmp'
  await mkdir(dirname(PENDING_PATH), { recursive: true })
  await writeFile(tmp, JSON.stringify({ version: 1, dropped: walletDropped, days }))
  await rename(tmp, PENDING_PATH)
}

/**
 * Accumulate one block's wallet deltas into walletDays.
 *
 * @param {object[]} receipts   eth_getBlockReceipts result
 * @param {number}   blockTs    block.timestamp as a number (seconds)
 * @param {number}   usdcDec    USDC decimals
 */
function accumulateWalletBlock(receipts, blockTs, usdcDec) {
  const day = walletDayOf(blockTs)
  if (!walletDays.has(day)) walletDays.set(day, new Map())
  const dayMap = walletDays.get(day)

  const deltas = walletDeltas(receipts, {
    day,
    usdcDecimals: usdcDec,
    appIndex: walletAppIndex,
    net: NET,
  })

  for (const [addr, delta] of deltas) {
    if (dayMap.has(addr)) {
      // existing wallet — always update
      mergeInto(dayMap, addr, delta)
    } else {
      // new wallet — check cap
      if (dayMap.size >= WALLET_CAP) {
        walletDropped++
        if (!walletCappedWarned) {
          console.warn(`[wallets] wallet cap ${WALLET_CAP} reached for day ${day}; new wallets dropped`)
          walletCappedWarned = true
        }
        continue
      }
      mergeInto(dayMap, addr, delta)
    }
  }
}

// ── Block processing ─────────────────────────────────────────────────────────

async function fetchBatch(blockNumbers, attempt = 0) {
  const calls = []
  blockNumbers.forEach((n, i) => {
    calls.push({ jsonrpc: '2.0', id: i * 2,     method: 'eth_getBlockByNumber', params: [hex(n), false] })
    calls.push({ jsonrpc: '2.0', id: i * 2 + 1, method: 'eth_getBlockReceipts', params: [hex(n)] })
  })
  const out = await rpc(calls)
  // A pruned endpoint (Blockdaemon) answers old blocks with EMPTY receipts and no error. The block lists its
  // transactions, so a receipt count that differs from it means the answer is wrong: ask another endpoint
  // rather than index "0 transactions". If every endpoint disagrees, fail the run (state stays untouched).
  const bad = badReceiptIndexes(blockNumbers.length, out)
  if (bad.length === 0) return out
  if (attempt >= ENDPOINTS.length) {
    throw new Error(`receipts do not match the block's transactions for block ${blockNumbers[bad[0]]} on every endpoint`)
  }
  rotateEndpoint(`receipts != transactions for block ${blockNumbers[bad[0]]}`)
  return fetchBatch(blockNumbers, attempt + 1)
}

/**
 * Apply a batch of fetched block results to the in-memory day files + open accumulator.
 *
 * Returns { openHk, openHour } — the accumulator for the newest (still-open) hour seen.
 * Closed hours (any hour that transitioned away from during this batch) are written into
 * the day-file cache and will be flushed by flush().
 *
 * @param {number[]} blockNumbers
 * @param {any[]} out — interleaved [block, receipts, block, receipts, …]
 * @param {{ hk: string|null, hour: object|null }} open — current open accumulator
 */
async function apply(blockNumbers, out, open) {
  for (let i = 0; i < blockNumbers.length; i++) {
    const block = out[i * 2]
    const receipts = out[i * 2 + 1] || []
    const hk = hourKey(num(block.timestamp))

    if (hk !== open.hk) {
      // Hour boundary: persist the previous open hour as a closed (compacted) hour
      if (open.hk !== null) {
        const day = await dayFile(dayOf(open.hk))
        compact(open.hour)
        day[open.hk] = open.hour
      }
      open.hk = hk
      open.hour = emptyHour()
    }

    const h = open.hour
    h.first ??= blockNumbers[i]
    h.blocks++

    for (const r of receipts) {
      h.txs++
      if (r.status !== '0x1') h.failed++
      const gas = num(r.gasUsed)
      const fee = Number(BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)) / 1e18
      h.gas += gas
      h.fees += fee
      // T3a Part 1: count per-sender transactions (replaces old presence flag h.senders[x]=1)
      h.senders[r.from] = (h.senders[r.from] ?? 0) + 1
      const target = r.to ?? r.contractAddress
      if (target) {
        const c = (h.contracts[target] ??= { tx: 0, fee: 0, from: {} })
        c.tx++
        c.fee += fee
        c.from[r.from] = 1
      }
      // T3a Part 1b: aaTx — bundler transactions (to == EntryPoint)
      if (r.to && ENTRY_POINTS.has(r.to.toLowerCase())) {
        h._aaTx = (h._aaTx ?? 0) + 1
      }
      // T3a Part 1c: aa — count UserOperationEvent logs from EntryPoints
      const userOps = countUserOps(r)
      if (userOps > 0) h._aa = (h._aa ?? 0) + userOps
      // T3a Part 2: payment-size buckets — only for successful txs (failed have no logs)
      if (r.status === '0x1') {
        const usdcDec = metaCache.decimals[USDC] ?? 6  // fallback to 6 (verified Arc USDC decimals)
        const largest = largestUsdcTransfer(r.logs ?? [], USDC, usdcDec)
        if (largest !== null) {
          const b = h._buckets ?? (h._buckets = [[0, 0], [0, 0], [0, 0]])
          const idx = bucketIndex(largest)
          b[idx][0]++
          b[idx][1] = +(b[idx][1] + largest).toFixed(2)
        }

        // T3b Part 1: big transfers (>= BIG_TRANSFER_USDC)
        const bigs = bigTransfers(r.logs ?? [], r.transactionHash ?? '', USDC, usdcDec)
        for (const bt of bigs) {
          const arr = h._big ?? (h._big = [])
          arr.push(bt)
          // Keep only top 5 by amount in the live accumulator to bound memory
          arr.sort((a, b) => b.amt - a.amt)
          if (arr.length > 5) arr.length = 5
        }

        // T3b Part 2: mint and burn (USDC + EURC)
        const eurcDec = metaCache.decimals[EURC] ?? 6
        const mb = mintBurnFromLogs(r.logs ?? [], USDC, EURC, Math.min(usdcDec, eurcDec))
        if (mb) {
          const acc = h._mb ?? (h._mb = {})
          if (mb.usdc) {
            acc.usdc ??= [0, 0]
            acc.usdc[0] = +(acc.usdc[0] + mb.usdc[0]).toFixed(2)
            acc.usdc[1] = +(acc.usdc[1] + mb.usdc[1]).toFixed(2)
          }
          if (mb.eurc) {
            acc.eurc ??= [0, 0]
            acc.eurc[0] = +(acc.eurc[0] + mb.eurc[0]).toFixed(2)
            acc.eurc[1] = +(acc.eurc[1] + mb.eurc[1]).toFixed(2)
          }
        }

        // T3b Part 3: blocklist events
        const blk = blocklistFromLogs(r.logs ?? [], USDC, EURC)
        if (blk) {
          const ba = h._blk ?? (h._blk = [0, 0])
          ba[0] += blk.added
          ba[1] += blk.removed
          const addrAcc = h._blkAddr ?? (h._blkAddr = [])
          for (const entry of blk.addrs) {
            addrAcc.push(entry)
            if (addrAcc.length >= 10) break  // cap at 10 per hour
          }
        }

        // T3b Part 4: CCTP bridge — outgoing (DepositForBurn from TokenMessenger)
        for (const log of r.logs ?? []) {
          if (!log.topics?.length) continue
          if (log.address?.toLowerCase() === TOKEN_MESSENGER_ADDR &&
              log.topics[0].toLowerCase() === DEPOSIT_FOR_BURN_TOPIC) {
            const decoded = decodeDepositForBurn(log.data, usdcDec)
            if (decoded) {
              const br = h._bridge ?? (h._bridge = { out: [0, 0, 0], in: [0], byDomain: {} })
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
          // T3b Part 4: CCTP bridge — incoming (MessageReceived from MessageTransmitter)
          if (log.address?.toLowerCase() === MESSAGE_TRANSMITTER_ADDR &&
              log.topics[0].toLowerCase() === MESSAGE_RECEIVED_TOPIC) {
            const br = h._bridge ?? (h._bridge = { out: [0, 0, 0], in: [0], byDomain: {} })
            br.in[0]++
          }
        }
      }
    }
    // ── App stats (v2) ──
    if (HAS_APPS && receipts.length) accumulateApps(h, receipts, APPS_CONFIG, metaCache.decimals)

    // ── Wallet index (feature-flagged) ──
    if (WALLET_INDEX && receipts.length) {
      const usdcDec = metaCache.decimals[USDC] ?? 6
      accumulateWalletBlock(receipts, num(block.timestamp), usdcDec)
    }
  }
}

/** Collapse sender sets into counts and keep only the busiest contracts. Mutates h in place. */
function compact(h) {
  if (h.senders && typeof h.senders === 'object') {
    h.senderCount = Object.keys(h.senders).length
    // T3a Part 1: derive auto stats from sender counts, then delete raw map
    const a = autoStats(h.senders)
    if (a.senders > 0) h.auto = a  // only written when non-zero (backwards compat)
    delete h.senders
  }
  const rows = Object.entries(h.contracts ?? {})
  const compacted = rows.map(([addr, c]) => [
    addr,
    c.tx,
    c.from ? Object.keys(c.from).length : (c.wallets ?? 0),
    +c.fee.toFixed(6),
  ])
  compacted.sort((a, b) => b[1] - a[1])
  h.top = compacted.slice(0, TOP_PER_HOUR)
  h.contractCount = rows.length
  delete h.contracts
  h.fees = +h.fees.toFixed(6)
  // T3a Part 1b/c: promote _aa/_aaTx to public fields (only when > 0; old hours lack them)
  if (h._aa)   { h.aa   = h._aa;   delete h._aa   }
  if (h._aaTx) { h.aaTx = h._aaTx; delete h._aaTx }
  // T3a Part 2: promote _buckets to public `buckets` field (only when present)
  if (h._buckets) { h.buckets = h._buckets; delete h._buckets }
  // T3b: promote live fields to public fields
  if (h._big)     { h.big = h._big;         delete h._big }
  if (h._mb)      { h.mb  = h._mb;          delete h._mb  }
  if (h._blk)     { h.blk = h._blk;         delete h._blk }
  if (h._blkAddr) { h.blkAddr = h._blkAddr; delete h._blkAddr }
  if (h._bridge)  { h.bridge  = h._bridge;  delete h._bridge  }
  compactApps(h) // v2 app stats
}

/** Write all dirty day files. The open hour is NOT written here (it stays in open.json). */
async function flush() {
  for (const [day, data] of days) {
    await writeJson(join(ROOT, 'hourly', `${day}.json`), data)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now()

  // Build wallet app index once (empty when no apps config)
  if (WALLET_INDEX) {
    walletAppIndex = buildAppIndex(APPS_CONFIG)
    await loadWalletPending()
  }

  await fetchDecimals()
  const tip = await head()
  const statePath = join(ROOT, 'state.json')
  const state = await readJson(statePath, null)

  // ── Determine starting cursor ────────────────────────────────────────────

  // First run: respect BACKFILL_HOURS
  let next = state?.next ?? Math.max(0, tip - Math.round((BACKFILL_HOURS * 3600) / BLOCK_SECONDS))

  // Catch-up policy: if we are more than BACKFILL_HOURS behind the tip, jump forward.
  // Record skipped ranges in state for transparency.
  const skipped = state?.skipped ?? []
  const backfillBlocks = Math.round((BACKFILL_HOURS * 3600) / BLOCK_SECONDS)
  const catchUpStart = tip - backfillBlocks
  if (next < catchUpStart) {
    console.log(`[catchup] cursor ${next} is > ${BACKFILL_HOURS}h behind tip ${tip}; jumping to ${catchUpStart}`)
    skipped.push([next, catchUpStart - 1])
    next = catchUpStart
    // Discard any saved open hour — it belongs to the skipped range
    await deleteOpen()
  }

  // Migration from the old format (no open.json): redo the old open hour once from its start.
  if (state?.openHourStart && !(await readJson(OPEN_PATH, null)) && next > state.openHourStart && next === state.next) {
    console.log(`[migrate] no open.json; rebuilding open hour ${state.openHour} from block ${state.openHourStart}`)
    next = state.openHourStart
  }

  // ── Resume open accumulator or start fresh ───────────────────────────────

  let openState = await loadOpen()
  // If the saved open block cursor doesn't match where we're starting, discard it
  if (openState && openState.blockCursor !== next) {
    console.log(`[open] discarding stale open.json (cursor mismatch: saved=${openState.blockCursor} next=${next})`)
    openState = null
    await deleteOpen()
  }

  // open = { hk: string|null, hour: object|null }
  const open = openState
    ? { hk: openState.hk, hour: openState.hour }
    : { hk: null, hour: null }

  const start = next
  let blocksProcessed = 0

  // ── Main loop ────────────────────────────────────────────────────────────

  let loopError = null
  try {
  while (next <= tip && Date.now() - t0 < BUDGET_MS) {
    const batchNums = []
    for (let n = next; n <= tip && batchNums.length < batch; n++) batchNums.push(n)

    const results = await fetchBatch(batchNums)
    await apply(batchNums, results, open)

    next = batchNums.at(-1) + 1
    blocksProcessed += batchNums.length

    // Save open accumulator after each batch so a crash loses at most one batch
    if (open.hk !== null) {
      await saveOpen(open.hk, open.hour, next)
    }
    // Save wallet pending alongside open.json (same crash semantics)
    if (WALLET_INDEX) await saveWalletPending()

    await new Promise((r) => setTimeout(r, PAUSE_MS))
  }
  } catch (e) {
    loopError = e // still save everything processed so far
    console.error(`[run] stopped early: ${e.message}`)
  }

  // ── Finalise ─────────────────────────────────────────────────────────────

  // Publish a compacted copy of the still-open hour so readers see the newest hour too
  // (the raw accumulator stays in open.json and the copy is replaced when the hour closes).
  if (open.hk !== null) {
    const copy = reviveHour(dumpHour(open.hour))
    compact(copy)
    ;(await dayFile(dayOf(open.hk)))[open.hk] = copy
  }
  // Flush all closed hours (day files)
  await flush()

  if (HAS_APPS) await writeJson(META_PATH, metaCache)

  // Persist wallet index BEFORE state.json (see trade-off comment in saveWalletPending).
  // If we crash between these two writes, state.json still points to the old cursor,
  // so the next run will re-process the last batch; at most a few blocks are double-
  // counted for wallets, but no wallet data is ever silently lost.
  if (WALLET_INDEX) await saveWalletPending()

  // Persist state
  await writeJson(statePath, {
    next,
    tip,
    network: NET,
    chainId: NETWORKS[NET].chainId,
    // openHour / openHourStart kept for backward compat with summarize.mjs readers
    openHour: open.hk ?? null,
    openHourStart: open.hour?.first ?? null,
    skipped,
    updatedAt: new Date().toISOString(),
  })

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
  console.log(`${NET}: ${blocksProcessed} blocks in ${elapsed}s, cursor ${next}/${tip}`)
  if (loopError) process.exitCode = 0 // progress saved; the next scheduled run continues
}

main().catch((e) => { console.error(e); process.exit(1) })
