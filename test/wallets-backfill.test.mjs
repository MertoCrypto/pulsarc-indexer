// Tests for src/wallets-backfill.mjs — T4c.
// Run: node --test pulsarc-indexer/test/
//
// All network calls use a local in-process mock (no real HTTP server needed):
// the `rpc` parameter accepted by exported functions is a plain async function
// (method, params) -> result, so tests inject a fake directly.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import {
  findDayStarts,
  planWindows,
  recordsFromLogs,
  fetchWindow,
  partialDayRange,
  runBackfill,
  runPartialDay,
} from '../src/wallets-backfill.mjs'

import {
  encodeRecord,
  decodeRecord,
  decodeShard,
  emptyRecord,
  EPOCH_S,
  dayOf,
  activeDayCount,
} from '../src/wallets.mjs'

import { USDC, TRANSFER_TOPIC } from '../src/counters.mjs'
import { publish } from '../src/wallets-publish.mjs'

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDir() { return mkdtempSync(join(tmpdir(), 'wbf-test-')) }

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

// Fixed addresses for tests
const ADDR_A = '0x' + 'a'.repeat(40)
const ADDR_B = '0x' + 'b'.repeat(40)
const ADDR_C = '0x' + 'c'.repeat(40)
const ADDR_D = '0x' + 'd'.repeat(40)
const ZERO   = '0x' + '0'.repeat(40)

// Pad a 40-char address into a 64-char topic (zero-padded on the left)
function addrTopic(addr) {
  return '0x' + '0'.repeat(24) + addr.slice(2)
}

// Build a hex amount (6 decimals)
function usdcHex(amount) {
  return '0x' + (BigInt(Math.round(amount * 1e6))).toString(16)
}

// Build a synthetic Transfer log
function makeLog(from, to, amount, blockNumber, blockHex) {
  return {
    address: USDC,
    topics: [
      TRANSFER_TOPIC,
      addrTopic(from),
      addrTopic(to),
    ],
    data: usdcHex(amount),
    blockNumber: blockHex ?? ('0x' + blockNumber.toString(16)),
  }
}

// ── findDayStarts ─────────────────────────────────────────────────────────────

// Synthetic chain: 10 blocks, each spaced 12 hours apart.
// Block 0 is at EPOCH_S (day 0 start), so:
//   block 0 = day 0, block 1 = day 0 (12h), block 2 = day 1, block 3 = day 1,
//   block 4 = day 2, block 5 = day 2, block 6 = day 3, block 7 = day 3,
//   block 8 = day 4, block 9 = day 4.
const BLOCK_TS_12H = (i) => EPOCH_S + i * 43200  // 12 h = 43200 s

describe('findDayStarts — basic', () => {
  it('returns the correct first block for each day', async () => {
    const getTs = async (n) => BLOCK_TS_12H(n)
    const result = await findDayStarts({ getTimestamp: getTs, lo: 0, hi: 9, fromDay: 0, toDay: 4 })

    // Day 0 starts at block 0 (EPOCH_S)
    assert.equal(result.get(0), 0, 'day 0 should start at block 0')
    // Day 1 starts at block 2 (EPOCH_S + 2*43200 = EPOCH_S + 86400)
    assert.equal(result.get(1), 2, 'day 1 should start at block 2')
    assert.equal(result.get(2), 4, 'day 2 should start at block 4')
    assert.equal(result.get(3), 6, 'day 3 should start at block 6')
    assert.equal(result.get(4), 8, 'day 4 should start at block 8')
  })

  it('block before returned block belongs to earlier day', async () => {
    const getTs = async (n) => BLOCK_TS_12H(n)
    const result = await findDayStarts({ getTimestamp: getTs, lo: 0, hi: 9, fromDay: 1, toDay: 3 })

    for (const [day, startBlock] of result) {
      if (startBlock > 0) {
        const prevTs = await getTs(startBlock - 1)
        const prevDay = Math.floor((prevTs - EPOCH_S) / 86400)
        assert.ok(prevDay < day, `block ${startBlock-1} (day ${prevDay}) must be < day ${day}`)
      }
      const thisTs = await getTs(startBlock)
      const thisDay = Math.floor((thisTs - EPOCH_S) / 86400)
      assert.equal(thisDay, day, `block ${startBlock} must be on day ${day}`)
    }
  })
})

