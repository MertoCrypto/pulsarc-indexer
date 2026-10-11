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
  // T3a accumulators
  const autoAcc = { senders: 0, tx: 0 }
  let aa = 0, aaTx = 0
  let autoCoverageHours = 0, bucketsCoverageHours = 0
  const bucketsAcc = [[0, 0], [0, 0], [0, 0]]  // [count, vol] per band
  // T3b accumulators
  const bigAll = []                   // Part 1: all big transfers, trimmed to top 10
  const mbAcc = {}                    // Part 2: { usdc?: [m,b], eurc?: [m,b] }
  let mbCoverageHours = 0
  let blkAdded = 0, blkRemoved = 0
  const blkAddrAcc = []               // Part 3: latest 10 across window
  const bridgeAcc = { out: [0, 0, 0], in: [0], byDomain: {} }  // Part 4
  let bridgeCoverageHours = 0
  const contracts = new Map()
  for (const k of keys) {
    const h = hours[k]
    total.blocks += h.blocks
    total.txs += h.txs
    total.failed += h.failed
    total.fees += h.fees
    total.walletHours += h.senderCount ?? 0
    // T3a Part 1
    if (h.auto) {
      autoAcc.senders += h.auto.senders
      autoAcc.tx      += h.auto.tx
      autoCoverageHours++
    }
    if (h.aa)   aa   += h.aa
    if (h.aaTx) aaTx += h.aaTx
    // T3a Part 2
    if (h.buckets) {
      for (let i = 0; i < 3; i++) {
        bucketsAcc[i][0] += h.buckets[i][0]
        bucketsAcc[i][1] = +(bucketsAcc[i][1] + h.buckets[i][1]).toFixed(2)
      }
      bucketsCoverageHours++
    }
    // T3b Part 1: big transfers — collect all, trim later
    if (h.big) for (const b of h.big) bigAll.push(b)
    // T3b Part 2: mb (mint/burn)
    if (h.mb) {
      mbCoverageHours++
      for (const token of ['usdc', 'eurc']) {
        if (!h.mb[token]) continue
        mbAcc[token] ??= [0, 0]
        mbAcc[token][0] = +(mbAcc[token][0] + h.mb[token][0]).toFixed(2)
        mbAcc[token][1] = +(mbAcc[token][1] + h.mb[token][1]).toFixed(2)
      }
    }
    // T3b Part 3: blocklist
    if (h.blk) {
      blkAdded   += h.blk[0]
      blkRemoved += h.blk[1]
    }
    if (h.blkAddr) for (const e of h.blkAddr) blkAddrAcc.push(e)
    // T3b Part 4: bridge
    if (h.bridge) {
      bridgeCoverageHours++
      bridgeAcc.out[0] += h.bridge.out[0]
      bridgeAcc.out[1]  = +(bridgeAcc.out[1] + h.bridge.out[1]).toFixed(2)
      bridgeAcc.out[2]  = +(bridgeAcc.out[2] + h.bridge.out[2]).toFixed(6)
      bridgeAcc.in[0]  += h.bridge.in[0]
      for (const [dom, vals] of Object.entries(h.bridge.byDomain ?? {})) {
        bridgeAcc.byDomain[dom] ??= [0, 0]
        bridgeAcc.byDomain[dom][0] += vals[0]
        bridgeAcc.byDomain[dom][1]  = +(bridgeAcc.byDomain[dom][1] + vals[1]).toFixed(2)
      }
    }
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
  const result = { hours: keys.length, ...total, fees: +total.fees.toFixed(4), top }
  // T3a: add new fields only when non-zero to stay backwards compatible
  if (autoAcc.senders > 0 || autoCoverageHours > 0) {
    result.auto = autoAcc
    result.autoCoverageHours = autoCoverageHours
  }
  if (aa   > 0) result.aa   = aa
  if (aaTx > 0) result.aaTx = aaTx
  if (bucketsCoverageHours > 0) {
    result.buckets             = bucketsAcc
    result.bucketsCoverageHours = bucketsCoverageHours
  }
  // T3b: add new fields only when present
  if (bigAll.length > 0) {
    bigAll.sort((a, b) => b.amt - a.amt)
    result.big = bigAll.slice(0, 10)
  }
  if (Object.keys(mbAcc).length > 0) {
    result.mb = mbAcc
    result.mbCoverageHours = mbCoverageHours
  }
  if (blkAdded > 0 || blkRemoved > 0) {
    result.blk = [blkAdded, blkRemoved]
    // Keep latest 10 blkAddr entries across the window
    result.blkAddr = blkAddrAcc.slice(-10)
  }
  if (bridgeCoverageHours > 0) {
    result.bridge = bridgeAcc
    result.bridgeCoverageHours = bridgeCoverageHours
  }
  return result
}

const hours = await loadHours()
const keys = Object.keys(hours).sort()
const out = { network: NET, generatedAt: new Date().toISOString(), windows: {}, series: [] }
for (const [name, n] of Object.entries(WINDOWS)) out.windows[name] = windowSummary(keys.slice(-n), hours)
out.series = keys.slice(-168).map((k) => {
  const h = hours[k]
  const pt = { hour: k, txs: h.txs, failed: h.failed, fees: h.fees, wallets: h.senderCount ?? 0, blocks: h.blocks }
  // T3a: include aa/aaTx in series points when present (absent in old hours — readers treat missing as 0)
  if (h.aa)   pt.aa   = h.aa
  if (h.aaTx) pt.aaTx = h.aaTx
  return pt
})
await writeFile(join(ROOT, 'latest.json'), JSON.stringify(out))
console.log(`${NET}: summary over ${keys.length} hours`)

// ── bridge.json ─────────────────────────────────────────────────────────────
{
  const bridgeOut = {
    network: NET,
    generatedAt: new Date().toISOString(),
    windows: {},
    series: keys.slice(-168).map((k) => {
      const h = hours[k]
      return {
        hour: k,
        outCount: h.bridge?.out[0] ?? 0,
        outUsdc:  h.bridge?.out[1] ?? 0,
        inCount:  h.bridge?.in[0]  ?? 0,
      }
    }),
  }
  for (const [name, n] of Object.entries(WINDOWS)) {
    const w = out.windows[name]
    bridgeOut.windows[name] = w.bridge ?? { out: [0, 0, 0], in: [0], byDomain: {} }
  }
  await writeFile(join(ROOT, 'bridge.json'), JSON.stringify(bridgeOut))
  console.log(`${NET}: bridge.json written`)
}

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
    coverageHours: keys.length, // hourly buckets held; a window is real once this reaches its length
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
