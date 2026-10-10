// Weekly digest for Pulsarc's /digest page: last 7 days vs the 7 days before, per app.
// Pure and template-based (no LLM). `hours` is the merged hourly map; see anomalies.mjs.

export const CFG = {
  windowHours: 168,
  minAppTxs: 500,   // an app needs this many txs in one of the two weeks to be ranked (avoids +9000% on dust)
  maxMovers: 3,
  coverage: 0.9,    // share of each week's hours that must carry app data
}

const HOUR_MS = 3_600_000
const hourStart = (key) => Date.parse(`${key}:00:00Z`)

const LABELS = {
  usdc: 'USDC', eurc: 'EURC', usyc: 'USYC', cirbtc: 'cirBTC', weth: 'WETH', stablefx: 'StableFX', memo: 'Memo',
  multicall: 'Multicall', cctp: 'CCTP', gateway: 'Gateway', erc8004: 'ERC-8004', erc8183: 'ERC-8183',
  uniswap: 'Uniswap', across: 'Across',
}
const label = (id) => LABELS[id] ?? id

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null)
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))
const signed = (p) => `${p > 0 ? '+' : ''}${p}%`

function sumWeek(keys, hours) {
  const apps = {}
  let txs = 0
  let withApps = 0
  for (const k of keys) {
    const h = hours[k]
    txs += h.txs ?? 0
    if (!h.apps) continue
    withApps++
    for (const [id, a] of Object.entries(h.apps)) apps[id] = (apps[id] ?? 0) + (a.tx ?? 0)
  }
  return { txs, apps, withApps }
}

export function computeDigest(hours, network, now = Date.now(), cfg = CFG) {
  const base = { network, generatedAt: new Date(now).toISOString() }
  const keys = Object.keys(hours).sort()
  const lastKey = keys[keys.length - 1]
  const firstApps = keys.find((k) => hours[k].apps)
  const need = 2 * cfg.windowHours

  if (!lastKey || !firstApps) return { ...base, status: 'warming-up', readyAt: null, hoursHeld: 0, hoursNeeded: need }

  const end = hourStart(lastKey) + HOUR_MS
  const inWin = (from, to) => keys.filter((k) => { const t = hourStart(k); return t >= from && t < to })
  const curKeys = inWin(end - cfg.windowHours * HOUR_MS, end)
  const prevKeys = inWin(end - need * HOUR_MS, end - cfg.windowHours * HOUR_MS)
  const cur = sumWeek(curKeys, hours)
  const prev = sumWeek(prevKeys, hours)

  const enough = cur.withApps >= cfg.coverage * cfg.windowHours && prev.withApps >= cfg.coverage * cfg.windowHours
  if (!enough) {
    return {
      ...base, status: 'warming-up',
      readyAt: new Date(hourStart(firstApps) + need * HOUR_MS).toISOString(),
      hoursHeld: cur.withApps + prev.withApps, hoursNeeded: need,
    }
  }

  const rows = [...new Set([...Object.keys(cur.apps), ...Object.keys(prev.apps)])].map((id) => ({
    app: id, label: label(id), txs: cur.apps[id] ?? 0, prevTxs: prev.apps[id] ?? 0, change: pct(cur.apps[id] ?? 0, prev.apps[id] ?? 0),
  }))
  const ranked = rows.filter((r) => r.change !== null && Math.max(r.txs, r.prevTxs) >= cfg.minAppTxs)
  const growers = ranked.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, cfg.maxMovers)
  const fallers = ranked.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, cfg.maxMovers)
  const top = [...rows].sort((a, b) => b.txs - a.txs).slice(0, 5)
  const networkChange = pct(cur.txs, prev.txs)

  const parts = [`Arc this week: ${fmtN(cur.txs)} transactions${networkChange === null ? '' : ` (${signed(networkChange)} vs last week)`}.`]
  if (growers.length) parts.push(`Fastest growing: ${growers.map((r) => `${r.label} ${signed(r.change)}`).join(', ')}.`)
  if (fallers.length) parts.push(`Biggest drops: ${fallers.map((r) => `${r.label} ${signed(r.change)}`).join(', ')}.`)
  parts.push('pulsarc.vercel.app')

  return {
    ...base, status: 'ok',
    from: new Date(end - cfg.windowHours * HOUR_MS).toISOString(), to: new Date(end).toISOString(),
    network_txs: cur.txs, network_prev_txs: prev.txs, network_change: networkChange,
    growers, fallers, top, shareText: parts.join(' '),
  }
}
