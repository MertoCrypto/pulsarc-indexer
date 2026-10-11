// Generalised alert planner for Pulsarc.
//
// Each "kind" is a pure planner that reads its inputs and returns { messages, nextKindState }.
// planAlerts(inputs, prev, opts) runs all enabled kinds, enforces the shared budget
// (max 8 per UTC day, max 3 per run, same app-id at most once per 6 h across kinds),
// and returns { messages, state, feed } where state is the next notified.json to persist.
//
// notify.mjs re-exports planNotifications / renderRss for backward compat.

import { appName } from './names.mjs'

// ─── constants ──────────────────────────────────────────────────────────────

export const SITE = 'https://pulsarc.vercel.app'
const HOUR_MS   = 3_600_000
const DAY_MS    = 86_400_000
const MAX_DAY   = 8
const MAX_RUN   = 3
const APP_COOLDOWN_H = 6

// Asset-type ids excluded from rank kind (they inflate raw tx counts)
const ASSET_IDS = new Set(['usdc', 'eurc', 'usyc', 'cirbtc', 'weth', 'wusdc', 'arc-dollar'])

// ─── helpers ────────────────────────────────────────────────────────────────

function safeNum(v) { return typeof v === 'number' && isFinite(v) ? v : 0 }

/** Thousands-separator integer, with K/M suffix when >= 100 000. */
export function fmtN(n) {
  n = Math.round(safeNum(n))
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000)   return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString('en-US')
}

function utcDay(ms) { return new Date(ms).toISOString().slice(0, 10) }
function utcHour(ms) { return new Date(ms).toISOString().slice(0, 13) }

/** Strip control characters and cap length. Input must be plain text. */
function sanitise(s, max = 40) {
  if (typeof s !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max)
}

function median(values) {
  const v = [...values].sort((a, b) => a - b)
  if (!v.length) return 0
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** ISO week string: "2026-W42" */
function isoWeek(iso) {
  // Use the date-based ISO week calculation
  const d = new Date(iso)
  const thu = new Date(d)
  thu.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3)
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((thu - yearStart) / DAY_MS + 1) / 7)
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Validate app id is safe. */
const safeId = (id) => /^[a-z0-9-]{1,40}$/.test(id ?? '')

// ─── kind: anomaly ──────────────────────────────────────────────────────────
// Mirrors existing planNotifications; item ids are "<hour>:<app>:<kind>"

export function planAnomaly(anomalies, kindState = {}) {
  if (!anomalies || anomalies.status !== 'ok' || !anomalies.hour || !Array.isArray(anomalies.items)) return { messages: [], nextKindState: kindState }
  const sent = new Set(Array.isArray(kindState.sent) ? kindState.sent : [])
  const messages = []
  for (const item of anomalies.items) {
    if (!safeId(item.app)) continue
    const id = `${anomalies.hour}:${item.app}:${item.kind}`
    if (sent.has(id)) continue
    const link = `${SITE}/dapp/${item.app}`
    const net = anomalies.network === 'testnet' ? 'Arc Testnet' : 'Arc'
    let text
    if (item.kind === 'spike') {
      text = `${appName(item.app)} on ${net}: ${item.ratio}x its usual activity. ${fmtN(item.txs)} transactions in the last hour, the 24h median is ${fmtN(item.baseline)}.`
    } else if (item.kind === 'drop') {
      const pct = Math.round((1 - item.ratio) * 100)
      text = `${appName(item.app)} on ${net}: down ${pct}% from its usual activity. ${fmtN(item.txs)} transactions in the last hour, the 24h median is ${fmtN(item.baseline)}.`
    } else continue
    messages.push({ id, text: `${text}\n${link}`, feedTitle: text, feedLink: link, appId: item.app })
    sent.add(id)
  }
  const newSent = [...(Array.isArray(kindState.sent) ? kindState.sent : []), ...messages.map(m => m.id)].slice(-200)
  return { messages, nextKindState: { sent: newSent } }
}

// ─── kind: daily ────────────────────────────────────────────────────────────

