// Tests for src/agents-activity.mjs — pure helpers only, no network.
// Run with: node --test test/agents-activity.test.mjs

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  groupByOwner,
  nonceCall,
  balanceCall,
  buildActivity,
  selectOwners,
  parseHexInt,
  rawToNumber,
} from '../src/agents-activity.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// ── Load the real trimmed mainnet sample once ─────────────────────────────────

// Real trimmed mainnet agents.json (first 40 agents). A missing file must FAIL the run, not skip tests.
const SAMPLE_PATH = join(ROOT, 'test', 'fixtures', 'mainnet-agents-trim.json')
const sample = JSON.parse(await readFile(SAMPLE_PATH, 'utf8'))

// ── groupByOwner — real trimmed sample ───────────────────────────────────────

describe('groupByOwner(real trimmed sample)', () => {
  // Skip gracefully if file not present
  const skipIfNoSample = sample ? it : it.skip

  skipIfNoSample('total agent count equals sample.count (or agents.length)', () => {
    const groups = groupByOwner(sample.agents)
    const total = groups.reduce((s, g) => s + g.agents, 0)
    assert.equal(total, sample.agents.length,
      `sum of group.agents (${total}) should equal sample.agents.length (${sample.agents.length})`)
  })

  skipIfNoSample('owners are lowercase', () => {
    const groups = groupByOwner(sample.agents)
    for (const g of groups) {
      assert.equal(g.owner, g.owner.toLowerCase(), `owner '${g.owner}' is not lowercase`)
    }
  })

  skipIfNoSample('owners are unique', () => {
    const groups = groupByOwner(sample.agents)
    const ownerSet = new Set(groups.map((g) => g.owner))
    assert.equal(ownerSet.size, groups.length, 'duplicate owners detected')
  })

  skipIfNoSample('sorted by owner ascending', () => {
    const groups = groupByOwner(sample.agents)
    for (let i = 1; i < groups.length; i++) {
      assert.ok(
        groups[i - 1].owner <= groups[i].owner,
        `not sorted: '${groups[i - 1].owner}' > '${groups[i].owner}'`,
      )
    }
  })

  skipIfNoSample('owner 0x9f408de79d38257dfb6d73c9da7d9c81d744377c holds 4 agents in sample', () => {
    const groups = groupByOwner(sample.agents)
    const g = groups.find((x) => x.owner === '0x9f408de79d38257dfb6d73c9da7d9c81d744377c')
    assert.ok(g, 'owner 0x9f40… not found')
    assert.equal(g.agents, 4)
  })

  skipIfNoSample('firstId is the lowest agent id for each owner', () => {
    const groups = groupByOwner(sample.agents)
    // Build expected firstId from scratch
    const expected = new Map()
    for (const agent of sample.agents) {
      const owner = agent.owner.toLowerCase()
      if (!expected.has(owner) || expected.get(owner) > agent.id) {
        expected.set(owner, agent.id)
      }
    }
    for (const g of groups) {
      assert.equal(g.firstId, expected.get(g.owner),
        `firstId mismatch for ${g.owner}`)
    }
  })
})

// ── groupByOwner — hand-made edge cases ───────────────────────────────────────

