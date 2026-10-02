import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeImpacts, assessImpact, notificationTierOf, retrieveImpactCandidates, type ImpactChange, type ImpactSession } from '../src/impact.ts'
import type { ModuleEdgeKind, ModuleGraph } from '../src/modules.ts'

const now = new Date('2026-10-01T10:00:00Z')

function session(overrides: Partial<ImpactSession> = {}): ImpactSession {
  return {
    sessionId: 'b',
    taskId: 'consumer',
    goal: 'render the settings screen',
    workspace: '/repo',
    worktree: '/repo',
    branch: 'main',
    updatedAt: now.toISOString(),
    active: true,
    phase: 'working',
    entities: [],
    dependencies: [],
    contracts: [],
    artifacts: [],
    ...overrides,
  }
}

function change(overrides: Partial<ImpactChange> = {}): ImpactChange {
  return {
    eventId: 'event-1',
    sessionId: 'a',
    taskId: 'producer',
    goal: 'harden token expiry',
    workspace: '/repo',
    worktree: '/repo',
    branch: 'main',
    timestamp: now.toISOString(),
    stream: 'core',
    revision: 1,
    status: 'completed',
    summary: 'entity contract changed',
    compatibility: 'breaking',
    entities: [{ key: 'file::packages/core/src/entity.ts', path: 'packages/core/src/entity.ts', access: 'write' }],
    dependencies: [],
    contracts: [],
    artifacts: [],
    evidence: [],
    ...overrides,
  }
}

/** A graph with the given edges, so the impact tests do not depend on scanning a real tree. */
function graphOf(edges: Array<[string, string]>, kind: ModuleEdgeKind = 'import', weight = 1): ModuleGraph {
  const ids = new Set<string>()
  for (const [from, to] of edges) {
    ids.add(from)
    ids.add(to)
  }
  return {
    version: 1,
    root: '/repo',
    fingerprint: 'test',
    modules: [...ids].map((id) => ({ id, rule: 'top-level' as const, fileCount: 0, fanIn: 0, fanOut: 0, hubScore: 0 })),
    edges: edges.map(([from, to]) => ({ from, to, kind, weight })),
    byPath: {},
    unresolved: 0,
    unparsed: 0,
    truncated: false,
  }
}

test('a receiver that imports the changed module is recalled and deferred, never interrupted', () => {
  const graph = graphOf([['packages/cli', 'packages/core']]) // cli imports core
  const producer = change()
  const consumer = session({
    sessionId: 'cli',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  })

  const impacts = analyzeImpacts([producer], [consumer], { now, moduleGraph: graph, moduleRouting: 'one-hop' })
  assert.equal(impacts.length, 1)
  assert.equal(impacts[0].evidence[0].relation, 'module_coupling')
  assert.equal(impacts[0].category, 'breaking_dependency')
  // A resolved import proves the modules are wired, not that this change breaks this consumer,
  // so the proof is unconfirmed and the strongest it can be is a deferred warning.
  assert.equal(impacts[0].confidence, 'possible')
  assert.equal(impacts[0].policy, 'defer')
})

test('a compatible change through the same edge is soft relevance, and the reverse direction is weaker', () => {
  const graph = graphOf([['packages/cli', 'packages/core']])
  const consumer = session({ sessionId: 'cli', goal: 'unrelated words about penguins', entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }] })

  const compatible = assessImpact(change({ compatibility: 'compatible' }), consumer, { moduleGraph: graph })
  assert.equal(compatible.category, 'soft_relevance')

  // The producer direction (the changed module imports the receiver's) is an adaptation, and it
  // is deliberately below the soft threshold so it lands as background.
  const producer = change({
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  })
  const dependsOnCli = session({
    sessionId: 'core',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/core/src/entity.ts', path: 'packages/core/src/entity.ts', access: 'write' }],
  })
  const impact = assessImpact(producer, dependsOnCli, { moduleGraph: graph })
  assert.equal(impact.category, 'soft_relevance')
  assert.equal(impact.policy, 'store-only')
})