export function planDaily(hours, openHour, network, now, kindState = {}) {
  // Only fires on first run after 06:00 UTC, about the previous full UTC day
  const nowDate = new Date(now)
  if (nowDate.getUTCHours() < 6) return { messages: [], nextKindState: kindState }

  const today = utcDay(now)
  if (kindState.lastDate === today) return { messages: [], nextKindState: kindState }

  // Collect hours for the previous UTC day
  const yesterday = utcDay(now - DAY_MS)
  const HOUR_MS = 3_600_000
  const dayKeys = Object.keys(hours)
    .filter(k => k.startsWith(yesterday) && k !== openHour)
    .sort()

  if (dayKeys.length < 20) return { messages: [], nextKindState: kindState }

  let txs = 0, failed = 0, fees = 0
  const appTxs = {}
  for (const k of dayKeys) {
    const h = hours[k]
    txs   += safeNum(h.txs)
    failed += safeNum(h.failed)
    fees   += safeNum(h.fees)
    if (h.apps) {
      for (const [id, a] of Object.entries(h.apps)) {
        if (safeId(id)) appTxs[id] = (appTxs[id] ?? 0) + safeNum(a.tx)
      }
    }
  }
  if (txs === 0) return { messages: [], nextKindState: kindState }

  const successPct = txs > 0 ? (((txs - failed) / txs) * 100).toFixed(1) : '100.0'
  const feesStr = fees > 0 ? `, ${Math.round(fees).toLocaleString('en-US')} USDC in fees` : ''

  // Top 3 apps by tx, no filtering by infra (labels not available here; task says "otherwise just top 3")
  const top3 = Object.entries(appTxs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, t]) => `${appName(id)} ${fmtN(t)}`)
    .join(', ')

  const netLabel = network === 'testnet' ? 'Arc Testnet' : 'Arc'
  const dateStr = new Date(yesterday + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const mostActive = top3 ? ` Most active: ${top3}.` : ''

  const text = `${netLabel} yesterday (${dateStr}): ${fmtN(txs)} transactions, ${successPct}% succeeded${feesStr}.${mostActive}\n${SITE}`
  const id = `daily:${yesterday}`
  return {
    messages: [{ id, text, feedTitle: text.split('\n')[0], feedLink: SITE, appId: null }],
    nextKindState: { lastDate: today },
  }
}

// ─── kind: health ────────────────────────────────────────────────────────────

export function planHealth(hours, openHour, now, kindState = {}) {
  const cooldowns = kindState.cooldowns ?? {}
  const HOUR_MS = 3_600_000

  // Collect completed, non-open hours sorted
  const keys = Object.keys(hours)
    .filter(k => k !== openHour)
    .sort()

  if (keys.length < 13) return { messages: [], nextKindState: kindState } // need last + 12 baseline

  const lastKey = keys[keys.length - 1]
  const last = hours[lastKey]

  // Baseline: up to 24 hours before the last hour (non-open, sorted)
  const lastStart = Date.parse(`${lastKey}:00:00Z`)
  const baseline = keys.filter(k => {
    const t = Date.parse(`${k}:00:00Z`)
    return t < lastStart && t >= lastStart - 24 * HOUR_MS
  })

  if (baseline.length < 12) return { messages: [], nextKindState: kindState }

  const messages = []
  const nextCooldowns = { ...cooldowns }

  function cooldownOk(trigger) {
    const last = cooldowns[trigger]
    return !last || (now - Date.parse(last + ':00:00Z')) >= APP_COOLDOWN_H * HOUR_MS
  }

  function maybeAdd(trigger, text) {
    if (!cooldownOk(trigger)) return
    messages.push({ id: `health:${trigger}:${lastKey}`, text: `${text}\n${SITE}`, feedTitle: text, feedLink: SITE, appId: null })
    nextCooldowns[trigger] = lastKey
  }

  // (a) failure rate
  const lastTxs    = safeNum(last.txs)
  const lastFailed = safeNum(last.failed)
  if (lastTxs >= 2000) {
    const lastRate = lastTxs > 0 ? lastFailed / lastTxs : 0
    const baseRates = baseline.map(k => {
      const t = safeNum(hours[k].txs)
      return t > 0 ? safeNum(hours[k].failed) / t : 0
    })
    const medRate = median(baseRates)
    const threshold = Math.max(0.03, 3 * medRate)
    if (lastRate >= threshold) {
      const pct = (lastRate * 100).toFixed(1)
      maybeAdd('failrate', `Arc network: ${pct}% of transactions failed in the last hour (${fmtN(lastFailed)} of ${fmtN(lastTxs)}). Baseline is ${(medRate * 100).toFixed(1)}%.`)
    }
  }

  // (b) fee spike
  const lastFees = safeNum(last.fees)
  if (lastTxs > 0) {
    const lastAvgFee = lastFees / lastTxs
    const baseAvgFees = baseline.map(k => {
      const t = safeNum(hours[k].txs)
      return t > 0 ? safeNum(hours[k].fees) / t : 0
    }).filter(f => f > 0)
    if (baseAvgFees.length >= 12) {
      const medFee = median(baseAvgFees)
      if (medFee > 0 && lastAvgFee >= 3 * medFee) {
        maybeAdd('feespike', `Arc network: average fee per transaction in the last hour was ${lastAvgFee.toFixed(4)} USDC, ${(lastAvgFee / medFee).toFixed(1)}x the usual ${medFee.toFixed(4)} USDC.`)
      }
    }
  }

  // (c) block drought
  const lastBlocks = safeNum(last.blocks)
  const baseBlocks = baseline.map(k => safeNum(hours[k].blocks))
  const medBlocks = median(baseBlocks)
  if (medBlocks > 0 && lastBlocks <= 0.70 * medBlocks) {
    maybeAdd('blockdrop', `Arc network: only ${fmtN(lastBlocks)} blocks produced in the last hour, ${Math.round((lastBlocks / medBlocks) * 100)}% of the usual ${fmtN(Math.round(medBlocks))}.`)
  }

  return { messages, nextKindState: { cooldowns: nextCooldowns } }
}