describe('findDayStarts — days before lo map to lo', () => {
  it('when lo block is on day 3, days 0-2 requested map to lo', async () => {
    // Block 6 is at EPOCH_S + 6*43200 = day 3
    const getTs = async (n) => BLOCK_TS_12H(n)
    const result = await findDayStarts({ getTimestamp: getTs, lo: 6, hi: 9, fromDay: 0, toDay: 2 })

    // Days 0-2 have no blocks on or after them within [6,9] range that belong
    // to those days — actually they all map to lo since the search finds no
    // block with ts >= dayStart within [6,9].
    // Days 0-2 each start at EPOCH_S, EPOCH_S+86400, EPOCH_S+172800
    // Block 6's ts = EPOCH_S + 6*43200 = EPOCH_S + 259200 = day 3
    // So blocks [6,9] are all day 3+, meaning day 0..2 targets map to lo=6.
    assert.equal(result.get(0), 6, 'day 0 should map to lo=6')
    assert.equal(result.get(1), 6, 'day 1 should map to lo=6')
    assert.equal(result.get(2), 6, 'day 2 should map to lo=6')
  })
})

describe('findDayStarts — irregular block times', () => {
  it('handles non-uniform block spacing', async () => {
    // Block timestamps with a gap: 0,1,2 days, then a block right at day 3 start
    const timestamps = [
      EPOCH_S,           // block 0: day 0
      EPOCH_S + 3600,    // block 1: day 0 (1h)
      EPOCH_S + 86399,   // block 2: day 0 (23h59m)
      EPOCH_S + 86400,   // block 3: day 1 exactly
      EPOCH_S + 86401,   // block 4: day 1
      EPOCH_S + 172800,  // block 5: day 2
    ]
    const getTs = async (n) => timestamps[n]
    const result = await findDayStarts({ getTimestamp: getTs, lo: 0, hi: 5, fromDay: 0, toDay: 2 })

    assert.equal(result.get(0), 0, 'day 0 starts at block 0')
    assert.equal(result.get(1), 3, 'day 1 starts at block 3 (first block with ts >= EPOCH_S+86400)')
    assert.equal(result.get(2), 5, 'day 2 starts at block 5')
  })
})

// ── planWindows ───────────────────────────────────────────────────────────────

describe('planWindows', () => {
  it('single block produces one window', () => {
    assert.deepEqual(planWindows(100, 100, 5000), [[100, 100]])
  })

  it('exactly span blocks produces one window', () => {
    assert.deepEqual(planWindows(0, 4999, 5000), [[0, 4999]])
  })

  it('span+1 blocks produces two windows', () => {
    assert.deepEqual(planWindows(0, 5000, 5000), [[0, 4999], [5000, 5000]])
  })

  it('empty range (from > to) returns empty array', () => {
    assert.deepEqual(planWindows(10, 5, 5000), [])
  })

  it('uneven split gives correct last window', () => {
    const windows = planWindows(0, 12, 5)
    assert.deepEqual(windows, [[0, 4], [5, 9], [10, 12]])
    // Last window is [10, 12] (only 3 blocks, less than span)
    assert.equal(windows.at(-1)[1], 12)
  })

  it('large range produces correct count', () => {
    const w = planWindows(0, 24999, 5000)
    assert.equal(w.length, 5)
    assert.equal(w[0][0], 0);    assert.equal(w[0][1], 4999)
    assert.equal(w[4][0], 20000); assert.equal(w[4][1], 24999)
  })

  it('span of 1 produces one window per block', () => {
    const w = planWindows(7, 9, 1)
    assert.deepEqual(w, [[7, 7], [8, 8], [9, 9]])
  })
})

// ── recordsFromLogs ───────────────────────────────────────────────────────────

