// Tests for src/wallets-publish.mjs — T4b.
// Run: node --test pulsarc-indexer/test/wallets-publish.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile, rename, mkdir, stat, cp, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

import { publish } from '../src/wallets-publish.mjs'
import { encodeRecord, decodeRecord, decodeShard, shardOf, emptyRecord } from '../src/wallets.mjs'

// ── Helpers ───────────────────────────────────────────────────────────────────

const NET = 'testnet'

/** Create a temp directory and return its path. */
function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'wp-test-'))
}

/**
 * Build a pending file object with the given day → address → record map.
 *
 * @param {Object.<number, Object.<string, number[]>>} dayMap  day → addr → encoded array
 */
function makePending(dayMap, dropped = 0) {
  const days = {}
  for (const [day, addrs] of Object.entries(dayMap)) {
    days[String(day)] = addrs
  }
  return { version: 1, dropped, days }
}

/** Write a JSON file (atomic temp + rename). */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(value))
  await rename(tmp, path)
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

/** Make an encoded wallet record with given t (tx count). */
function enc(day, t = 1) {
  return encodeRecord({ ...emptyRecord(day), t, x: 0, e: 0, o: 0, i: 0, a: '0', d: '1', bo: 0, bi: 0 })
}

// Fixed test addresses (40 hex chars after 0x)
const ADDR_A = '0x' + 'a'.repeat(40)
const ADDR_B = '0x' + 'b'.repeat(40)
const ADDR_C = '0x' + 'c'.repeat(40)

// Shard keys for the test addresses
const SHARD_A = shardOf(ADDR_A)  // 'aaa'
const SHARD_B = shardOf(ADDR_B)  // 'bbb'
const SHARD_C = shardOf(ADDR_C)  // 'ccc'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('publish — basic closed-day merge', () => {
  it('closed days merged and today left in pending', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    // today = 10; days 8 and 9 are closed; day 10 is open (today)
    const pending = makePending({
      8:  { [ADDR_A]: enc(8, 5) },
      9:  { [ADDR_B]: enc(9, 3) },
      10: { [ADDR_C]: enc(10, 1) },
    })
    await writeJson(pendingPath, pending)

    const result = await publish({ pendingPath, outDir, today: 10, net: NET })
    assert.deepEqual(result.publishedDays, [8, 9])
    assert.ok(result.touchedShards >= 2, 'at least 2 shards touched (one per distinct address)')
    assert.equal(result.newWallets, 2, '2 new wallets added')
    assert.equal(result.throughDay, 9)

    // today (day 10) must still be in pending
    const newPending = await readJson(pendingPath)
    assert.ok(newPending?.days?.['10'], 'day 10 must remain in pending')
    assert.ok(!newPending?.days?.['8'], 'day 8 must be removed from pending')
    assert.ok(!newPending?.days?.['9'], 'day 9 must be removed from pending')
  })
})

describe('publish — second run is a no-op', () => {
  it('running publish twice gives same result; second call returns publishedDays=[]', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    const pending = makePending({ 5: { [ADDR_A]: enc(5, 2) } })
    await writeJson(pendingPath, pending)

    const r1 = await publish({ pendingPath, outDir, today: 6, net: NET })
    assert.deepEqual(r1.publishedDays, [5])
    assert.equal(r1.newWallets, 1)

    // second run: day 5 was removed from pending after first publish, so nothing to do
    const r2 = await publish({ pendingPath, outDir, today: 6, net: NET })
    assert.deepEqual(r2.publishedDays, [], 'second run must return empty publishedDays')
    assert.equal(r2.newWallets, 0)

    // meta.through must still be 5
    const meta = await readJson(join(outDir, 'meta.json'))
    assert.equal(meta.through, 5)
  })
})

describe('publish — two days touching the same wallet are summed', () => {
  it('records from two closed days accumulate into one shard record', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    // ADDR_A appears in both day 3 (t=4) and day 4 (t=6); total should be t=10
    const pending = makePending({
      3: { [ADDR_A]: enc(3, 4) },
      4: { [ADDR_A]: enc(4, 6) },
    })
    await writeJson(pendingPath, pending)

    const result = await publish({ pendingPath, outDir, today: 5, net: NET })
    assert.deepEqual(result.publishedDays, [3, 4])
    // ADDR_A appears in both days; it was NEW on day 3 (1 new wallet total).
    assert.equal(result.newWallets, 1)

    // Decode the shard for ADDR_A and check t=10
    const shardPath = join(outDir, 's', `${SHARD_A}.json`)
    const shardObj = await readJson(shardPath)
    assert.ok(shardObj, 'shard must exist')
    const shardMap = decodeShard(shardObj)
    const rec = shardMap.get(ADDR_A.toLowerCase())
    assert.ok(rec, 'ADDR_A must be in the shard')
    assert.equal(rec.t, 10, `t should be 10 (4+6), got ${rec.t}`)
  })
})

