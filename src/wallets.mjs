// Pure wallet-index core for the Pulsarc indexer.
//
// No top-level await, no I/O, no dependencies.
// Imported by run.mjs (later task); tested by test/wallets.test.mjs.

import {
  USDC,
  TRANSFER_TOPIC,
  TOKEN_MESSENGER_V2,
  MESSAGE_TRANSMITTER_V2,
  DEPOSIT_FOR_BURN_TOPIC,
  MESSAGE_RECEIVED_TOPIC,
} from './counters.mjs'

// ── Constants ────────────────────────────────────────────────────────────────

/** Epoch for dayOf(): 2026-01-01T00:00:00Z in Unix seconds. */
export const EPOCH_S = 1767225600   // Date.UTC(2026, 0, 1) / 1000

const ZERO = '0x' + '0'.repeat(40)
const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/

// ── 1. shardOf ────────────────────────────────────────────────────────────────

/**
 * Return the 3-hex-char shard key for an address.
 * '0xAbC123...' → 'abc'
 * Throws on invalid input.
 *
 * @param {string} address
 * @returns {string}  three lowercase hex chars
 */
export function shardOf(address) {
  if (typeof address !== 'string' || !HEX_ADDR_RE.test(address)) {
    throw new Error(`Invalid address: ${address}`)
  }
  return address.slice(2, 5).toLowerCase()
}

// ── 2. dayOf ─────────────────────────────────────────────────────────────────

/**
 * Whole days since 2026-01-01T00:00:00Z (day 0).
 *
 * @param {number} timestampSeconds  Unix timestamp in seconds
 * @returns {number}  non-negative integer
 */
export function dayOf(timestampSeconds) {
  return Math.floor((timestampSeconds - EPOCH_S) / 86400)
}

// ── 3. emptyRecord ───────────────────────────────────────────────────────────

/**
 * Create an empty wallet record for a wallet first seen on `day`.
 *
 * @param {number} day  result of dayOf()
 * @returns {object}
 */
export function emptyRecord(day) {
  return {
    f: day,   // firstDay
    l: day,   // lastDay
    d: '0',   // active-days bit array (hex string; bit i = active on day f+i)
    t: 0,     // tx sent
    x: 0,     // failed tx sent
    e: 0,     // fees paid in USDC
    o: 0,     // USDC sent
    i: 0,     // USDC received
    a: '0',   // apps mask (hex string; bit k = app at index k)
    bo: 0,    // bridge-out count
    bi: 0,    // bridge-in count
  }
}

// ── Bit-array helpers ─────────────────────────────────────────────────────────

/**
 * Set bit `bitIndex` in a hex-string bit array, returning a new string.
 * Bit 0 = LSB of the number (i.e. the rightmost bit).
 * No leading-zero padding beyond what is needed.
 *
 * @param {string} hex    Current hex string (e.g. '0' or '1a')
 * @param {number} bitIndex  Non-negative integer
 * @returns {string}
 */
function setBit(hex, bitIndex) {
  const n = BigInt('0x' + (hex || '0')) | (1n << BigInt(bitIndex))
  return n.toString(16)
}

/**
 * OR two hex-string bit arrays aligned on the same origin.
 * `shift` aligns b: if b's f > a's f, shift = b.f - a.f (shift b's bits right so they
 * align with a's origin); if a's f > b's f they should already have been swapped by the
 * caller so that a has the earlier f.
 *
 * @param {string} hexA  bit array whose origin is the smaller f
 * @param {string} hexB  bit array whose origin is shiftB days later
 * @param {number} shiftB  >= 0
 * @returns {string}
 */
function orBits(hexA, hexB, shiftB) {
  const a = BigInt('0x' + (hexA || '0'))
  const b = BigInt('0x' + (hexB || '0'))
  return (a | (b << BigInt(shiftB))).toString(16)
}

/**
 * Count set bits in a hex string.
 *
 * @param {string} hex
 * @returns {number}
 */