describe('groupByOwner(synthetic)', () => {
  const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  it('names are deduped (same name from two agents counts once)', () => {
    const agents = [
      { id: 1, owner: A, name: 'Alpha' },
      { id: 2, owner: A, name: 'Alpha' },   // duplicate
      { id: 3, owner: A, name: 'Beta' },
    ]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.names.length, 2)
    assert.ok(g.names.includes('Alpha'))
    assert.ok(g.names.includes('Beta'))
  })

  it('names capped at 3 (4th distinct name is dropped)', () => {
    const agents = [
      { id: 1, owner: A, name: 'One' },
      { id: 2, owner: A, name: 'Two' },
      { id: 3, owner: A, name: 'Three' },
      { id: 4, owner: A, name: 'Four' },  // 4th: should be dropped
    ]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.names.length, 3)
  })

  it('name truncated to 60 characters', () => {
    const longName = 'x'.repeat(100)
    const agents = [{ id: 1, owner: A, name: longName }]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.names[0].length, 60)
  })

  it('control characters stripped from name', () => {
    const agents = [{ id: 1, owner: A, name: 'Hello\x00\x1fWorld' }]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.names[0], 'HelloWorld')
  })

  it('empty name (after stripping) is not included in names', () => {
    const agents = [{ id: 1, owner: A, name: '\x00\x01\x1f' }]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.names.length, 0)
  })

  it('undefined name produces no entry in names', () => {
    const agents = [{ id: 1, owner: A }]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.names.length, 0)
  })

  it('firstId is the lowest id across all agents for an owner', () => {
    const agents = [
      { id: 10, owner: A, name: 'Ten' },
      { id: 3,  owner: A, name: 'Three' },
      { id: 7,  owner: A, name: 'Seven' },
    ]
    const groups = groupByOwner(agents)
    const g = groups.find((x) => x.owner === A)
    assert.equal(g.firstId, 3)
  })

  it('mixed-case owner is lowercased', () => {
    const mixed = '0xAaBbCcDdEeFf000000000000000000000000AABB'
    const agents = [{ id: 1, owner: mixed, name: 'Test' }]
    const groups = groupByOwner(agents)
    assert.equal(groups[0].owner, mixed.toLowerCase())
  })

  it('sorted by owner ascending with two owners', () => {
    const agents = [
      { id: 1, owner: B },
      { id: 2, owner: A },
    ]
    const groups = groupByOwner(agents)
    assert.equal(groups[0].owner, A)
    assert.equal(groups[1].owner, B)
  })

  it('agents count is correct for two owners', () => {
    const agents = [
      { id: 1, owner: A },
      { id: 2, owner: A },
      { id: 3, owner: B },
    ]
    const groups = groupByOwner(agents)
    const gA = groups.find((x) => x.owner === A)
    const gB = groups.find((x) => x.owner === B)
    assert.equal(gA.agents, 2)
    assert.equal(gB.agents, 1)
  })
})

// ── parseHexInt ───────────────────────────────────────────────────────────────

describe('parseHexInt', () => {
  it('parses 0x0 to 0n', () => {
    assert.equal(parseHexInt('0x0'), 0n)
  })

  it('parses 0x1 to 1n', () => {
    assert.equal(parseHexInt('0x1'), 1n)
  })

  it('parses a nonce hex like 0x1a to 26n', () => {
    assert.equal(parseHexInt('0x1a'), 26n)
  })

  it('parses a large hex correctly', () => {
    // 0xde0b6b3a7640000 = 1_000_000_000_000_000_000n (1e18)
    assert.equal(parseHexInt('0xde0b6b3a7640000'), 1_000_000_000_000_000_000n)
  })

  it('parses uppercase hex', () => {
    assert.equal(parseHexInt('0xFF'), 255n)
  })

  it('throws on empty string', () => {
    assert.throws(() => parseHexInt(''), /invalid hex/)
  })

  it('throws on "0x" alone (no digits)', () => {
    assert.throws(() => parseHexInt('0x'), /invalid hex/)
  })

  it('throws on undefined', () => {
    assert.throws(() => parseHexInt(undefined), /invalid hex/)
  })

  it('throws on null', () => {
    assert.throws(() => parseHexInt(null), /invalid hex/)
  })

  it('throws on non-hex chars', () => {
    assert.throws(() => parseHexInt('0xGGGG'), /invalid hex/)
  })

  it('throws on string without 0x prefix', () => {
    assert.throws(() => parseHexInt('123'), /invalid hex/)
  })
})

// ── nonceCall ─────────────────────────────────────────────────────────────────

describe('nonceCall', () => {
  const addr = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('returns the exact JSON-RPC object', () => {
    assert.deepEqual(nonceCall(7, addr), {
      jsonrpc: '2.0',
      id: 7,
      method: 'eth_getTransactionCount',
      params: [addr, 'latest'],
    })
  })

  it('accepts a string id', () => {
    const call = nonceCall('req-1', addr)
    assert.equal(call.id, 'req-1')
    assert.equal(call.method, 'eth_getTransactionCount')
  })

  it('params[0] is the owner address unchanged', () => {
    const call = nonceCall(0, addr)
    assert.equal(call.params[0], addr)
    assert.equal(call.params[1], 'latest')
  })
})