// ─── kind: rank ──────────────────────────────────────────────────────────────

export function planRank(appsLatest, now, kindState = {}) {
  if (!appsLatest?.apps || safeNum(appsLatest.coverageHours) < 24) return { messages: [], nextKindState: kindState }

  const prevTop5 = kindState.top5 ?? []
  const prevTop5Set = new Set(prevTop5)

  // Sort non-asset apps by 24h txs
  const ranked = Object.entries(appsLatest.apps)
    .filter(([id]) => safeId(id) && !ASSET_IDS.has(id))
    .map(([id, w]) => ({ id, txs: safeNum(w['24h']?.txs) }))
    .sort((a, b) => b.txs - a.txs)
    .slice(0, 5)

  const nowTop5 = ranked.map(r => r.id)
  const nowTop5Set = new Set(nowTop5)

  const messages = []
  for (const { id, txs } of ranked) {
    if (!prevTop5Set.has(id) && prevTop5.length > 0 && safeId(id)) {
      // New entrant
      messages.push({
        id: `rank:${id}:${utcDay(now)}`,
        text: `${appName(id)} moved into the top 5 on Arc by transactions (24h): ${fmtN(txs)} transactions.\n${SITE}`,
        feedTitle: `${appName(id)} moved into the top 5 on Arc by transactions (24h): ${fmtN(txs)} transactions.`,
        feedLink: SITE,
        appId: id,
      })
    }
  }

  // Max 2 per day
  const today = utcDay(now)
  const dayCount = kindState.lastDate === today ? (kindState.dayCount ?? 0) : 0
  const allowed = messages.slice(0, Math.max(0, 2 - dayCount))

  return {
    messages: allowed,
    nextKindState: {
      top5: nowTop5,
      lastDate: today,
      dayCount: dayCount + allowed.length,
    },
  }
}

// ─── kind: contract ──────────────────────────────────────────────────────────

