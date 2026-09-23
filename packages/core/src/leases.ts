/**
 * Soft leases: a claim on an entity that expires on its own.
 *
 * Why not a lock
 * --------------
 * A hard lock on a file is the wrong size for this problem in both directions. It
 * is too coarse, because two agents editing unrelated functions in one file do not
 * conflict; and it is too strong, because a crashed agent must not be able to wedge
 * a workspace. A lease is therefore advisory by default, scoped to a symbol when a
 * symbol is known, and always carries an expiry.
 *
 * The lease is what makes the preflight answer `reuse` instead of `allow`. Without
 * it the coordinator knows an entity was touched *before*, which is history; with it
 * the coordinator knows someone is on the entity *now*, which is the thing a second
 * agent needs to be told.
 *
 * @module @agentgit/core/leases
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { compareCodepoint } from './ledger.ts'
import type { WorkspacePaths } from './workspace.ts'

/** What a lease is held on. `contract` leases cover a published interface, not a file. */
export type LeaseKind = 'file' | 'symbol' | 'contract'

export interface Lease {
  readonly entityKey: string
  readonly kind: LeaseKind
  readonly taskId: string
  readonly sessionId: string
  /** Why this entity is claimed. Quoted back to whoever is told to wait or reuse. */
  readonly reason: string
  readonly grantedAt: string
  readonly renewedAt: string
  readonly expiresAt: string
  /** Tasks explicitly allowed to write under this lease despite not holding it. */
  readonly shareWith: readonly string[]
}

export interface LeaseStore {
  readonly version: number
  readonly leases: readonly Lease[]
}

export const EMPTY_LEASES: LeaseStore = { version: 1, leases: [] }

function leasesPath(paths: WorkspacePaths): string {
  return join(paths.state, 'leases.json')
}

/** Read the lease store. A corrupt store is treated as empty rather than fatal. */
export function loadLeases(paths: WorkspacePaths): LeaseStore {
  const file = leasesPath(paths)
  if (!existsSync(file)) return EMPTY_LEASES
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as LeaseStore
    if (!raw || !Array.isArray(raw.leases)) return EMPTY_LEASES
    return { version: raw.version ?? 1, leases: raw.leases }
  } catch {
    return EMPTY_LEASES
  }
}