function popCount(hex) {
  let n = BigInt('0x' + (hex || '0'))
  let count = 0
  while (n > 0n) { count += Number(n & 1n); n >>= 1n }
  return count
}

// ── 4. buildAppIndex ─────────────────────────────────────────────────────────

/**
 * Build a Map from lowercase anchor address to app index (position in appsConfig.apps).
 * Apps beyond index 63 are excluded (64-bit mask limit).
 *
 * @param {object} appsConfig  { apps: [{ id, anchors: [{ address, kind }] }] }
 * @returns {Map<string, number>}
 */
export function buildAppIndex(appsConfig) {
  const map = new Map()
  if (!appsConfig?.apps?.length) return map
  for (let k = 0; k < appsConfig.apps.length && k < 64; k++) {
    for (const anchor of appsConfig.apps[k].anchors ?? []) {
      const addr = anchor.address.toLowerCase()
      if (!map.has(addr)) map.set(addr, k)  // first appearance wins
    }
  }
  return map
}

// ── 5. bridgeAddrs ───────────────────────────────────────────────────────────

/**
 * Return bridge contract addresses for the given network.
 * Exported so tests can choose either network without relying on process.env.NET.
 *
 * @param {'testnet'|'mainnet'} net
 * @returns {{ tokenMessenger: string, messageTransmitter: string }}
 */
export function bridgeAddrs(net) {
  const n = net === 'mainnet' ? 'mainnet' : 'testnet'
  return {
    tokenMessenger:    TOKEN_MESSENGER_V2[n].toLowerCase(),
    messageTransmitter: MESSAGE_TRANSMITTER_V2[n].toLowerCase(),
  }
}

// ── 6. walletDeltas ──────────────────────────────────────────────────────────

/**
 * Compute per-wallet deltas from one block's receipts.
 *
 * @param {object[]} receipts  eth_getBlockReceipts output
 * @param {{ day: number, usdcDecimals: number, appIndex: Map<string,number>, net?: string }} ctx
 * @returns {Map<string, object>}  lowercase address → delta record
 */
