// Pulsarc indexer — reads Arc blocks and keeps small hourly aggregates.
//
// Resumes from data/<net>/state.json, so it can be run on a schedule: each run processes as
// many blocks as its time budget allows and stops. Only aggregates are stored, never raw
// transactions (ArcScan is the place for those).
//
//   NET=mainnet node indexer/run.mjs
//   env: BACKFILL_HOURS (first run only, default 24), BUDGET_SECONDS (default 1200)

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NETWORKS = {
  mainnet: { rpc: 'https://rpc.mainnet.arc.io', chainId: 5042 },
  testnet: { rpc: 'https://rpc.testnet.arc.io', chainId: 5042002 },
}

const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const RPC = process.env.RPC_URL || NETWORKS[NET].rpc
const BACKFILL_HOURS = Number(process.env.BACKFILL_HOURS || 24)
const BUDGET_MS = Number(process.env.BUDGET_SECONDS || 1200) * 1000
const BATCH = 15 // blocks per RPC round trip (2 calls each) — keeps well under the public rate limit
const PARALLEL = 1
const PAUSE_MS = 80
const TOP_PER_HOUR = 400 // contracts kept per hour
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const BLOCK_SECONDS = 0.5

const hex = (n) => '0x' + n.toString(16)
const num = (h) => Number(BigInt(h))

async function rpc(calls, attempt = 0) {
  try {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls),
    })
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
    const out = await res.json()
    if (!Array.isArray(out)) throw new Error('bad batch response')
    const failed = out.find((r) => r.error)
    if (failed) throw new Error(failed.error.message) // includes 'rate limit exceeded' — retried
    return out.sort((a, b) => a.id - b.id).map((r) => r.result)
  } catch (e) {
    if (attempt >= 8) throw e
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt))
    return rpc(calls, attempt + 1)
  }
}

async function head() {
  const [h] = await rpc([{ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] }])
  return num(h)
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

/** hour key like 2026-10-08T14 (UTC) */
const hourKey = (ts) => new Date(ts * 1000).toISOString().slice(0, 13)
const dayOf = (hk) => hk.slice(0, 10)

// Hours are loaded lazily and flushed per day file.
const days = new Map()
async function dayFile(day) {
  if (!days.has(day)) days.set(day, await readJson(join(ROOT, 'hourly', `${day}.json`), {}))
  return days.get(day)
}

function emptyHour() {
  return { blocks: 0, txs: 0, failed: 0, gas: 0, fees: 0, senders: {}, contracts: {} }
}

async function fetchBatch(blockNumbers) {
  const calls = []
  blockNumbers.forEach((n, i) => {
    calls.push({ jsonrpc: '2.0', id: i * 2, method: 'eth_getBlockByNumber', params: [hex(n), false] })
    calls.push({ jsonrpc: '2.0', id: i * 2 + 1, method: 'eth_getBlockReceipts', params: [hex(n)] })
  })
  return rpc(calls)
}

async function apply(blockNumbers, out) {
  for (let i = 0; i < blockNumbers.length; i++) {
    const block = out[i * 2]
    const receipts = out[i * 2 + 1] || []
    const hk = hourKey(num(block.timestamp))
    const day = await dayFile(dayOf(hk))
    const h = (day[hk] ??= emptyHour())
    h.first ??= blockNumbers[i]
    h.blocks++
    for (const r of receipts) {
      h.txs++
      if (r.status !== '0x1') h.failed++
      const gas = num(r.gasUsed)
      // fee in USDC: gasUsed × effectiveGasPrice (wei, 18 decimals)
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
  }
}

/** Collapse sender sets into counts and keep only the busiest contracts per hour. */
function compact(h) {
  if (h.senders && typeof h.senders === 'object' && !Array.isArray(h.senders)) {
    h.senderCount = Object.keys(h.senders).length
    delete h.senders
  }
  const rows = Object.entries(h.contracts ?? {})
  const compacted = rows.map(([addr, c]) => [addr, c.tx, c.from ? Object.keys(c.from).length : c.wallets, +c.fee.toFixed(6)])
  compacted.sort((a, b) => b[1] - a[1])
  h.top = compacted.slice(0, TOP_PER_HOUR) // [address, txs, wallets, fees]
  h.contractCount = rows.length
  delete h.contracts
  h.fees = +h.fees.toFixed(6)
}

async function flush(hourKeysTouched) {
  for (const [day, data] of days) {
    for (const hk of Object.keys(data)) {
      if (hourKeysTouched.has(hk) && data[hk].contracts) compact(data[hk])
    }
    await writeJson(join(ROOT, 'hourly', `${day}.json`), data)
  }
}

async function main() {
  const t0 = Date.now()
  const tip = await head()
  const statePath = join(ROOT, 'state.json')
  const state = await readJson(statePath, null)
  let next = state?.next ?? Math.max(0, tip - Math.round((BACKFILL_HOURS * 3600) / BLOCK_SECONDS))
  const start = next
  const touched = new Set()

  // A partially processed hour at the cursor is rebuilt from scratch so reruns never double count.
  if (state?.openHour) {
    const day = await dayFile(dayOf(state.openHour))
    delete day[state.openHour]
    next = state.openHourStart
  }

  while (next <= tip && Date.now() - t0 < BUDGET_MS) {
    // a few batches in flight at once, applied strictly in block order
    const batches = []
    for (let b = 0, n = next; b < PARALLEL && n <= tip; b++) {
      const batch = []
      for (; n <= tip && batch.length < BATCH; n++) batch.push(n)
      batches.push(batch)
    }
    const results = await Promise.all(batches.map(fetchBatch))
    for (let i = 0; i < batches.length; i++) await apply(batches[i], results[i])
    for (const [, data] of days) for (const hk of Object.keys(data)) touched.add(hk)
    next = batches.at(-1).at(-1) + 1
    await new Promise((r) => setTimeout(r, PAUSE_MS))
  }

  // The newest hour is still filling up; remember where it started so the next run can redo it.
  const lastHour = [...touched].sort().at(-1) ?? null
  const openHourStart = lastHour ? (await dayFile(dayOf(lastHour)))[lastHour].first : null

  await flush(touched)
  await writeJson(statePath, {
    next,
    tip,
    network: NET,
    chainId: NETWORKS[NET].chainId,
    openHour: lastHour,
    openHourStart,
    updatedAt: new Date().toISOString(),
  })
  const done = next - start
  console.log(`${NET}: ${done} blocks in ${((Date.now() - t0) / 1000).toFixed(0)}s, cursor ${next}/${tip}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
