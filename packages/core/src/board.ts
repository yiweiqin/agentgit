/**
 * The board: one derived view of a workspace, for both the panel and the daemon.
 *
 * The panel and the daemon must never disagree, because a user who sees a
 * collision in one and not the other stops trusting both. They therefore share
 * this function rather than each deriving their own summary. The only difference
 * between them is how often it is called and how the result is delivered: the
 * panel embeds it at generation time, the daemon pushes it over SSE on change.
 *
 * Everything here is derived. Nothing in this module writes, so it is safe to call
 * on a timer.
 *
 * @module @agentgit/core/board
 */

import { currentVersion, loadAssumptions, loadContracts, staleAssumptions } from './contracts.ts'
import { buildCapsules, buildContention, buildReport, compareCodepoint, entityTouches } from './ledger.ts'
import { contestedLeases, leasesHeldBy, liveLeases, loadLeases } from './leases.ts'
import { intentSimilarity } from './policy.ts'
import {
  loadConfig,
  machineId,
  readAllEvents,
  spoolStats,
  type WorkspaceConfig,
  type WorkspacePaths,
} from './workspace.ts'
import type { Capsule, ContentionRecord, LedgerReport } from './types.ts'

/** One task as the board presents it. */
export interface BoardTask {
  readonly taskId: string
  readonly state: Capsule['state']
  readonly openedAt: string
  readonly sessions: readonly string[]
  readonly entities: readonly string[]
  readonly intents: readonly string[]
  readonly writes: number
  readonly leases: readonly string[]
  readonly staleContracts: readonly string[]
}

/** One entity two or more in-flight tasks want. */
export interface BoardCollision {
  readonly entityKey: string
  readonly tasks: readonly string[]
  readonly sessions: readonly string[]
  readonly intents: readonly string[]
  readonly touches: number
  /** True when two live leases cover it, i.e. someone is on it right now. */
  readonly live: boolean
  /**
   * Whether the competing intents look like the same work.
   *
   * Carried rather than collapsed into the flag because the two cases call for
   * opposite actions: the same work is a duplicate to reuse, different work is a
   * plan to renegotiate.
   */
  readonly sameWork: boolean | null
}

/** The numbers behind the coordination-debt score. */
export interface DebtBreakdown {
  readonly collisions: number
  readonly staleAssumptions: number
  readonly unprotected: number
  readonly unclaimed: number
}

export interface DebtScore {
  readonly score: number
  readonly breakdown: DebtBreakdown
  /** Human-readable biggest contributors, worst first. */
  readonly drivers: readonly string[]
}

export interface BoardView {
  readonly workspace: string
  readonly machine: string
  /**
   * The arm that produced this view, so the numbers can be read against it.
   *
   * Carried on the view rather than looked up by each renderer because a board is a snapshot
   * of a moment, and the arm is part of what that moment could see. A panel that showed
   * counts without it would invite exactly the wrong question — "why is nothing collided?" —
   * when the answer is that this workspace was running the session-only ablation.
   */
  readonly arm: string
  readonly generatedAt: string
  readonly report: LedgerReport
  readonly tasks: readonly BoardTask[]
  readonly collisions: readonly BoardCollision[]
  readonly leases: ReturnType<typeof liveLeases>
  readonly contestedLeases: ReturnType<typeof contestedLeases>
  readonly contracts: ReturnType<typeof registryViewSafe>
  readonly debt: DebtScore
  readonly diagnostics: {
    readonly events: number
    readonly malformedEvents: number
    readonly shards: number
    readonly bytes: number
  }
}

function registryViewSafe(paths: WorkspacePaths) {
  const registry = loadContracts(paths)
  return [...new Set(registry.contracts.map((contract) => contract.name))]
    .sort(compareCodepoint)
    .map((name) => {
      const current = currentVersion(registry, name)!
      return {
        name,
        version: current.version,
        breaking: current.breaking,
        symbol: current.symbol,
        declaredIn: current.declaredIn,
        publishedBy: current.publishedBy,
        summary: current.summary,
      }
    })
}

/**
 * Coordination debt in `[0, 100]`, higher is worse.
 *
 * The weights are deliberately simple and visible rather than tuned, for the same
 * reason a linter shows its rule names: a score nobody can recompute by hand gets
 * ignored the first time it disagrees with intuition, and then it gets ignored
 * permanently. Each term is capped so one runaway term cannot saturate the score
 * and hide the others.
 */
export function computeDebt(input: {
  collisions: number
  breakingStale: number
  unprotected: number
  unclaimed: number
  openTasks: number
}): DebtScore {
  const collisions = Math.min(30, input.collisions * 6)
  const stale = Math.min(30, input.breakingStale * 5)
  const unprotected = Math.min(25, input.unprotected * 5)
  const unclaimed = Math.min(15, input.unclaimed * 3)
  const score = Math.round(collisions + stale + unprotected + unclaimed)

  const drivers: string[] = []
  if (input.collisions > 0) drivers.push(`${input.collisions} in-flight collision(s)`)
  if (input.breakingStale > 0) drivers.push(`${input.breakingStale} stale assumption(s) on breaking interfaces`)
  if (input.unprotected > 0) drivers.push(`${input.unprotected} live task(s) holding no lease`)
  if (input.unclaimed > 0) drivers.push(`${input.unclaimed} unclaimed write(s)`)

  return {
    score,
    breakdown: {
      collisions: input.collisions,
      staleAssumptions: input.breakingStale,
      unprotected: input.unprotected,
      unclaimed: input.unclaimed,
    },
    drivers,
  }
}

