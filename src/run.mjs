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

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accumulateApps, compactApps } from './apps.mjs'

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
    senders: saved.hour._senders ?? {},
    contracts: {},
    first: saved.hour.first,
    ...(saved.hour._apps ? { apps: saved.hour._apps } : {}),
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
    },
  })
}

async function deleteOpen() {
  try { await writeJson(OPEN_PATH, null) } catch { /* ignore */ }
}

// ── Block processing ─────────────────────────────────────────────────────────

async function fetchBatch(blockNumbers) {
  const calls = []
  blockNumbers.forEach((n, i) => {
    calls.push({ jsonrpc: '2.0', id: i * 2,     method: 'eth_getBlockByNumber', params: [hex(n), false] })
    calls.push({ jsonrpc: '2.0', id: i * 2 + 1, method: 'eth_getBlockReceipts', params: [hex(n)] })
  })
  return rpc(calls)
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
      h.senders[r.from] = 1
      const target = r.to ?? r.contractAddress
      if (!target) continue
      const c = (h.contracts[target] ??= { tx: 0, fee: 0, from: {} })
      c.tx++
      c.fee += fee
      c.from[r.from] = 1
    }
    // ── App stats (v2) ──
    if (HAS_APPS && receipts.length) accumulateApps(h, receipts, APPS_CONFIG, metaCache.decimals)
  }
}

/** Collapse sender sets into counts and keep only the busiest contracts. Mutates h in place. */
function compact(h) {
  if (h.senders && typeof h.senders === 'object') {
    h.senderCount = Object.keys(h.senders).length
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
