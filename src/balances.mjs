// Reads USDC balances held by tracked apps and writes a time-series document.
// Writes data/<net>/balances.json.  On RPC failure keeps the old file and exits 0.
//
// Usage: NET=testnet|mainnet node src/balances.mjs  (default: mainnet)
//
// Pure helpers (holderAddresses, encodeBalanceOf, rawToNumber, buildBalances) are
// exported and have no side-effects so they can be tested without network access.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── App ids that are themselves tokens, not holders ────────────────────────────

export const EXCLUDE_APPS = new Set(['usdc', 'eurc', 'usyc', 'cirbtc', 'weth', 'wusdc'])

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return the list of apps that should have their USDC balances summed.
 *
 * Each entry is `{ id, addresses }` where `addresses` is a lowercase,
 * de-duplicated array of anchor addresses for that app (within-app dedup only;
 * the same address may appear under multiple apps).
 *
 * Preserves the order of apps as they appear in the config.
 *
 * @param {{ apps: Array<{ id: string; anchors: Array<{ address: string }> }> }} appsConfig
 * @returns {Array<{ id: string; addresses: string[] }>}
 */
export function holderAddresses(appsConfig) {
  const result = []
  for (const app of appsConfig.apps) {
    if (EXCLUDE_APPS.has(app.id)) continue
    const seen = new Set()
    const addresses = []
    for (const anchor of app.anchors ?? []) {
      const lc = anchor.address.toLowerCase()
      if (!seen.has(lc)) {
        seen.add(lc)
        addresses.push(lc)
      }
    }
    if (addresses.length > 0) {
      result.push({ id: app.id, addresses })
    }
  }
  return result
}

/**
 * ABI-encode a `balanceOf(address)` call.
 *
 * Selector: 0x70a08231
 * Returns: 4-byte selector + 32-byte zero-padded address (0x-prefixed, 74 chars total).
 *
 * @param {string} address  0x-prefixed, exactly 40 hex chars
 * @returns {string}        full calldata hex string
 * @throws {Error}          if `address` is not a valid 0x+40-hex address
 */
export function encodeBalanceOf(address) {
  if (
    typeof address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(address)
  ) {
    throw new Error(`encodeBalanceOf: invalid address: ${address}`)
  }
  // Address is right-aligned in a 32-byte ABI word (12 zero bytes of padding).
  const padded = '0'.repeat(24) + address.slice(2).toLowerCase()
  return '0x70a08231' + padded
}

/**
 * Convert a raw token balance (bigint) to a JS number rounded to 2 decimal places.
 *
 * Uses exact bigint arithmetic for the integer part; only the fractional part
 * is converted to floating-point, which avoids precision loss for large balances.
 *
 * @param {bigint} raw       raw token amount (e.g. as returned by balanceOf)
 * @param {number} decimals  token decimal count (e.g. 6 for USDC)
 * @returns {number}         human-readable amount, rounded to 2 decimals
 */
export function rawToNumber(raw, decimals) {
  const scale = 10n ** BigInt(decimals)
  const intPart = raw / scale           // bigint integer division
  const fracRaw = raw % scale           // bigint remainder
  // Convert fractional part: fracRaw / scale, then round to 2 decimals.
  const frac = Number(fracRaw) / Number(scale)
  return Math.round((Number(intPart) + frac) * 100) / 100
}

/**
 * Build (or update) the balances.json document.
 *
 * @param {object|null} prev   existing balances.json, or null on first run
 * @param {{ hour: string; perApp: Record<string, number> }} reading
 *   `hour` is a 'YYYY-MM-DDTHH' string; `perApp` maps app id → USDC total
 * @param {{ network: string; now: string }} meta
 * @param {number} [keep=168]  max number of hourly series points to retain
 * @returns {object}  the updated document
 *
 * Shape:
 * {
 *   network,
 *   generatedAt,
 *   token: 'USDC',
 *   total: number,          // sum of all per-app values, 2 decimals
 *   apps: { [id]: { usdc: number } },  // sorted by usdc desc then id asc; 0-balance apps kept
 *   series: [{ hour, total }]           // sorted asc, trimmed to `keep`, same-hour replaces
 * }
 */
