// Registered-agent list for Pulsarc's /agents page (ERC-8004 Identity Registry).
//
// The registry has no totalSupply(), so ids are walked upward from the last one we saw until
// ownerOf(id) reverts GAP_STOP times in a row. tokenURI is read once per agent; inline data: profiles
// are decoded to name/description, short http(s)/ipfs links are kept. The indexer never fetches a URI.
//
// scanAgents is pure apart from `ethCall`, which the caller injects:
//   ethCall(calls: [{ to, data }]) -> Promise<Array<{ result?: string, error?: string }>>

export const REGISTRY = {
  mainnet: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  testnet: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
}
export const SEL_OWNER_OF = '0x6352211e'
export const SEL_TOKEN_URI = '0xc87b56dd'
const MAX_URI = 300
const MAX_TEXT = 160
const GAP_STOP = 20

const word = (id) => BigInt(id).toString(16).padStart(64, '0')

export function decodeAddress(hex) {
  if (typeof hex !== 'string' || hex.length < 66) return null
  const a = '0x' + hex.slice(-40).toLowerCase()
  return /^0x0{40}$/.test(a) ? null : a
}

/** ABI-decode a single dynamic `string` return value. Returns null if malformed. */
export function decodeString(hex) {
  try {
    if (typeof hex !== 'string' || hex.length < 130) return null
    const body = hex.slice(2)
    const off = Number(BigInt('0x' + body.slice(0, 64))) * 2
    const len = Number(BigInt('0x' + body.slice(off, off + 64)))
    const data = body.slice(off + 64, off + 64 + len * 2)
    if (data.length !== len * 2) return null
    return Buffer.from(data, 'hex').toString('utf8')
  } catch { return null }
}

const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim().slice(0, n) : undefined) || undefined

/**
 * Keep the stored record small. Inline `data:application/json;base64,` profiles are decoded here
 * (no network) into name + description; http(s)/ipfs links are kept as-is when short. Nothing is fetched.
 */
export function slimUri(uri) {
  if (!uri) return {}
  const m = /^data:application\/json(?:;[^,]*)?;base64,(.+)$/i.exec(uri)
  if (m) {
    try {
      const j = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'))
      return { name: clean(j.name, 80), description: clean(j.description, MAX_TEXT) }
    } catch { return {} }
  }
  return uri.length <= MAX_URI && /^(https?|ipfs):\/\//i.test(uri) ? { uri } : {}
}

/**
 * @param {object} p
 * @param {string} p.registry
 * @param {{lastId:number, agents:object[]}} p.state   previous agents.json content (or {lastId:0, agents:[]})
 * @param {Function} p.ethCall
 * @param {number} [p.maxPerRun=2000]   ids examined per run
 * @param {number} [p.chunk=40]         ids per RPC batch
 * @returns {Promise<{lastId:number, agents:object[], examined:number, done:boolean}>}
 */
export async function scanAgents({ registry, state, ethCall, maxPerRun = 2000, chunk = 40 }) {
  const agents = [...state.agents]
  let lastId = state.lastId
  let next = lastId + 1
  let misses = 0
  let examined = 0
  let done = false

  while (examined < maxPerRun && !done) {
    const ids = []
    for (let i = 0; i < chunk && examined + ids.length < maxPerRun; i++) ids.push(next + i)
    const owners = await ethCall(ids.map((id) => ({ to: registry, data: SEL_OWNER_OF + word(id) })))
    const found = []
    ids.forEach((id, i) => {
      const owner = owners[i]?.error ? null : decodeAddress(owners[i]?.result)
      if (owner) { found.push({ id, owner }); misses = 0 } else if (++misses >= GAP_STOP) done = true
    })
    if (found.length) {
      const uris = await ethCall(found.map((f) => ({ to: registry, data: SEL_TOKEN_URI + word(f.id) })))
      found.forEach((f, i) => {
        const uri = uris[i]?.error ? null : decodeString(uris[i]?.result)
        agents.push({ id: f.id, owner: f.owner, ...slimUri(uri) })
        lastId = Math.max(lastId, f.id)
      })
    }
    examined += ids.length
    next += ids.length
    if (done) break
  }
  return { lastId, agents, examined, done }
}