describe('publish — only touched shard files change', () => {
  it('mtimes of untouched shards do not change', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    await mkdir(join(outDir, 's'), { recursive: true })
    const pendingPath = join(dir, 'wallets-pending.json')

    // Pre-populate an untouched shard for SHARD_C with a dummy record
    const untouchedShardPath = join(outDir, 's', `${SHARD_C}.json`)
    await writeJson(untouchedShardPath, { [ADDR_C.toLowerCase()]: enc(1, 1) })
    const mtimeBefore = (await stat(untouchedShardPath)).mtimeMs

    // Add ADDR_A to day 7 (different shard from C)
    const pending = makePending({ 7: { [ADDR_A]: enc(7, 1) } })
    await writeJson(pendingPath, pending)

    // Sleep briefly so timestamps can differ
    await new Promise((r) => setTimeout(r, 20))

    await publish({ pendingPath, outDir, today: 8, net: NET })

    const mtimeAfter = (await stat(untouchedShardPath)).mtimeMs
    assert.equal(mtimeBefore, mtimeAfter, 'untouched shard mtime must not change')
  })
})

describe('publish — meta since/through/gaps/walletCount', () => {
  it('days skipped between two separate publishes are recorded as gaps', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    await writeJson(pendingPath, makePending({ 10: { [ADDR_A]: enc(10, 1) } }))
    await publish({ pendingPath, outDir, today: 11, net: NET })

    // The indexer was down for days 11 and 12; day 13 arrives later.
    await writeJson(pendingPath, makePending({ 13: { [ADDR_B]: enc(13, 1) } }))
    const result = await publish({ pendingPath, outDir, today: 14, net: NET })

    assert.deepEqual(result.publishedDays, [13])
    const meta = await readJson(join(outDir, 'meta.json'))
    assert.deepEqual(meta.gaps, [11, 12])
    assert.equal(meta.through, 13)
    assert.equal(meta.since, 10)
  })

  it('3-day example with missing middle day gives correct meta', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    // Days 10, 12 are present; day 11 is missing (gap).
    // Day 13 is "today" (open, not published).
    const pending = makePending({
      10: { [ADDR_A]: enc(10, 1) },
      12: { [ADDR_B]: enc(12, 1) },
      13: { [ADDR_C]: enc(13, 1) },
    })
    await writeJson(pendingPath, pending)

    const result = await publish({ pendingPath, outDir, today: 13, net: NET })
    assert.deepEqual(result.publishedDays, [10, 12])
    assert.equal(result.newWallets, 2)
    assert.equal(result.throughDay, 12)

    const meta = await readJson(join(outDir, 'meta.json'))
    assert.equal(meta.since, 10, 'since = first published day')
    assert.equal(meta.through, 12, 'through = last published day')
    assert.deepEqual(meta.gaps, [11], 'gap day 11 must be recorded')
    assert.equal(meta.walletCount, 2, '2 distinct wallets published')
    assert.equal(meta.network, NET)
  })
})

describe('publish — corrupt pending file', () => {
  it('returns error and does not touch outDir', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    await writeFile(pendingPath, 'NOT VALID JSON{{{')

    const result = await publish({ pendingPath, outDir, today: 5, net: NET })
    assert.equal(result.error, 'corrupt pending')
    assert.deepEqual(result.publishedDays, [])
    // outDir must not have been created
    assert.ok(!existsSync(join(outDir, 'meta.json')), 'meta.json must not be created on corrupt pending')
  })
})

function existsSync(p) { try { statSync(p); return true } catch { return false } }

describe('publish — version mismatch in pending', () => {
  it('returns error for wrong version', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    await writeJson(pendingPath, { version: 99, dropped: 0, days: {} })

    const result = await publish({ pendingPath, outDir, today: 5, net: NET })
    assert.equal(result.error, 'corrupt pending')
  })
})

describe('publish — missing pending file is a no-op', () => {
  it('returns empty publishedDays without error when file is absent', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'no-such-file.json')

    const result = await publish({ pendingPath, outDir, today: 5, net: NET })
    assert.deepEqual(result.publishedDays, [], 'missing file returns empty')
    assert.ok(!result.error, 'missing file must not set error')
  })
})

describe('publish — day <= through is skipped even if still in pending', () => {
  it('a day already in meta.through is not re-merged', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    // Simulate a previous publish that set through=5
    await writeJson(join(outDir, 'meta.json'), {
      network: NET, version: 1, since: 5, through: 5,
      gaps: [], walletCount: 1, updatedAt: new Date().toISOString(),
    })
    await mkdir(join(outDir, 's'), { recursive: true })

    // Write a shard for ADDR_A with t=10 (already published for day 5)
    await writeJson(join(outDir, 's', `${SHARD_A}.json`), { [ADDR_A.toLowerCase()]: enc(5, 10) })

    // Pending still contains day 5 (simulating a crash before cleanup) + day 6 (new)
    const pending = makePending({
      5: { [ADDR_A]: enc(5, 10) },  // should be skipped
      6: { [ADDR_B]: enc(6, 3) },   // should be published
    })
    await writeJson(pendingPath, pending)

    const result = await publish({ pendingPath, outDir, today: 7, net: NET })
    assert.deepEqual(result.publishedDays, [6], 'only day 6 should be published; day 5 was already through')
    assert.equal(result.newWallets, 1, 'only ADDR_B is new')

    // ADDR_A's record must NOT be doubled (t must still be 10)
    const shardObj = await readJson(join(outDir, 's', `${SHARD_A}.json`))
    const rec = decodeShard(shardObj).get(ADDR_A.toLowerCase())
    assert.equal(rec.t, 10, `ADDR_A t must remain 10, not be doubled`)
  })
})

