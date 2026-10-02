/** Ledger-backed observations and receipts; projections are disposable delivery caches. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { contractNames, currentVersion, loadAssumptions, loadContracts, versionHistory } from './contracts.ts'
import { buildEvent, entityKey, toWire } from './ledger.ts'
import { seenMarkerName } from './hub.ts'
import { appendEvent, canonicalEntityPath, invalidateImpactInputs, readAllEvents, type WorkspacePaths } from './workspace.ts'
import { analyzeImpacts, impactDigest, renderImpactAdvisory, type ImpactAssessment, type ImpactChange, type ImpactOptions, type ImpactSession } from './impact.ts'
import { parseImpactChange, parseImpactSession, type ImpactIdentity } from './impact-input.ts'
import type { CoordEvent } from './types.ts'

export interface ImpactNotification extends ImpactAssessment { status: 'pending' | 'delivered' | 'acknowledged' }
export interface ImpactReport {
  version: 1
  workspace: string
  generatedAt: string
  sessions: ImpactSession[]
  changes: ImpactChange[]
  notifications: ImpactNotification[]
  malformed: number
}
const sessionHost = 'impact/session'
const changeHost = 'impact/change'
const ackHost = 'impact/ack'
const terminal = new Set(['session_ended', 'lifecycle_integrated', 'lifecycle_stale', 'lifecycle_abandoned'])
const atomicJson = (file: string, value: unknown): void => {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8')
  renameSync(temp, file)
}
const invalidate = invalidateImpactInputs

/** Serialize revision checks and appends across processes; a busy writer asks callers to retry. */
function withImpactWriter<T>(paths: WorkspacePaths, write: () => T): T {
  mkdirSync(paths.state, { recursive: true })
  const file = join(paths.state, 'impact-write.lock')
  let fd: number
  try { fd = openSync(file, 'wx') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const pid = Number(readFileSync(file, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Impact writer is busy; retry later')
    try { process.kill(pid, 0); throw new Error('Impact writer is busy; retry later') } catch (owner) {
      if ((owner as NodeJS.ErrnoException).code !== 'ESRCH') throw owner
    }
    unlinkSync(file)
    fd = openSync(file, 'wx')
  }
  try { writeFileSync(fd, String(process.pid)); return write() }
  finally { closeSync(fd); unlinkSync(file) }
}

export function recordImpactSession(paths: WorkspacePaths, value: unknown, identity: ImpactIdentity, now = new Date()): ImpactSession {
  const state = parseImpactSession(value, paths, identity, now)
  // Invalidate before and after append: a racing publisher cannot certify partial input.
  invalidate(paths)
  appendEvent(paths, buildEvent({ kind: 'decision', timestampUtc: state.updatedAt, ...identity,
    hostEvent: sessionHost, detail: { state } }), now)
  invalidate(paths)
  return state
}

export function recordImpactChange(paths: WorkspacePaths, value: unknown, identity: ImpactIdentity, now = new Date()): ImpactChange {
  const change = parseImpactChange(value, paths, identity, now)
  return withImpactWriter(paths, () => {
    const previous = readAllEvents(paths).events.filter(e => e.hostEvent === changeHost && e.sessionId === identity.sessionId)
      .map(e => e.detail?.change as ImpactChange).filter(Boolean)
    const same = previous.find(c => c.eventId === change.eventId || (c.stream === change.stream && c.revision === change.revision))
    if (same) {
      const body = (c: ImpactChange) => JSON.stringify({ ...c, timestamp: '' })
      if (body(same) !== body(change)) throw new Error('An event ID or stream revision cannot be reused with different content')
      return same
    }
    if (previous.some(c => c.stream === change.stream && c.revision >= change.revision)) throw new Error('Change revision must increase within its producer stream')
    invalidate(paths)
    appendEvent(paths, buildEvent({ kind: 'decision', timestampUtc: change.timestamp, ...identity,
      hostEvent: changeHost, detail: { change } }), now)
    invalidate(paths)
    return change
  })
}

function emptySession(paths: WorkspacePaths, sessionId: string, taskId: string, timestamp: string): ImpactSession {
  return { sessionId, taskId, goal: '', workspace: paths.root, worktree: null, branch: null, updatedAt: timestamp,
    active: true, phase: 'working', entities: [], dependencies: [], contracts: [], artifacts: [] }
}
function ordered(events: readonly CoordEvent[]): CoordEvent[] {
  // Stable sort preserves append order for consecutive declarations in one millisecond.
  return [...events].sort((a, b) => a.timestampUtc.localeCompare(b.timestampUtc))
}

/** Structured declarations augment ordinary reads/writes and existing contract assumptions. */
export function extractImpactState(paths: WorkspacePaths, events: readonly CoordEvent[], now = new Date()) {
  const sessions = new Map<string, ImpactSession>()
  const declaredAt = new Map<string, string>()
  const changes: ImpactChange[] = []
  const acknowledgements = new Set<string>()
  let malformed = 0
  const sorted = ordered(events)
  for (const event of sorted) {
    if (event.sessionId.startsWith('hub:') || !Number.isFinite(Date.parse(event.timestampUtc)) || Date.parse(event.timestampUtc) > now.getTime()) continue
    if (event.hostEvent === ackHost) {
      if (typeof event.detail?.id === 'string') acknowledgements.add(JSON.stringify([event.sessionId, event.detail.id]))
      continue
    }
    const identity = { sessionId: event.sessionId, taskId: event.taskId ?? event.sessionId }
    if (event.hostEvent === sessionHost) {
      try {
        sessions.set(event.sessionId, parseImpactSession(event.detail?.state, paths, identity, new Date(event.timestampUtc)))
        declaredAt.set(event.sessionId, event.timestampUtc)
      }
      catch { malformed++ }
      continue
    }
    if (event.hostEvent === changeHost) {
      try { changes.push(parseImpactChange(event.detail?.change, paths, identity, new Date(event.timestampUtc))) }
      catch { malformed++ }
      continue
    }
    if (event.kind === 'advisory_injected' || event.hostEvent?.startsWith('hub/')) continue
    let state = sessions.get(event.sessionId)
    if (!state || (event.taskId && state.taskId !== event.taskId)) {
      state = emptySession(paths, event.sessionId, identity.taskId, event.timestampUtc)
      declaredAt.delete(event.sessionId)
    }
    state.updatedAt = event.timestampUtc
    if (event.kind === 'session_started' || event.kind === 'task_registered') state.active = true
    if (terminal.has(event.kind)) state.active = false
    if (event.kind === 'turn_ended') state.phase = 'idle'
    else if (['file_read', 'file_write', 'command'].includes(event.kind)) state.phase = 'working'
    if (event.intentText) state.goal = event.intentText
    for (const entity of event.entities ?? []) {
      if (!['file_read', 'file_write'].includes(event.kind)) continue
      const path = canonicalEntityPath(paths.root, entity.path)
      const key = entity.kind === 'file' ? `file::${path}` : entityKey(entity)
      const access = event.kind === 'file_write' ? 'write' as const : 'read' as const
      const previous = state.entities.find(e => e.key === key)
      if (!previous) state.entities.push({ key, path, access })
      else if (access === 'write') previous.access = 'write'
      if (access === 'read' && !state.dependencies.some(d => d.entity === key)) state.dependencies.push({ entity: key, relation: 'read' })
      if (access === 'write') changes.push({
        eventId: toWire(event).event_id, ...identity, goal: state.goal, workspace: paths.root, worktree: state.worktree, branch: state.branch,
        timestamp: event.timestampUtc, expiresAt: new Date(Date.parse(event.timestampUtc) + 30 * 60_000).toISOString(),
        stream: `observed:${key}`, revision: Date.parse(event.timestampUtc), status: 'in_progress', summary: event.intentText ?? `Observed write to ${key}`,
        compatibility: 'unknown', entities: [{ key, path, access: 'write' }], dependencies: [], contracts: [], artifacts: [], evidence: [toWire(event).event_id],
      })
    }
    sessions.set(event.sessionId, state)
  }
  const registry = loadContracts(paths)
  for (const assumption of loadAssumptions(paths).assumptions) {
    const state = sessions.get(assumption.sessionId) ?? emptySession(paths, assumption.sessionId, assumption.taskId, assumption.recordedAt)
    if (state.taskId !== assumption.taskId) continue
    if ((declaredAt.get(state.sessionId) ?? '') > assumption.recordedAt) continue
    state.contracts = state.contracts.filter(c => c.name !== assumption.contract)
    state.contracts.push({ name: assumption.contract, version: assumption.version, inferred: assumption.source === 'inferred' })
    if (assumption.recordedAt > state.updatedAt) state.updatedAt = assumption.recordedAt
    sessions.set(state.sessionId, state)
  }
  for (const name of contractNames(registry)) {
    const contract = currentVersion(registry, name)!
    const producer = [...sorted].reverse().find(e => e.taskId === contract.publishedBy &&
      e.detail?.contract === name && e.detail?.version === contract.version) ??
      [...sorted].reverse().find(e => e.taskId === contract.publishedBy && !e.sessionId.startsWith('hub:'))
    const source = producer ? sessions.get(producer.sessionId) : undefined
    changes.push({
      eventId: `contract-${impactDigest([name, contract.version, contract.publishedAt])}`,
      sessionId: producer?.sessionId ?? `task:${contract.publishedBy}`, taskId: contract.publishedBy,
      goal: contract.summary, workspace: paths.root, worktree: source?.worktree ?? null, branch: source?.branch ?? null,
      timestamp: contract.publishedAt, stream: `contract:${name}`, revision: contract.version, status: 'completed',
      summary: `${name} v${contract.version}: ${contract.summary}`, compatibility: 'unknown', entities: [], dependencies: [],
      contracts: [{ name, version: contract.version, breaking: contract.breaking,
        breakingVersions: versionHistory(registry, name).filter(c => c.breaking).map(c => c.version) }],
      artifacts: [], evidence: [`contracts/index.json#${name}@${contract.version}`, ...(contract.declaredIn ? [contract.declaredIn] : [])],
    })
  }
  // Index once; avoid a scan over the entire change history for every contract revision.
  const breaks = new Map<string, { revision: number; version: number }[]>()
  const historyKey = (c: ImpactChange, name: string) => JSON.stringify([c.sessionId, c.stream, name])
  for (const change of changes.filter(c => c.status === 'completed')) for (const contract of change.contracts.filter(c => c.breaking)) {
    const key = historyKey(change, contract.name)
    const history = breaks.get(key) ?? []
    history.push({ revision: change.revision, version: contract.version })
    breaks.set(key, history)
  }
  for (const change of changes) for (const contract of change.contracts) {
    contract.breakingVersions = [...new Set([...(contract.breakingVersions ?? []), ...(breaks.get(historyKey(change, contract.name)) ?? [])
      .filter(b => b.revision <= change.revision).map(b => b.version)])].sort((a, b) => a - b)
    if (contract.breakingVersions.some(v => v < contract.version)) delete contract.parts
  }
  return { sessions: [...sessions.values()], changes, acknowledgements, malformed }
}

function receipt(paths: WorkspacePaths, sessionId: string, id: string): boolean {
  return existsSync(join(paths.state, 'impact-seen', seenMarkerName(sessionId), `${id}.json`))
}
export function computeImpactReport(paths: WorkspacePaths, options: ImpactOptions = {}): ImpactReport {
  const now = options.now ?? new Date()
  const read = readAllEvents(paths)
  const state = extractImpactState(paths, read.events, now)
  const notifications = analyzeImpacts(state.changes, state.sessions, { ...options, now }).map(assessment => ({ ...assessment,
    status: state.acknowledgements.has(JSON.stringify([assessment.targetSessionId, assessment.id])) ? 'acknowledged' as const :
      receipt(paths, assessment.targetSessionId, assessment.id) ? 'delivered' as const : 'pending' as const,
  }))
  return { version: 1, workspace: paths.root, generatedAt: now.toISOString(), sessions: state.sessions, changes: state.changes,
    notifications, malformed: read.malformed + state.malformed }
}

export function acknowledgeImpact(paths: WorkspacePaths, sessionId: string, id: string, now = new Date()): void {
  const notification = computeImpactReport(paths, { now }).notifications.find(n => n.id === id && n.targetSessionId === sessionId)
  if (!notification) throw new Error('Unknown or superseded impact for this session')
  if (notification.status === 'acknowledged') return
  invalidate(paths)
  appendEvent(paths, buildEvent({ kind: 'decision', timestampUtc: now.toISOString(), sessionId,
    taskId: notification.targetTaskId, hostEvent: ackHost, detail: { id } }), now)
  invalidate(paths)
}

/** Changes to declarations, published contracts or assumptions invalidate cached deliveries immediately. */
export function impactInputStamp(paths: WorkspacePaths): string {
  return JSON.stringify(['impact-input.json', 'assumptions.json', '../contracts/index.json'].map(name => {
    if (name === 'impact-input.json') {
      try { return [name, readFileSync(join(paths.state, name), 'utf8')] } catch { return [name, null] }
    }
    try { const stat = statSync(join(paths.state, name)); return [name, stat.size, stat.mtimeMs] } catch { return [name, null] }
  }))
}
export const IMPACT_PROJECTION_TTL_MS = 10_000
export function publishImpactProjection(paths: WorkspacePaths, options: ImpactOptions = {}): ImpactReport {
  const stamp = impactInputStamp(paths)
  const report = computeImpactReport(paths, options)
  if (stamp !== impactInputStamp(paths)) return report
  const dir = join(paths.state, 'impact-inbox')
  mkdirSync(dir, { recursive: true })
  for (const session of report.sessions) {
    const all = report.notifications.filter(n => n.targetSessionId === session.sessionId && n.status === 'pending' && n.policy !== 'store-only')
      .sort((a, b) => Number(b.policy === 'interrupt') - Number(a.policy === 'interrupt') || b.score - a.score || a.id.localeCompare(b.id))
    atomicJson(join(dir, seenMarkerName(session.sessionId)), {
      version: 1, workspace: paths.root, sessionId: session.sessionId, generatedAt: report.generatedAt, inputStamp: stamp,
      expiresAt: new Date(Date.parse(report.generatedAt) + IMPACT_PROJECTION_TTL_MS).toISOString(),
      notifications: all.slice(0, 20).map(n => ({ id: n.id, policy: n.policy, text: renderImpactAdvisory(n) })),
      remaining: Math.max(0, all.length - 20),
    })
  }
  // Advertise the selective protocol even for a session with no pending notifications.
  atomicJson(join(paths.state, 'impact-protocol.json'), { version: 1 })
  return report
}
