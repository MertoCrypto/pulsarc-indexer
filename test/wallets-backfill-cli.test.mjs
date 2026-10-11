// pulsarc-indexer/test/wallets-backfill-cli.test.mjs — T7
// End-to-end CLI tests for src/wallets-backfill.mjs.
//
// Each test spins up its own real HTTP JSON-RPC server (node:http, port 0) and
// runs the CLI with execFile so that flag parsing, untilDay computation,
// --no-partial, --live-pending, and exit-code paths are all exercised.
//
// Synthetic chain:
//   6 days × 1000 blocks/day = blocks 0-5999
//   block i timestamp = EPOCH_S + floor(i/1000)*86400 + (i%1000)*86
//     (each 1000-block group occupies exactly one UTC day relative to EPOCH_S)
//   Day boundary: block d*1000 is the first block of day d.
//
// Wallets: every block has ONE Transfer log, ADDR_A → ADDR_B, 1 USDC.
// --span 300: ~3-4 windows per day (exercises multi-window code path).
// --until-block 3500: in day 3; complete days = 0,1,2; partial day = 3,
//   range = [3000, 3499] (500 blocks, 500 logs).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ── Constants ─────────────────────────────────────────────────────────────────

// Re-derive EPOCH_S and USDC/TRANSFER_TOPIC from the same source modules.
import { EPOCH_S, decodeShard, decodeRecord } from '../src/wallets.mjs'
import { USDC, TRANSFER_TOPIC } from '../src/counters.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wallets-backfill.mjs')

// Synthetic wallet addresses.
const ADDR_A = '0x' + 'a'.repeat(40)
const ADDR_B = '0x' + 'b'.repeat(40)
const ZERO   = '0x' + '0'.repeat(40)

// ── Synthetic chain ───────────────────────────────────────────────────────────

/** Unix timestamp for block `i` on the synthetic chain. */
function blockTs(i) {
  return EPOCH_S + Math.floor(i / 1000) * 86400 + (i % 1000) * 86
}

/** Pad a 40-char address into a 64-char log topic. */
function addrTopic(addr) {
  return '0x' + '0'.repeat(24) + addr.slice(2)
}

/** Hex-encode a USDC amount (6 decimals). */
function usdcHex(amount) {
  return '0x' + BigInt(Math.round(amount * 1e6)).toString(16)
}

/** Build one synthetic Transfer log for block `bn`. */
function makeLog(bn) {
  return {
    address:     USDC,
    topics:      [TRANSFER_TOPIC, addrTopic(ADDR_A), addrTopic(ADDR_B)],
    data:        usdcHex(1),
    blockNumber: '0x' + bn.toString(16),
  }
}

// ── RPC server factory ────────────────────────────────────────────────────────

/**
 * Start a local HTTP JSON-RPC server.
 *
 * @param {object} opts
 * @param {number}  [opts.totalBlocks=6000]   Chain length (blocks 0 .. totalBlocks-1).
 * @param {Function} [opts.onGetLogs]         Called with (fromBlock, toBlock) for each eth_getLogs.
 * @param {Function} [opts.overrideLogs]      When set, replaces the default log response.
 *                                             Called with (fromBlock, toBlock) → logs | Error to throw.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
function startServer({ totalBlocks = 6000, onGetLogs, overrideLogs } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', async () => {
        try {
          const { method, params, id } = JSON.parse(body)
          let result = null

          if (method === 'eth_getBlockByNumber') {
            const bn = Number(BigInt(params[0]))
            if (bn < 0 || bn >= totalBlocks) {
              const reply = { jsonrpc: '2.0', id, error: { code: -32000, message: `block ${bn} out of range` } }
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify(reply))
              return
            }
            result = {
              number:    '0x' + bn.toString(16),
              timestamp: '0x' + blockTs(bn).toString(16),
            }
          } else if (method === 'eth_getLogs') {
            const from = Number(BigInt(params[0].fromBlock))
            const to   = Number(BigInt(params[0].toBlock))
            if (onGetLogs) onGetLogs(from, to)

            if (overrideLogs) {
              const override = overrideLogs(from, to)
              if (override instanceof Error) {
                const reply = {
                  jsonrpc: '2.0', id,
                  error: { code: override.code ?? -32000, message: override.message },
                }
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify(reply))
                return
              }
              result = override
            } else {
              // Return all synthetic logs in [from, to]
              const logs = []
              const lo = Math.max(0, from)
              const hi = Math.min(totalBlocks - 1, to)
              for (let bn = lo; bn <= hi; bn++) {
                logs.push(makeLog(bn))
              }
              result = logs
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
        } catch (e) {
          res.writeHead(500)
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { message: e.message } }))
        }
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        port,
        close: () => new Promise((res, rej) => server.close((e) => e ? rej(e) : res())),
      })
    })
    server.on('error', reject)
  })
}

/** Create a fresh temp dir for one test run. */
function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'wbf-cli-'))
}