describe('publish — shard file content decodes correctly', () => {
  it('decoded record matches original encoded record', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    const originalRec = { ...emptyRecord(20), t: 7, x: 1, e: 0.000021, o: 50.5, i: 30.25, a: '3', d: '201', bo: 2, bi: 1 }
    const encoded = encodeRecord(originalRec)

    const pending = makePending({ 20: { [ADDR_A]: encoded } })
    await writeJson(pendingPath, pending)

    await publish({ pendingPath, outDir, today: 21, net: NET })

    const shardPath = join(outDir, 's', `${SHARD_A}.json`)
    const shardObj = await readJson(shardPath)
    const rec = decodeShard(shardObj).get(ADDR_A.toLowerCase())

    assert.ok(rec, 'record must be in shard')
    assert.equal(rec.t, originalRec.t)
    assert.equal(rec.x, originalRec.x)
    assert.equal(rec.o, originalRec.o)
    assert.equal(rec.i, originalRec.i)
    assert.equal(rec.a, originalRec.a)
    assert.equal(rec.d, originalRec.d)
    assert.equal(rec.bo, originalRec.bo)
    assert.equal(rec.bi, originalRec.bi)
    assert.equal(rec.f, originalRec.f)
    assert.equal(rec.l, originalRec.l)
  })
})

describe('publish — walletCount increments across calls', () => {
  it('walletCount in meta is maintained exactly across two publish calls', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const pendingPath = join(dir, 'wallets-pending.json')

    // First publish: day 1 with 2 wallets
    await writeJson(pendingPath, makePending({ 1: { [ADDR_A]: enc(1), [ADDR_B]: enc(1) } }))
    await publish({ pendingPath, outDir, today: 2, net: NET })

    let meta = await readJson(join(outDir, 'meta.json'))
    assert.equal(meta.walletCount, 2, 'after first publish')

    // Second publish: day 2 with 1 new + 1 existing wallet
    await writeJson(pendingPath, makePending({ 2: { [ADDR_A]: enc(2), [ADDR_C]: enc(2) } }))
    await publish({ pendingPath, outDir, today: 3, net: NET })

    meta = await readJson(join(outDir, 'meta.json'))
    assert.equal(meta.walletCount, 3, 'after second publish: 2 + 1 new = 3')
  })
})

describe('publish CLI — smoke test via execFile', () => {
  it('exits 0 on nothing to do, prints summary line', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const publishScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wallets-publish.mjs')

    // Point to a non-existent pending file → nothing to do
    const pendingPath = join(dir, 'no-such-pending.json')

    let stdout = '', stderr = ''
    try {
      const result = await execFileAsync('node', [publishScript, outDir], {
        env: { ...process.env, NET: 'testnet', WALLET_PENDING_PATH: pendingPath },
        encoding: 'utf8',
      })
      stdout = result.stdout; stderr = result.stderr
    } catch (e) {
      // CLI exits 0 even on "nothing to do"; only exits 1 on thrown errors
      assert.fail(`CLI exited with error: ${e.message} stderr=${e.stderr}`)
    }
    // Must print some summary line (stdout or stderr)
    const combined = stdout + stderr
    assert.ok(combined.length > 0, 'CLI must print at least one line')
  })

  it('exits 0 and prints published summary when there is work to do', async () => {
    const dir = tmpDir()
    const outDir = join(dir, 'out')
    const net = 'testnet'
    const pendingDir = join(dir, 'data', net)
    await mkdir(pendingDir, { recursive: true })
    const pendingPath = join(pendingDir, 'wallets-pending.json')

    // The CLI computes today = dayOf(Date.now()/1000), which is >>0 (2026+),
    // so day 0 will be treated as a closed day and published.
    const pending = makePending({ 0: { [ADDR_A]: enc(0, 1) } })
    await writeJson(pendingPath, pending)

    const publishScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wallets-publish.mjs')
    let stdout = '', stderr = ''
    try {
      const result = await execFileAsync('node', [publishScript, outDir], {
        env: { ...process.env, NET: net, WALLET_PENDING_PATH: pendingPath },
        encoding: 'utf8',
      })
      stdout = result.stdout; stderr = result.stderr
    } catch (e) {
      assert.fail(`CLI exited with error: ${e.stderr ?? e.message}`)
    }
    const combined = stdout + stderr
    assert.ok(combined.includes('wallets-publish:'), `expected summary line, got: ${combined}`)
  })
})
