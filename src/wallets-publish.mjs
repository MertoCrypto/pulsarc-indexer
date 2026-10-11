// src/wallets-publish.mjs — Wallet shard publisher for the Pulsarc indexer.
//
// SIZE ESTIMATE (comment per spec):
//
//   One encoded wallet record: [f,l,d,t,x,e,o,i,a,bo,bi] → ~11 numbers as JSON.
//   Uncompressed JSON: ~80-100 bytes per wallet (per spec). With 60,000 distinct wallets/day,
//   the pending file for one day ≈ 60,000 × 90 bytes = 5.4 MB raw, ~1 MB gzip (git compresses).
//
//   CORRECTED ESTIMATE: the record array has 11 elements. Average element width:
//     integers (f,l,t,x,bo,bi) ~4 chars, floats (e,o,i) ~8 chars, hex strings (d,a) ~4 chars.
//     Total ≈ 11 elements × 6 chars + commas + brackets ≈ 80 bytes. The spec's 80-100 bytes/record
//     matches. 60,000 wallets × 90 bytes = 5.4 MB pending file ≈ 1 MB compressed; consistent.
//
//   Shard directory: 4096 shards. With 500,000 wallets ever seen, average shard has ~122 wallets.
//   122 wallets × 90 bytes = ~11 KB per shard file ≈ 45 MB total. Consistent with the spec.
//   In memory, a Map of 200,000 wallets × ~350 bytes per Map entry (object overhead) ≈ 70 MB.
//   The spec says ~60 MB; the difference is JS object overhead. At 200k wallets this is fine.
//   At 500k wallets the Map would be ~175 MB; still within a 512 MB Action runner limit.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { shardOf, mergeInto, encodeShard, decodeShard, decodeRecord, dayOf } from './wallets.mjs'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJsonAtomic(path, value) {
  const tmp = path + '.tmp'
  await mkdir(dirname(path), { recursive: true })
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

// ── publish() ─────────────────────────────────────────────────────────────────

/**
 * Merge all closed days from the pending file into shard files under outDir/s/.
 *
 * @param {{ pendingPath: string, outDir: string, today: number, net: string }} opts
 * @returns {Promise<{
 *   publishedDays: number[],
 *   touchedShards: number,
 *   newWallets: number,
 *   throughDay: number,
 * } | { publishedDays: [], error: string }>}
 */
