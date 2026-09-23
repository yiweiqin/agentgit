/**
 * Text output for the terminal.
 *
 * Plain ASCII structure rather than box drawing or colour, for three reasons: the
 * output gets pasted into issues and chat, where alignment escapes are noise; the
 * commands are run by agents as often as by people, and an agent reading box
 * characters has to strip them; and colour can always be added later on top of text
 * that is already correct without it.
 *
 * @module @agentgit/cli/output
 */

import {
  compareCodepoint,
  currentVersion,
  kindOfVerdict,
  type BoardView,
  type CoordEvent,
  type PreflightResult,
  type StaleAssumption,
  type Verdict,
  type WorkspaceConfig,
} from '@agentgit/core'
import { ago, baseName, shortPath, truncate, until, VERDICT_ACTION } from '@agentgit/board'

function heading(title: string): string {
  return `\n${title}\n${'-'.repeat(title.length)}`
}

/**
 * `2 touches`, not `2 touchs`.
 *
 * Derived from the spelling rather than a table, because a table has to be kept in step
 * with every call site and the failure is invisible: a missing entry quietly prints
 * `2 touchs`, and a reader who does not trust the grammar of a line does not trust its
 * numbers either. The sibilant and consonant-plus-y rules cover every noun used here.
 */
function plural(noun: string): string {
  if (/(s|x|z|ch|sh)$/.test(noun)) return `${noun}es`
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`
  return `${noun}s`
}

function counts(n: number, noun: string): string {
  return `${n} ${n === 1 ? noun : plural(noun)}`
}

/** `agentgit status` - the answer to "what is going on here". */
export function renderStatus(view: BoardView, config: WorkspaceConfig): string {
  const lines: string[] = []
  const open = view.tasks.filter((t) => t.state === 'proposed' || t.state === 'active' || t.state === 'validated')

  lines.push(`workspace        : ${view.workspace}`)
  lines.push(`machine shard    : ${view.machine}`)
  lines.push(`coordination debt: ${view.debt.score}/100${view.debt.drivers.length > 0 ? `  (${view.debt.drivers.join('; ')})` : ''}`)
  lines.push('')
  lines.push(`tasks in flight  : ${counts(open.length, 'task')}${open.length > 0 ? ` of ${view.tasks.length} recorded` : ''}`)
  lines.push(`collisions       : ${counts(view.collisions.length, 'entity')}${view.collisions.filter((c) => c.live).length > 0 ? `, ${view.collisions.filter((c) => c.live).length} with a live lease` : ''}`)
  lines.push(`live leases      : ${counts(view.leases.length, 'lease')}`)
  lines.push(`contracts        : ${counts(view.contracts.length, 'interface')}`)
  lines.push(`stale assumptions: ${counts(view.debt.breakdown.staleAssumptions, 'assumption')}`)

  if (open.length > 0) {
    lines.push(heading('In flight'))
    for (const task of open) {
      const intent = task.intents[0] ? ` - ${truncate(task.intents[0], 70)}` : ''
      lines.push(`  ${truncate(task.taskId, 34)}  ${task.state.padEnd(10)} ${counts(task.writes, 'write')}${intent}`)
      if (task.leases.length > 0) lines.push(`    holds: ${task.leases.map((e) => shortPath(e.replace(/^[a-z]+::/, ''), 50)).join(', ')}`)
      if (task.staleContracts.length > 0) lines.push(`    stale: ${task.staleContracts.join(', ')}`)
    }
  }

  if (view.collisions.length > 0) {
    lines.push(heading('Collision radar'))
    for (const collision of view.collisions.slice(0, 12)) {
      const same = collision.sameWork === null ? 'unknown' : collision.sameWork ? 'same work' : 'different work'
      lines.push(`  ${shortPath(collision.entityKey.replace(/^[a-z]+::/, ''), 56)}`)
      lines.push(`    ${counts(collision.tasks.length, 'task')}, ${counts(collision.sessions.length, 'session')}, ${counts(collision.touches, 'touch')} - ${same}${collision.live ? ' - live lease' : ''}`)
      for (const intent of collision.intents.slice(0, 2)) lines.push(`      "${truncate(intent, 88)}"`)
    }
  }

  lines.push(heading('Ledger'))
  lines.push(`  ${counts(view.diagnostics.events, 'event')} across ${counts(view.diagnostics.shards, 'shard')} (${(view.diagnostics.bytes / 1024).toFixed(1)} KiB)`)
  if (view.diagnostics.malformedEvents > 0) {
    lines.push(`  ${counts(view.diagnostics.malformedEvents, 'line')} could not be parsed - a torn write, most likely. The rest of the ledger is unaffected.`)
  }
  lines.push(`  ignored: ${config.ignore.join(', ')}`)
  lines.push('')
  lines.push(view.debt.score === 0 ? 'Nothing is waiting on anyone.' : `Start with: agentgit board`)

  return `${lines.join('\n')}\n`
}

/** `agentgit board` - the same view the live page renders, in text. */
export function renderBoard(view: BoardView): string {
  const lines: string[] = []
  lines.push(`${view.workspace}  -  ${ago(view.generatedAt)}  -  debt ${view.debt.score}/100`)

  lines.push(heading('Tasks'))
  if (view.tasks.length === 0) lines.push('  (none)')
  for (const task of view.tasks) {
    lines.push(`  ${truncate(task.taskId, 40)}  ${task.state.padEnd(10)} opened ${ago(task.openedAt)}`)
    lines.push(`    sessions: ${task.sessions.join(', ') || '(none)'}  writes: ${task.writes}  entities: ${task.entities.length}`)
    if (task.leases.length > 0) lines.push(`    holds: ${task.leases.join(', ')}`)
    if (task.staleContracts.length > 0) lines.push(`    stale: ${task.staleContracts.join(', ')}`)
    for (const intent of task.intents.slice(0, 2)) lines.push(`    intent: "${truncate(intent, 84)}"`)
  }

  lines.push(heading('Collisions'))
  if (view.collisions.length === 0) lines.push('  (none)')
  for (const collision of view.collisions) {
    const same = collision.sameWork === null ? 'unknown' : collision.sameWork ? 'same work' : 'different work'
    lines.push(`  ${collision.entityKey}${collision.live ? '  [live]' : ''}`)
    lines.push(`    tasks: ${collision.tasks.join(', ')}`)
    lines.push(`    sessions: ${collision.sessions.join(', ')}`)
    lines.push(`    ${counts(collision.touches, 'touch')} - ${same}`)
  }

  lines.push(heading('Live leases'))
  if (view.leases.length === 0) lines.push('  (none)')
  for (const lease of view.leases) {
    lines.push(`  ${lease.entityKey}`)
    lines.push(`    ${lease.taskId} (${lease.sessionId}) - ${until(lease.expiresAt)}`)
    lines.push(`    reason: ${truncate(lease.reason, 88)}`)
  }
  if (view.contestedLeases.length > 0) {
    lines.push(heading('Two tasks on one lease'))
    for (const contested of view.contestedLeases) {
      lines.push(`  ${contested.entityKey} -> ${contested.tasks.join(', ')}`)
    }
  }

  lines.push(heading('Contracts'))
  if (view.contracts.length === 0) lines.push('  (none published)')
  for (const contract of view.contracts) {
    lines.push(`  ${contract.name}  v${contract.version}  ${contract.breaking ? 'BREAKING' : 'additive'}  by ${contract.publishedBy}`)
    lines.push(`    ${truncate(contract.summary, 92)}`)
    if (contract.declaredIn) lines.push(`    declared in ${contract.declaredIn}`)
  }

  return `${lines.join('\n')}\n`
}

/** The verdict block, which is what an agent reads. */
export function renderPreflight(result: PreflightResult, opts: { json: boolean } = { json: false }): string {
  if (opts.json) return `${JSON.stringify(result, null, 2)}\n`

  const lines: string[] = []
  lines.push(`verdict : ${result.verdict.toUpperCase()}  (${kindOfVerdict(result.verdict)})`)
  lines.push(`entity  : ${result.entityKey}`)
  lines.push(`task    : ${result.taskId}`)
  lines.push(`version : ${result.version}   ttl ${result.ttlSeconds}s`)
  lines.push('')
  lines.push(result.reason)

  if (result.evidence.competitors.length > 0) {
    lines.push('')
    lines.push('competing work:')
    for (const record of result.evidence.competitors) {
      lines.push(`  ${record.entityKey}`)
      lines.push(`    tasks: ${record.tasks.join(', ') || '(none)'}  sessions: ${record.sessions.join(', ') || '(none)'}  touches: ${record.touches}`)
      for (const intent of record.intents.slice(0, 3)) lines.push(`    intent: "${truncate(intent, 84)}"`)
    }
  }
  if (result.evidence.leaseConflicts.length > 0) {
    lines.push('')
    lines.push('held by:')
    for (const lease of result.evidence.leaseConflicts) {
      lines.push(`  ${lease.taskId} until ${lease.expiresAt} - ${truncate(lease.reason, 80)}`)
    }
  }
  if (result.evidence.staleAssumptions.length > 0) {
    lines.push('')
    lines.push('expired assumptions:')
    for (const stale of result.evidence.staleAssumptions) {
      lines.push(`  ${stale.contract}: coded against v${stale.assumedVersion}, current is v${stale.currentVersion}${stale.breaking ? ' (breaking)' : ''}`)
      lines.push(`    ${stale.summary}`)
    }
  }
  if (result.nextActions.length > 0) {
    lines.push('')
    lines.push('next:')
    for (const action of result.nextActions) lines.push(`  ${action}`)
  }
  lines.push('')
  lines.push(VERDICT_ACTION[result.verdict])
  return `${lines.join('\n')}\n`
}

export interface ReconcileView {
  readonly stale: readonly StaleAssumption[]
  readonly order: readonly { taskId: string; branch: string; reason: string; blocking: boolean }[]
  readonly merge: readonly { a: string; b: string; clean: boolean; message: string }[]
  readonly dirty: boolean
  readonly branch: string | null
}

/** `agentgit reconcile` - what to do next, and what it will take. */
export function renderReconcile(view: ReconcileView): string {
  const lines: string[] = []
  lines.push(`on branch ${view.branch ?? '(detached HEAD)'}${view.dirty ? ' with uncommitted changes' : ''}`)

  lines.push(heading('Expired assumptions'))
  if (view.stale.length === 0) lines.push('  (none)')
  for (const stale of view.stale) {
    lines.push(`  ${stale.taskId}: ${stale.contract} v${stale.assumedVersion} -> v${stale.currentVersion}${stale.breaking ? '  BREAKING' : ''}`)
    lines.push(`    ${stale.summary}`)
  }

  lines.push(heading('Integration order'))
  if (view.order.length === 0) lines.push('  (no task branches yet)')
  for (const [index, item] of view.order.entries()) {
    lines.push(`  ${index + 1}. ${item.taskId}  (${item.branch})${item.blocking ? '  [others depend on this]' : ''}`)
    lines.push(`     ${item.reason}`)
  }

  lines.push(heading('Ghost merge'))
  if (view.merge.length === 0) lines.push('  (nothing to compare)')
  for (const pair of view.merge) {
    lines.push(`  ${pair.a} + ${pair.b}: ${pair.clean ? 'merges cleanly' : `conflicts - ${pair.message}`}`)
  }
  if (view.merge.some((pair) => pair.clean)) {
    lines.push('')
    lines.push('  A clean merge is not a working result. It only means no text conflicted;')
    lines.push('  a breaking interface change still merges cleanly and still breaks at run time.')
  }

  lines.push(heading('Yours to run'))
  if (view.order.length > 0) {
    lines.push('  agentgit emits these; it does not run them.')
    for (const [index, item] of view.order.entries()) {
      lines.push(`  # ${index + 1}. ${item.taskId}`)
      lines.push(`  git merge ${item.branch}          # while on ${view.branch ?? '<your branch>'}`)
    }
  } else {
    lines.push('  (nothing to merge)')
  }
  return `${lines.join('\n')}\n`
}

