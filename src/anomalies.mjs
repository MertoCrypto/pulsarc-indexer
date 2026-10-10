// Anomaly detection for the "moving today" strip on Pulsarc's Rankings page.
//
// computeAnomalies(hours, now, cfg) is pure: it compares the last COMPLETED hour of each app's
// tx count with the median of the preceding 24 hours and flags spikes and drops.
// `hours` is the merged hourly map from data/<net>/hourly/*.json: { 'YYYY-MM-DDTHH': { apps: { id: { tx } } } }.

export const CFG = {
  spikeRatio: 2,      // last hour >= 2x the 24h median
  dropRatio: 0.3,     // last hour <= 30% of the 24h median (a 70% drop)
  minTxs: 200,        // ignore small apps: spike needs >= 200 txs in the hour, drop needs a median >= 200
  minHours: 12,       // baseline hours (with app data) needed before we say anything
  baselineHours: 24,
  maxItems: 5,
  maxAgeHours: 3,     // the last completed hour must be this recent
}

const HOUR_MS = 3_600_000
const hourStart = (key) => Date.parse(`${key}:00:00Z`)

function median(values) {
  const v = [...values].sort((a, b) => a - b)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

export function computeAnomalies(hours, now = Date.now(), cfg = CFG) {
  const base = { generatedAt: new Date(now).toISOString(), items: [] }
  const keys = Object.keys(hours).sort()
  const lastKey = keys[keys.length - 1]
  if (!lastKey) return { ...base, status: 'warming-up', hour: null }

  const lastStart = hourStart(lastKey)
  if (now - (lastStart + HOUR_MS) > cfg.maxAgeHours * HOUR_MS) return { ...base, status: 'stale', hour: lastKey }
  if (!hours[lastKey].apps) return { ...base, status: 'warming-up', hour: lastKey }

  // Baseline: hours inside the 24h before the last hour that carry app data (older hours have none).
  const baseline = keys.filter((k) => {
    const t = hourStart(k)
    return t < lastStart && t >= lastStart - cfg.baselineHours * HOUR_MS && hours[k].apps
  })
  if (baseline.length < cfg.minHours) return { ...base, status: 'warming-up', hour: lastKey }

  const ids = new Set(Object.keys(hours[lastKey].apps))
  for (const k of baseline) for (const id of Object.keys(hours[k].apps)) ids.add(id)

  const items = []
  for (const id of ids) {
    const txs = hours[lastKey].apps[id]?.tx ?? 0
    const med = median(baseline.map((k) => hours[k].apps[id]?.tx ?? 0))
    if (txs >= cfg.minTxs && txs >= cfg.spikeRatio * med) {
      items.push({ app: id, kind: 'spike', ratio: +Math.min(99, txs / Math.max(med, 1)).toFixed(1), txs, baseline: Math.round(med) })
    } else if (med >= cfg.minTxs && txs <= cfg.dropRatio * med) {
      items.push({ app: id, kind: 'drop', ratio: +(txs / med).toFixed(2), txs, baseline: Math.round(med) })
    }
  }
  const score = (i) => (i.kind === 'spike' ? i.ratio : 1 / Math.max(i.ratio, 0.01))
  items.sort((a, b) => score(b) - score(a))
  return { ...base, status: 'ok', hour: lastKey, items: items.slice(0, cfg.maxItems) }
}