describe('recordsFromLogs — basic sent/received sums', () => {
  it('single transfer: sender and receiver both recorded', () => {
    const logs = [makeLog(ADDR_A, ADDR_B, 10, 100)]
    const map = recordsFromLogs(logs, () => 5, 6)

    assert.ok(map.has(ADDR_A), 'sender must be in map')
    assert.ok(map.has(ADDR_B), 'receiver must be in map')
    assert.equal(map.get(ADDR_A).o, 10, 'sender o=10')
    assert.equal(map.get(ADDR_A).i, 0,  'sender i=0')
    assert.equal(map.get(ADDR_B).i, 10, 'receiver i=10')
    assert.equal(map.get(ADDR_B).o, 0,  'receiver o=0')
  })

  it('multiple logs for same wallet in one day are summed', () => {
    const logs = [
      makeLog(ADDR_A, ADDR_B, 5, 100),
      makeLog(ADDR_A, ADDR_C, 3, 101),
      makeLog(ADDR_D, ADDR_A, 7, 102),
    ]
    const map = recordsFromLogs(logs, () => 0, 6)
    assert.equal(map.get(ADDR_A).o, 8,  'ADDR_A sent 5+3=8')
    assert.equal(map.get(ADDR_A).i, 7,  'ADDR_A received 7')
  })

  it('zero address as sender is skipped (mint)', () => {
    const logs = [makeLog(ZERO, ADDR_B, 100, 200)]
    const map = recordsFromLogs(logs, () => 1, 6)
    assert.ok(!map.has(ZERO), 'zero address must not appear')
    assert.ok(map.has(ADDR_B), 'recipient must be recorded')
    assert.equal(map.get(ADDR_B).i, 100)
    assert.equal(map.get(ADDR_B).o, 0)
  })

  it('zero address as recipient is skipped (burn)', () => {
    const logs = [makeLog(ADDR_A, ZERO, 50, 300)]
    const map = recordsFromLogs(logs, () => 2, 6)
    assert.ok(!map.has(ZERO), 'zero address must not appear')
    assert.ok(map.has(ADDR_A), 'sender must be recorded')
    assert.equal(map.get(ADDR_A).o, 50)
    assert.equal(map.get(ADDR_A).i, 0)
  })

  it('malformed log missing topics is skipped', () => {
    const bad = [{ address: USDC, data: usdcHex(1), blockNumber: '0x1' }]
    const map = recordsFromLogs(bad, () => 0, 6)
    assert.equal(map.size, 0, 'malformed log must be skipped')
  })

  it('malformed log with wrong topics length is skipped', () => {
    const bad = [{ address: USDC, topics: [TRANSFER_TOPIC, addrTopic(ADDR_A)], data: usdcHex(1), blockNumber: '0x1' }]
    const map = recordsFromLogs(bad, () => 0, 6)
    assert.equal(map.size, 0)
  })

  it('malformed log with bad data is skipped', () => {
    const bad = [{
      address: USDC,
      topics: [TRANSFER_TOPIC, addrTopic(ADDR_A), addrTopic(ADDR_B)],
      data: 'not-a-number',
      blockNumber: '0x1',
    }]
    const map = recordsFromLogs(bad, () => 0, 6)
    assert.equal(map.size, 0)
  })

  it('t, x, e, a, bo, bi stay 0 in lite records', () => {
    const logs = [makeLog(ADDR_A, ADDR_B, 1, 1)]
    const map = recordsFromLogs(logs, () => 0, 6)
    const recA = map.get(ADDR_A)
    assert.equal(recA.t, 0)
    assert.equal(recA.x, 0)
    assert.equal(recA.e, 0)
    assert.equal(recA.a, '0')
    assert.equal(recA.bo, 0)
    assert.equal(recA.bi, 0)
  })
})

describe('recordsFromLogs — wallet active on two days', () => {
  it('activeDayCount is 2 when logs span two days', () => {
    // dayOfBlock uses the actual block number to determine the day
    const dayOfBlock = (bn) => bn === 100 ? 5 : 6
    const logs = [
      makeLog(ADDR_A, ADDR_B, 1, 100),
      makeLog(ADDR_A, ADDR_C, 2, 200),
    ]
    const map = recordsFromLogs(logs, dayOfBlock, 6)
    const rec = map.get(ADDR_A)
    assert.ok(rec, 'ADDR_A must be in map')
    const adc = activeDayCount(rec)
    assert.equal(adc, 2, `ADDR_A should have activeDayCount 2, got ${adc}`)
    assert.equal(rec.f, 5, 'first day = 5')
    assert.equal(rec.l, 6, 'last day = 6')
  })
})

// ── fetchWindow ───────────────────────────────────────────────────────────────

describe('fetchWindow — happy path', () => {
  it('returns logs from a single call when count < 9500', async () => {
    const logs = [makeLog(ADDR_A, ADDR_B, 1, 0)]
    const rpc = async () => logs
    const result = await fetchWindow({ rpc, from: 0, to: 100 })
    assert.deepEqual(result, logs)
  })
})

