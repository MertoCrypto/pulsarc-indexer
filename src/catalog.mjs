// Generates data/<net>/catalog.json — a catalogue of ERC-20 tokens and NFTs
// discovered on the chain, classified via eth_call probes.
//
// Usage: NET=mainnet node src/catalog.mjs
//
// Each run probes at most MAX_PER_RUN addresses that have not been tried before
// (addresses already recorded in catalog.json's `probed` map are skipped).
// App-token addresses (kind==='token' anchors from apps.<NET>.json) are ALWAYS
// probed on every run regardless of whether they were probed before — this keeps
// their totalSupply current.
// The `probed` map persists every attempted address (including ones that came
// back as 'other') so they are never re-probed on subsequent runs.
//
// Follows the same RPC pattern as label.mjs: batch requests, 10-address chunks,
// exponential back-off on rate-limit (-32005) errors.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join }              from 'node:path'
import { fileURLToPath }              from 'node:url'
import { candidateAddresses, mergeCatalog, decodeBool } from './catalogCore.mjs'
import { decodeString }               from './labelCore.mjs'

// ── Config ────────────────────────────────────────────────────────────────────

const NET  = process.env.NET === 'testnet' ? 'testnet' : 'mainnet'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', NET)

const NETWORKS = {
  mainnet: {
    rpc:       'https://rpc.mainnet.arc.io',
    fallbacks: ['https://rpc.blockdaemon.mainnet.arc.io', 'https://rpc.drpc.mainnet.arc.io'],
  },
  testnet: {
    rpc:       'https://rpc.testnet.arc.io',
    fallbacks: ['https://rpc.blockdaemon.testnet.arc.io', 'https://rpc.drpc.testnet.arc.io'],
  },
}

function buildEndpoints() {
  if (process.env.RPC_URLS) return process.env.RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean)
  if (process.env.RPC_URL)  return [process.env.RPC_URL]
  return [NETWORKS[NET].rpc, ...NETWORKS[NET].fallbacks]
}

const ENDPOINTS      = buildEndpoints()
const MAX_PER_RUN    = 400  // max NEW (unprobed) addresses to probe in one run
const CHUNK_SIZE     = 10   // addresses per batch RPC call
const REQUEST_TIMEOUT_MS = 15_000

// ── eth_call selectors ────────────────────────────────────────────────────────

const SEL_NAME         = '0x06fdde03'
const SEL_SYMBOL       = '0x95d89b41'
const SEL_DECIMALS     = '0x313ce567'
const SEL_TOTAL_SUPPLY = '0x18160ddd'

// supportsInterface(bytes4): selector 0x01ffc9a7
// ABI encoding of bytes4 argument: left-aligned, right-padded to 32 bytes.
//   ERC-721  interfaceId: 0x80ac58cd  → 80ac58cd + 28 zero bytes
//   ERC-1155 interfaceId: 0xd9b67a26  → d9b67a26 + 28 zero bytes
const SEL_SUPPORTS = '0x01ffc9a7'
const ARG_ERC721   = '80ac58cd' + '00'.repeat(28)   // bytes4 right-padded to 32 bytes
const ARG_ERC1155  = 'd9b67a26' + '00'.repeat(28)

const DATA_IS721   = SEL_SUPPORTS + ARG_ERC721
const DATA_IS1155  = SEL_SUPPORTS + ARG_ERC1155

// ── RPC helper ────────────────────────────────────────────────────────────────

/**
 * Send a JSON-RPC batch. Retries on rate-limit errors (-32005) and HTTP 429/5xx
 * with exponential back-off. Returns the response array sorted by id.
 *
 * @param {object[]} calls
 * @returns {Promise<object[]>}
 */
async function rpc(calls) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length]
    try {
      const res = await fetch(ep, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(calls),
        signal:  AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const out = await res.json()
      if (!Array.isArray(out)) throw new Error('non-array response')
      // Retry if any call hit a rate-limit error
      if (out.some((r) => r.error?.code === -32005 || r.error?.message === 'rate limit exceeded')) {
        throw new Error('rate limit')
      }
      return out.sort((a, b) => a.id - b.id)
    } catch (e) {
      if (attempt === 7) throw e
    }
    await new Promise((r) => setTimeout(r, 700 * 1.8 ** attempt))
  }
  throw new Error('rpc failed')
}

// ── File helpers ──────────────────────────────────────────────────────────────