test('module overlap alone is never evidence', () => {
  const graph = graphOf([]) // two files in one module, but nothing imports anything
  const producer = change({
    entities: [{ key: 'file::src/a.ts', path: 'src/a.ts', access: 'write' }],
    goal: 'harden token expiry',
  })
  const other = session({
    sessionId: 'other',
    goal: 'render the settings screen',
    entities: [{ key: 'file::src/b.ts', path: 'src/b.ts', access: 'write' }],
  })
  assert.deepEqual(analyzeImpacts([producer], [other], { now, moduleGraph: graph, moduleRouting: 'one-hop' }), [])
})

test('a co-change edge alone never escalates, and never widens the routing', () => {
  const graph = graphOf([['packages/cli', 'packages/core']], 'co-change', 10)
  const producer = change()
  const consumer = session({
    sessionId: 'cli',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  })
  assert.deepEqual(analyzeImpacts([producer], [consumer], { now, moduleGraph: graph, moduleRouting: 'one-hop' }), [])
})

test('routing narrows a fully-placed session outside the neighborhood, and off recalls it', () => {
  const graph = graphOf([['packages/cli', 'packages/core']])
  const producer = change({ goal: 'harden token expiry' })
  const far = session({
    sessionId: 'far',
    goal: 'harden token expiry', // same words, so intent similarity alone would recall it
    entities: [{ key: 'file::packages/mcp/src/tool.ts', path: 'packages/mcp/src/tool.ts', access: 'write' }],
  })
  assert.equal(retrieveImpactCandidates(producer, [far], { now, moduleGraph: graph, moduleRouting: 'off' }).length, 1)
  assert.equal(retrieveImpactCandidates(producer, [far], { now, moduleGraph: graph, moduleRouting: 'one-hop' }).length, 0)
})

test('routing never drops a session it cannot place, or one that shares a contract', () => {
  const graph = graphOf([['packages/cli', 'packages/core']])
  const producer = change({ contracts: [{ name: 'auth', version: 2, breaking: true }] })

  // Cannot place: a bare symbol has no module, so "unknown ground" must not be read as "unrelated".
  const symbolOnly = session({ sessionId: 'sym', goal: 'harden token expiry', entities: [{ key: 'symbol::Auth.login', access: 'write' }] })
  // Shares a contract: a contract is an identifier with no module, so the router has no basis to exclude it.
  const farContract = session({
    sessionId: 'contract',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/mcp/src/tool.ts', path: 'packages/mcp/src/tool.ts', access: 'write' }],
    contracts: [{ name: 'auth', version: 1 }],
  })

  const routed = retrieveImpactCandidates(producer, [symbolOnly, farContract], { now, moduleGraph: graph, moduleRouting: 'one-hop' })
  assert.deepEqual(routed.map((candidate) => candidate.sessionId).sort(), ['contract', 'sym'])
})

test('without a graph the analysis is byte-for-byte the pairwise baseline', () => {
  const caller = session({ dependencies: [{ entity: 'file::packages/core/src/entity.ts', relation: 'call' }] })
  assert.equal(retrieveImpactCandidates(change(), [caller], { now }).length, 1)
  // Default routing with no graph must not exclude anything the old predicate set would keep.
  assert.equal(retrieveImpactCandidates(change(), [caller], { now, moduleRouting: 'one-hop' }).length, 1)
})