/** Read JSON from a file; returns `fallback` on any error. */
async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

/** Write JSON atomically. */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

/** Run the backfill CLI with the given args and env. */
async function runCli({ port, args, extraEnv = {} }) {
  const rpcUrl = `http://127.0.0.1:${port}`
  return execFileAsync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, NET: 'mainnet', RPC_URLS: rpcUrl, ...extraEnv },
    encoding: 'utf8',
  })
}

// ── Derived constants for our 6-day chain ──────────────────────────────────────
//
// --from-block 0 --until-block 3500 --span 300
//
// untilBlock = 3500
// untilBlock ts = EPOCH_S + 3*86400 + 500*86 = EPOCH_S + 302200
// dayOf(untilTs) = floor(302200 / 86400) = 3   → untilDay = 3
//
// runBackfill toBlock = untilBlock-1 = 3499
// Complete days = 0, 1, 2  (day < 3)
// Each complete day has exactly 1000 blocks → 1000 Transfer logs (A→B, 1 USDC each)
// ADDR_A.o = 1000 per day, ADDR_B.i = 1000 per day
//
// Partial day 3: day starts at block 3000; range = [3000, 3499] = 500 logs
// ADDR_A.o = 500, ADDR_B.i = 500
//
// Shard for ADDR_A: 'aaa' (first 3 hex chars of 'aa...a' = 'aaa')
// Shard for ADDR_B: 'bbb'

const UNTIL_BLOCK = 3500
const SPAN        = '300'