const readJson = async (p, fallback) => {
  try { return JSON.parse(await readFile(p, 'utf8')) } catch { return fallback }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const labelsPath   = join(ROOT, 'labels.json')
const discoverPath = join(ROOT, 'discover.json')
const catalogPath  = join(ROOT, 'catalog.json')

// apps.<NET>.json lives at the repository root (one level above src/)
const REPO_ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..')
const appsPath   = join(REPO_ROOT, `apps.${NET}.json`)

const labels   = await readJson(labelsPath, {})
const discover = await readJson(discoverPath, { contracts: [] })
const prev     = await readJson(catalogPath, null)
const appsData = await readJson(appsPath, { apps: [] })

// probed: { address: kind } — persists across runs to skip re-probing
const probed = prev?.probed ?? {}

// Extract kind==='token' anchor addresses from apps.<NET>.json (lowercase, deduplicated)
const appTokenAddresses = [
  ...new Set(
    (appsData.apps ?? [])
      .flatMap((app) => app.anchors ?? [])
      .filter((a) => a.kind === 'token')
      .map((a) => a.address.toLowerCase())
  ),
]

// Build discover txs map for entry construction
const discoverTxsMap = new Map(
  (discover.contracts ?? []).map((c) => [c.address.toLowerCase(), c.txs])
)

// All candidate addresses (sorted: app-tokens first, then discover txs desc, then address asc)
const allCandidates = candidateAddresses(labels, discover, appTokenAddresses)

// The todo list is:
//   (1) app-token addresses — ALWAYS re-probed for fresh totalSupply, regardless of probed map
//   (2) unprobed addresses from the rest of allCandidates, capped at MAX_PER_RUN
const appTokenSet  = new Set(appTokenAddresses)
const newCandidates = allCandidates
  .filter((a) => !appTokenSet.has(a) && !(a in probed))
  .slice(0, MAX_PER_RUN)

const todo = [...appTokenAddresses, ...newCandidates]

console.log(
  `${NET}: ${allCandidates.length} candidates, ${Object.keys(probed).length} already probed, ` +
  `${appTokenAddresses.length} app-tokens (always re-probed), ${newCandidates.length} new to probe`
)

// ── Probe in CHUNK_SIZE-address batches ───────────────────────────────────────

// 6 calls per address: name, symbol, decimals, totalSupply, is721, is1155
const CALLS_PER_ADDR = 6

// Collect newly-probed entries (with real probe data) so mergeCatalog can upsert them
const newlyProbedEntries = []

for (let i = 0; i < todo.length; i += CHUNK_SIZE) {
  const chunk = todo.slice(i, i + CHUNK_SIZE)
  const calls = []
  chunk.forEach((a, j) => {
    const base = j * CALLS_PER_ADDR
    calls.push({ jsonrpc: '2.0', id: base + 0, method: 'eth_call', params: [{ to: a, data: SEL_NAME },         'latest'] })
    calls.push({ jsonrpc: '2.0', id: base + 1, method: 'eth_call', params: [{ to: a, data: SEL_SYMBOL },       'latest'] })
    calls.push({ jsonrpc: '2.0', id: base + 2, method: 'eth_call', params: [{ to: a, data: SEL_DECIMALS },     'latest'] })
    calls.push({ jsonrpc: '2.0', id: base + 3, method: 'eth_call', params: [{ to: a, data: SEL_TOTAL_SUPPLY }, 'latest'] })
    calls.push({ jsonrpc: '2.0', id: base + 4, method: 'eth_call', params: [{ to: a, data: DATA_IS721 },       'latest'] })
    calls.push({ jsonrpc: '2.0', id: base + 5, method: 'eth_call', params: [{ to: a, data: DATA_IS1155 },      'latest'] })
  })

  let out
  try {
    out = await rpc(calls)
  } catch (e) {
    console.error(`chunk ${i}..${i + chunk.length - 1} failed: ${e.message}`)
    // Mark all as 'other' so we don't retry endlessly on a broken RPC
    for (const a of chunk) {
      newlyProbedEntries.push({
        address:     a,
        probe:       { name: null, symbol: null, decimals: null, totalSupply: null, is721: null, is1155: null },
        discoverTxs: discoverTxsMap.get(a) ?? 0,
        appToken:    appTokenSet.has(a),
      })
    }
    continue
  }

  chunk.forEach((a, j) => {
    const base = j * CALLS_PER_ADDR
    const get  = (offset) => out[base + offset]?.result ?? null
    const probe = {
      name:        decodeString(get(0)),
      symbol:      decodeString(get(1)),
      decimals:    get(2),
      totalSupply: get(3),
      is721:       decodeBool(get(4)),
      is1155:      decodeBool(get(5)),
    }
    newlyProbedEntries.push({
      address:     a,
      probe,
      discoverTxs: discoverTxsMap.get(a) ?? 0,
      appToken:    appTokenSet.has(a),
    })
  })

  // Polite pause between chunks
  if (i + CHUNK_SIZE < todo.length) await new Promise((r) => setTimeout(r, 400))
}

// ── Merge into catalog ────────────────────────────────────────────────────────
//
// mergeCatalog keeps ALL previously-stored tokens/nfts (with their real values)
// and upserts the newly-probed entries on top. No synthetic probes, no placeholders.

const output = mergeCatalog(prev, newlyProbedEntries, {
  network:     NET,
  generatedAt: new Date().toISOString(),
  maxTokens:   200,
  maxNfts:     200,
})

await mkdir(ROOT, { recursive: true })
await writeFile(catalogPath, JSON.stringify(output))

console.log(`${NET}: catalog.json written — ${output.tokens.length} tokens, ${output.nfts.length} NFTs, ${Object.keys(output.probed).length} total probed`)