export async function publish({ pendingPath, outDir, today, net }) {
  // ── Load pending file ──────────────────────────────────────────────────────

  let pending
  try {
    const raw = await readFile(pendingPath, 'utf8')
    pending = JSON.parse(raw)
    if (!pending || typeof pending !== 'object' || pending.version !== 1 || typeof pending.days !== 'object') {
      return { publishedDays: [], error: 'corrupt pending' }
    }
  } catch (e) {
    // Missing file → no-op (not an error)
    if (e.code === 'ENOENT') return { publishedDays: [], touchedShards: 0, newWallets: 0, throughDay: -1 }
    return { publishedDays: [], error: 'corrupt pending' }
  }

  // ── Load meta ──────────────────────────────────────────────────────────────

  const metaPath = join(outDir, 'meta.json')
  const shardsDir = join(outDir, 's')

  let meta = await readJson(metaPath, null)
  if (!meta) {
    meta = {
      network: net,
      version: 1,
      since: null,
      through: -1,
      gaps: [],
      walletCount: 0,
      updatedAt: new Date().toISOString(),
    }
  }

  // ── Find days to publish: day < today AND day > meta.through ──────────────

  const closedDays = Object.keys(pending.days)
    .map(Number)
    .filter((d) => d < today && d > meta.through)
    .sort((a, b) => a - b)

  if (closedDays.length === 0) {
    return { publishedDays: [], touchedShards: 0, newWallets: 0, throughDay: meta.through }
  }

  // Detect gaps: if there are integer days between meta.through+1 and the first
  // closed day that have NO pending data, record them as gaps.
  const pendingDaySet = new Set(Object.keys(pending.days).map(Number))
  const gaps = [...meta.gaps]
  if (meta.through >= 0) {
    for (let d = meta.through + 1; d < closedDays[0]; d++) {
      if (!pendingDaySet.has(d)) gaps.push(d)
    }
  }
  // Also check gaps between each pair of consecutive closed days
  for (let i = 0; i + 1 < closedDays.length; i++) {
    for (let d = closedDays[i] + 1; d < closedDays[i + 1]; d++) {
      if (!pendingDaySet.has(d)) gaps.push(d)
    }
  }

  await mkdir(shardsDir, { recursive: true })

  let touchedShards = 0
  let newWallets = 0
  const publishedDays = []

  for (const day of closedDays) {
    const dayData = pending.days[String(day)]
    if (!dayData || typeof dayData !== 'object') { publishedDays.push(day); continue }

    // Group addresses by shard
    const byShardMap = new Map()  // shard key → Map<addr, record>
    for (const [addr, encoded] of Object.entries(dayData)) {
      let shard
      try { shard = shardOf(addr) } catch { continue }  // skip malformed addresses

      if (!byShardMap.has(shard)) byShardMap.set(shard, new Map())
      // encoded is the compact array [f,l,d,t,x,e,o,i,a,bo,bi]
      const delta = decodeRecord(encoded)
      mergeInto(byShardMap.get(shard), addr.toLowerCase(), delta)
    }

    // Write touched shard files
    for (const [shard, deltaMap] of byShardMap) {
      const shardPath = join(shardsDir, `${shard}.json`)

      // Load existing shard (if any)
      let existingMap = new Map()
      const existing = await readJson(shardPath, null)
      if (existing && typeof existing === 'object') {
        existingMap = decodeShard(existing)
      }

      // Count new wallets (addresses not already in the shard)
      for (const addr of deltaMap.keys()) {
        if (!existingMap.has(addr)) newWallets++
      }

      // Merge deltas into the existing shard
      for (const [addr, delta] of deltaMap) {
        mergeInto(existingMap, addr, delta)
      }

      // Write atomically
      await writeJsonAtomic(shardPath, encodeShard(existingMap))
      touchedShards++
    }

    publishedDays.push(day)
  }

  // ── Update meta (write LAST, after all shard files) ───────────────────────

  const newThrough = closedDays[closedDays.length - 1]
  const newMeta = {
    network: net,
    version: 1,
    since: meta.since ?? closedDays[0],
    through: newThrough,
    gaps,
    walletCount: (meta.walletCount ?? 0) + newWallets,
    updatedAt: new Date().toISOString(),
  }
  await writeJsonAtomic(metaPath, newMeta)

  // ── Remove published days from pending file ───────────────────────────────

  const publishedSet = new Set(publishedDays.map(String))
  const newDays = {}
  for (const [k, v] of Object.entries(pending.days)) {
    if (!publishedSet.has(k)) newDays[k] = v
  }
  // Preserve startBlock and any other unknown top-level keys from the original pending file.
  // Only version, dropped, and days are managed here; everything else is carried through.
  const { version: _v, dropped: _d, days: _dy, ...extraKeys } = pending
  const newPending = { version: 1, dropped: pending.dropped ?? 0, ...extraKeys, days: newDays }
  await writeJsonAtomic(pendingPath, newPending)

  return { publishedDays, touchedShards, newWallets, throughDay: newThrough }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const net     = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
  const outDir  = process.argv[2]
  if (!outDir) { console.error('Usage: NET=<net> node src/wallets-publish.mjs <outDir>'); process.exit(1) }

  // Allow tests to override the pending path via WALLET_PENDING_PATH env var.
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', net)
  const pendingPath = process.env.WALLET_PENDING_PATH ?? join(ROOT, 'wallets-pending.json')
  const todayTs     = Date.now() / 1000
  const today       = dayOf(todayTs)

  try {
    const result = await publish({ pendingPath, outDir, today, net })
    if (result.error) {
      console.log(`wallets-publish: ${result.error}`)
    } else if (result.publishedDays.length === 0) {
      console.log(`wallets-publish: nothing to do (through=${result.throughDay})`)
    } else {
      console.log(`wallets-publish: published days=${result.publishedDays.join(',')} shards=${result.touchedShards} newWallets=${result.newWallets} through=${result.throughDay}`)
    }
  } catch (e) {
    console.error(`wallets-publish error: ${e.message}`)
    process.exit(1)
  }
}
