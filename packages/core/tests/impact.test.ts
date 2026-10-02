import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeImpacts, assessImpact, currentImpactChanges, retrieveImpactCandidates, type ImpactChange, type ImpactSession } from '../src/impact.ts'
import { acknowledgeImpact, computeImpactReport, publishImpactProjection, recordImpactChange, recordImpactSession } from '../src/impact-state.ts'
import { appendEvent, ensureWorkspace, readAllEvents, type WorkspacePaths } from '../src/workspace.ts'
import { buildEvent } from '../src/ledger.ts'
import { loadAssumptions, loadContracts, publishContract, recordAssumption, staleAssumptions } from '../src/contracts.ts'
import { seenMarkerName } from '../src/hub.ts'

const now = new Date('2026-10-01T10:00:00Z')
const later = new Date(now.getTime() + 1000)
function session(overrides: Partial<ImpactSession> = {}): ImpactSession {
  return { sessionId: 'b', taskId: 'consumer', goal: 'build report exports', workspace: '/repo', worktree: '/repo', branch: 'main',
    updatedAt: now.toISOString(), active: true, phase: 'working', entities: [], dependencies: [], contracts: [], artifacts: [], ...overrides }
}
function change(overrides: Partial<ImpactChange> = {}): ImpactChange {
  return { eventId: 'event-1', sessionId: 'a', taskId: 'producer', goal: 'change authentication', workspace: '/repo', worktree: '/repo', branch: 'main',
    timestamp: now.toISOString(), stream: 'auth', revision: 1, status: 'completed', summary: 'Auth.login returns {token, expires_at}',
    compatibility: 'breaking', entities: [{ key: 'symbol::Auth.login', path: 'src/auth.ts', access: 'write' }],
    dependencies: [], contracts: [], artifacts: [], evidence: ['commit:abc:src/auth.ts:12'], ...overrides }
}

test('a low-similarity caller is recalled by a directed dependency, and the reverse is background', () => {
  const caller = session({ dependencies: [{ entity: 'symbol::Auth.login', relation: 'call' }] })
  assert.equal(retrieveImpactCandidates(change(), [caller], { now }).length, 1)
  const impact = assessImpact(change(), caller)
  assert.equal(impact.category, 'breaking_dependency')
  assert.equal(impact.policy, 'interrupt')
  assert.equal(impact.scoreKind, 'heuristic')
  assert.equal(impact.evidence[0].relation, 'caller_callee')
  const reverse = assessImpact(change({ sessionId: 'b', entities: [{ key: 'symbol::Report.render', access: 'write' }] }), session({ sessionId: 'a' }))
  assert.equal(reverse.category, 'background_only')
})

test('similar goals alone recall candidates but never justify an interruption or conflict', () => {
  const target = session({ goal: 'change authentication' })
  assert.equal(retrieveImpactCandidates(change(), [target], { now }).length, 1)
  const result = assessImpact(change(), target)
  assert.equal(result.category, 'background_only')
  assert.equal(result.policy, 'store-only')
  assert.equal(result.confidence, 'insufficient')
})

test('same symbol, unknown compatibility: relevant but no hard conflict', () => {
  const result = assessImpact(change({ compatibility: 'unknown' }), session({ entities: [{ key: 'symbol::Auth.login', access: 'write' }] }))
  assert.equal(result.category, 'soft_relevance')
  assert.equal(result.policy, 'defer')
  assert.equal(result.confidence, 'possible')
})

test('incompatible writes require the same known worktree', () => {
  const target = session({ entities: [{ key: 'symbol::Auth.login', access: 'write' }] })
  assert.equal(assessImpact(change(), target).category, 'hard_conflict')
  for (const worktree of ['/other-worktree', null]) {
    assert.equal(assessImpact(change({ worktree }), target).category, 'soft_relevance')
  }
  assert.equal(assessImpact(change({ status: 'planned' }), target).policy, 'defer')
})

test('two different symbols in one file are recalled without inventing a conflict', () => {
  const target = session({ entities: [{ key: 'symbol::Auth.logout', path: 'src/auth.ts', access: 'write' }] })
  assert.equal(retrieveImpactCandidates(change(), [target], { now }).length, 1)
  assert.equal(assessImpact(change(), target).category, 'background_only')
})