/** Persist the lease store, creating its directory on first use. */
export function saveLeases(paths: WorkspacePaths, store: LeaseStore): void {
  const file = leasesPath(paths)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

/** True when the lease has not yet expired at `now`. */
export function isLive(lease: Lease, now: Date = new Date()): boolean {
  return Date.parse(lease.expiresAt) > now.getTime()
}

/** Live leases only, sorted for stable output. */
export function liveLeases(store: LeaseStore, now: Date = new Date()): Lease[] {
  return store.leases
    .filter((lease) => isLive(lease, now))
    .sort(
      (a, b) =>
        compareCodepoint(a.entityKey, b.entityKey) ||
        compareCodepoint(a.taskId, b.taskId),
    )
}

export interface AcquireInput {
  readonly entityKey: string
  readonly kind?: LeaseKind
  readonly taskId: string
  readonly sessionId: string
  readonly reason: string
  readonly minutes: number
  readonly shareWith?: readonly string[]
  /** Set to take over an entity another task is holding. Recorded, never silent. */
  readonly steal?: boolean
}

export interface AcquireResult {
  readonly granted: boolean
  readonly lease: Lease | null
  /** Live leases already on this entity, excluding the caller's own. */
  readonly conflicts: readonly Lease[]
  readonly reason: string
}

/**
 * Acquire or renew a lease on one entity.
 *
 * Renewing is the same call as acquiring: an agent that keeps working keeps
 * renewing, and an agent that dies stops renewing and therefore stops blocking
 * anyone. That identity is what removes the need for a crash-recovery path that
 * has to guess whether someone is still alive.
 *
 * A conflict does not fail the acquisition when the caller has not asked to steal;
 * it is reported instead. Refusing to grant would turn a coordination signal into
 * an obstruction, which is the failure mode the product cannot afford.
 */
export function acquireLease(
  paths: WorkspacePaths,
  input: AcquireInput,
  now: Date = new Date(),
): AcquireResult {
  if (!input.taskId) throw new Error('taskId is required: an unowned lease blocks everyone and releases no one')
  if (!(input.minutes > 0)) throw new Error('lease duration must be positive')

  const store = loadLeases(paths)
  const live = liveLeases(store, now)
  const conflicts = live.filter(
    (lease) =>
      lease.entityKey === input.entityKey &&
      lease.taskId !== input.taskId &&
      !lease.shareWith.includes(input.taskId),
  )

  if (conflicts.length > 0 && !input.steal) {
    return {
      granted: false,
      lease: null,
      conflicts,
      reason:
        `${input.entityKey} is held by task ${conflicts.map((c) => c.taskId).join(', ')} ` +
        `(expires ${conflicts[0].expiresAt}). Reuse that work, or take over with an explicit steal.`,
    }
  }

  const timestamp = now.toISOString()
  const expiresAt = new Date(now.getTime() + input.minutes * 60_000).toISOString()
  const existing = live.find(
    (lease) => lease.entityKey === input.entityKey && lease.taskId === input.taskId,
  )

  const lease: Lease = {
    entityKey: input.entityKey,
    kind: input.kind ?? (input.entityKey.includes('::') ? kindFromKey(input.entityKey) : 'file'),
    taskId: input.taskId,
    sessionId: input.sessionId,
    reason: input.reason,
    grantedAt: existing?.grantedAt ?? timestamp,
    renewedAt: timestamp,
    expiresAt,
    shareWith: input.shareWith ?? [],
  }

  // Expired leases are dropped on every write, so the file cannot grow without
  // bound in a long-lived workspace and no explicit maintenance command is needed.
  const kept = live.filter(
    (other) => !(other.entityKey === input.entityKey && other.taskId === input.taskId),
  )
  saveLeases(paths, { version: store.version, leases: [...kept, lease] })

  return {
    granted: true,
    lease,
    conflicts: input.steal ? conflicts : [],
    reason: conflicts.length > 0
      ? `took over ${input.entityKey} from task ${conflicts.map((c) => c.taskId).join(', ')}`
      : `holding ${input.entityKey} until ${expiresAt}`,
  }
}

function kindFromKey(entityKey: string): LeaseKind {
  const [kind] = entityKey.split('::')
  return kind === 'symbol' || kind === 'contract' ? kind : 'file'
}

/** Release one task's lease on one entity, or all of them when no entity is named. */
export function releaseLease(
  paths: WorkspacePaths,
  taskId: string,
  entityKey?: string,
): { released: string[] } {
  const store = loadLeases(paths)
  const released = store.leases
    .filter((lease) => lease.taskId === taskId && (!entityKey || lease.entityKey === entityKey))
    .map((lease) => lease.entityKey)
  const kept = store.leases.filter(
    (lease) => !(lease.taskId === taskId && (!entityKey || lease.entityKey === entityKey)),
  )
  saveLeases(paths, { version: store.version, leases: kept })
  return { released }
}

/** Live leases on an entity held by anyone other than `excludeTaskId`. */
export function leasesOn(
  store: LeaseStore,
  entityKey: string,
  excludeTaskId: string | null,
  now: Date = new Date(),
): Lease[] {
  return liveLeases(store, now).filter(
    (lease) => lease.entityKey === entityKey && lease.taskId !== excludeTaskId,
  )
}

/** Live leases held by one task, which is what a panel shows as "what you hold". */
export function leasesHeldBy(store: LeaseStore, taskId: string, now: Date = new Date()): Lease[] {
  return liveLeases(store, now).filter((lease) => lease.taskId === taskId)
}

/** Anything currently claimed by more than one live task. */
export function contestedLeases(store: LeaseStore, now: Date = new Date()): Array<{
  entityKey: string
  tasks: string[]
  reason: string
}> {
  const byEntity = new Map<string, Lease[]>()
  for (const lease of liveLeases(store, now)) {
    const list = byEntity.get(lease.entityKey) ?? []
    list.push(lease)
    byEntity.set(lease.entityKey, list)
  }
  const out: Array<{ entityKey: string; tasks: string[]; reason: string }> = []
  for (const [entityKey, leases] of byEntity) {
    const tasks = [...new Set(leases.map((lease) => lease.taskId))].sort(compareCodepoint)
    if (tasks.length > 1) out.push({ entityKey, tasks, reason: leases[0].reason })
  }
  return out.sort((a, b) => compareCodepoint(a.entityKey, b.entityKey))
}
