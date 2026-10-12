// Fetches EURC/USDC pool rates from the Curve pool on Arc and appends hourly series.
// Writes data/<net>/fx.json.  On RPC failure keeps the old file and exits 0.
//
// Usage: NET=testnet node src/fx.mjs
//
// Pure helpers (encodeGetDy, decodeUint, poolRate, appendFxSeries) are exported and
// have no side-effects so they can be tested without network access.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── Verified on-chain constants (Arc testnet, checked 2026-10-12) ─────────────

/** Curve USDC/EURC pool address (Arc testnet). */
export const POOL = '0x2d84d79c852f6842abe0304b70bbaa1506add457'

/** coins(0) — USDC on Arc testnet. */
export const USDC_ADDR = '0x3600000000000000000000000000000000000000'

/** coins(1) — EURC on Arc testnet. */
export const EURC_ADDR = '0x89b50855aa3be2f677cd6303cec089b5f319d72a'

/** ABI selectors used by the CLI. */
export const SELECTORS = {
  coins:      '0xc6610657',
  getDy:      '0x5e0d443f',
  decimals:   '0x313ce567',
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Encode a get_dy(i, j, dx) call.
 * Returns a full calldata hex string: 4-byte selector + 3 × 32-byte ABI words.
 *
 * @param {number} i   coin index in
 * @param {number} j   coin index out
 * @param {bigint} dx  amount in (raw, with token decimals)
 * @returns {string}   0x-prefixed hex calldata
 */
export function encodeGetDy(i, j, dx) {
  // int128 is right-aligned and sign-extended in ABI encoding.
  // For non-negative values within 32 bytes, 0-padding is identical.
  const w = (n) => BigInt(n).toString(16).padStart(64, '0')
  return SELECTORS.getDy + w(i) + w(j) + w(dx)
}

/**
 * Decode a single uint256 return value from an eth_call result.
 *
 * @param {string} hex  0x-prefixed 66-char hex string (32-byte ABI word)
 * @returns {bigint}
 * @throws {Error}  if the hex is malformed or empty
 */
export function decodeUint(hex) {
  if (typeof hex !== 'string' || hex === '0x' || hex.length < 4) {
    throw new Error(`decodeUint: malformed or empty result: ${hex}`)
  }
  return BigInt(hex)
}

/**
 * Compute spot rates from two get_dy results.
 *
 * rate = (output / 10^decOut) / (dx / 10^decIn)
 *
 * Sanity check: the two directions must agree within 5%, i.e.
 *   |usdcPerEurc * eurcPerUsdc - 1| <= 0.05
 *
 * @param {bigint} dyUsdcToEurc  get_dy(0,1,dxUsdc) result (raw EURC out)
 * @param {bigint} dyEurcToUsdc  get_dy(1,0,dxEurc) result (raw USDC out)
 * @param {bigint} dxUsdc        probe amount for USDC->EURC direction
 * @param {bigint} dxEurc        probe amount for EURC->USDC direction
 * @param {number} decUsdc       USDC decimals (e.g. 6)
 * @param {number} decEurc       EURC decimals (e.g. 6)
 * @returns {{ usdcPerEurc: number; eurcPerUsdc: number } | null}
 */
export function poolRate(dyUsdcToEurc, dyEurcToUsdc, dxUsdc, dxEurc, decUsdc, decEurc) {
  if (dyUsdcToEurc === 0n || dyEurcToUsdc === 0n) return null

  const scaleUsdc = 10 ** decUsdc
  const scaleEurc = 10 ** decEurc

  // eurcPerUsdc: how many EURC for 1 USDC
  const eurcPerUsdc = round6(Number(dyUsdcToEurc) / scaleEurc / (Number(dxUsdc) / scaleUsdc))
  // usdcPerEurc: how many USDC for 1 EURC
  const usdcPerEurc = round6(Number(dyEurcToUsdc) / scaleUsdc / (Number(dxEurc) / scaleEurc))

  // Sanity: product of forward and inverse should be ~1 (within 5%)
  if (Math.abs(usdcPerEurc * eurcPerUsdc - 1) > 0.05) return null

  return { usdcPerEurc, eurcPerUsdc }
}

function round6(x) {
  return Math.round(x * 1_000_000) / 1_000_000
}

/**
 * Append a new fx rate point to the document, returning the updated document.
 *
 * @param {object|null} prev   existing fx.json content, or null for first run
 * @param {{ hour: string; usdcPerEurc: number; eurcPerUsdc: number }} point
 * @param {number}      keep   max series length (default 168 = 7 days)
 * @param {{ network?: string; now?: string }} [meta]  optional network/timestamp override
 * @returns {object}  the next fx.json document
 */
export function appendFxSeries(prev, point, keep = 168, meta = {}) {
  const network = meta.network ?? prev?.network ?? 'testnet'
  const generatedAt = meta.now ?? new Date().toISOString()

  // Build series from existing data, normalising to array of {hour, usdcPerEurc}.
  const existing = Array.isArray(prev?.series) ? prev.series : []

  // Remove any entry for the same hour (same-hour replacement).
  const filtered = existing.filter((e) => e.hour !== point.hour)
  filtered.push({ hour: point.hour, usdcPerEurc: point.usdcPerEurc })

  // Sort by hour string (ISO lexicographic order == chronological).
  filtered.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0))

  // Trim to the last `keep` entries.
  const series = filtered.length > keep ? filtered.slice(filtered.length - keep) : filtered

  // change24hPct: compare current usdcPerEurc with the entry 24 hours earlier.
  const prev24hIso = offsetHour(point.hour, -24)
  const ref = series.find((e) => e.hour === prev24hIso)
  let change24hPct = null
  if (ref != null && ref.usdcPerEurc !== 0) {
    change24hPct = Math.round(
      ((point.usdcPerEurc - ref.usdcPerEurc) / ref.usdcPerEurc) * 100 * 100,
    ) / 100
  }

  return {
    network,
    generatedAt,
    source: {
      kind: 'curve-pool',
      pool: POOL,
      label: 'Curve USDC/EURC pool (marginal price for 1 token, not an official FX rate)',
    },
    usdcPerEurc: point.usdcPerEurc,
    eurcPerUsdc: point.eurcPerUsdc,
    change24hPct,
    series,
  }
}