test('planned work and idle receivers defer the same high-severity dependency', () => {
  const target = session({ dependencies: [{ entity: 'symbol::Auth.login', relation: 'call' }] })
  for (const update of [{ status: 'planned' as const }, { status: 'in_progress' as const }]) {
    const result = assessImpact(change(update), target)
    assert.equal(result.category, 'breaking_dependency')
    assert.equal(result.severity, 'high')
    assert.equal(result.policy, 'defer')
  }
  assert.equal(assessImpact(change(), { ...target, phase: 'idle' }).policy, 'defer')
})

test('compatible implementation changes remain soft even when the caller is active', () => {
  const result = assessImpact(change({ compatibility: 'compatible' }), session({ dependencies: [{ entity: 'symbol::Auth.login', relation: 'call' }] }))
  assert.equal(result.category, 'soft_relevance')
  assert.equal(result.policy, 'defer')
})

test('contract parts and assumed versions determine whether the changed part is used', () => {
  const update = change({ entities: [], contracts: [{ name: 'auth', version: 2, breaking: true, parts: ['return.token'] }] })
  assert.equal(assessImpact(update, session({ contracts: [{ name: 'auth', version: 1, parts: ['exceptions'] }] })).category, 'background_only')
  assert.equal(assessImpact(update, session({ contracts: [{ name: 'auth', version: 2 }] })).category, 'background_only')
  assert.equal(assessImpact(update, session({ contracts: [{ name: 'auth', version: 1, parts: ['return.token'] }] })).category, 'breaking_dependency')
  const inferred = assessImpact(update, session({ contracts: [{ name: 'auth', version: 1, inferred: true }] }))
  assert.equal(inferred.confidence, 'possible')
  assert.notEqual(inferred.policy, 'interrupt')
})

test('an additive latest version cannot hide an intervening incompatible version', () => {
  const update = change({ entities: [], contracts: [{ name: 'auth', version: 3, breaking: false, breakingVersions: [2] }] })
  assert.equal(assessImpact(update, session({ contracts: [{ name: 'auth', version: 1 }] })).category, 'breaking_dependency')
  assert.equal(assessImpact(update, session({ contracts: [{ name: 'auth', version: 2 }] })).category, 'soft_relevance')
})

test('entity part evidence and updated contracts prevent obsolete dependency alerts', () => {
  const consumer = session({ dependencies: [{ entity: 'symbol::Auth.login', relation: 'call', parts: ['return.token'] }],
    contracts: [{ name: 'auth', version: 2 }] })
  const update = change({ contracts: [{ name: 'auth', version: 2, breaking: true }] })
  assert.equal(assessImpact(update, consumer).category, 'soft_relevance')
  const disjoint = change({ entities: [{ key: 'symbol::Auth.login', access: 'write', parts: ['exceptions'] }] })
  assert.equal(assessImpact(disjoint, consumer).category, 'background_only')
})

test('an artifact producer affects consumers with a different version', () => {
  const update = change({ entities: [], artifacts: [{ id: 'artifact::schema', version: 'v2', access: 'write' }] })
  const consumer = session({ artifacts: [{ id: 'artifact::schema', version: 'v1', access: 'read' }] })
  assert.equal(retrieveImpactCandidates(update, [consumer], { now }).length, 1)
  assert.equal(assessImpact(update, consumer).category, 'breaking_dependency')
  assert.equal(assessImpact(update, session({ artifacts: [{ id: 'artifact::schema', version: 'v2', access: 'read' }] })).category, 'background_only')
  assert.equal(assessImpact(update, session({ artifacts: [{ id: 'artifact::schema', access: 'write' }] })).category, 'hard_conflict')
})

test('self, foreign, finished, stale and future sessions are excluded', () => {
  const candidates = [
    session({ sessionId: 'a' }), session({ workspace: '/another' }), session({ active: false }),
    session({ updatedAt: new Date(now.getTime() - 31 * 60_000).toISOString() }), session({ updatedAt: later.toISOString() }),
  ].map(s => ({ ...s, goal: 'change authentication' }))
  assert.deepEqual(retrieveImpactCandidates(change(), candidates, { now }), [])
})

test('newer revisions supersede old ones without resurrecting expired or cancelled changes', () => {
  const first = change()
  const second = change({ eventId: 'event-2', revision: 2 })
  assert.deepEqual(currentImpactChanges([second, first, second], now).map(c => c.eventId), ['event-2'])
  assert.deepEqual(currentImpactChanges([first, { ...second, status: 'cancelled' }], now), [])
  assert.deepEqual(currentImpactChanges([first, { ...second, expiresAt: now.toISOString() }], now), [])
  assert.equal(currentImpactChanges([first, { ...second, timestamp: later.toISOString() }], now)[0].eventId, 'event-1')
})