/**
 * Build the whole view.
 *
 * `paths` is passed in rather than discovered, so the daemon can serve several
 * workspaces from one process without the answer depending on its own directory.
 */
export function buildBoardView(
  paths: WorkspacePaths,
  config: WorkspaceConfig = loadConfig(paths),
  now: Date = new Date(),
): BoardView {
  const { events, malformed } = readAllEvents(paths)
  const report = buildReport(events)
  const capsules = buildCapsules(events)
  const contention = buildContention(capsules)
  const touches = entityTouches(capsules).filter((record) => record.tasks.length > 1 || record.sessions.length > 1)
  const leaseStore = loadLeases(paths)
  const live = liveLeases(leaseStore, now)

  // Ground a task is on, either by holding a lease or by being named in one. The two are
  // not the same: a share is only coverage while the task also holds its own lease on that
  // entity. Counting a bare permission as coverage would let a released task keep showing
  // up as protected by an agreement it is no longer acting on.
  const holdersByEntity = new Map<string, Set<string>>()
  for (const lease of live) {
    const holders = holdersByEntity.get(lease.entityKey) ?? new Set<string>()
    holders.add(lease.taskId)
    holdersByEntity.set(lease.entityKey, holders)
  }

  const held = new Map<string, string[]>()
  const cover = (taskId: string, entityKey: string): void => {
    const entities = held.get(taskId) ?? []
    if (!entities.includes(entityKey)) entities.push(entityKey)
    held.set(taskId, entities)
  }
  for (const lease of live) {
    cover(lease.taskId, lease.entityKey)
    const holders = holdersByEntity.get(lease.entityKey)!
    for (const shared of lease.shareWith) {
      if (holders.has(shared)) cover(shared, lease.entityKey)
    }
  }

  const registry = loadContracts(paths)
  const stale = staleAssumptions(loadAssumptions(paths), registry)
  const staleByTask = new Map<string, string[]>()
  for (const entry of stale) {
    staleByTask.set(entry.taskId, [...(staleByTask.get(entry.taskId) ?? []), entry.contract])
  }

  const tasks: BoardTask[] = [...capsules.values()]
    .sort((a, b) => compareCodepoint(b.openedAtUtc, a.openedAtUtc))
    .map((capsule) => ({
      taskId: capsule.taskId,
      state: capsule.state,
      openedAt: capsule.openedAtUtc,
      sessions: capsule.sessions,
      entities: [...capsule.entities.values()].map((record) => record.identifier),
      intents: [...new Set([...capsule.entities.values()].flatMap((record) => record.intents))],
      writes: [...capsule.entities.values()].reduce((sum, record) => sum + record.touches, 0),
      leases: held.get(capsule.taskId) ?? [],
      staleContracts: [...new Set(staleByTask.get(capsule.taskId) ?? [])],
    }))

  const collisions: BoardCollision[] = touches.map((record) => {
    const liveLeaseTasks = new Set(
      live.filter((lease) => lease.entityKey === record.entityKey).map((lease) => lease.taskId),
    )
    return {
      entityKey: record.entityKey,
      tasks: record.tasks,
      sessions: record.sessions,
      intents: record.intents,
      touches: record.touches,
      live: liveLeaseTasks.size > 1,
      sameWork: compareIntents(record),
    }
  })

  const openTasks = tasks.filter((task) => task.state === 'proposed' || task.state === 'active' || task.state === 'validated')
  const unprotected = openTasks.filter((task) => (held.get(task.taskId) ?? []).length === 0).length
  const unclaimed = openTasks.filter(
    (task) => task.writes > 0 && !events.some((event) => event.taskId === task.taskId && event.hostEvent === 'preflight'),
  ).length

  const stats = spoolStats(paths)

  return {
    workspace: paths.root,
    machine: machineId(),
    arm: config.arm,
    generatedAt: now.toISOString(),
    report,
    tasks,
    collisions,
    leases: live,
    contestedLeases: contestedLeases(leaseStore, now),
    contracts: registryViewSafe(paths),
    debt: computeDebt({
      collisions: collisions.filter((collision) => collision.live).length,
      breakingStale: stale.filter((entry) => entry.breaking).length,
      unprotected,
      unclaimed,
      openTasks: openTasks.length,
    }),
    diagnostics: {
      events: report.counts.events,
      malformedEvents: malformed,
      shards: stats.shards,
      bytes: stats.bytes,
    },
  }
}

/**
 * Are the competing intents on one entity the same work?
 *
 * `null` when there is not enough text to tell, which is reported as unknown rather
 * than as `false`. Calling an unknown collision "different work" would push a real
 * duplicate toward `replan`, which asks the agent to do the opposite of what it
 * should.
 */
function compareIntents(record: ContentionRecord): boolean | null {
  const intents = record.intents.filter((intent) => intent.trim().length > 0)
  if (intents.length < 2) return null
  let best = 0
  for (let i = 0; i < intents.length; i += 1) {
    for (let j = i + 1; j < intents.length; j += 1) {
      best = Math.max(best, intentSimilarity(intents[i], intents[j]))
    }
  }
  return best >= 0.42
}

/** Live leases held by one task, for the panel's "what you hold" section. */
export function heldBy(paths: WorkspacePaths, taskId: string, now: Date = new Date()) {
  return leasesHeldBy(loadLeases(paths), taskId, now)
}

/** A one-line summary suitable for a CLI banner. */
export function summarise(view: BoardView): string {
  const { debt, report } = view
  return (
    `coordination debt ${debt.score}/100 · ` +
    `${report.counts.openCapsules} open task(s) · ` +
    `${view.collisions.length} collision(s) · ` +
    `${debt.breakdown.staleAssumptions} stale assumption(s)`
  )
}