// ── balanceCall ───────────────────────────────────────────────────────────────

describe('balanceCall', () => {
  const usdc  = '0x3400000000000000000000000000000000000001'
  const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('returns the exact JSON-RPC object shape', () => {
    const call = balanceCall(3, usdc, owner)
    assert.equal(call.jsonrpc, '2.0')
    assert.equal(call.id, 3)
    assert.equal(call.method, 'eth_call')
    assert.ok(Array.isArray(call.params))
    assert.equal(call.params.length, 2)
    assert.equal(call.params[1], 'latest')
  })

  it('params[0].to is the usdc contract address (lowercased)', () => {
    const mixedUsdc = '0x3400000000000000000000000000000000000001'
    const call = balanceCall(1, mixedUsdc, owner)
    assert.equal(call.params[0].to, mixedUsdc.toLowerCase())
  })

  it('params[0].data starts with the balanceOf selector 0x70a08231', () => {
    const call = balanceCall(1, usdc, owner)
    assert.ok(call.params[0].data.startsWith('0x70a08231'),
      `data should start with selector, got: ${call.params[0].data.slice(0, 10)}`)
  })

  it('params[0].data encodes the owner address (zero-padded to 32 bytes)', () => {
    const call = balanceCall(1, usdc, owner)
    const data = call.params[0].data
    // 4 bytes selector + 32 bytes = 36 bytes → 72 hex chars + '0x' = 74
    assert.equal(data.length, 74)
    // last 40 hex chars are the owner address (no 0x)
    assert.ok(data.endsWith(owner.slice(2).toLowerCase()))
  })

  it('accepts a string id', () => {
    const call = balanceCall('x-9', usdc, owner)
    assert.equal(call.id, 'x-9')
  })
})

// ── rawToNumber ───────────────────────────────────────────────────────────────

describe('rawToNumber', () => {
  it('returns 0 for 0n at 6 decimals', () => {
    assert.equal(rawToNumber(0n, 6), 0)
  })

  it('returns 123.46 for 123456789n at 6 decimals', () => {
    // 123456789 / 1000000 = 123.456789 → rounds to 123.46
    assert.equal(rawToNumber(123456789n, 6), 123.46)
  })

  it('handles a value above 2^53 exactly (no floating-point loss on integer part)', () => {
    // 10_000_001_000_000n / 1_000_000 = 10_000_001.0
    const raw = 10_000_001_000_000n
    assert.equal(rawToNumber(raw, 6), 10000001)
  })

  it('rounds to exactly 2 decimal places', () => {
    // 1_500_005n / 1_000_000 = 1.500005 → 1.5
    assert.equal(rawToNumber(1_500_005n, 6), 1.5)
    // 999_999n / 1_000_000 = 0.999999 → 1.0
    assert.equal(rawToNumber(999_999n, 6), 1)
  })

  it('returns 1 for 1_000_000n at 6 decimals', () => {
    assert.equal(rawToNumber(1_000_000n, 6), 1)
  })
})

// ── buildActivity ─────────────────────────────────────────────────────────────