export interface DoctorCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
  readonly fix?: string
}

/** `agentgit doctor` - every precondition, stated as a pass or a fix. */
export function renderDoctor(checks: readonly DoctorCheck[], version: string): string {
  const lines: string[] = []
  const bad = checks.filter((check) => !check.ok)
  lines.push(`agentgit doctor  (${version})`)
  lines.push('')
  for (const check of checks) {
    lines.push(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name.padEnd(28)} ${check.detail}`)
    if (!check.ok && check.fix) lines.push(`     fix: ${check.fix}`)
  }
  lines.push('')
  lines.push(bad.length === 0 ? 'Everything the plugin needs is in place.' : `${counts(bad.length, 'check')} failed.`)
  return `${lines.join('\n')}\n`
}

/** A one-line summary, used by `--quiet` and by the MCP tool results. */
export function renderVerdictLine(verdict: Verdict, reason: string): string {
  return `${verdict.toUpperCase()}: ${reason}`
}

/** Contract list, used by `agentgit contracts list` and by the panel's text twin. */
export function renderContracts(
  registry: readonly {
    name: string
    version: number
    breaking: boolean
    symbol: string | null
    declaredIn: string | null
    publishedBy: string
    summary: string
    /** Present only when the list came from version history rather than the board view. */
    versions?: number
  }[],
): string {
  if (registry.length === 0) return 'No interface has been published yet.\n'
  const lines: string[] = []
  for (const contract of registry) {
    lines.push(`${contract.name}  v${contract.version}${contract.breaking ? '  BREAKING' : ''}`)
    if (contract.versions !== undefined) lines.push(`  ${contract.versions} version(s)`)

    lines.push(`  latest published by ${contract.publishedBy}`)
    if (contract.symbol) lines.push(`  symbol: ${contract.symbol}`)
    if (contract.declaredIn) lines.push(`  declared in: ${contract.declaredIn}`)
    lines.push(`  ${truncate(contract.summary, 100)}`)
  }
  return `${lines.join('\n')}\n`
}

/** `agentgit lease list`. */
export function renderLeases(
  leases: readonly { entityKey: string; taskId: string; sessionId: string; reason: string; expiresAt: string; renewedAt: string }[],
): string {
  if (leases.length === 0) return 'No lease is held.\n'
  const lines: string[] = []
  for (const lease of leases) {
    lines.push(`${lease.entityKey}  ->  ${lease.taskId}`)
    lines.push(`  held by session ${lease.sessionId} - renewed ${ago(lease.renewedAt)} - ${until(lease.expiresAt)}`)
    lines.push(`  reason: ${truncate(lease.reason, 96)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Current version of a named contract, or a message naming the miss. */
export function renderContract(
  registry: Parameters<typeof currentVersion>[0],
  name: string,
): string {
  const contract = currentVersion(registry, name)
  if (!contract) return `No interface named ${name} has been published.\n`
  return `${JSON.stringify(contract, null, 2)}\n`
}

/**
 * `agentgit why` - the event history behind one answer.
 *
 * Printed oldest first, unlike every other view, because the question "why did it
 * say that" is a question about a sequence. A newest-first list makes the reader
 * reconstruct the order by eye, which is the work this command exists to save.
 */
export function renderWhy(target: string, key: string, events: readonly CoordEvent[]): string {
  if (events.length === 0) {
    return `Nothing in the ledger mentions ${target}.\n\nThat is itself an answer: a verdict about it was reached from a lease, an interface\nversion, or the current plan, not from recorded history.\n`
  }

  const ordered = [...events].sort((a, b) => compareCodepoint(a.timestampUtc, b.timestampUtc))
  const lines: string[] = []
  lines.push(`${counts(ordered.length, 'event')} mention ${key}`)
  // Only when the lookup resolved through a different key than the one typed — a path that
  // became `file::<path>`. A task id is reported as itself, because that is what was asked.
  if (key !== target) lines.push(`(looked up as ${key})`)

  const sessions = new Set(ordered.map((event) => event.sessionId))
  const tasks = new Set(ordered.map((event) => event.taskId).filter((taskId): taskId is string => Boolean(taskId)))
  lines.push(`sessions: ${[...sessions].join(', ')}`)
  lines.push(`tasks   : ${[...tasks].join(', ') || '(unattributed)'}`)

  lines.push(heading('Timeline'))
  for (const event of ordered) {
    const when = event.timestampUtc.replace('T', ' ').slice(0, 19)
    lines.push(`  ${when}  ${event.kind.padEnd(18)} ${truncate(event.taskId ?? '(no task)', 26)}`)
    lines.push(`    session ${event.sessionId}${event.hostEvent ? ` via ${event.hostEvent}` : ''}`)
    if (event.reason) lines.push(`    ${truncate(event.reason, 110)}`)
    if (event.intentText) lines.push(`    intent: "${truncate(event.intentText, 100)}"`)
    for (const entity of event.entities ?? []) {
      lines.push(`    - ${entity.kind} ${entity.identifier}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export { baseName }