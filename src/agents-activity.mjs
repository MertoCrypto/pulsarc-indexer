// Reads owner-level activity for every distinct agent owner and writes
// data/<net>/agents-activity.json.  On any failure keeps the old file and exits 0.
//
// Usage: NET=testnet|mainnet node src/agents-activity.mjs  (default: mainnet)
//
// Pure helpers (groupByOwner, nonceCall, balanceCall, buildActivity, parseHexInt,
// rawToNumber) are exported and have no side-effects so they can be tested without
// network access.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Group an array of agents by owner wallet.
 *
 * @param {Array<{ id: number; owner: string; name?: string }>} agents
 * @returns {Array<{ owner: string; agents: number; firstId: number; names: string[] }>}
 *   Sorted by owner address ascending for determinism.
 *   `names` holds up to 3 distinct non-empty names, each trimmed to 60 chars
 *   with control characters removed.
 */
export function groupByOwner(agents) {
  /** @type {Map<string, { count: number; firstId: number; nameSet: Set<string> }>} */
  const map = new Map()

  for (const agent of agents) {
    const owner = agent.owner.toLowerCase()
    // Clean name: strip control chars, trim, truncate to 60
    const rawName = typeof agent.name === 'string' ? agent.name : ''
    const name = rawName
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      .trim()
      .slice(0, 60)

    const existing = map.get(owner)
    if (!existing) {
      const nameSet = new Set()
      if (name) nameSet.add(name)
      map.set(owner, { count: 1, firstId: agent.id, nameSet })
    } else {
      existing.count++
      if (existing.firstId > agent.id) existing.firstId = agent.id
      if (name && existing.nameSet.size < 3) existing.nameSet.add(name)
    }
  }

  const result = []
  for (const [owner, { count, firstId, nameSet }] of map) {
    result.push({
      owner,
      agents: count,
      firstId,
      names: [...nameSet],
    })
  }

  result.sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  return result
}

/**
 * Build a JSON-RPC request for eth_getTransactionCount (nonce) for an owner.
 *
 * @param {number|string} id   JSON-RPC request id
 * @param {string}        owner  0x-prefixed address
 * @returns {{ jsonrpc: '2.0'; id: number|string; method: string; params: [string, string] }}
 */
export function nonceCall(id, owner) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'eth_getTransactionCount',
    params: [owner, 'latest'],
  }
}

/**
 * ABI-encode a `balanceOf(address)` call.
 * Selector: 0x70a08231
 *
 * @param {string} address  0x-prefixed, exactly 40 hex chars
 * @returns {string}        full calldata hex string
 */
function encodeBalanceOf(address) {
  const padded = '0'.repeat(24) + address.slice(2).toLowerCase()
  return '0x70a08231' + padded
}

/**
 * Build a JSON-RPC request for eth_call balanceOf(owner) on the USDC contract.
 *
 * @param {number|string} id   JSON-RPC request id
 * @param {string}        usdc  USDC contract address (0x-prefixed)
 * @param {string}        owner target address (0x-prefixed)
 * @returns {{ jsonrpc: '2.0'; id: number|string; method: string; params: [object, string] }}
 */
export function balanceCall(id, usdc, owner) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'eth_call',
    params: [{ to: usdc.toLowerCase(), data: encodeBalanceOf(owner) }, 'latest'],
  }
}

/**
 * Parse a 0x-prefixed hex string to bigint.
 * Throws if the value is missing, empty, or not valid hex.
 *
 * @param {string} hex
 * @returns {bigint}
 */
export function parseHexInt(hex) {
  if (typeof hex !== 'string' || hex === '' || hex === '0x' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`parseHexInt: invalid hex value: ${JSON.stringify(hex)}`)
  }
  return BigInt(hex)
}

/**
 * Convert a raw token balance (bigint) to a JS number rounded to 2 decimal places.
 * Uses exact bigint arithmetic for the integer part.
 *
 * @param {bigint} raw       raw token amount
 * @param {number} decimals  token decimal count (e.g. 6 for USDC)
 * @returns {number}
 */
export function rawToNumber(raw, decimals) {
  const scale = 10n ** BigInt(decimals)
  const intPart = raw / scale
  const fracRaw = raw % scale
  const frac = Number(fracRaw) / Number(scale)
  return Math.round((Number(intPart) + frac) * 100) / 100
}

/**
 * Pick the owners to measure: all of them when there are at most `max`, otherwise the `max` owners holding
 * the most agents (ties by owner address) so the choice is deterministic between runs.
 *
 * @param {Array<{ owner: string; agents: number }>} groups
 * @param {number} max
 */