describe('fetchWindow — splits on too-many-results error', () => {
  it('splits the window and returns combined logs', async () => {
    const logs1 = [makeLog(ADDR_A, ADDR_B, 1, 0)]
    const logs2 = [makeLog(ADDR_C, ADDR_D, 2, 50)]
    let calls = 0
    const rpc = async (method, params) => {
      const f = Number(BigInt(params[0].fromBlock))
      const t = Number(BigInt(params[0].toBlock))
      calls++
      if (f === 0 && t === 100) {
        // First call: pretend too many results
        const err = new Error('query returned more than 10000 results')
        throw err
      }
      if (f === 0 && t === 50) return logs1
      if (f === 51 && t === 100) return logs2
      return []
    }
    const result = await fetchWindow({ rpc, from: 0, to: 100 })
    assert.equal(result.length, 2, 'should have 2 logs total')
    assert.ok(calls >= 3, `should have made at least 3 calls (got ${calls})`)
  })
})

describe('fetchWindow — splits on >= 9500 log count', () => {
  it('fetches twice when response hits 9500 log threshold', async () => {
    // Build 9500 fake logs
    const bigBatch = Array.from({ length: 9500 }, (_, i) => makeLog(ADDR_A, ADDR_B, 1, i))
    const smallBatch = [makeLog(ADDR_C, ADDR_D, 2, 5001)]
    const calls = []
    const rpc = async (method, params) => {
      const f = Number(BigInt(params[0].fromBlock))
      const t = Number(BigInt(params[0].toBlock))
      calls.push([f, t])
      if (f === 0 && t === 10000) return bigBatch  // triggers split
      if (f === 0 && t === 5000) return [makeLog(ADDR_A, ADDR_B, 1, 0)]
      if (f === 5001 && t === 10000) return smallBatch
      return []
    }
    const result = await fetchWindow({ rpc, from: 0, to: 10000 })
    // The oversized answer must be DISCARDED and replaced by the two half-window answers.
    assert.equal(result.length, 2, 'only the two half-window answers are returned')
    assert.equal(calls.length, 3, 'one full-window call, then two halves')
    assert.deepEqual(calls.slice(1), [[0, 5000], [5001, 10000]])
  })
})

describe('fetchWindow — retries on rate limit (-32005)', () => {
  it('retries after rate-limit error and succeeds', async () => {
    const expectedLogs = [makeLog(ADDR_A, ADDR_B, 5, 10)]
    let attempt = 0
    const rpc = async () => {
      attempt++
      if (attempt < 2) {
        const err = new Error('rate limit exceeded')
        err.code = -32005
        throw err
      }
      return expectedLogs
    }
    const result = await fetchWindow({ rpc, from: 0, to: 100 })
    assert.deepEqual(result, expectedLogs)
    assert.equal(attempt, 2, 'should have tried twice')
  })
})

describe('fetchWindow — same results as unsplit call', () => {
  it('splitting and not splitting produce same combined logs', async () => {
    const allLogs = [
      makeLog(ADDR_A, ADDR_B, 1, 0),
      makeLog(ADDR_C, ADDR_D, 2, 50),
      makeLog(ADDR_A, ADDR_C, 3, 99),
    ]

    // Single-call mock
    const rpcSingle = async () => allLogs
    const single = await fetchWindow({ rpc: rpcSingle, from: 0, to: 99 })

    // Split mock: first wide call throws, halves succeed
    const rpcSplit = async (method, params) => {
      const f = Number(BigInt(params[0].fromBlock))
      const t = Number(BigInt(params[0].toBlock))
      if (f === 0 && t === 99) throw new Error('too many results')
      if (f === 0 && t === 49) return allLogs.filter(l => Number(BigInt(l.blockNumber)) <= 49)
      if (f === 50 && t === 99) return allLogs.filter(l => Number(BigInt(l.blockNumber)) >= 50)
      return []
    }
    const split = await fetchWindow({ rpc: rpcSplit, from: 0, to: 99 })

    assert.equal(split.length, single.length, 'split and single should return same count')
    // Compare sorted
    const sortLogs = (arr) => [...arr].sort((a, b) =>
      Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)))
    assert.deepEqual(sortLogs(split), sortLogs(single))
  })
})

// ── runBackfill — 4-day synthetic chain ───────────────────────────────────────

