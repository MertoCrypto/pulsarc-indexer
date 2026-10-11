// Runs after summarize.mjs. Writes data/<net>/anomalies.json, digest-latest.json, agents.json,
// notified.json and feed.xml, and posts new alerts to Telegram when a bot is configured.
// Each step is isolated: a failure in one never blocks the others or the snapshot publish.
//
// Env:
//   NOTIFY_KINDS   comma-separated kinds to enable (default: anomaly,daily,health,rank,contract,agents,weekly)
//   NOTIFY_DRY_RUN=1  prints messages as [dry-run] lines; does NOT write notified.json; still writes feed.xml
//   NOTIFY_NETS    comma-separated networks that get Telegram delivery (default: mainnet)

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeAnomalies } from './anomalies.mjs'
import { computeDigest } from './digest.mjs'
import { scanAgents, REGISTRY } from './agents.mjs'
import { planAlerts, SITE } from './alerts.mjs'
import { renderRss, sendTelegram } from './notify.mjs'

const NET     = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const ROOT    = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const DRY_RUN = process.env.NOTIFY_DRY_RUN === '1'

const DEFAULT_KINDS = 'anomaly,daily,health,rank,contract,agents,weekly'
const enabledKinds  = new Set(
  (process.env.NOTIFY_KINDS ?? DEFAULT_KINDS).split(',').map(s => s.trim()).filter(Boolean)
)

const RPCS = {
  mainnet: ['https://rpc.mainnet.arc.io', 'https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io', 'https://rpc.quicknode.mainnet.arc.io'],
  testnet: ['https://rpc.testnet.arc.io', 'https://rpc.blockdaemon.testnet.arc.io', 'https://rpc.drpc.testnet.arc.io', 'https://rpc.quicknode.testnet.arc.io'],
}

async function loadAllHours() {
  const files = (await readdir(join(ROOT, 'hourly'))).filter((f) => f.endsWith('.json')).sort()
  const hours = {}
  for (const f of files) Object.assign(hours, JSON.parse(await readFile(join(ROOT, 'hourly', f), 'utf8')))
  return hours
}

async function readJson(path, def = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return def }
}

async function step(name, fn) {
  try { await fn() } catch (e) { console.error(`${NET}: ${name} failed — ${e.message}`) }
}

// eth_call batch with per-item errors (reverts are expected) and endpoint rotation.
let idx = 0
async function ethCall(calls) {
  for (let attempt = 0; attempt < RPCS[NET].length * 3; attempt++) {
    const url = RPCS[NET][idx % RPCS[NET].length]
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: 'eth_call', params: [c, 'latest'] }))),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const out = await res.json()
      if (!Array.isArray(out)) throw new Error('non-array response')
      if (out.some((r) => r.error && /rate.?limit|too many/i.test(r.error.message ?? ''))) throw new Error('rate limited')
      const byId = new Map(out.map((r) => [r.id, r]))
      return calls.map((_, id) => {
        const r = byId.get(id)
        return r?.error ? { error: r.error.message ?? 'error' } : { result: r?.result }
      })
    } catch {
      idx++
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  throw new Error('all RPC endpoints failed')
}

// ─── load data ───────────────────────────────────────────────────────────────

const hours = await loadAllHours().catch((e) => { console.error(`${NET}: cannot read hourly data — ${e.message}`); return null })

let anomalies  = null
let stateJson  = null
let appsLatest = null
let discover   = null
let labels     = null
let agentsData = null
let digest     = null

if (hours) {
  await step('anomalies', async () => {
    stateJson = await readJson(join(ROOT, 'state.json'))
    const openHour = stateJson?.openHour ?? null
    const a = computeAnomalies(hours, Date.now(), undefined, openHour)
    await writeFile(join(ROOT, 'anomalies.json'), JSON.stringify({ network: NET, ...a }))
    console.log(`${NET}: anomalies.json — ${a.status}, ${a.items.length} items`)
    anomalies = { network: NET, ...a }
  })

  await step('digest', async () => {
    const d = computeDigest(hours, NET)
    await writeFile(join(ROOT, 'digest-latest.json'), JSON.stringify(d))
    console.log(`${NET}: digest-latest.json — ${d.status}`)
    digest = d
  })
}

appsLatest = await readJson(join(ROOT, 'apps-latest.json'))
discover   = await readJson(join(ROOT, 'discover.json'))
labels     = await readJson(join(ROOT, 'labels.json'))

// Collect all anchor addresses from the apps config
let anchorAddrs = []
try {
  const appsConfig = JSON.parse(await readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', `apps.${NET}.json`), 'utf8'
  ))
  anchorAddrs = (appsConfig?.apps ?? []).flatMap(a => (a.anchors ?? []).map(an => an.address?.toLowerCase())).filter(Boolean)
} catch { /* ignore */ }

// ─── agents ──────────────────────────────────────────────────────────────────

await step('agents', async () => {
  const path = join(ROOT, 'agents.json')
  let prev = { lastId: 0, agents: [] }
  try { prev = JSON.parse(await readFile(path, 'utf8')) } catch { /* first run */ }
  const registry = REGISTRY[NET]
  const r = await scanAgents({ registry, state: prev, ethCall, maxPerRun: Number(process.env.AGENTS_PER_RUN || 2000) })
  agentsData = {
    network: NET, generatedAt: new Date().toISOString(), registry, lastId: r.lastId, caughtUp: r.done,
    count: r.agents.length, agents: r.agents,
  }
  await writeFile(path, JSON.stringify(agentsData))
  console.log(`${NET}: agents.json — ${r.agents.length} agents, lastId ${r.lastId}, ${r.done ? 'caught up' : 'more to scan'}`)
})

// ─── alerts ───────────────────────────────────────────────────────────────────

await step('notify', async () => {
  const notifiedPath = join(ROOT, 'notified.json')
  let prev = {}
  try { prev = JSON.parse(await readFile(notifiedPath, 'utf8')) } catch { /* first run */ }

  const openHour = stateJson?.openHour ?? null

  const plan = planAlerts(
    { anomalies, hours: hours ?? {}, openHour, network: NET,
      appsLatest, discover, labels, anchorAddrs, agentsData, digest },
    prev,
    { enabledKinds },
  )

  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat  = process.env.TELEGRAM_CHAT_ID
  const nets  = (process.env.NOTIFY_NETS || 'mainnet').split(',').map(s => s.trim())
  let posted  = 0

  for (const text of plan.messages) {
    if (DRY_RUN) {
      console.log(`[dry-run] ${text}`)
    } else if (token && chat && nets.includes(NET)) {
      await sendTelegram(token, chat, text)
      posted++
    }
  }

  // Always write feed
  await writeFile(join(ROOT, 'feed.xml'), renderRss(plan.state.feed, NET))

  // Only write notified.json when NOT dry-run
  if (!DRY_RUN) {
    await writeFile(notifiedPath, JSON.stringify(plan.state))
  }

  console.log(`${NET}: notify — ${plan.messages.length} new, ${posted} posted to Telegram${DRY_RUN ? ' [dry-run]' : ''}`)
})