test('routing thresholds are configurable, validated and separate from severity', () => {
  const target = session({ dependencies: [{ entity: 'symbol::Auth.login', relation: 'call' }] })
  const result = analyzeImpacts([change()], [target], { now, thresholds: { breaking_dependency: 1 } })[0]
  assert.equal(result.severity, 'high')
  assert.equal(result.policy, 'store-only')
  assert.throws(() => assessImpact(change(), target, { thresholds: { breaking_dependency: NaN } }), /threshold/)
})

let paths: WorkspacePaths
beforeEach(() => { paths = ensureWorkspace(mkdtempSync(join(tmpdir(), 'agentgit-impact-'))) })
afterEach(() => rmSync(paths.root, { recursive: true, force: true }))
const a = { sessionId: 'a', taskId: 'producer' }
const b = { sessionId: 'b', taskId: 'consumer' }
function declarePair() {
  recordImpactSession(paths, { goal: 'write caller', dependencies: [{ entity: 'symbol::Auth.login', relation: 'call' }] }, b, now)
  return recordImpactChange(paths, { stream: 'login', revision: 1, summary: 'Return type changed', compatibility: 'breaking',
    entities: [{ key: 'symbol::Auth.login', access: 'write' }], evidence: ['patch:auth.ts:42'] }, a, now)
}

test('declarations survive replay, retries deduplicate, acknowledgements belong to the receiver', () => {
  const update = declarePair()
  const count = readAllEvents(paths).events.length
  recordImpactChange(paths, update, a, later)
  assert.equal(readAllEvents(paths).events.length, count)
  const first = computeImpactReport(paths, { now }).notifications[0]
  assert.equal(first.status, 'pending')
  assert.equal(first.policy, 'interrupt')
  assert.throws(() => acknowledgeImpact(paths, 'a', first.id, now), /Unknown/)
  acknowledgeImpact(paths, 'b', first.id, now)
  acknowledgeImpact(paths, 'b', first.id, now)
  assert.equal(computeImpactReport(paths, { now }).notifications[0].status, 'acknowledged')
  assert.equal(readAllEvents(paths).events.filter(e => e.hostEvent === 'impact/ack').length, 1)
})

test('a conflicting replay or backwards revision fails without changing the ledger', () => {
  const first = declarePair()
  const count = readAllEvents(paths).events.length
  assert.throws(() => recordImpactChange(paths, { ...first, summary: 'different' }, a, later), /reused/)
  recordImpactChange(paths, { ...first, eventId: 'v3', revision: 3 }, a, later)
  assert.throws(() => recordImpactChange(paths, { ...first, eventId: 'v2', revision: 2 }, a, later), /increase/)
  assert.equal(readAllEvents(paths).events.length, count + 1)
})

test('a replacement session state removes obsolete dependencies and clears pending delivery', () => {
  declarePair()
  assert.equal(computeImpactReport(paths, { now }).notifications.length, 1)
  recordImpactSession(paths, { goal: 'unrelated task', dependencies: [] }, b, later)
  assert.equal(computeImpactReport(paths, { now: later }).notifications.length, 0)
})

test('ended sessions remain inactive even when they still have contract assumptions', () => {
  declarePair()
  appendEvent(paths, buildEvent({ kind: 'session_ended', timestampUtc: later.toISOString(), ...b }), later)
  recordAssumption(paths, { ...b, contract: 'auth', version: 1, recordedAt: now.toISOString(), source: 'declared', path: null })
  assert.equal(computeImpactReport(paths, { now: later }).notifications.length, 0)
})

test('existing file events are extracted without inventing compatibility', () => {
  for (const [identity, kind] of [[b, 'file_read'], [a, 'file_write']] as const) {
    appendEvent(paths, buildEvent({ kind, ...identity, timestampUtc: now.toISOString(),
      entities: [{ kind: 'file', identifier: './src/auth.ts', path: './src/auth.ts' }] }), now)
  }
  const report = computeImpactReport(paths, { now })
  assert.equal(report.notifications[0].category, 'soft_relevance')
  assert.equal(report.notifications[0].policy, 'defer')
})