// Build a 4-day synthetic chain:
//   day 0: blocks 0-1  (EPOCH_S to EPOCH_S+43200)
//   day 1: blocks 2-3
//   day 2: blocks 4-5
//   day 3: blocks 6-7  (untilDay — not a complete day)
// Each block has one Transfer log.

function buildSyntheticChain() {
  // Timestamps: block i at EPOCH_S + i*43200 (12h each)
  const blockTs = (i) => EPOCH_S + i * 43200

  // Transfers: one per block, from ADDR_A to ADDR_B, amount=1 USDC
  const logs = []
  for (let b = 0; b < 8; b++) {
    logs.push(makeLog(ADDR_A, ADDR_B, 1, b))
  }

  // rpc mock
  const rpc = async (method, params) => {
    if (method === 'eth_getBlockByNumber') {
      const bn = Number(BigInt(params[0]))
      if (bn < 0 || bn > 7) throw new Error(`block ${bn} out of range`)
      return { number: '0x' + bn.toString(16), timestamp: '0x' + blockTs(bn).toString(16) }
    }
    if (method === 'eth_getLogs') {
      const f = Number(BigInt(params[0].fromBlock))
      const t = Number(BigInt(params[0].toBlock))
      return logs.filter(l => {
        const bn = Number(BigInt(l.blockNumber))
        return bn >= f && bn <= t
      })
    }
    throw new Error(`unknown method ${method}`)
  }

  return { rpc, blockTs, logs }
}

describe('runBackfill — 4-day synthetic chain produces correct shard files', () => {
  it('shard files match feeding the same data to publish() directly', async () => {
    const { rpc } = buildSyntheticChain()
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingDir = join(dir, 'pending')

    // Run backfill: fromBlock=0, toBlock=6 (day 3 starts at block 6, so complete days are 0-2)
    const result = await runBackfill({
      rpc,
      outDir,
      pendingDir,
      fromBlock: 0,
      toBlock: 6,
      span: 5000,
      log: () => {},
      net: 'testnet',
    })

    // Should have processed days 0, 1, 2 (day 3 is untilDay, not complete)
    assert.equal(result.days, 3, `expected 3 days processed, got ${result.days}`)
    assert.ok(result.wallets > 0, 'should have found wallets')

    // Verify meta.json
    const meta = await readJson(join(outDir, 'meta.json'))
    assert.ok(meta, 'meta.json must exist')
    assert.equal(meta.through, 2, 'through must be day 2')

    // Now build reference by calling publish() directly:
    // Each day: 2 blocks (days 0-2), each block has 1 transfer from A to B with 1 USDC.
    // So per day: ADDR_A.o=2, ADDR_A.i=0; ADDR_B.i=2, ADDR_B.o=0.
    // Cross-day totals: ADDR_A.o=6 (2 per day * 3 days), ADDR_B.i=6.
    const dir2 = tmpDir()
    const outDir2 = join(dir2, 'out')
    const pendingPath2 = join(dir2, 'pending.json')

    // Build pending manually and publish all 3 days at once
    const days = {}
    for (let d = 0; d < 3; d++) {
      const addrARec = { ...emptyRecord(d), o: 2, d: '1' }
      const addrBRec = { ...emptyRecord(d), i: 2, d: '1' }
      days[String(d)] = {
        [ADDR_A]: encodeRecord(addrARec),
        [ADDR_B]: encodeRecord(addrBRec),
      }
    }
    await writeJson(pendingPath2, { version: 1, dropped: 0, days })
    await publish({ pendingPath: pendingPath2, outDir: outDir2, today: 3, net: 'testnet' })

    // Compare shard files for ADDR_A and ADDR_B
    const shardA_bf  = await readJson(join(outDir,  's', 'aaa.json'))
    const shardA_ref = await readJson(join(outDir2, 's', 'aaa.json'))
    const shardB_bf  = await readJson(join(outDir,  's', 'bbb.json'))
    const shardB_ref = await readJson(join(outDir2, 's', 'bbb.json'))

    assert.ok(shardA_bf,  'backfill shard for A must exist')
    assert.ok(shardA_ref, 'reference shard for A must exist')

    const recA_bf  = decodeShard(shardA_bf).get(ADDR_A.toLowerCase())
    const recA_ref = decodeShard(shardA_ref).get(ADDR_A.toLowerCase())
    assert.ok(recA_bf,  'ADDR_A must be in backfill shard')
    assert.ok(recA_ref, 'ADDR_A must be in reference shard')
    assert.equal(recA_bf.o, recA_ref.o, `ADDR_A.o should match: ${recA_bf.o} vs ${recA_ref.o}`)

    const recB_bf  = decodeShard(shardB_bf).get(ADDR_B.toLowerCase())
    const recB_ref = decodeShard(shardB_ref).get(ADDR_B.toLowerCase())
    assert.ok(recB_bf,  'ADDR_B must be in backfill shard')
    assert.equal(recB_bf.i, recB_ref.i, `ADDR_B.i should match`)
  })
})

