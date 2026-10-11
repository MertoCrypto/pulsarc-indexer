// Runs after summarize.mjs. Writes data/<net>/anomalies.json, digest-latest.json, agents.json,
// notified.json and feed.xml, and posts new anomalies to Telegram when a bot is configured.
// Each step is isolated: a failure in one never blocks the others or the snapshot publish.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeAnomalies } from './anomalies.mjs'
import { computeDigest } from './digest.mjs'
import { scanAgents, REGISTRY } from './agents.mjs'
import { planNotifications, renderRss, sendTelegram } from './notify.mjs'

const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
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

const hours = await loadAllHours().catch((e) => { console.error(`${NET}: cannot read hourly data — ${e.message}`); return null })

let anomalies = null
if (hours) {
  await step('anomalies', async () => {
    let openHour = null
    try { openHour = JSON.parse(await readFile(join(ROOT, 'state.json'), 'utf8')).openHour ?? null } catch { /* no state yet */ }
    const a = computeAnomalies(hours, Date.now(), undefined, openHour)
    await writeFile(join(ROOT, 'anomalies.json'), JSON.stringify({ network: NET, ...a }))
    console.log(`${NET}: anomalies.json — ${a.status}, ${a.items.length} items`)
    anomalies = { network: NET, ...a }
  })
  // The feed is always written. Telegram needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and the
  // network listed in NOTIFY_NETS (default: mainnet only).
  await step('notify', async () => {
    if (!anomalies) return
    const path = join(ROOT, 'notified.json')
    let prev = {}
    try { prev = JSON.parse(await readFile(path, 'utf8')) } catch { /* first run */ }
    const plan = planNotifications(anomalies, prev)
    const token = process.env.TELEGRAM_BOT_TOKEN
    const chat = process.env.TELEGRAM_CHAT_ID
    const nets = (process.env.NOTIFY_NETS || 'mainnet').split(',').map((s) => s.trim())
    let posted = 0
    if (token && chat && nets.includes(NET)) {
      for (const text of plan.messages) { await sendTelegram(token, chat, text); posted++ }
    }
    await writeFile(path, JSON.stringify(plan.state))
    await writeFile(join(ROOT, 'feed.xml'), renderRss(plan.state.feed, NET))
    console.log(`${NET}: notify — ${plan.messages.length} new, ${posted} posted to Telegram`)
  })
  await step('digest', async () => {
    const d = computeDigest(hours, NET)
    await writeFile(join(ROOT, 'digest-latest.json'), JSON.stringify(d))
    console.log(`${NET}: digest-latest.json — ${d.status}`)
  })
}

await step('agents', async () => {
  const path = join(ROOT, 'agents.json')
  let prev = { lastId: 0, agents: [] }
  try { prev = JSON.parse(await readFile(path, 'utf8')) } catch { /* first run */ }
  const registry = REGISTRY[NET]
  const r = await scanAgents({ registry, state: prev, ethCall, maxPerRun: Number(process.env.AGENTS_PER_RUN || 2000) })
  await writeFile(path, JSON.stringify({
    network: NET, generatedAt: new Date().toISOString(), registry, lastId: r.lastId, caughtUp: r.done,
    count: r.agents.length, agents: r.agents,
  }))
  console.log(`${NET}: agents.json — ${r.agents.length} agents, lastId ${r.lastId}, ${r.done ? 'caught up' : 'more to scan'}`)
})
