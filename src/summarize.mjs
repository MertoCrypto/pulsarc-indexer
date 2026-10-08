// Builds data/<net>/latest.json — the one small file the Pulsarc site reads.
// Windows are computed from the hourly aggregates written by run.mjs.
//
// Unique wallets across several hours cannot be summed exactly from hourly counts, so each
// window reports `walletHours` (sum of hourly distinct wallets) — an upper bound on distinct
// wallets and an honest "how many wallet-sessions" measure.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const WINDOWS = { '1h': 1, '24h': 24, '7d': 168 }
const TOP = 100

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