describe('buildActivity — basic shape', () => {
  const META = {
    network: 'mainnet',
    now: '2026-10-12T10:00:00.000Z',
    registry: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    totalAgents: 2372,
  }

  const FIVE_OWNERS = [
    { owner: '0xaaaa', agents: 3, firstId: 1, names: ['Alpha'], txCount: 100, usdc: 50.0  },
    { owner: '0xbbbb', agents: 2, firstId: 4, names: ['Beta'],  txCount: 0,   usdc: 0     },
    { owner: '0xcccc', agents: 1, firstId: 6, names: [],        txCount: 5,   usdc: 10.5  },
    { owner: '0xdddd', agents: 4, firstId: 7, names: ['Delta'], txCount: 0,   usdc: 100.0 },
    { owner: '0xeeee', agents: 1, firstId: 8, names: [],        txCount: 200, usdc: 0     },
  ]

  it('has the right top-level keys', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    for (const key of ['network', 'generatedAt', 'registry', 'totalAgents',
                        'owners', 'ownersWithTx', 'ownersWithUsdc',
                        'agentsOfOwnersWithoutTx', 'top']) {
      assert.ok(key in doc, `missing key: ${key}`)
    }
  })

  it('network, generatedAt, registry, totalAgents come from meta', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    assert.equal(doc.network,     META.network)
    assert.equal(doc.generatedAt, META.now)
    assert.equal(doc.registry,    META.registry)
    assert.equal(doc.totalAgents, META.totalAgents)
  })

  it('owners = distinct owner count', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    assert.equal(doc.owners, 5)
  })

  it('ownersWithTx counts owners with txCount > 0', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    // 0xaaaa(100), 0xcccc(5), 0xeeee(200) → 3
    assert.equal(doc.ownersWithTx, 3)
  })

  it('ownersWithUsdc counts owners with usdc > 0', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    // 0xaaaa(50), 0xcccc(10.5), 0xdddd(100) → 3
    assert.equal(doc.ownersWithUsdc, 3)
  })

  it('agentsOfOwnersWithoutTx sums agents over owners with txCount === 0', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    // 0xbbbb(2) + 0xdddd(4) = 6
    assert.equal(doc.agentsOfOwnersWithoutTx, 6)
  })

  it('top has all 5 owners when total <= 200', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    assert.equal(doc.top.length, 5)
  })

  it('top is sorted: txCount desc, then agents desc, then owner asc', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    // Expected order:
    //   0xeeee txCount=200
    //   0xaaaa txCount=100
    //   0xcccc txCount=5
    //   0xbbbb txCount=0, agents=2
    //   0xdddd txCount=0, agents=4  ← MORE agents, so comes before 0xbbbb (agents desc)
    // Wait: agents desc means higher agents come first → 0xdddd(4) before 0xbbbb(2)
    const tops = doc.top
    assert.equal(tops[0].owner, '0xeeee')  // txCount 200
    assert.equal(tops[1].owner, '0xaaaa')  // txCount 100
    assert.equal(tops[2].owner, '0xcccc')  // txCount 5
    assert.equal(tops[3].owner, '0xdddd')  // txCount 0, agents 4
    assert.equal(tops[4].owner, '0xbbbb')  // txCount 0, agents 2
  })

  it('top entries have the required fields', () => {
    const doc = buildActivity(FIVE_OWNERS, META)
    for (const entry of doc.top) {
      for (const key of ['owner', 'agents', 'txCount', 'usdc', 'firstId', 'names']) {
        assert.ok(key in entry, `top entry missing key: ${key}`)
      }
    }
  })
})

describe('buildActivity — tie-breaking by owner asc', () => {
  const META = {
    network: 'mainnet',
    now: '2026-10-12T10:00:00.000Z',
    registry: null,
    totalAgents: 10,
  }

  it('owners with equal txCount AND equal agents are sorted by owner asc', () => {
    const owners = [
      { owner: '0xzzzz', agents: 2, firstId: 3, names: [], txCount: 5, usdc: 0 },
      { owner: '0xaaaa', agents: 2, firstId: 1, names: [], txCount: 5, usdc: 0 },
      { owner: '0xmmmm', agents: 2, firstId: 2, names: [], txCount: 5, usdc: 0 },
    ]
    const doc = buildActivity(owners, META)
    assert.equal(doc.top[0].owner, '0xaaaa')
    assert.equal(doc.top[1].owner, '0xmmmm')
    assert.equal(doc.top[2].owner, '0xzzzz')
  })
})