export function walletDeltas(receipts, ctx) {
  const { day, usdcDecimals, appIndex } = ctx
  const net = ctx.net ?? process.env.NET ?? 'testnet'
  const { tokenMessenger, messageTransmitter } = bridgeAddrs(net)

  const deltas = new Map()   // lowercase addr → live record (sums for this block)

  function getDelta(addr) {
    const key = addr.toLowerCase()
    if (!deltas.has(key)) {
      const r = emptyRecord(day)
      r._dBits = 0n     // raw BigInt accumulator for d (bit 0 = day-f=0 always, since f=l=day)
      r._aBits = 0n     // raw BigInt accumulator for a
      deltas.set(key, r)
    }
    return deltas.get(key)
  }

  function markActive(addr) {
    const r = getDelta(addr)
    r._dBits |= 1n           // always bit 0 (only one day per block)
  }

  function addAppBit(addr, appIdx) {
    if (appIdx < 0 || appIdx >= 64) return
    const r = getDelta(addr)
    r._aBits |= (1n << BigInt(appIdx))
  }

  for (const receipt of receipts) {
    const from = receipt.from?.toLowerCase()
    if (!from) continue

    const status  = receipt.status
    const gasUsed = receipt.gasUsed
    const price   = receipt.effectiveGasPrice
    const fee     = (gasUsed && price)
      ? Number(BigInt(gasUsed) * BigInt(price)) / 1e18
      : 0

    // ── sender delta ────────────────────────────────────────────────────────
    const sender = getDelta(from)
    sender.t++
    if (status !== '0x1') sender.x++
    sender.e = +(sender.e + fee).toFixed(6)
    markActive(from)

    // App bits from receipt.to
    if (receipt.to) {
      const toAddr = receipt.to.toLowerCase()
      const toIdx  = appIndex.get(toAddr)
      if (toIdx !== undefined) addAppBit(from, toIdx)
    }

    // Failed transactions have no useful logs
    if (status !== '0x1') continue

    const logs = receipt.logs ?? []

    // App bits from log emitters
    for (const log of logs) {
      if (!log.address) continue
      const logAddr = log.address.toLowerCase()
      const logIdx  = appIndex.get(logAddr)
      if (logIdx !== undefined) addAppBit(from, logIdx)
    }

    // ── USDC Transfer logs ───────────────────────────────────────────────────
    for (const log of logs) {
      if (!log.topics || log.topics.length !== 3) continue
      if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue
      if (!log.address || log.address.toLowerCase() !== USDC) continue

      const fromAddr = ('0x' + log.topics[1].slice(-40)).toLowerCase()
      const toAddr   = ('0x' + log.topics[2].slice(-40)).toLowerCase()

      let amount
      try { amount = Number(BigInt(log.data)) / 10 ** usdcDecimals } catch { continue }

      if (fromAddr !== ZERO) {
        const r = getDelta(fromAddr)
        r.o = +(r.o + amount).toFixed(6)
        markActive(fromAddr)
      }
      if (toAddr !== ZERO) {
        const r = getDelta(toAddr)
        r.i = +(r.i + amount).toFixed(6)
        markActive(toAddr)
      }
    }

    // ── Bridge-out: DepositForBurn from TOKEN_MESSENGER_V2 ─────────────────
    for (const log of logs) {
      if (!log.address || log.address.toLowerCase() !== tokenMessenger) continue
      if (!log.topics?.length) continue
      if (log.topics[0].toLowerCase() !== DEPOSIT_FOR_BURN_TOPIC) continue

      // depositor = topics[2] last 40 chars (indexed param: depositor address)
      if (!log.topics[2]) continue
      const depositor = ('0x' + log.topics[2].slice(-40)).toLowerCase()
      if (depositor === ZERO) continue
      const r = getDelta(depositor)
      r.bo++
      markActive(depositor)
    }

    // ── Bridge-in: MessageReceived from MESSAGE_TRANSMITTER_V2 ─────────────
    //   If this receipt has a MessageReceived log from the transmitter,
    //   every USDC Transfer in the same receipt where from==zero address
    //   gives bi+1 to the `to` wallet (it's a CCTP mint).
    const hasMessageReceived = logs.some(
      (l) => l.address?.toLowerCase() === messageTransmitter &&
             l.topics?.[0]?.toLowerCase() === MESSAGE_RECEIVED_TOPIC
    )
    if (hasMessageReceived) {
      for (const log of logs) {
        if (!log.topics || log.topics.length !== 3) continue
        if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue
        if (!log.address || log.address.toLowerCase() !== USDC) continue
        const fromAddr = ('0x' + log.topics[1].slice(-40)).toLowerCase()
        if (fromAddr !== ZERO) continue
        const toAddr = ('0x' + log.topics[2].slice(-40)).toLowerCase()
        if (toAddr === ZERO) continue
        const r = getDelta(toAddr)
        r.bi++
        markActive(toAddr)
      }
    }
  }

  // Finalise: convert BigInt accumulators to hex strings, delete private fields
  for (const [, r] of deltas) {
    r.d = r._dBits ? r._dBits.toString(16) : '0'
    r.a = r._aBits ? r._aBits.toString(16) : '0'
    delete r._dBits
    delete r._aBits
  }

  return deltas
}

// ── 7. mergeRecords ──────────────────────────────────────────────────────────

/**
 * Pure merge of two wallet records.  Does NOT mutate either input.
 *
 * @param {object} a  existing record
 * @param {object} b  delta record
 * @returns {object}  merged record
 */