// ── Case 1: Full run ──────────────────────────────────────────────────────────
describe('CLI case 1 — full run: shard files, meta.json, partial pending, stdout', () => {
  it('produces days 0-2 in shards, partial day 3 in pending, correct stdout', async () => {
    const srv = await startServer()
    const dir = tmpDir()
    const outDir = join(dir, 'out')

    let stdout, stderr
    try {
      const res = await runCli({
        port: srv.port,
        args: ['--out', outDir, '--from-block', '0', '--until-block', String(UNTIL_BLOCK), '--span', SPAN],
      })
      stdout = res.stdout
      stderr = res.stderr
    } finally {
      await srv.close()
    }

    // ── Shard files for days 0-2 ────────────────────────────────────────────

    const shardA = await readJson(join(outDir, 's', 'aaa.json'))
    const shardB = await readJson(join(outDir, 's', 'bbb.json'))
    assert.ok(shardA, 'shard aaa.json must exist')
    assert.ok(shardB, 'shard bbb.json must exist')

    const recA = decodeShard(shardA).get(ADDR_A.toLowerCase())
    const recB = decodeShard(shardB).get(ADDR_B.toLowerCase())
    assert.ok(recA, 'ADDR_A must be in shard aaa.json')
    assert.ok(recB, 'ADDR_B must be in shard bbb.json')

    // 3 complete days × 1000 logs/day = 3000 USDC sent by A, received by B
    assert.equal(recA.o, 3000, `ADDR_A.o should be 3000, got ${recA.o}`)
    assert.equal(recB.i, 3000, `ADDR_B.i should be 3000, got ${recB.i}`)

    // Lite record: other fields stay 0/'0'
    assert.equal(recA.t,  0,   'recA.t must be 0 (lite)')
    assert.equal(recA.x,  0,   'recA.x must be 0 (lite)')
    assert.equal(recA.e,  0,   'recA.e must be 0 (lite)')
    assert.equal(recA.a,  '0', 'recA.a must be "0" (lite)')
    assert.equal(recA.bo, 0,   'recA.bo must be 0 (lite)')
    assert.equal(recA.bi, 0,   'recA.bi must be 0 (lite)')

    // f, l, d fields are populated
    assert.equal(recA.f, 0, 'ADDR_A.f must be 0 (first day)')
    assert.equal(recA.l, 2, 'ADDR_A.l must be 2 (last complete day)')

    // ── meta.json ───────────────────────────────────────────────────────────

    const meta = await readJson(join(outDir, 'meta.json'))
    assert.ok(meta, 'meta.json must exist')
    assert.equal(meta.through, 2, 'meta.through must be 2')
    assert.ok(meta.lite, 'meta.lite must exist')
    assert.equal(meta.lite.from,    0, 'meta.lite.from must be 0')
    assert.equal(meta.lite.through, 2, 'meta.lite.through must be 2')

    // ── Partial pending file ────────────────────────────────────────────────

    const pendingPath = join(outDir, 'pending', 'wallets-pending.json')
    const pending = await readJson(pendingPath)
    assert.ok(pending, 'pending/wallets-pending.json must exist')
    assert.ok(pending.days?.['3'], 'partial day 3 must be in pending.days["3"]')

    const partialA = decodeRecord(pending.days['3'][ADDR_A.toLowerCase()])
    const partialB = decodeRecord(pending.days['3'][ADDR_B.toLowerCase()])
    assert.ok(partialA, 'ADDR_A must be in partial day 3')
    assert.ok(partialB, 'ADDR_B must be in partial day 3')

    // Partial day 3 = blocks [3000, 3499] = 500 logs
    assert.equal(partialA.o, 500, `partial ADDR_A.o should be 500, got ${partialA.o}`)
    assert.equal(partialB.i, 500, `partial ADDR_B.i should be 500, got ${partialB.i}`)

    // ── stdout: "backfill: partial day=3 wallets=2 logs=500" ────────────────

    assert.ok(stdout.includes('backfill: partial day=3'),
      `stdout must include "backfill: partial day=3"; got:\n${stdout}`)
    assert.ok(stdout.includes('wallets=2'),
      `stdout must include "wallets=2"; got:\n${stdout}`)
    assert.ok(stdout.includes('logs=500'),
      `stdout must include "logs=500"; got:\n${stdout}`)
  })
})

// ── Case 2: --no-partial ──────────────────────────────────────────────────────
describe('CLI case 2 — --no-partial: no pending file, stdout says cut-over not scanned', () => {
  it('does not write partial pending and stdout contains "cut-over day not scanned"', async () => {
    const srv = await startServer()
    const dir = tmpDir()
    const outDir = join(dir, 'out')

    let stdout
    try {
      const res = await runCli({
        port: srv.port,
        args: [
          '--out', outDir,
          '--from-block', '0',
          '--until-block', String(UNTIL_BLOCK),
          '--span', SPAN,
          '--no-partial',
        ],
      })
      stdout = res.stdout
    } finally {
      await srv.close()
    }

    // Shard files for days 0-2 still written
    const shardA = await readJson(join(outDir, 's', 'aaa.json'))
    assert.ok(shardA, 'shard aaa.json must exist even with --no-partial')

    // No partial pending file
    const pendingPath = join(outDir, 'pending', 'wallets-pending.json')
    const pending = await readJson(pendingPath)
    // The pending file may exist from runBackfill internal writes but days["3"] must be absent
    // (runBackfill writes then publishes, which clears the pending; runPartialDay is never called)
    const hasDay3 = pending?.days?.['3'] != null
    assert.ok(!hasDay3, 'days["3"] must NOT exist in pending when --no-partial is set')

    // stdout must mention "cut-over day not scanned"
    assert.ok(stdout.includes('cut-over day not scanned'),
      `stdout must include "cut-over day not scanned"; got:\n${stdout}`)
  })
})