export function planContract(discover, labels, anchorAddrs, now, kindState = {}) {
  if (!discover?.contracts || !Array.isArray(discover.contracts)) return { messages: [], nextKindState: kindState }

  const seenTop50 = new Set(kindState.seenTop50 ?? [])
  const isFirstRun = seenTop50.size === 0

  // Record top 50 addresses
  const top50 = discover.contracts.slice(0, 50).map(c => c.address?.toLowerCase()).filter(Boolean)
  const top20 = discover.contracts.slice(0, 20)

  // Collect all anchor addresses (lowercased) to exclude
  const anchors = new Set([...(anchorAddrs ?? [])].map(a => a.toLowerCase()))

  const messages = []
  const today = utcDay(now)
  const dayCount = kindState.lastDate === today ? (kindState.dayCount ?? 0) : 0
  let added = dayCount

  for (const c of top20) {
    const addr = c.address?.toLowerCase()
    if (!addr || anchors.has(addr) || seenTop50.has(addr)) continue
    if (isFirstRun) break // first run only records, posts nothing

    const txs = safeNum(c.txs)
    const wh  = safeNum(c.walletHours)
    const isAuto = txs >= 1000 && wh > 0 && txs / wh >= 50

    const raw = labels?.[addr]?.name
    const displayName = raw ? sanitise(raw, 40) : null
    const shortAddr   = `${addr.slice(0, 6)}…${addr.slice(-4)}`
    const nameStr     = displayName || shortAddr
    const autoStr     = isAuto ? ' (automated-looking)' : ''

    const text = `New busy contract on Arc: ${nameStr}, ${fmtN(txs)} transactions in 24h${autoStr}.`
    if (added < 2) {
      messages.push({ id: `contract:${addr}:${today}`, text: `${text}\n${SITE}`, feedTitle: text, feedLink: SITE, appId: null })
      added++
    }
  }

  // Update seenTop50 to include all top50 (regardless of whether we posted)
  for (const a of top50) seenTop50.add(a)
  // Keep the set bounded
  const nextSeen = [...seenTop50].slice(-500)

  return {
    messages,
    nextKindState: {
      seenTop50: nextSeen,
      lastDate: today,
      dayCount: added,
    },
  }
}

// ─── kind: agents ────────────────────────────────────────────────────────────

export function planAgents(agentsData, network, kindState = {}) {
  if (!agentsData || typeof agentsData.count !== 'number') return { messages: [], nextKindState: kindState }
  const count = agentsData.count
  const milestone = network === 'mainnet' ? 500 : 5000
  const lastAnnounced = kindState.lastAnnounced ?? 0

  const currentMilestone = Math.floor(count / milestone) * milestone
  if (currentMilestone <= 0 || currentMilestone <= lastAnnounced) return { messages: [], nextKindState: kindState }
  if (lastAnnounced === 0) {
    // First run: just record, post nothing
    return { messages: [], nextKindState: { lastAnnounced: currentMilestone } }
  }

  const text = `${fmtN(currentMilestone)} agents are now registered on Arc.\n${SITE}`
  return {
    messages: [{ id: `agents:${currentMilestone}`, text, feedTitle: text.split('\n')[0], feedLink: SITE, appId: null }],
    nextKindState: { lastAnnounced: currentMilestone },
  }
}

// ─── kind: weekly ────────────────────────────────────────────────────────────

export function planWeekly(digest, kindState = {}) {
  if (!digest || digest.status !== 'ok') return { messages: [], nextKindState: kindState }

  const week = isoWeek(digest.generatedAt)
  const sentId = `weekly:${week}`
  const sent = new Set(kindState.sent ?? [])
  if (sent.has(sentId)) return { messages: [], nextKindState: kindState }

  let shareText = typeof digest.shareText === 'string' ? digest.shareText.trim() : null

  if (!shareText) {
    // Build fallback from available fields (never invent numbers)
    const parts = []
    if (typeof digest.network_txs === 'number') {
      const change = typeof digest.network_change === 'number'
        ? ` (${digest.network_change > 0 ? '+' : ''}${digest.network_change}% vs last week)` : ''
      parts.push(`Arc this week: ${fmtN(digest.network_txs)} transactions${change}.`)
    }
    if (Array.isArray(digest.growers) && digest.growers.length) {
      parts.push(`Fastest growing: ${digest.growers.slice(0,2).map(g => `${g.label ?? appName(g.app)} +${g.change}%`).join(', ')}.`)
    }
    parts.push(SITE)
    shareText = parts.join(' ')
  }

  const text = shareText.endsWith(SITE) ? shareText : `${shareText}\n${SITE}`
  sent.add(sentId)
  return {
    messages: [{ id: sentId, text, feedTitle: shareText.split('\n')[0], feedLink: SITE, appId: null }],
    nextKindState: { sent: [...sent].slice(-52) },
  }
}

// ─── budget ──────────────────────────────────────────────────────────────────

/**
 * Apply budget: max MAX_DAY per UTC day total, max MAX_RUN per run,
 * same appId at most once per APP_COOLDOWN_H hours across kinds.
 */