// ── runBackfill — kill-and-resume ─────────────────────────────────────────────

describe('runBackfill — kill-and-resume produces same result', () => {
  it('stopping after day 1 then rerunning gives same output as uninterrupted', async () => {
    const { rpc: rpcClean } = buildSyntheticChain()
    const { rpc: rpcResume } = buildSyntheticChain()

    // Uninterrupted run
    const dirFull = tmpDir()
    await runBackfill({
      rpc: rpcClean,
      outDir: join(dirFull, 'out'),
      pendingDir: join(dirFull, 'pending'),
      fromBlock: 0, toBlock: 6, span: 5000,
      log: () => {}, net: 'testnet',
    })

    // Interrupted run: throw after processing day 1
    const dirPartial = tmpDir()
    let daysSeen = 0
    const rpcInterrupt = async (method, params) => {
      if (method === 'eth_getLogs') {
        const f = Number(BigInt(params[0].fromBlock))
        // After seeing two distinct day windows, throw (simulate kill after day 1)
        // blocks 0-1 = day 0, blocks 2-3 = day 1
        if (f >= 4 && daysSeen < 2) {
          daysSeen++
          throw new Error('simulated kill after day 1')
        }
      }
      return rpcResume(method, params)
    }

    // First partial run: will fail during day 2
    try {
      await runBackfill({
        rpc: rpcInterrupt,
        outDir: join(dirPartial, 'out'),
        pendingDir: join(dirPartial, 'pending'),
        fromBlock: 0, toBlock: 6, span: 5000,
        log: () => {}, net: 'testnet',
      })
    } catch { /* expected */ }

    // Second run (resume): should succeed
    await runBackfill({
      rpc: rpcResume,
      outDir: join(dirPartial, 'out'),
      pendingDir: join(dirPartial, 'pending'),
      fromBlock: 0, toBlock: 6, span: 5000,
      log: () => {}, net: 'testnet',
    })

    // Compare final shard files
    const shardA_full    = await readJson(join(dirFull,    'out', 's', 'aaa.json'))
    const shardA_resumed = await readJson(join(dirPartial, 'out', 's', 'aaa.json'))

    assert.ok(shardA_full,    'full run shard must exist')
    assert.ok(shardA_resumed, 'resumed run shard must exist')

    const recFull    = decodeShard(shardA_full).get(ADDR_A.toLowerCase())
    const recResumed = decodeShard(shardA_resumed).get(ADDR_A.toLowerCase())
    assert.ok(recFull,    'ADDR_A in full shard')
    assert.ok(recResumed, 'ADDR_A in resumed shard')
    assert.equal(recFull.o, recResumed.o,
      `full.o=${recFull.o} vs resumed.o=${recResumed.o}`)
    assert.equal(recFull.f, recResumed.f, 'first day must match')
    assert.equal(recFull.l, recResumed.l, 'last day must match')
  })
})

// ── blockdaemon URL refused ───────────────────────────────────────────────────

describe('blockdaemon URL refused in CLI', () => {
  it('exits 1 and prints an error message when RPC_URLS contains blockdaemon', async () => {
    const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wallets-backfill.mjs')
    let threw = false
    let stderr = ''
    try {
      await execFileAsync('node', [script, '--out', '/tmp/bd-test', '--from-block', '0', '--until-block', '100'], {
        env: {
          ...process.env,
          NET: 'testnet',
          RPC_URLS: 'https://rpc.blockdaemon.mainnet.arc.io',
        },
        encoding: 'utf8',
      })
    } catch (e) {
      threw = true
      stderr = e.stderr ?? ''
    }
    assert.ok(threw, 'CLI must exit with non-zero when blockdaemon URL is present')
    assert.ok(
      stderr.toLowerCase().includes('blockdaemon'),
      `stderr must mention blockdaemon; got: ${stderr}`
    )
  })
})

