// Builds data/<net>/latest.json — the one small file the Pulsarc site reads.
// Also writes data/<net>/apps-latest.json (per-app windows) and data/<net>/discover.json.
// Windows are computed from the hourly aggregates written by run.mjs.
//
// Unique wallets across several hours cannot be summed exactly from hourly counts, so each
// window reports `walletHours` (sum of hourly distinct wallets) — an upper bound on distinct
// wallets and an honest "how many wallet-sessions" measure.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const ROOT         = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const INDEXER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS = { '1h': 1, '24h': 24, '7d': 168 }
const TOP = 100
const DISCOVER_MIN_TXS = 50
const DISCOVER_MAX     = 50

async function loadHours() {
  const files = (await readdir(join(ROOT, 'hourly'))).filter((f) => f.endsWith('.json')).sort().slice(-9)
  const hours = {}
  for (const f of files) Object.assign(hours, JSON.parse(await readFile(join(ROOT, 'hourly', f), 'utf8')))
  return hours
}

function windowSummary(keys, hours) {
  const total = { blocks: 0, txs: 0, failed: 0, fees: 0, walletHours: 0 }
  const contracts = new Map()
  for (const k of keys) {
    const h = hours[k]
    total.blocks += h.blocks
    total.txs += h.txs
    total.failed += h.failed
    total.fees += h.fees
    total.walletHours += h.senderCount ?? 0
    for (const [addr, tx, wallets, fee] of h.top ?? []) {
      const c = contracts.get(addr) ?? { address: addr, txs: 0, walletHours: 0, fees: 0 }
      c.txs += tx
      c.walletHours += wallets
      c.fees += fee
      contracts.set(addr, c)
    }
  }
  const top = [...contracts.values()].sort((a, b) => b.txs - a.txs).slice(0, TOP)
    .map((c) => ({ ...c, fees: +c.fees.toFixed(4) }))
  return { hours: keys.length, ...total, fees: +total.fees.toFixed(4), top }
}

const hours = await loadHours()
const keys = Object.keys(hours).sort()
const out = { network: NET, generatedAt: new Date().toISOString(), windows: {}, series: [] }
for (const [name, n] of Object.entries(WINDOWS)) out.windows[name] = windowSummary(keys.slice(-n), hours)
out.series = keys.slice(-168).map((k) => ({
  hour: k, txs: hours[k].txs, failed: hours[k].failed, fees: hours[k].fees, wallets: hours[k].senderCount ?? 0, blocks: hours[k].blocks,
}))
await writeFile(join(ROOT, 'latest.json'), JSON.stringify(out))
console.log(`${NET}: summary over ${keys.length} hours`)

// ── apps-latest.json ────────────────────────────────────────────────────────
// Load app config; if absent or empty, write an empty apps-latest.json and skip.
let appsConfig = { apps: [] }
try {
  appsConfig = JSON.parse(await readFile(join(INDEXER_ROOT, `apps.${NET}.json`), 'utf8'))
} catch { /* file absent — no app stats */ }

if (appsConfig.apps.length > 0) {
  /**
   * Build per-app window summary from the same hour keys as windowSummary().
   * walletHours = sum of hourly wallet counts (upper bound on distinct wallets).
   */
  function appWindowSummary(windowKeys) {
    const totals = {} // appId → { txs, walletHours, volume, fees }
    for (const k of windowKeys) {
      const h = hours[k]
      if (!h?.apps) continue
      for (const [appId, a] of Object.entries(h.apps)) {
        if (!totals[appId]) totals[appId] = { txs: 0, walletHours: 0, volume: 0, fees: 0 }
        totals[appId].txs        += a.tx     ?? 0
        totals[appId].walletHours += a.wallets ?? 0  // already a count after compactApps
        totals[appId].volume     += a.vol    ?? 0
        totals[appId].fees       += a.fee    ?? 0
      }
    }
    // Round and return
    for (const t of Object.values(totals)) {
      t.volume = +t.volume.toFixed(4)
      t.fees   = +t.fees.toFixed(6)
    }
    return totals
  }

  const appsOut = {
    network: NET,
    generatedAt: new Date().toISOString(),
    note: 'walletHours sums distinct wallets per hour — an upper bound on unique wallets over the window',
    apps: {},
  }

  // Collect window data for each app across all three windows
  const windowData = {}
  for (const [name, n] of Object.entries(WINDOWS)) {
    windowData[name] = appWindowSummary(keys.slice(-n))
  }

  // Build per-app output: only include apps that appear in at least one window
  const allAppIds = new Set(appsConfig.apps.map(a => a.id))
  for (const appId of allAppIds) {
    const entry = {}
    for (const [name] of Object.entries(WINDOWS)) {
      const w = windowData[name][appId] ?? { txs: 0, walletHours: 0, volume: 0, fees: 0 }
      entry[name] = w
    }
    appsOut.apps[appId] = entry
  }

  await writeFile(join(ROOT, 'apps-latest.json'), JSON.stringify(appsOut))
  console.log(`${NET}: apps-latest.json written for ${allAppIds.size} apps`)
} else {
  await writeFile(join(ROOT, 'apps-latest.json'), JSON.stringify({
    network: NET, generatedAt: new Date().toISOString(), apps: {},
  }))
}

// ── discover.json ───────────────────────────────────────────────────────────
// Contracts from the 24h top list that are not any known app anchor, txs >= threshold.
{
  // Build the set of all known anchor addresses (lowercased)
  const knownAnchors = new Set()
  for (const app of appsConfig.apps) {
    for (const anchor of app.anchors) knownAnchors.add(anchor.address.toLowerCase())
  }

  const w24 = out.windows['24h']
  const discover = (w24?.top ?? [])
    .filter(c => !knownAnchors.has(c.address.toLowerCase()) && c.txs >= DISCOVER_MIN_TXS)
    .sort((a, b) => b.txs - a.txs)
    .slice(0, DISCOVER_MAX)
    .map(c => ({ address: c.address, txs: c.txs, walletHours: c.walletHours, fees: c.fees }))

  await writeFile(join(ROOT, 'discover.json'), JSON.stringify({ network: NET, generatedAt: new Date().toISOString(), contracts: discover }))
  console.log(`${NET}: discover.json — ${discover.length} unlabelled contracts with txs >= ${DISCOVER_MIN_TXS}`)
}