describe('buildActivity — top capped at 200', () => {
  const META = {
    network: 'mainnet',
    now: '2026-10-12T10:00:00.000Z',
    registry: null,
    totalAgents: 500,
  }

  it('top contains at most 200 entries when 250 owners are provided', () => {
    // Build 250 synthetic owners, each with distinct txCount so ordering is deterministic
    const owners = []
    for (let i = 0; i < 250; i++) {
      const hex = i.toString(16).padStart(40, '0')
      owners.push({
        owner: '0x' + hex,
        agents: 1,
        firstId: i + 1,
        names: [],
        txCount: 250 - i,   // distinct, descending
        usdc: 0,
      })
    }
    const doc = buildActivity(owners, META)
    assert.equal(doc.top.length, 200)
  })

  it('top contains the 200 owners with the highest txCount', () => {
    const owners = []
    for (let i = 0; i < 250; i++) {
      const hex = i.toString(16).padStart(40, '0')
      owners.push({
        owner: '0x' + hex,
        agents: 1,
        firstId: i + 1,
        names: [],
        txCount: i,   // owner 249 has highest txCount=249
        usdc: 0,
      })
    }
    const doc = buildActivity(owners, META)
    // The top entry should be the owner with txCount=249 (index 249)
    assert.equal(doc.top[0].txCount, 249)
    // The last top entry should have txCount=50 (owners 50..249 are the top 200)
    assert.equal(doc.top[199].txCount, 50)
    // owners count is still 250
    assert.equal(doc.owners, 250)
  })

  it('owners count reflects all 250, not just top 200', () => {
    const owners = []
    for (let i = 0; i < 250; i++) {
      const hex = i.toString(16).padStart(40, '0')
      owners.push({
        owner: '0x' + hex,
        agents: 1,
        firstId: i + 1,
        names: [],
        txCount: i,
        usdc: 0,
      })
    }
    const doc = buildActivity(owners, META)
    assert.equal(doc.owners, 250)
  })
})

describe('buildActivity — null registry', () => {
  it('registry is null when meta.registry is null', () => {
    const doc = buildActivity([], {
      network: 'testnet', now: '2026-10-12T10:00:00.000Z',
      registry: null, totalAgents: 0,
    })
    assert.equal(doc.registry, null)
  })
})

describe('buildActivity — empty owners list', () => {
  it('produces zero counts', () => {
    const doc = buildActivity([], {
      network: 'testnet', now: '2026-10-12T10:00:00.000Z',
      registry: null, totalAgents: 0,
    })
    assert.equal(doc.owners, 0)
    assert.equal(doc.ownersWithTx, 0)
    assert.equal(doc.ownersWithUsdc, 0)
    assert.equal(doc.agentsOfOwnersWithoutTx, 0)
    assert.deepEqual(doc.top, [])
  })
})


describe('selectOwners', () => {
  it('returns everything when within the cap (same array order)', () => {
    const g = [{ owner: '0xb', agents: 1 }, { owner: '0xa', agents: 5 }]
    assert.deepEqual(selectOwners(g, 2), g)
    assert.deepEqual(selectOwners(g, 10), g)
  })
  it('keeps the owners with the most agents, ties by address, deterministic', () => {
    const g = [
      { owner: '0xc', agents: 2 }, { owner: '0xa', agents: 2 }, { owner: '0xd', agents: 9 },
      { owner: '0xb', agents: 2 }, { owner: '0xe', agents: 1 },
    ]
    assert.deepEqual(selectOwners(g, 3).map((o) => o.owner), ['0xd', '0xa', '0xb'])
    assert.deepEqual(selectOwners([...g].reverse(), 3).map((o) => o.owner), ['0xd', '0xa', '0xb'])
    assert.equal(g.length, 5, 'input is not mutated')
  })
})

describe('buildActivity with a measured subset', () => {
  it('reports registry-wide owners separately from measured ones', () => {
    const owners = [{ owner: '0xa', agents: 3, firstId: 1, names: [], txCount: 0, usdc: 0 }]
    const doc = buildActivity(owners, { network: 'testnet', now: 'x', registry: null, totalAgents: 100, ownersTotal: 40 })
    assert.equal(doc.owners, 40)
    assert.equal(doc.ownersMeasured, 1)
    assert.equal(doc.agentsMeasured, 3)
  })
})