export function selectOwners(groups, max) {
  if (groups.length <= max) return groups
  return [...groups]
    .sort((a, b) => b.agents - a.agents || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
    .slice(0, max)
}

/**
 * Build the agents-activity.json document.
 *
 * @param {Array<{
 *   owner: string;
 *   agents: number;
 *   firstId: number;
 *   names: string[];
 *   txCount: number;
 *   usdc: number;
 * }>} owners
 * @param {{
 *   network: string;
 *   now: string;
 *   registry: string|null;
 *   totalAgents: number;
 * }} meta
 * @returns {object}
 */
export function buildActivity(owners, meta) {
  const { network, now: generatedAt, registry, totalAgents } = meta
  // owners may be a measured subset (testnet has tens of thousands of owners): ownersTotal is the registry-wide count
  const ownersTotal = meta.ownersTotal ?? owners.length
  const agentsMeasured = owners.reduce((s, o) => s + o.agents, 0)

  const ownersWithTx = owners.filter((o) => o.txCount > 0).length
  const ownersWithUsdc = owners.filter((o) => o.usdc > 0).length
  const agentsOfOwnersWithoutTx = owners
    .filter((o) => o.txCount === 0)
    .reduce((s, o) => s + o.agents, 0)

  // Sort: txCount desc, then agents desc, then owner asc
  const sorted = [...owners].sort((a, b) => {
    if (b.txCount !== a.txCount) return b.txCount - a.txCount
    if (b.agents !== a.agents) return b.agents - a.agents
    return a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0
  })

  const top = sorted.slice(0, 200).map((o) => ({
    owner: o.owner,
    agents: o.agents,
    txCount: o.txCount,
    usdc: o.usdc,
    firstId: o.firstId,
    names: o.names,
  }))

  return {
    network,
    generatedAt,
    registry,
    totalAgents,
    owners: ownersTotal,
    ownersMeasured: owners.length,
    agentsMeasured,
    ownersWithTx,
    ownersWithUsdc,
    agentsOfOwnersWithoutTx,
    top,
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli()
}

async function runCli() {
  const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'

  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const APPS_PATH   = join(REPO_ROOT, `apps.${NET}.json`)
  const AGENTS_PATH = join(REPO_ROOT, 'data', NET, 'agents.json')
  const DATA_DIR    = join(REPO_ROOT, 'data', NET)
  const OUT_PATH    = join(DATA_DIR, 'agents-activity.json')

  // ── RPC endpoint rotation ─────────────────────────────────────────────────

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
  const CHUNK_SIZE = 10   // 2 calls per owner × 10 owners = 20 calls per batch

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    // Return results indexed by original id
    const byId = new Map(out.map((r) => [r.id, r.result]))
    return calls.map((c) => byId.get(c.id))
  }

  /** Like rpcBatch, but retries calls that returned undefined/null (per-call rate limit). */
  async function rpcBatchPatient(calls) {
    const results = new Array(calls.length).fill(undefined)
    let pending = calls.map((_, i) => i)
    for (let round = 0; round < 8 && pending.length > 0; round++) {
      if (round > 0) await sleep(Math.min(500 * 2 ** (round - 1), 8000))
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

  function chunks(arr, size) {
    const out = []
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
    return out
  }

  // ── Refresh at most about once an hour (the reads take 30 s to 3 min and the numbers move slowly) ──

  const MAX_AGE_MIN = Number(process.env.AGENT_ACTIVITY_MAX_AGE_MIN ?? 55)
  try {
    const prev = JSON.parse(await readFile(OUT_PATH, 'utf8'))
    const ageMin = (Date.now() - Date.parse(prev.generatedAt)) / 60_000
    if (Number.isFinite(ageMin) && ageMin >= 0 && ageMin < MAX_AGE_MIN) {
      console.log(`${NET}: agents-activity.json is ${Math.round(ageMin)} min old (< ${MAX_AGE_MIN}) — skipping`)
      process.exit(0)
    }
  } catch { /* no previous file: continue */ }

  // ── Load agents.json ─────────────────────────────────────────────────────

  let agentsDoc
  try {
    agentsDoc = JSON.parse(await readFile(AGENTS_PATH, 'utf8'))
  } catch (e) {
    process.stderr.write(`[agents-activity] failed to read ${AGENTS_PATH}: ${e.message} — keeping old file\n`)
    process.exit(0)
  }

  if (!agentsDoc || !Array.isArray(agentsDoc.agents)) {
    process.stderr.write('[agents-activity] agents.json has no agents array — keeping old file\n')
    process.exit(0)
  }

  // ── Load apps config to find USDC address ────────────────────────────────

  let appsConfig
  try {
    appsConfig = JSON.parse(await readFile(APPS_PATH, 'utf8'))
  } catch (e) {
    process.stderr.write(`[agents-activity] failed to read ${APPS_PATH}: ${e.message} — keeping old file\n`)
    process.exit(0)
  }

  const usdcApp = appsConfig.apps.find((a) => a.id === 'usdc')
  if (!usdcApp || !usdcApp.anchors?.[0]?.address) {
    process.stderr.write('[agents-activity] could not find usdc app in apps config — keeping old file\n')
    process.exit(0)
  }
  const USDC_TOKEN = usdcApp.anchors[0].address.toLowerCase()

  // ── Group agents by owner ────────────────────────────────────────────────

  const allOwnerGroups = groupByOwner(agentsDoc.agents)
  // Measure at most MAX_OWNERS owners, the ones holding the most agents (testnet has ~23k owners: too many calls per run)
  const MAX_OWNERS = Math.max(1, Number(process.env.AGENT_OWNERS_MAX) || 600)
  const ownerGroups = selectOwners(allOwnerGroups, MAX_OWNERS)
  const nowIso = new Date().toISOString()

  // ── Fetch decimals once ───────────────────────────────────────────────────

  let decimals = 6
  try {
    const decimalsResult = await rpcBatchPatient([{
      jsonrpc: '2.0', id: 0, method: 'eth_call',
      params: [{ to: USDC_TOKEN, data: '0x313ce567' }, 'latest'],
    }])
    const dHex = decimalsResult[0]
    if (dHex && dHex !== '0x' && /^0x[0-9a-fA-F]+$/.test(dHex)) {
      try { decimals = Number(BigInt(dHex)) } catch { /* keep default 6 */ }
    }
  } catch { /* keep default 6 */ }

  // ── Build call list: nonce + balance per owner, 2 calls × chunk of 10 ────
  // Call ids: owner index 0 → nonce id = 0*2=0, balance id = 0*2+1=1
  //           owner index 1 → nonce id = 1*2=2, balance id = 1*2+3=3  etc.

  const OWNERS_CHUNK = 10   // 10 owners = 20 calls per RPC batch

  const ownerResults = []   // { txCount: number, usdc: number } per owner index
  let failCount = 0

  const ownerChunks = chunks(ownerGroups, OWNERS_CHUNK)

  for (const chunk of ownerChunks) {
    // Build calls: for each owner in chunk, nonce call then balance call
    const calls = []
    for (let i = 0; i < chunk.length; i++) {
      const owner = chunk[i].owner
      // Use position-local ids; we'll map back by position
      calls.push(nonceCall(i * 2,     owner))
      calls.push(balanceCall(i * 2 + 1, USDC_TOKEN, owner))
    }

    let results
    try {
      results = await rpcBatchPatient(calls)
    } catch (e) {
      process.stderr.write(`[agents-activity] RPC batch failed: ${e.message} — keeping old file\n`)
      process.exit(0)
    }

    // Decode results: results[i*2] = nonce, results[i*2+1] = balance
    for (let i = 0; i < chunk.length; i++) {
      const nonceHex   = results[i * 2]
      const balanceHex = results[i * 2 + 1]

      let txCount = 0
      let usdc = 0
      let ok = true   // a failed read must NOT be recorded as "0 transactions": such owners are left out

      try {
        txCount = Number(parseHexInt(nonceHex))
      } catch {
        failCount++
        ok = false
      }

      try {
        usdc = rawToNumber(parseHexInt(balanceHex), decimals)
      } catch {
        failCount++
        ok = false
      }

      ownerResults.push({ txCount, usdc, ok })
    }

    await sleep(150)
  }

  // ── Check failure rate (2 calls per owner, so total calls = owners * 2) ──
  const totalCalls = ownerGroups.length * 2
  if (totalCalls > 0 && failCount / totalCalls > 0.2) {
    process.stderr.write(
      `[agents-activity] too many failed owner reads (${failCount}/${totalCalls}) — keeping old file\n`,
    )
    process.exit(0)
  }

  // ── Merge results into ownerGroups ────────────────────────────────────────

  const ownersWithData = ownerGroups
    .map((g, i) => ({
      ...g,
      txCount: ownerResults[i]?.txCount ?? 0,
      usdc:    ownerResults[i]?.usdc    ?? 0,
      ok:      ownerResults[i]?.ok === true,
    }))
    .filter((o) => o.ok)

  // ── Build document ────────────────────────────────────────────────────────

  const doc = buildActivity(ownersWithData, {
    network: NET,
    now: nowIso,
    registry: agentsDoc.registry ?? null,
    totalAgents: agentsDoc.count ?? agentsDoc.agents.length,
    ownersTotal: allOwnerGroups.length,
  })

  // ── Write atomically ──────────────────────────────────────────────────────

  try {
    await mkdir(DATA_DIR, { recursive: true })
    const tmp = OUT_PATH + '.tmp'
    await writeFile(tmp, JSON.stringify(doc))
    await rename(tmp, OUT_PATH)
    console.log(
      `${NET}: agents-activity.json written ` +
      `(owners=${doc.owners}, ownersWithTx=${doc.ownersWithTx}, ` +
      `ownersWithUsdc=${doc.ownersWithUsdc})`,
    )
  } catch (e) {
    process.stderr.write(`[agents-activity] write failed: ${e.message} — keeping old file\n`)
    process.exit(0)
  }
}
