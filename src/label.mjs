// Adds names to the busiest contracts in data/<net>/latest.json.
//
// For each address that appears in a top list and has no label yet, it asks the RPC whether the
// address is a contract (eth_getCode) and, if so, tries the ERC-20 / ERC-721 name() and symbol()
// getters. Results are cached in data/<net>/labels.json, so every address is looked up once.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NET = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const RPC = NET === 'testnet' ? 'https://rpc.testnet.arc.io' : 'https://rpc.mainnet.arc.io'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)
const MAX_NEW = 120 // new addresses labelled per run, keeps the run short

// Well-known singletons that exist at the same address on every EVM chain.
const KNOWN = {
  '0x000000000022d473030f116ddee9f6b43ac78ba3': { name: 'Permit2', kind: 'infra' },
  '0x0000000071727de22e5e9d8baf0edac6f37da032': { name: 'ERC-4337 EntryPoint v0.7', kind: 'account-abstraction' },
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789': { name: 'ERC-4337 EntryPoint v0.6', kind: 'account-abstraction' },
  '0xca11bde05977b3631167028862be2a173976ca11': { name: 'Multicall3', kind: 'infra' },
  '0x3600000000000000000000000000000000000000': { name: 'USDC', kind: 'token' },
}

const NAME = '0x06fdde03'
const SYMBOL = '0x95d89b41'

async function rpc(calls) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls) })
      const out = await res.json()
      if (Array.isArray(out) && !out.some((r) => r.error?.message === 'rate limit exceeded')) return out.sort((a, b) => a.id - b.id)
    } catch (e) { if (attempt === 7) console.error(String(e)) }
    await new Promise((r) => setTimeout(r, 700 * 1.8 ** attempt))
  }
  throw new Error('rpc failed')
}

/** Decodes an ABI-encoded string return value; returns null for anything that is not one. */
function decodeString(hex) {
  if (!hex || hex === '0x' || hex.length < 130) return null
  try {
    const bytes = Buffer.from(hex.slice(2), 'hex')
    const offset = Number(BigInt('0x' + bytes.subarray(0, 32).toString('hex')))
    const len = Number(BigInt('0x' + bytes.subarray(offset, offset + 32).toString('hex')))
    if (len === 0 || len > 80) return null
    const s = bytes.subarray(offset + 32, offset + 32 + len).toString('utf8')
    return /^[\x20-\x7e -￿]+$/.test(s) ? s.trim() : null
  } catch { return null }
}

const readJson = async (p, f) => { try { return JSON.parse(await readFile(p, 'utf8')) } catch { return f } }

const latest = await readJson(join(ROOT, 'latest.json'), null)
if (!latest) { console.log('no latest.json yet'); process.exit(0) }
const labels = await readJson(join(ROOT, 'labels.json'), {})
for (const [a, k] of Object.entries(KNOWN)) labels[a] = { contract: true, name: k.name, symbol: null, kind: k.kind }

const wanted = new Set()
for (const w of Object.values(latest.windows)) for (const c of w.top.slice(0, 40)) if (!(c.address in labels)) wanted.add(c.address)
const todo = [...wanted].slice(0, MAX_NEW)

for (let i = 0; i < todo.length; i += 4) {
  const chunk = todo.slice(i, i + 4)
  const calls = []
  chunk.forEach((a, j) => {
    calls.push({ jsonrpc: '2.0', id: j * 3, method: 'eth_getCode', params: [a, 'latest'] })
    calls.push({ jsonrpc: '2.0', id: j * 3 + 1, method: 'eth_call', params: [{ to: a, data: NAME }, 'latest'] })
    calls.push({ jsonrpc: '2.0', id: j * 3 + 2, method: 'eth_call', params: [{ to: a, data: SYMBOL }, 'latest'] })
  })
  const out = await rpc(calls)
  await new Promise((r) => setTimeout(r, 400))
  chunk.forEach((a, j) => {
    const isContract = (out[j * 3].result ?? '0x') !== '0x'
    labels[a] = {
      contract: isContract,
      name: isContract ? decodeString(out[j * 3 + 1].result) : null,
      symbol: isContract ? decodeString(out[j * 3 + 2].result) : null,
    }
  })
}

await writeFile(join(ROOT, 'labels.json'), JSON.stringify(labels))
const named = Object.values(labels).filter((l) => l.name).length
console.log(`${NET}: ${todo.length} new, ${named}/${Object.keys(labels).length} named`)