// ── runPartialDay ─────────────────────────────────────────────────────────────

describe('runPartialDay — merges into existing live pending file', () => {
  it('sums with existing days[day] records for same address', async () => {
    const dir = tmpDir()
    const pendingPath = join(dir, 'pending', 'wallets-pending.json')

    // Pre-populate pending with ADDR_A having i=5 on day 2
    const existingRec = { ...emptyRecord(2), i: 5, d: '1' }
    const existing = {
      version: 1, dropped: 0,
      days: { '2': { [ADDR_A]: encodeRecord(existingRec) } },
    }
    await writeJson(pendingPath, existing)

    // runPartialDay: one transfer A→B of 3 USDC (A.o+=3, B.i+=3)
    const logs = [makeLog(ADDR_A, ADDR_B, 3, 500)]
    const rpc = async () => logs

    const result = await runPartialDay({
      rpc,
      pendingPath,
      day: 2,
      fromBlock: 500,
      toBlock: 500,
      span: 5000,
      decimals: 6,
    })

    assert.equal(result.wallets, 2, 'should have merged 2 wallets')
    assert.equal(result.logs, 1, 'should have fetched 1 log')

    const pending = await readJson(pendingPath)
    assert.ok(pending?.days?.['2'], 'day 2 must exist in pending')

    const recA = decodeRecord(pending.days['2'][ADDR_A])
    assert.equal(recA.i, 5,  'ADDR_A.i must remain 5 (from existing)')
    assert.equal(recA.o, 3,  'ADDR_A.o must be 3 (new from partial day)')

    const recB = decodeRecord(pending.days['2'][ADDR_B])
    assert.equal(recB.i, 3,  'ADDR_B.i must be 3')
  })

  it('creates the pending file when missing', async () => {
    const dir = tmpDir()
    const pendingPath = join(dir, 'no-existing', 'wallets-pending.json')

    const logs = [makeLog(ADDR_C, ADDR_D, 7, 1000)]
    const rpc = async () => logs

    const result = await runPartialDay({
      rpc,
      pendingPath,
      day: 10,
      fromBlock: 1000,
      toBlock: 1000,
      span: 5000,
      decimals: 6,
    })

    assert.equal(result.wallets, 2)

    const pending = await readJson(pendingPath)
    assert.ok(pending?.days?.['10'], 'day 10 must exist')
    const recC = decodeRecord(pending.days['10'][ADDR_C])
    assert.equal(recC.o, 7, 'ADDR_C.o=7')
    const recD = decodeRecord(pending.days['10'][ADDR_D])
    assert.equal(recD.i, 7, 'ADDR_D.i=7')
  })
})

// ── wallet active on two days across runBackfill ──────────────────────────────

describe('runBackfill — wallet active on two days has activeDayCount 2', () => {
  it('ADDR_A active on days 0 and 1 gives activeDayCount=2 in shard', async () => {
    const { rpc } = buildSyntheticChain()
    const dir = tmpDir()

    await runBackfill({
      rpc,
      outDir: join(dir, 'out'),
      pendingDir: join(dir, 'pending'),
      fromBlock: 0,
      toBlock: 4,   // complete days 0 and 1; day 2 is untilDay
      span: 5000,
      log: () => {},
      net: 'testnet',
    })

    const shardA = await readJson(join(dir, 'out', 's', 'aaa.json'))
    assert.ok(shardA, 'shard must exist')
    const recA = decodeShard(shardA).get(ADDR_A.toLowerCase())
    assert.ok(recA, 'ADDR_A must be in shard')
    const adc = activeDayCount(recA)
    assert.equal(adc, 2, `activeDayCount should be 2, got ${adc}`)
    assert.equal(recA.f, 0, 'first day = 0')
    assert.equal(recA.l, 1, 'last day = 1')
  })
})

describe('partialDayRange — cut-over day range', () => {
  it('covers the day start up to the block before the cut', () => {
    assert.deepEqual(partialDayRange({ 283: 25323044 }, 283, 25400000), [25323044, 25399999])
  })
  it('returns null when the cut is exactly at the day start or the day is unknown', () => {
    assert.equal(partialDayRange({ 283: 25400000 }, 283, 25400000), null)
    assert.equal(partialDayRange({}, 283, 25400000), null)
  })
})