// ── Case 3: --live-pending ────────────────────────────────────────────────────
describe('CLI case 3 — --live-pending: merges partial day into existing file, preserves extra keys', () => {
  it('merges days["3"] and preserves top-level extra key, nothing in outDir/pending/', async () => {
    const srv = await startServer()
    const dir = tmpDir()
    const outDir = join(dir, 'out')

    // Prepare an existing live pending file with a pre-existing days["3"] entry
    // for ADDR_B (i=100) and an extra top-level key.
    const livePendingPath = join(dir, 'live-wallets-pending.json')

    // Build a pre-existing record for ADDR_B on day 3 with i=100
    // (encoded as array [f,l,d,t,x,e,o,i,a,bo,bi])
    const existingRecB = [3, 3, '1', 0, 0, 0, 0, 100, '0', 0, 0]
    // Also add ADDR_C (a third wallet not touched by the backfill)
    const ADDR_C = '0x' + 'c'.repeat(40)
    const existingRecC = [3, 3, '1', 0, 0, 0, 5, 0, '0', 0, 0]

    await writeJson(livePendingPath, {
      version: 1,
      dropped: 0,
      startBlock: 99999,              // extra top-level key to be preserved
      days: {
        '3': {
          [ADDR_B.toLowerCase()]: existingRecB,
          [ADDR_C.toLowerCase()]: existingRecC,
        },
      },
    })

    let stdout
    try {
      const res = await runCli({
        port: srv.port,
        args: [
          '--out', outDir,
          '--from-block', '0',
          '--until-block', String(UNTIL_BLOCK),
          '--span', SPAN,
          '--live-pending', livePendingPath,
        ],
      })
      stdout = res.stdout
    } finally {
      await srv.close()
    }

    // Read the live pending file (should have been updated in-place)
    const merged = await readJson(livePendingPath)
    assert.ok(merged, 'live pending file must exist after run')

    // Extra top-level key must be preserved
    assert.equal(merged.startBlock, 99999,
      'extra top-level key "startBlock" must be preserved in live pending file')

    // days["3"] must contain all three wallets: A, B, C
    const day3 = merged.days?.['3']
    assert.ok(day3, 'days["3"] must exist in live pending file')

    // ADDR_A: only from the backfill partial run (o=500)
    const recA = decodeRecord(day3[ADDR_A.toLowerCase()])
    assert.ok(recA, 'ADDR_A must be in merged days["3"]')
    assert.equal(recA.o, 500, `merged ADDR_A.o should be 500, got ${recA.o}`)

    // ADDR_B: pre-existing i=100 PLUS backfill i=500 → i=600
    const recB = decodeRecord(day3[ADDR_B.toLowerCase()])
    assert.ok(recB, 'ADDR_B must be in merged days["3"]')
    assert.equal(recB.i, 600, `merged ADDR_B.i should be 600 (100+500), got ${recB.i}`)

    // ADDR_C: untouched, o=5 still
    const recC = decodeRecord(day3[ADDR_C.toLowerCase()])
    assert.ok(recC, 'ADDR_C must be preserved in merged days["3"]')
    assert.equal(recC.o, 5, `ADDR_C.o should remain 5, got ${recC.o}`)

    // Nothing written to outDir/pending/wallets-pending.json for day 3
    // (the outDir pending may have some state from runBackfill's internal writes,
    //  but the partial day must not appear there)
    const internalPending = await readJson(join(outDir, 'pending', 'wallets-pending.json'))
    const internalDay3 = internalPending?.days?.['3']
    assert.ok(!internalDay3,
      'days["3"] must NOT appear in outDir/pending/wallets-pending.json when --live-pending is used')
  })
})