test('one observed patch touching two streams cannot collapse their delivery receipts', () => {
  recordImpactSession(paths, { dependencies: [
    { entity: 'file::src/auth.ts', relation: 'import' }, { entity: 'file::src/schema.ts', relation: 'type' },
  ] }, b, now)
  appendEvent(paths, buildEvent({ ...a, kind: 'file_write', timestampUtc: now.toISOString(),
    entities: ['src/auth.ts', 'src/schema.ts'].map(path => ({ kind: 'file', identifier: path, path })),
  }), now)
  const notifications = computeImpactReport(paths, { now }).notifications
  assert.equal(notifications.length, 2)
  assert.equal(new Set(notifications.map(n => n.id)).size, 2)
})

test('existing contracts detect v1 -> breaking v2 -> additive v3 and clear after adaptation', () => {
  for (let version = 1; version <= 3; version++) publishContract(paths, {
    name: 'auth', version, breaking: version === 2, publishedBy: 'producer', publishedAt: now.toISOString(), summary: `v${version}`,
  })
  recordAssumption(paths, { ...b, contract: 'auth', version: 1, recordedAt: now.toISOString(), source: 'declared', path: null })
  assert.equal(staleAssumptions(loadAssumptions(paths), loadContracts(paths))[0].breaking, true)
  const report = computeImpactReport(paths, { now })
  assert.equal(report.notifications[0].category, 'breaking_dependency')
  recordAssumption(paths, { ...b, contract: 'auth', version: 3, recordedAt: later.toISOString(), source: 'declared', path: null })
  assert.equal(computeImpactReport(paths, { now: later }).notifications[0].category, 'background_only')
})

test('structured contract stream coalescing preserves intervening breaks', () => {
  recordImpactSession(paths, { contracts: [{ name: 'auth', version: 1 }] }, b, now)
  for (let version = 1; version <= 3; version++) recordImpactChange(paths, {
    stream: 'contract', revision: version, summary: `v${version}`, contracts: [{ name: 'auth', version, breaking: version === 2 }],
  }, a, now)
  const report = computeImpactReport(paths, { now })
  assert.equal(report.notifications.length, 1)
  assert.equal(report.notifications[0].category, 'breaking_dependency')
})

test('later tool activity cannot restore an assumption that the receiver already updated', () => {
  recordImpactSession(paths, { contracts: [{ name: 'auth', version: 1 }] }, b, now)
  recordImpactChange(paths, { stream: 'auth', revision: 1, summary: 'auth v2', contracts: [{ name: 'auth', version: 2, breaking: true }] }, a, now)
  recordAssumption(paths, { ...b, contract: 'auth', version: 2, recordedAt: later.toISOString(), source: 'declared', path: null })
  const after = new Date(later.getTime() + 1000)
  appendEvent(paths, buildEvent({ ...b, kind: 'command', timestampUtc: after.toISOString() }), after)
  assert.equal(computeImpactReport(paths, { now: after }).notifications[0].category, 'background_only')
})

test('a replacement snapshot can remove a previously recorded contract dependency', () => {
  recordAssumption(paths, { ...b, contract: 'auth', version: 1, recordedAt: now.toISOString(), source: 'declared', path: null })
  recordImpactChange(paths, { stream: 'auth', revision: 1, summary: 'auth v2', contracts: [{ name: 'auth', version: 2, breaking: true }] }, a, now)
  recordImpactSession(paths, { goal: 'no longer uses auth', contracts: [] }, b, later)
  assert.equal(computeImpactReport(paths, { now: later }).notifications.length, 0)
})

test('invalid external inputs fail before appending any observation', () => {
  for (const value of [null, [], { stream: 's', revision: -1 }, { stream: 's', revision: 1, summary: 'x', entities: [{ key: '../x' }] },
    { stream: 's', revision: 1, summary: 'x', contracts: [{ name: 'auth', version: NaN }] }]) {
    assert.throws(() => recordImpactChange(paths, value, a, now))
  }
  assert.throws(() => recordImpactSession(paths, { active: 'yes' }, b, now), /boolean/)
  assert.equal(readAllEvents(paths).events.length, 0)
})

test('projections are scoped, bounded and never contain another target\'s context', () => {
  declarePair()
  recordImpactSession(paths, { goal: 'other private task' }, { sessionId: 'c', taskId: 'c' }, now)
  publishImpactProjection(paths, { now })
  const inbox = (id: string) => JSON.parse(readFileSync(join(paths.state, 'impact-inbox', seenMarkerName(id)), 'utf8'))
  assert.equal(inbox('b').notifications.length, 1)
  assert.equal(inbox('c').notifications.length, 0)
  assert.doesNotMatch(JSON.stringify(inbox('b')), /other private task/)
})