export function mergeRecords(a, b) {
  const newF = Math.min(a.f, b.f)
  const newL = Math.max(a.l, b.l)

  // Align bit arrays on newF; the one with the larger f must be shifted right
  // (its bit 0 corresponds to a later day, so we shift it left by the offset
  // relative to the new origin newF to align bit positions).
  const shiftA = a.f - newF   // >= 0 because newF <= a.f
  const shiftB = b.f - newF   // >= 0 because newF <= b.f
  const dA = BigInt('0x' + (a.d || '0'))
  const dB = BigInt('0x' + (b.d || '0'))
  const dMerged = ((dA << BigInt(shiftA)) | (dB << BigInt(shiftB))).toString(16)

  // App masks: simple OR (both are absolute bit positions)
  const aA = BigInt('0x' + (a.a || '0'))
  const aB = BigInt('0x' + (b.a || '0'))
  const aMerged = (aA | aB).toString(16)

  return {
    f: newF,
    l: newL,
    d: dMerged,
    t:  a.t  + b.t,
    x:  a.x  + b.x,
    e:  +((a.e  + b.e ).toFixed(6)),
    o:  +((a.o  + b.o ).toFixed(6)),
    i:  +((a.i  + b.i ).toFixed(6)),
    a:  aMerged,
    bo: a.bo + b.bo,
    bi: a.bi + b.bi,
  }
}

/**
 * Merge `delta` into the Map `map` at `addr`.
 * If no existing record, the delta becomes the initial record.
 *
 * @param {Map<string,object>} map
 * @param {string}             addr  lowercase address
 * @param {object}             delta  delta record
 */
export function mergeInto(map, addr, delta) {
  const key = addr.toLowerCase()
  if (map.has(key)) {
    map.set(key, mergeRecords(map.get(key), delta))
  } else {
    map.set(key, { ...delta })
  }
}

// ── 8. encode / decode ───────────────────────────────────────────────────────

const KEYS = ['f', 'l', 'd', 't', 'x', 'e', 'o', 'i', 'a', 'bo', 'bi']

/**
 * Encode a record to a compact array [f,l,d,t,x,e,o,i,a,bo,bi].
 *
 * @param {object} rec
 * @returns {Array}
 */
export function encodeRecord(rec) {
  return KEYS.map((k) => rec[k] ?? (k === 'd' || k === 'a' ? '0' : 0))
}

/**
 * Decode an array back to a record.
 *
 * @param {Array} arr
 * @returns {object}
 */
export function decodeRecord(arr) {
  const rec = {}
  for (let i = 0; i < KEYS.length; i++) rec[KEYS[i]] = arr[i]
  return rec
}

/**
 * Encode a Map<address, record> to a plain object sorted by address.
 *
 * @param {Map<string,object>} map
 * @returns {object}  { "<addr>": array }
 */
export function encodeShard(map) {
  const out = {}
  for (const [addr] of [...map].sort(([a], [b]) => a < b ? -1 : 1)) {
    out[addr] = encodeRecord(map.get(addr))
  }
  return out
}

/**
 * Decode a shard object back to a Map.
 *
 * @param {object} obj  { "<addr>": array }
 * @returns {Map<string,object>}
 */
export function decodeShard(obj) {
  const map = new Map()
  for (const [addr, arr] of Object.entries(obj ?? {})) {
    map.set(addr, decodeRecord(arr))
  }
  return map
}

// ── 9. activeDayCount / ageDays / appsOf ─────────────────────────────────────

/**
 * Count the number of active days recorded in `rec.d`.
 *
 * @param {object} rec
 * @returns {number}
 */
export function activeDayCount(rec) {
  return popCount(rec.d || '0')
}

/**
 * Number of days from first seen to today.
 *
 * @param {object} rec
 * @param {number} today  dayOf(Date.now() / 1000)
 * @returns {number}
 */
export function ageDays(rec, today) {
  return today - rec.f
}

/**
 * List app ids from the apps mask.
 *
 * @param {object} rec
 * @param {object} appsConfig  { apps: [{ id, anchors }] }
 * @returns {string[]}
 */
export function appsOf(rec, appsConfig) {
  if (!appsConfig?.apps?.length) return []
  const mask = BigInt('0x' + (rec.a || '0'))
  const ids  = []
  for (let k = 0; k < appsConfig.apps.length && k < 64; k++) {
    if ((mask >> BigInt(k)) & 1n) ids.push(appsConfig.apps[k].id)
  }
  return ids
}