// ── Case 4: Resume — no re-fetch of already-published days ───────────────────
describe('CLI case 4 — resume: second run skips already-published days', () => {
  it('second run produces same shard files; days 0-1 windows not re-requested', async () => {
    // We do two runs against two separate servers so we can count getLogs calls
    // per run independently.

    // --- First run: until-block 2500 → complete days 0, 1 (day 2 partial or untilDay=2) ---
    // untilBlock=2500 ts = EPOCH_S + 2*86400 + 500*86 = EPOCH_S + 216200
    // dayOf(216200) = floor(216200/86400) = 2 → untilDay=2
    // runBackfill toBlock=2499: complete days 0,1 (days < 2)
    // partial day 2 → [2000, 2499]

    const UNTIL_1 = 2500
    const UNTIL_2 = 3500  // same as our main until-block

    let getLogsCalls1 = []  // recorded by first server
    const srv1 = await startServer({
      onGetLogs: (f, t) => { getLogsCalls1.push([f, t]) },
    })
    const dir = tmpDir()
    const outDir = join(dir, 'out')

    try {
      await runCli({
        port: srv1.port,
        args: ['--out', outDir, '--from-block', '0', '--until-block', String(UNTIL_1), '--span', SPAN],
      })
    } finally {
      await srv1.close()
    }

    // Verify first run wrote days 0 and 1
    const metaAfterRun1 = await readJson(join(outDir, 'meta.json'))
    assert.ok(metaAfterRun1, 'meta.json must exist after first run')
    assert.equal(metaAfterRun1.through, 1, 'after first run: meta.through must be 1')

    // --- Second run: from-block 0 until-block 3500 ---
    let getLogsCalls2 = []
    const srv2 = await startServer({
      onGetLogs: (f, t) => { getLogsCalls2.push([f, t]) },
    })

    try {
      await runCli({
        port: srv2.port,
        args: ['--out', outDir, '--from-block', '0', '--until-block', String(UNTIL_2), '--span', SPAN],
      })
    } finally {
      await srv2.close()
    }

    // Final meta must show through=2 (day 2 is now complete since UNTIL_2 is in day 3)
    const metaFinal = await readJson(join(outDir, 'meta.json'))
    assert.ok(metaFinal, 'meta.json must exist after second run')
    assert.equal(metaFinal.through, 2, 'after second run: meta.through must be 2')

    // ── Compare shard files with a fresh single-run reference ──────────────

    const dirRef = tmpDir()
    const outDirRef = join(dirRef, 'out')
    const srvRef = await startServer()
    try {
      await runCli({
        port: srvRef.port,
        args: ['--out', outDirRef, '--from-block', '0', '--until-block', String(UNTIL_2), '--span', SPAN],
      })
    } finally {
      await srvRef.close()
    }

    const shardA_resumed = await readJson(join(outDir,    's', 'aaa.json'))
    const shardA_ref     = await readJson(join(outDirRef, 's', 'aaa.json'))
    const shardB_resumed = await readJson(join(outDir,    's', 'bbb.json'))
    const shardB_ref     = await readJson(join(outDirRef, 's', 'bbb.json'))

    assert.ok(shardA_resumed, 'resumed aaa.json must exist')
    assert.ok(shardA_ref,     'reference aaa.json must exist')

    const recA_resumed = decodeShard(shardA_resumed).get(ADDR_A.toLowerCase())
    const recA_ref     = decodeShard(shardA_ref).get(ADDR_A.toLowerCase())
    assert.equal(recA_resumed.o, recA_ref.o,
      `shard ADDR_A.o: resumed=${recA_resumed.o} ref=${recA_ref.o}`)

    const recB_resumed = decodeShard(shardB_resumed).get(ADDR_B.toLowerCase())
    const recB_ref     = decodeShard(shardB_ref).get(ADDR_B.toLowerCase())
    assert.equal(recB_resumed.i, recB_ref.i,
      `shard ADDR_B.i: resumed=${recB_resumed.i} ref=${recB_ref.i}`)

    // ── Second run must not re-fetch windows for days 0-1 ──────────────────

    // Days 0 and 1 span blocks 0-1999. Any getLogs call from the second run
    // with toBlock <= 1999 would indicate re-fetching published days.
    const secondRunRefetched = getLogsCalls2.filter(([, to]) => to <= 1999)
    assert.equal(secondRunRefetched.length, 0,
      `Second run must not re-fetch day 0-1 windows (blocks 0-1999), got ${JSON.stringify(secondRunRefetched)}`)
  })
})