export function applyBudget(allMessages, prev, now) {
  const today = utcDay(now)
  const dayCount = (prev.day?.date === today) ? (prev.day.count ?? 0) : 0
  const appLastSent = prev.appLastSent ?? {}  // appId -> ISO hour string

  const allowed = []
  let runCount = 0

  for (const m of allMessages) {
    if (runCount >= MAX_RUN) break
    if (dayCount + runCount >= MAX_DAY) break

    if (m.appId) {
      const lastHour = appLastSent[m.appId]
      if (lastHour) {
        const elapsed = now - Date.parse(`${lastHour}:00:00Z`)
        if (elapsed < APP_COOLDOWN_H * HOUR_MS) continue
      }
    }
    allowed.push(m)
    runCount++
    if (m.appId) appLastSent[m.appId] = utcHour(now)
  }

  return {
    messages: allowed,
    nextDay: { date: today, count: dayCount + runCount },
    nextAppLastSent: appLastSent,
  }
}

// ─── main planner ─────────────────────────────────────────────────────────────

/**
 * inputs: { anomalies, hours, openHour, network, appsLatest, discover, labels,
 *           anchorAddrs, agentsData, digest }
 * prev: current notified.json content
 * opts: { enabledKinds: Set<string>, now: number, maxPerRun: number }
 */
export function planAlerts(inputs, prev = {}, opts = {}) {
  const {
    anomalies, hours = {}, openHour = null, network = 'mainnet',
    appsLatest, discover, labels, anchorAddrs = [], agentsData, digest,
  } = inputs

  const now = opts.now ?? Date.now()
  const enabledKinds = opts.enabledKinds instanceof Set ? opts.enabledKinds : new Set(['anomaly','daily','health','rank','contract','agents','weekly'])

  const kinds = prev.kinds ?? {}

  // --- Run each planner ---
  const candidates = []

  if (enabledKinds.has('anomaly')) {
    const { messages, nextKindState } = planAnomaly(anomalies, kinds.anomaly)
    candidates.push(...messages)
    kinds.anomaly = nextKindState
  }

  if (enabledKinds.has('daily') && hours) {
    const { messages, nextKindState } = planDaily(hours, openHour, network, now, kinds.daily)
    candidates.push(...messages)
    kinds.daily = nextKindState
  }

  if (enabledKinds.has('health') && hours) {
    const { messages, nextKindState } = planHealth(hours, openHour, now, kinds.health)
    candidates.push(...messages)
    kinds.health = nextKindState
  }

  if (enabledKinds.has('rank')) {
    const { messages, nextKindState } = planRank(appsLatest, now, kinds.rank)
    candidates.push(...messages)
    kinds.rank = nextKindState
  }

  if (enabledKinds.has('contract')) {
    const { messages, nextKindState } = planContract(discover, labels, anchorAddrs, now, kinds.contract)
    candidates.push(...messages)
    kinds.contract = nextKindState
  }

  if (enabledKinds.has('agents')) {
    const { messages, nextKindState } = planAgents(agentsData, network, kinds.agents)
    candidates.push(...messages)
    kinds.agents = nextKindState
  }

  if (enabledKinds.has('weekly')) {
    const { messages, nextKindState } = planWeekly(digest, kinds.weekly)
    candidates.push(...messages)
    kinds.weekly = nextKindState
  }

  // --- Apply budget ---
  const { messages: allowed, nextDay, nextAppLastSent } = applyBudget(candidates, prev, now)

  // --- Build feed entries ---
  const oldFeed = Array.isArray(prev.feed) ? prev.feed : []
  const newFeedEntries = allowed.map(m => ({
    id: m.id, title: m.feedTitle, link: m.feedLink,
    date: new Date(now).toISOString(),
  }))
  const feed = [...newFeedEntries, ...oldFeed].slice(0, 50)

  // --- Backward-compat: keep prev.sent for anomaly kind ---
  const anomalyKind = kinds.anomaly ?? {}
  const sent = Array.isArray(anomalyKind.sent) ? anomalyKind.sent : (Array.isArray(prev.sent) ? prev.sent : [])

  return {
    messages: allowed.map(m => m.text),
    state: { sent, feed, kinds, day: nextDay, appLastSent: nextAppLastSent },
  }
}
