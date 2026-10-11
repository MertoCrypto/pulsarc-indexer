// Fetches USDC and EURC totalSupply() from the chain and appends hourly series points.
// Writes data/<net>/supply.json.  On RPC failure keeps the old file and exits 0.
//
// Usage: NET=testnet node src/supply.mjs
//
// Pure helpers (parseSupplyHex, appendSupplySeries) live in counters.mjs so they can
// be tested without network access.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USDC, EURC, parseSupplyHex, appendSupplySeries } from './counters.mjs'

const NET  = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const SUPPLY_PATH = join(ROOT, 'supply.json')
const HOURLY_DIR  = join(ROOT, 'hourly')

// ── RPC (same rotation logic as run.mjs, simplified single-batch) ─────────────

const NETWORKS = {
  mainnet: { rpc: 'https://rpc.mainnet.arc.io', fallbacks: ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io'] },
  testnet: { rpc: 'https://rpc.testnet.arc.io',  fallbacks: ['https://rpc.blockdaemon.testnet.arc.io', 'https://rpc.drpc.testnet.arc.io'] },
}

function buildEndpoints() {
  if (process.env.RPC_URLS) return process.env.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  if (process.env.RPC_URL)  return [process.env.RPC_URL]
  return [NETWORKS[NET].rpc, ...NETWORKS[NET].fallbacks]
}

const ENDPOINTS = buildEndpoints()
const REQUEST_TIMEOUT_MS = 10_000
const TOTAL_SUPPLY_SELECTOR = '0x18160ddd'
const DECIMALS_SELECTOR     = '0x313ce567'

async function rpcCall(calls, attempt = 0) {
  if (attempt > ENDPOINTS.length * 2) throw new Error('all RPC endpoints failed')
  const ep = ENDPOINTS[attempt % ENDPOINTS.length]
  let res
  try {
    res = await fetch(ep, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) { return rpcCall(calls, attempt + 1) }
  if (res.status === 429 || res.status >= 500) return rpcCall(calls, attempt + 1)
  const out = await res.json()
  if (!Array.isArray(out)) return rpcCall(calls, attempt + 1)
  return out.sort((a, b) => a.id - b.id).map((r) => r.result)
}

const hex = (n) => '0x' + n.toString(16)

// ── Load existing supply.json ──────────────────────────────────────────────────

let existing = null
try {
  existing = JSON.parse(await readFile(SUPPLY_PATH, 'utf8'))
} catch { /* first run */ }

// ── Current UTC hour key ───────────────────────────────────────────────────────

const nowHk = new Date().toISOString().slice(0, 13)   // e.g. '2026-10-08T14'

// ── Load the latest hourly file to find any mb data for this hour ─────────────

async function loadLatestMb(hk) {
  try {
    const day = hk.slice(0, 10) + '.json'
    const data = JSON.parse(await readFile(join(HOURLY_DIR, day), 'utf8'))
    return data[hk]?.mb ?? null
  } catch { return null }
}

// ── Fetch totalSupply + decimals ───────────────────────────────────────────────

let results
try {
  results = await rpcCall([
    { jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: USDC, data: TOTAL_SUPPLY_SELECTOR }, 'latest'] },
    { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: EURC, data: TOTAL_SUPPLY_SELECTOR }, 'latest'] },
    { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: USDC, data: DECIMALS_SELECTOR },     'latest'] },
    { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: EURC, data: DECIMALS_SELECTOR },     'latest'] },
  ])
} catch (e) {
  console.warn(`[supply] RPC failed: ${e.message} — keeping old supply.json`)
  process.exit(0)
}

const usdcDec  = results[2] && results[2] !== '0x' ? Number(BigInt(results[2])) : 6
const eurcDec  = results[3] && results[3] !== '0x' ? Number(BigInt(results[3])) : 6
const usdcSup  = parseSupplyHex(results[0], usdcDec)
const eurcSup  = parseSupplyHex(results[1], eurcDec)

const mb = await loadLatestMb(nowHk)

// ── Build or update output ────────────────────────────────────────────────────

const usdcSeries = existing?.tokens?.usdc?.series ?? []
const eurcSeries = existing?.tokens?.eurc?.series ?? []

appendSupplySeries(usdcSeries, nowHk, usdcSup, mb, 'usdc')
appendSupplySeries(eurcSeries, nowHk, eurcSup, mb, 'eurc')

const out = {
  generatedAt: new Date().toISOString(),
  network: NET,
  tokens: {
    usdc: { supply: usdcSup, series: usdcSeries },
    eurc: { supply: eurcSup, series: eurcSeries },
  },
}

await mkdir(ROOT, { recursive: true })
await writeFile(SUPPLY_PATH, JSON.stringify(out))
console.log(`${NET}: supply.json written (usdc=${usdcSup}, eurc=${eurcSup})`)
