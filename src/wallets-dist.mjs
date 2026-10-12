// src/wallets-dist.mjs — Distribution/quantile file builder for the Pulsarc indexer.
//
// No top-level await outside of the CLI guard.
// No network or RPC calls.
// Tested by test/wallets-dist.test.mjs; run: node --test test/wallets-dist.test.mjs

import { readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { decodeShard, decodeRecord, activeDayCount } from './wallets.mjs'

// ── 1. Constants ──────────────────────────────────────────────────────────────

/**
 * Number of quantile boundary points produced by `quantiles()`.
 * q[0] = min, q[100] = max, q[k] = value at the k-th percentile boundary.
 */
export const QUANTILE_POINTS = 101

// ── 2. quantiles ─────────────────────────────────────────────────────────────

/**
 * Compute 101 evenly-spaced quantile boundaries from a sorted ascending array.
 *
 * q[k] = sortedAscending[ floor(k / 100 * (n - 1)) ]   for k = 0..100
 *
 * Precondition: the input array MUST already be sorted in ascending order.
 * Passing an unsorted array produces undefined (likely wrong) results.
 *
 * q[0]   = minimum value  (index 0)
 * q[100] = maximum value  (index n-1)
 *
 * @param {number[]} sortedAscending  Must be sorted ascending; empty is allowed.
 * @returns {number[]}  101-element array, or [] if the input is empty.
 */
export function quantiles(sortedAscending) {
  const n = sortedAscending.length
  if (n === 0) return []
  const q = new Array(QUANTILE_POINTS)
  for (let k = 0; k < QUANTILE_POINTS; k++) {
    const idx = Math.floor(k / 100 * (n - 1))
    q[k] = sortedAscending[idx]
  }
  return q
}

// ── 3. percentileOf ───────────────────────────────────────────────────────────

/**
 * Estimate the percentile rank of `value` from 101 quantile boundaries.
 *
 * Definition (monotonic non-decreasing in value):
 *   Let `below` = the number of quantile boundaries q[0..100] that are
 *   strictly less than `value`.  Then:
 *
 *     percentileOf(q, value) = clamp(below - 1, 0, 100)
 *
 * Interpretation: returns the percentage (integer 0–100) of wallets whose
 * metric value is estimated to be strictly below `value`.
 *
 * Edge cases:
 *   value <= q[0]  →  0   (at or below the minimum: 0% are strictly below you)
 *   value >  q[100] → 100  (above the maximum: 100% are at or below you)
 *
 * Monotonicity: as `value` increases, `below` can only stay the same or
 * increase, so the result is non-decreasing.
 *
 * @param {number[]} q      101-element quantile array from `quantiles()`.
 * @param {number}   value  The value to rank.
 * @returns {number}  Integer in [0, 100].
 */
export function percentileOf(q, value) {
  if (!q || q.length === 0) return 0
  let below = 0
  for (let k = 0; k < q.length; k++) {
    if (q[k] < value) below++
  }
  return Math.min(100, Math.max(0, below - 1))
}

// ── 4. Helpers ────────────────────────────────────────────────────────────────

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

// ── 5. buildDist ─────────────────────────────────────────────────────────────

/**
 * Read all shards under `<dir>/s/` and `<dir>/meta.json`, decode every wallet
 * record, and compute per-metric 101-point quantile arrays.
 *
 * @param {string}  dir   Root output directory (contains meta.json and s/).
 * @param {Date}   [now]  Timestamp for the `generatedAt` field (default: new Date()).
 * @returns {Promise<object|null>}  Distribution object, or null when there are
 *   no wallets or no meta.json.
 */
export async function buildDist(dir, now = new Date()) {
  // ── Load meta ──────────────────────────────────────────────────────────────
  const meta = await readJson(join(dir, 'meta.json'), null)
  if (!meta) return null

  // ── Enumerate shard files ─────────────────────────────────────────────────
  const shardsDir = join(dir, 's')
  let shardFiles
  try {
    const entries = await readdir(shardsDir)
    shardFiles = entries.filter((f) => f.endsWith('.json'))
  } catch {
    return null  // s/ directory missing → no wallets
  }

  if (shardFiles.length === 0) return null

  // ── Collect metrics from every wallet ────────────────────────────────────
  const activeDaysVals  = []
  const txVals          = []
  const usdcSentVals    = []
  const usdcRecvVals    = []

  let walletCount = 0

  for (const file of shardFiles) {
    const shardPath = join(shardsDir, file)
    let obj
    try {
      obj = JSON.parse(await readFile(shardPath, 'utf8'))
    } catch {
      continue  // unreadable shard: skip
    }
    if (!obj || typeof obj !== 'object') continue

    for (const [, encoded] of Object.entries(obj)) {
      // encoded is the compact array [f,l,d,t,x,e,o,i,a,bo,bi]
      if (!Array.isArray(encoded)) continue  // malformed entry: skip

      let rec
      try {
        rec = decodeRecord(encoded)
      } catch {
        continue  // malformed: skip
      }

      // Validate that we can derive numeric metrics; skip NaN/non-finite records
      const ad = activeDayCount(rec)
      const tx = rec.t
      const os = rec.o
      const ir = rec.i

      if (!isFinite(ad) || !isFinite(tx) || !isFinite(os) || !isFinite(ir)) continue

      activeDaysVals.push(ad)
      txVals.push(tx)
      usdcSentVals.push(os)
      usdcRecvVals.push(ir)
      walletCount++
    }
  }

  if (walletCount === 0) return null

  // ── Build quantile arrays ─────────────────────────────────────────────────
  activeDaysVals.sort((a, b) => a - b)
  txVals.sort((a, b) => a - b)
  usdcSentVals.sort((a, b) => a - b)
  usdcRecvVals.sort((a, b) => a - b)

  const metrics = {}

  // activeDays is always included
  metrics.activeDays = quantiles(activeDaysVals)

  // tx: include only when at least one wallet has tx > 0
  if (txVals.some((v) => v > 0)) {
    metrics.tx = quantiles(txVals)
  }

  // usdcSent: include only when at least one wallet has a non-zero value
  if (usdcSentVals.some((v) => v > 0)) {
    metrics.usdcSent = quantiles(usdcSentVals)
  }

  // usdcReceived: include only when at least one wallet has a non-zero value
  if (usdcRecvVals.some((v) => v > 0)) {
    metrics.usdcReceived = quantiles(usdcRecvVals)
  }

  return {
    version: 1,
    net: meta.network,
    through: meta.through,
    walletCount,
    generatedAt: now.toISOString(),
    metrics,
  }
}

// ── 6. writeDist ─────────────────────────────────────────────────────────────

/**
 * Build the distribution object and write it atomically to `<dir>/dist.json`.
 *
 * @param {string}  dir   Root output directory.
 * @param {Date}   [now]  Timestamp for generatedAt (default: new Date()).
 * @returns {Promise<boolean>}  true when written, false when buildDist returned null.
 */
export async function writeDist(dir, now = new Date()) {
  const dist = await buildDist(dir, now)
  if (dist === null) return false

  const destPath = join(dir, 'dist.json')
  const tmpPath  = destPath + '.tmp'
  await writeFile(tmpPath, JSON.stringify(dist))
  await rename(tmpPath, destPath)
  return true
}

// ── 7. CLI ────────────────────────────────────────────────────────────────────

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]
  if (!dir) {
    console.error('Usage: node src/wallets-dist.mjs <dir>')
    process.exit(1)
  }
  try {
    const written = await writeDist(dir)
    if (written) {
      const dist = JSON.parse(await readFile(join(dir, 'dist.json'), 'utf8'))
      console.log(`wallet-dist: ${dist.walletCount} wallets`)
    } else {
      console.log('wallet-dist: nothing to write')
    }
  } catch (e) {
    console.error(`wallet-dist error: ${e.message}`)
    process.exit(1)
  }
}