test('the ablation: routing keeps the hard-case recall while comparing strictly fewer sessions', () => {
  // One real edge: `packages/cli` imports `packages/core`. The producer changes `core`.
  const graph = graphOf([['packages/cli', 'packages/core']])
  const producer = change({ compatibility: 'breaking' })

  // The hard case the E2 pack reports: the affected consumer describes its work in words that
  // share nothing with the producer, so text similarity alone cannot recall it. Only the import
  // edge does — and it must survive routing.
  const hardCase = session({
    sessionId: 'cli',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  })
  // The false positive: same words as the producer, but in a module nothing wires to the change.
  const lookAlike = session({
    sessionId: 'far',
    goal: 'harden token expiry',
    entities: [{ key: 'file::packages/mcp/src/tool.ts', path: 'packages/mcp/src/tool.ts', access: 'write' }],
  })

  const baseline = retrieveImpactCandidates(producer, [hardCase, lookAlike], { now, moduleGraph: graph, moduleRouting: 'off' })
  const routed = retrieveImpactCandidates(producer, [hardCase, lookAlike], { now, moduleGraph: graph, moduleRouting: 'one-hop' })

  // Comparisons: the pairwise baseline visits both; routing visits only the wired module.
  assert.equal(baseline.length, 2)
  assert.deepEqual(routed.map((candidate) => candidate.sessionId), ['cli'])

  // Recall of the hard case is preserved by the edge, not by the words, and it still escalates.
  const impacts = analyzeImpacts([producer], [hardCase, lookAlike], { now, moduleGraph: graph, moduleRouting: 'one-hop' })
  assert.equal(impacts.length, 1)
  assert.equal(impacts[0].targetSessionId, 'cli')
  assert.equal(impacts[0].category, 'breaking_dependency')
  assert.equal(impacts[0].evidence.some((proof) => proof.relation === 'module_coupling'), true)
})

test('routing is a recall filter, never a gate: it prunes by place, never by evidence', () => {
  const graph = graphOf([['packages/cli', 'packages/core']])
  // The changed module itself, and the module wired to it, are both in reach.
  const sameModule = session({
    sessionId: 'same',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/core/src/entity.ts', path: 'packages/core/src/entity.ts', access: 'write' }],
  })
  const wired = session({
    sessionId: 'wired',
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  })
  assert.deepEqual(
    retrieveImpactCandidates(change(), [sameModule, wired], { now, moduleGraph: graph, moduleRouting: 'one-hop' })
      .map((candidate) => candidate.sessionId).sort(),
    ['same', 'wired'],
  )

  // Fully placed and outside the neighbourhood: pruned even though its words match the producer.
  const farPlaced = session({
    sessionId: 'far',
    goal: 'harden token expiry',
    entities: [{ key: 'file::packages/mcp/src/tool.ts', path: 'packages/mcp/src/tool.ts', access: 'write' }],
  })
  assert.equal(retrieveImpactCandidates(change(), [farPlaced], { now, moduleGraph: graph, moduleRouting: 'one-hop' }).length, 0)

  // A session the router cannot place is never the router's to drop: routing keeps it in the
  // pool and the evidence decides. With no evidence it is not recalled; with matching words it is.
  const unplaceable = session({ sessionId: 'sym', goal: 'unrelated words about penguins', entities: [{ key: 'symbol::Auth.login', access: 'write' }] })
  assert.equal(retrieveImpactCandidates(change(), [unplaceable], { now, moduleGraph: graph, moduleRouting: 'one-hop' }).length, 0)
  const unplaceableSameWords = session({ sessionId: 'sym2', goal: 'harden token expiry', entities: [{ key: 'symbol::Auth.login', access: 'write' }] })
  assert.equal(retrieveImpactCandidates(change(), [unplaceableSameWords], { now, moduleGraph: graph, moduleRouting: 'one-hop' }).length, 1)
})

test('the tier vocabulary is derived from the delivery policy, and coupling never reaches `immediate`', () => {
  assert.equal(notificationTierOf('interrupt'), 'immediate')
  assert.equal(notificationTierOf('defer'), 'defer')
  assert.equal(notificationTierOf('store-only'), 'record')

  // A module edge proves the modules are wired, not that this change breaks this consumer, so the
  // strongest tier mechanical coupling can reach is the safe point — never the write boundary.
  const graph = graphOf([['packages/cli', 'packages/core']])
  const consumer = session({ sessionId: 'cli', goal: 'unrelated words about penguins', entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }] })
  const impacts = analyzeImpacts([change()], [consumer], { now, moduleGraph: graph, moduleRouting: 'one-hop' })
  assert.equal(notificationTierOf(impacts[0].policy), 'defer')
})