export function buildBalances(prev, reading, meta, keep = 168) {
  const { hour, perApp } = reading
  const { network, now: generatedAt } = meta

  // ── total ──────────────────────────────────────────────────────────────────
  const total = Math.round(
    Object.values(perApp).reduce((s, v) => s + v, 0) * 100,
  ) / 100

  // ── apps map — sorted by usdc descending, then id ascending ───────────────
  const sortedIds = Object.keys(perApp).sort((a, b) => {
    const diff = perApp[b] - perApp[a]
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })
  const apps = {}
  for (const id of sortedIds) {
    apps[id] = { usdc: perApp[id] }
  }

  // ── series — same-hour replace, sort asc, trim ────────────────────────────
  const existing = Array.isArray(prev?.series) ? prev.series : []
  const filtered = existing.filter((e) => e.hour !== hour)
  filtered.push({ hour, total })
  filtered.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0))
  const series = filtered.length > keep ? filtered.slice(filtered.length - keep) : filtered

  return {
    network,
    generatedAt,
    token: 'USDC',
    total,
    apps,
    series,
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}

async function runCli() {
  const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const APPS_PATH = join(REPO_ROOT, `apps.${NET}.json`)
  const DATA_DIR  = join(REPO_ROOT, 'data', NET)
  const OUT_PATH  = join(DATA_DIR, 'balances.json')

  // ── RPC endpoint rotation (same pattern as supply.mjs / fx.mjs) ─────────────

  const NETWORKS = {
    testnet: {
      rpc: 'https://rpc.testnet.arc.io',
      fallbacks: [
        'https://rpc.blockdaemon.testnet.arc.io',
        'https://rpc.drpc.testnet.arc.io',
      ],
    },
    mainnet: {
      rpc: 'https://rpc.mainnet.arc.io',
      fallbacks: [
        'https://rpc.blockdaemon.mainnet.arc.io',
        'https://rpc.drpc.mainnet.arc.io',
      ],
    },
  }

  function buildEndpoints() {
    if (process.env.RPC_URLS) return process.env.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
    if (process.env.RPC_URL)  return [process.env.RPC_URL]
    return [NETWORKS[NET].rpc, ...NETWORKS[NET].fallbacks]
  }

  const ENDPOINTS = buildEndpoints()
  const REQUEST_TIMEOUT_MS = 10_000
  const CHUNK_SIZE = 10   // the public RPC answers single calls of a big batch with -32005 (HTTP 200)

  async function rpcBatch(calls, attempt = 0) {
    if (attempt > ENDPOINTS.length * 2) throw new Error('all RPC endpoints failed')
    const ep = ENDPOINTS[attempt % ENDPOINTS.length]
    let res
    try {
      res = await fetch(ep, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      return rpcBatch(calls, attempt + 1)
    }
    if (res.status === 429 || res.status >= 500) return rpcBatch(calls, attempt + 1)
    const out = await res.json()
    if (!Array.isArray(out)) return rpcBatch(calls, attempt + 1)
    return out.sort((a, b) => a.id - b.id).map((r) => r.result)
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Like rpcBatch, but re-sends the calls that came back without a result (per-call rate limit). */
  async function rpcBatchPatient(calls) {
    const results = new Array(calls.length).fill(undefined)
    let pending = calls.map((_, i) => i)
    for (let round = 0; round < 5 && pending.length > 0; round++) {
      if (round > 0) await sleep(500 * 2 ** (round - 1))
      const sub = await rpcBatch(pending.map((i) => calls[i]))
      const next = []
      pending.forEach((idx, k) => {
        if (sub[k] === undefined || sub[k] === null) next.push(idx)
        else results[idx] = sub[k]
      })
      pending = next
    }
    return results
  }

  /** Split an array into chunks of at most `size`. */
  function chunks(arr, size) {
    const out = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }

  // ── Load apps config ─────────────────────────────────────────────────────────

  let appsConfig
  try {
    appsConfig = JSON.parse(await readFile(APPS_PATH, 'utf8'))
  } catch (e) {
    process.stderr.write(`[balances] failed to read ${APPS_PATH}: ${e.message} — keeping old file\n`)
    process.exit(0)
  }

  // ── Find USDC token address from apps config (app id = 'usdc') ───────────────

  const usdcApp = appsConfig.apps.find((a) => a.id === 'usdc')
  if (!usdcApp || !usdcApp.anchors?.[0]?.address) {
    process.stderr.write('[balances] could not find usdc app in apps config — keeping old file\n')
    process.exit(0)
  }
  const USDC_TOKEN = usdcApp.anchors[0].address.toLowerCase()

  // ── Load existing balances.json ───────────────────────────────────────────────

  let existing = null
  try {
    existing = JSON.parse(await readFile(OUT_PATH, 'utf8'))
  } catch { /* first run */ }

  // ── Current UTC hour key ─────────────────────────────────────────────────────

  const nowIso = new Date().toISOString()
  const nowHour = nowIso.slice(0, 13)   // 'YYYY-MM-DDTHH'

  // ── Build the list of apps and their addresses ────────────────────────────────

  const holders = holderAddresses(appsConfig)

  // ── Build the batched call list ───────────────────────────────────────────────
  // Call 0:  decimals() on USDC token
  // Calls 1…N: balanceOf(<address>) for each unique address across all apps
  //   (We query every per-app address; each app may share an address with another
  //   but we still need all results independently indexed.)

  // Collect the flat ordered list of (appIndex, addrIndex, address) for calls.
  // We deduplicate across apps for the RPC calls but map results back per-app.
  const addrCallMap = new Map()   // address → call id (offset by 1 for decimals)
  const callList = []             // in order, index 0 = first balanceOf slot

  for (const { addresses } of holders) {
    for (const addr of addresses) {
      if (!addrCallMap.has(addr)) {
        addrCallMap.set(addr, callList.length)
        callList.push(addr)
      }
    }
  }

  // id 0 = decimals; id 1..N = balanceOf calls
  const decimalsCall = {
    jsonrpc: '2.0',
    id: 0,
    method: 'eth_call',
    params: [{ to: USDC_TOKEN, data: '0x313ce567' }, 'latest'],
  }
  const balanceOfCalls = callList.map((addr, i) => ({
    jsonrpc: '2.0',
    id: i + 1,
    method: 'eth_call',
    params: [{ to: USDC_TOKEN, data: encodeBalanceOf(addr) }, 'latest'],
  }))

  const allCalls = [decimalsCall, ...balanceOfCalls]

  // ── Send in chunks of at most CHUNK_SIZE ──────────────────────────────────────

  let allResults
  try {
    const chunked = chunks(allCalls, CHUNK_SIZE)
    allResults = []
    for (const chunk of chunked) {
      allResults.push(...(await rpcBatchPatient(chunk)))
      await sleep(150)
    }
  } catch (e) {
    process.stderr.write(`[balances] RPC batch failed: ${e.message} — keeping old file\n`)
    process.exit(0)
  }

  // ── Decode decimals ───────────────────────────────────────────────────────────

  const decimalsHex = allResults[0]
  let decimals = 6
  if (decimalsHex && decimalsHex !== '0x' && /^0x[0-9a-fA-F]+$/.test(decimalsHex)) {
    try { decimals = Number(BigInt(decimalsHex)) } catch { /* keep default 6 */ }
  }

  // ── Decode balanceOf results and track failures ───────────────────────────────

  // allResults[1..N] correspond to balanceOfCalls in the same order.
  // We need to map them back to the correct position in callList.
  // After chunking and flattening, positions shift: we need to re-index by
  // the original call `id` fields.

  // Build a map from call id → result value
  const resultById = new Map()
  for (let i = 0; i < allCalls.length; i++) {
    resultById.set(allCalls[i].id, allResults[i])
  }

  let failCount = 0
  const addrBalance = new Map()   // address → bigint balance

  for (const [addr, callIdx] of addrCallMap) {
    const raw = resultById.get(callIdx + 1)   // +1 because id 0 is decimals
    if (!raw || raw === '0x' || !/^0x[0-9a-fA-F]+$/.test(raw)) {
      failCount++
      addrBalance.set(addr, 0n)
    } else {
      try {
        addrBalance.set(addr, BigInt(raw))
      } catch {
        failCount++
        addrBalance.set(addr, 0n)
      }
    }
  }

  // More than 20% of balanceOf calls failed → abort
  if (callList.length > 0 && failCount / callList.length > 0.2) {
    process.stderr.write(
      `[balances] too many failed balanceOf calls (${failCount}/${callList.length}) — keeping old file\n`,
    )
    process.exit(0)
  }

  // ── Sum balances per app ──────────────────────────────────────────────────────

  const perApp = {}
  for (const { id, addresses } of holders) {
    let sum = 0n
    for (const addr of addresses) {
      sum += addrBalance.get(addr) ?? 0n
    }
    perApp[id] = rawToNumber(sum, decimals)
  }

  // ── Build document and write atomically ──────────────────────────────────────

  const doc = buildBalances(
    existing,
    { hour: nowHour, perApp },
    { network: NET, now: nowIso },
    168,
  )

  try {
    await mkdir(DATA_DIR, { recursive: true })
    const tmp = OUT_PATH + '.tmp'
    await writeFile(tmp, JSON.stringify(doc))
    await rename(tmp, OUT_PATH)
    console.log(`${NET}: balances.json written (total=${doc.total} USDC, apps=${Object.keys(doc.apps).length})`)
  } catch (e) {
    process.stderr.write(`[balances] write failed: ${e.message} — keeping old file\n`)
    process.exit(0)
  }
}