/** Return the ISO hour string `n` hours offset from `hourStr` ('YYYY-MM-DDTHH'). */
function offsetHour(hourStr, n) {
  // Parse as UTC midnight of that day + hour offset.
  const base = Date.parse(hourStr + ':00:00Z')
  return new Date(base + n * 3_600_000).toISOString().slice(0, 13)
}

// ── CLI ───────────────────────────────────────────────────────────────────────

// Only runs when this file is the entry point.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}

async function runCli() {
  const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'

  if (NET === 'mainnet') {
    console.log('fx: no verified source for mainnet')
    process.exit(0)
  }

  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
  const FX_PATH = join(ROOT, 'fx.json')

  // ── RPC endpoints (same rotation pattern as supply.mjs) ─────────────────────

  const NETWORKS = {
    testnet: {
      rpc: 'https://rpc.testnet.arc.io',
      fallbacks: [
        'https://rpc.blockdaemon.testnet.arc.io',
        'https://rpc.drpc.testnet.arc.io',
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

  async function rpcCall(calls, attempt = 0) {
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
    } catch (e) {
      return rpcCall(calls, attempt + 1)
    }
    if (res.status === 429 || res.status >= 500) return rpcCall(calls, attempt + 1)
    const out = await res.json()
    if (!Array.isArray(out)) return rpcCall(calls, attempt + 1)
    return out.sort((a, b) => a.id - b.id).map((r) => r.result)
  }

  // ── Load existing fx.json ──────────────────────────────────────────────────

  let existing = null
  try {
    existing = JSON.parse(await readFile(FX_PATH, 'utf8'))
  } catch { /* first run */ }

  // ── Current UTC hour key ───────────────────────────────────────────────────

  const nowHour = new Date().toISOString().slice(0, 13)   // 'YYYY-MM-DDTHH'

  // ── Fetch pool data ────────────────────────────────────────────────────────

  // Probe size: 1 whole token (will be scaled by decimals below, but we start
  // with the raw 1-unit probe and re-encode once we have decimals).
  // We need decimals before encoding get_dy, so fetch coins + decimals first.

  const DX_DEFAULT = 1_000_000n   // 1 token at 6 decimals (will be rechecked)

  let results
  try {
    results = await rpcCall([
      // id 0: coins(0)
      { jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: POOL, data: SELECTORS.coins + '0'.padStart(64, '0') }, 'latest'] },
      // id 1: coins(1)
      { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: POOL, data: SELECTORS.coins + '1'.padStart(64, '0') }, 'latest'] },
      // id 2: USDC.decimals()
      { jsonrpc: '2.0', id: 2, method: 'eth_call', params: [{ to: USDC_ADDR, data: SELECTORS.decimals }, 'latest'] },
      // id 3: EURC.decimals()
      { jsonrpc: '2.0', id: 3, method: 'eth_call', params: [{ to: EURC_ADDR, data: SELECTORS.decimals }, 'latest'] },
    ])
  } catch (e) {
    process.stderr.write(`[fx] RPC failed (batch 1): ${e.message} — keeping old fx.json\n`)
    process.exit(0)
  }

  // ── Verify coin addresses ──────────────────────────────────────────────────

  function addrFromWord(word) {
    // ABI-encoded address is right-aligned in 32 bytes; take the last 20 bytes.
    if (!word || word === '0x') return null
    return '0x' + word.slice(-40).toLowerCase()
  }

  const coin0 = addrFromWord(results[0])
  const coin1 = addrFromWord(results[1])
  const expectedUsdc = USDC_ADDR.toLowerCase()
  const expectedEurc = EURC_ADDR.toLowerCase()

  if (coin0 !== expectedUsdc || coin1 !== expectedEurc) {
    console.log(
      `fx: pool coin mismatch — expected coins(0)=${USDC_ADDR} coins(1)=${EURC_ADDR}, ` +
      `got coins(0)=${coin0} coins(1)=${coin1} — writing nothing`,
    )
    process.exit(0)
  }

  const decUsdc = results[2] && results[2] !== '0x' ? Number(BigInt(results[2])) : 6
  const decEurc = results[3] && results[3] !== '0x' ? Number(BigInt(results[3])) : 6

  const dxUsdc = BigInt(10 ** decUsdc)   // 1 USDC in raw units
  const dxEurc = BigInt(10 ** decEurc)   // 1 EURC in raw units

  // ── Fetch get_dy in both directions ───────────────────────────────────────

  let rates
  try {
    rates = await rpcCall([
      // id 0: get_dy(0, 1, 1_usdc) — how many EURC for 1 USDC
      { jsonrpc: '2.0', id: 0, method: 'eth_call', params: [{ to: POOL, data: encodeGetDy(0, 1, dxUsdc) }, 'latest'] },
      // id 1: get_dy(1, 0, 1_eurc) — how many USDC for 1 EURC
      { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: POOL, data: encodeGetDy(1, 0, dxEurc) }, 'latest'] },
    ])
  } catch (e) {
    process.stderr.write(`[fx] RPC failed (batch 2): ${e.message} — keeping old fx.json\n`)
    process.exit(0)
  }

  // ── Decode and compute rates ───────────────────────────────────────────────

  let dyUsdcToEurc, dyEurcToUsdc
  try {
    dyUsdcToEurc = decodeUint(rates[0])
    dyEurcToUsdc = decodeUint(rates[1])
  } catch (e) {
    process.stderr.write(`[fx] bad get_dy result: ${e.message} — keeping old fx.json\n`)
    process.exit(0)
  }

  const rate = poolRate(dyUsdcToEurc, dyEurcToUsdc, dxUsdc, dxEurc, decUsdc, decEurc)
  if (rate === null) {
    process.stderr.write('[fx] pool rate sanity check failed (zero output or >5% spread) — keeping old fx.json\n')
    process.exit(0)
  }

  // ── Append and write atomically ────────────────────────────────────────────

  const doc = appendFxSeries(
    existing,
    { hour: nowHour, usdcPerEurc: rate.usdcPerEurc, eurcPerUsdc: rate.eurcPerUsdc },
    168,
    { network: NET, now: new Date().toISOString() },
  )

  try {
    await mkdir(ROOT, { recursive: true })
    const tmp = FX_PATH + '.tmp'
    await writeFile(tmp, JSON.stringify(doc))
    await rename(tmp, FX_PATH)
    console.log(`${NET}: fx.json written (usdcPerEurc=${rate.usdcPerEurc}, eurcPerUsdc=${rate.eurcPerUsdc})`)
  } catch (e) {
    process.stderr.write(`[fx] write failed: ${e.message} — keeping old fx.json\n`)
    process.exit(0)
  }
}