// ── Case 5: Refusals / usage errors ───────────────────────────────────────────
describe('CLI case 5 — refusals: blockdaemon, missing --out, non-numeric --from-block', () => {
  it('blockdaemon URL exits 1 with explanation on stderr (server never contacted)', async () => {
    const dir = tmpDir()
    // Use a blockdaemon URL; the server is never actually started / contacted
    let threw = false
    let stderr = ''
    try {
      await execFileAsync(process.execPath, [
        SCRIPT,
        '--out', join(dir, 'out'),
        '--from-block', '0',
        '--until-block', '100',
        '--span', SPAN,
      ], {
        env: {
          ...process.env,
          NET: 'mainnet',
          RPC_URLS: 'https://rpc.blockdaemon.mainnet.arc.io',
        },
        encoding: 'utf8',
      })
    } catch (e) {
      threw = true
      stderr = e.stderr ?? ''
    }
    assert.ok(threw, 'CLI must exit non-zero for blockdaemon URL')
    assert.ok(
      stderr.toLowerCase().includes('blockdaemon'),
      `stderr must mention "blockdaemon"; got: ${stderr}`,
    )
    // Verify exit code is 1
    let exitCode
    try {
      await execFileAsync(process.execPath, [
        SCRIPT,
        '--out', join(dir, 'out2'),
        '--from-block', '0',
        '--until-block', '100',
      ], {
        env: {
          ...process.env,
          NET: 'mainnet',
          RPC_URLS: 'https://rpc.blockdaemon.mainnet.arc.io',
        },
        encoding: 'utf8',
      })
    } catch (e) {
      exitCode = e.code
    }
    assert.equal(exitCode, 1, 'exit code must be 1 for blockdaemon refusal')
  })

  it('missing --out exits 1 with usage message on stderr', async () => {
    const srv = await startServer()
    let threw = false
    let stderr = ''
    let exitCode
    try {
      await execFileAsync(process.execPath, [
        SCRIPT,
        '--from-block', '0',
        '--until-block', '100',
      ], {
        env: { ...process.env, NET: 'mainnet', RPC_URLS: `http://127.0.0.1:${srv.port}` },
        encoding: 'utf8',
      })
    } catch (e) {
      threw = true
      stderr  = e.stderr ?? ''
      exitCode = e.code
    } finally {
      await srv.close()
    }
    assert.ok(threw, 'CLI must exit non-zero when --out is missing')
    assert.equal(exitCode, 1, 'exit code must be 1')
    assert.ok(
      stderr.toLowerCase().includes('usage'),
      `stderr must include "usage"; got: ${stderr}`,
    )
  })

  it('non-numeric --from-block exits 1 with error message on stderr', async () => {
    const srv = await startServer()
    const dir = tmpDir()
    let threw = false
    let stderr = ''
    let exitCode
    try {
      await execFileAsync(process.execPath, [
        SCRIPT,
        '--out', join(dir, 'out'),
        '--from-block', 'notanumber',
        '--until-block', '100',
      ], {
        env: { ...process.env, NET: 'mainnet', RPC_URLS: `http://127.0.0.1:${srv.port}` },
        encoding: 'utf8',
      })
    } catch (e) {
      threw = true
      stderr   = e.stderr ?? ''
      exitCode = e.code
    } finally {
      await srv.close()
    }
    assert.ok(threw, 'CLI must exit non-zero for non-numeric --from-block')
    assert.equal(exitCode, 1, 'exit code must be 1')
    assert.ok(stderr.length > 0, 'stderr must not be empty for non-numeric --from-block')
  })
})

// ── Case 6: Server error (non-retryable) ──────────────────────────────────────
describe('CLI case 6 — server error: non-retryable JSON-RPC error → exit 1 + "backfill error:"', () => {
  it('CLI exits 1 and prints "backfill error:" when getLogs always returns an error', async () => {
    // Serve eth_getBlockByNumber normally (so untilDay is resolved), but
    // always return a non-retryable error for eth_getLogs.
    const fatalError = new Error('internal server error')
    fatalError.code = -32000  // not rate-limit, not too-many-results

    const srv = await startServer({
      overrideLogs: () => fatalError,
    })
    const dir = tmpDir()
    let threw = false
    let stderr = ''
    let exitCode
    try {
      await runCli({
        port: srv.port,
        args: ['--out', join(dir, 'out'), '--from-block', '0', '--until-block', String(UNTIL_BLOCK), '--span', SPAN],
      })
    } catch (e) {
      threw = true
      stderr   = e.stderr ?? ''
      exitCode = e.code
    } finally {
      await srv.close()
    }

    assert.ok(threw,  'CLI must exit non-zero when getLogs always errors')
    assert.equal(exitCode, 1, 'exit code must be 1')
    assert.ok(
      stderr.includes('backfill error:'),
      `stderr must include "backfill error:"; got: ${stderr}`,
    )
  })
})
