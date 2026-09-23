/**
 * The governor runtime: the ledger plus the policy, wired to a clock and a sink.
 *
 * Kept free of any host import so the whole decision path — what is observed,
 * what a proposal sees, what it decides, what it says — is driven directly from
 * tests. `plugin.ts` is then only the mapping from host events onto these calls.
 *
 * @module dsh-coord-governor/governor
 */

import {
  buildCapsules,
  buildContention,
  entityTouches,
  buildReport,
  entityKey,
  sessionContextLoss,
  Ledger,
} from './ledger.ts'
import {
  buildAdvisory,
  decideWrite,
  renderOverview,
  type GovDecision,
  type WriteProposal,
} from './policy.ts'
import type { CoordConfig } from './config.ts'
import type { Capsule, ContentionRecord, CoordEvent, Entity, LedgerReport } from './types.ts'

/**
 * How a task id was established for an event. Recorded, never guessed silently.
 *
 * - `declared`: the host or harness named the task. The only fully trustworthy kind.
 * - `session-derived`: the session previously declared a task, so this event belongs
 *   to it. This is what makes the H3 probe work: a compaction is attributed to the
 *   task the session was working on, instead of opening a phantom capsule.
 * - `session-fallback`: nothing declared one, so the session stands in as the task.
 *   One session is the smallest attributable unit of work, and E1's scenario starts
 *   here.
 * - `unattributed`: bookkeeping that is not work at all, so it forms no capsule.
 */
export type TaskIdSource = 'declared' | 'session-derived' | 'session-fallback' | 'unattributed'

/**
 * Events that are session bookkeeping rather than work.
 *
 * These must not open capsules. Attributing `session_started` to its own session
 * creates a capsule that never closes, permanently inflating `B(t)` and the
 * capsule count with something that is not a change at all.
 */
export const NON_CAPSULE_KINDS: readonly CoordEvent['kind'][] = [
  'session_started',
  'session_ended',
  'turn_ended',
]

export interface ObserveInput {
  readonly kind: CoordEvent['kind']
  readonly sessionId: string
  readonly taskId?: string | null
  readonly entities?: readonly Entity[]
  readonly intentText?: string | null
  readonly hostEvent?: string | null
  readonly reason?: string | null
  readonly detail?: Readonly<Record<string, unknown>> | null
}

export interface GovernorError {
  readonly handler: string
  readonly message: string
}

/**
 * Orchestrates observation and governance for one plugin instance.
 *
 * One instance serves every session in the process, because cross-session
 * awareness is the whole point. The `ledgerScope` config decides what a given
 * proposal is allowed to *see*, which is how the session-only ablation is
 * expressed without a second code path.
 */
export class GovernorRuntime {
  readonly #config: CoordConfig
  readonly #ledger: Ledger
  readonly #now: () => string
  readonly #errors: GovernorError[] = []
  /**
   * The task each session is currently working on, learned from declared events.
   *
   * Without this, a compaction arriving from `session/event` — which carries no
   * task id — would open a capsule named after the session, leaving the real task's
   * capsule with zero compactions and the H3 probe reading zero forever.
   */
  readonly #sessionTask = new Map<string, string>()

  constructor(config: CoordConfig, options: { sink?: (line: string) => void; now?: () => string } = {}) {
    this.#config = config
    this.#ledger = new Ledger(options.sink)
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  get config(): CoordConfig {
    return this.#config
  }

  get errors(): readonly GovernorError[] {
    return this.#errors
  }

  /**
   * Record one observation, unless this arm is defined not to record.
   *
   * Returns the stored event so a caller can assert what was written; returns
   * `null` when recording is off, which is the difference between `A1` and `A2`.
   */
  observe(input: ObserveInput): CoordEvent | null {
    if (!this.#config.recordObservations) return null

    const { taskId, source } = this.#attribute(input)
    if (source === 'declared') this.#sessionTask.set(input.sessionId, taskId!)

    try {
      return this.#ledger.record({
        kind: input.kind,
        timestampUtc: this.#now(),
        sessionId: input.sessionId,
        taskId,
        entities: input.entities ?? [],
        intentText: input.intentText ?? null,
        hostEvent: input.hostEvent ?? null,
        reason: input.reason ?? null,
        detail: {
          ...(input.detail ?? {}),
          taskIdSource: source satisfies TaskIdSource,
        },
      })
    } catch (error) {
      this.noteError('observe', error)
      return null
    }
  }

  /** Resolve which task an event belongs to, and record how it was decided. */
  #attribute(input: ObserveInput): { taskId: string | null; source: TaskIdSource } {
    // Bookkeeping is not work, so it forms no capsule. Recording it with the
    // session as its task would create a capsule that never closes.
    if (NON_CAPSULE_KINDS.includes(input.kind)) {
      return { taskId: null, source: 'unattributed' }
    }
    const declared = input.taskId
    if (declared != null && declared !== '') return { taskId: declared, source: 'declared' }
    const derived = this.#sessionTask.get(input.sessionId)
    if (derived) return { taskId: derived, source: 'session-derived' }
    return { taskId: input.sessionId, source: 'session-fallback' }
  }

  /**
   * Note that a session compacted its context. The H3 probe depends on this being
   * attributed to the task the session was working on, not to the session itself:
   * see {@link #sessionTask}.
   */
  noteCompaction(sessionId: string): CoordEvent | null {
    return this.observe({ kind: 'context_compacted', sessionId, hostEvent: 'compaction/end' })
  }

  /** Record a lifecycle transition for a task's capsule. */
  noteLifecycle(kind: CoordEvent['kind'], sessionId: string, taskId: string | null, reason?: string): CoordEvent | null {
    return this.observe({ kind, sessionId, taskId, reason: reason ?? null })
  }

  /** Record the outcome of a gate, so the arm's interventions are countable. */
  noteGate(decision: GovDecision, proposal: WriteProposal): CoordEvent | null {
    const kind: CoordEvent['kind'] =
      decision.action === 'deny' ? 'gate_denied' : decision.action === 'ask' ? 'gate_asked' : 'gate_allowed'
    return this.observe({
      kind,
      sessionId: proposal.sessionId,
      taskId: proposal.taskId,
      entities: [{ kind: 'file', identifier: proposal.entityPath, path: proposal.entityPath }],
      reason: decision.reason,
      detail: {
        basis: decision.basis,
        intendedAction: decision.intendedAction,
        interventionClass: decision.interventionClass,
        dryRun: decision.dryRun,
        similarity: decision.similarity,
        otherTasks: decision.otherTasks,
      },
    })
  }

  /**
   * Contention this proposal is permitted to see.
   *
   * This is where `ledgerScope` has teeth. Under `session` the ledger still
   * holds everything, but a proposal is shown only its own session's history —
   * so the governor blocks local duplicates and misses global ones, which is
   * exactly the ablation that asks whether the *shared ledger* is the mechanism.
   */
  /** Events this runtime is allowed to see for a session, given `ledgerScope`. */
  #scopedEvents(sessionId: string): readonly CoordEvent[] {
    if (this.#config.ledgerScope === 'off') return []
    if (this.#config.ledgerScope === 'session') {
      return this.#ledger.events.filter((event) => event.sessionId === sessionId)
    }
    return this.#ledger.events
  }

  /**
   * Touches by someone *other* than this proposal, which is what a decision needs.
   *
   * Built on `entityTouches`, not `buildContention`. The filtered contention list only
   * contains entities with two or more touchers, so a decision based on it cannot see
   * the first other toucher — and the first other toucher is exactly the collision a
   * proposal is about to create. Using the filtered list meant the governor stayed
   * silent on the first duplicate of every entity and only started firing from the
   * second onward, which in E3 would have disabled the treatment on the events the
   * primary outcome is measured from.
   *
   * The session's own touches are excluded, so this means "who else is on this entity"
   * rather than "what is in scope". Under `ledgerScope: 'session'` that yields nothing,
   * which is the ablation's entire point.
   */
  visibleContention(proposal: WriteProposal): ContentionRecord[] {
    return entityTouches(buildCapsules(this.#scopedEvents(proposal.sessionId))).filter((record) => {
      if (record.sessions.some((s) => s !== proposal.sessionId)) return true
      // A null task id means the host named no task, so the task rule cannot say
      // anything; falling back to "all tasks differ" would report the session's own
      // work back to it as if it were someone else's.
      return proposal.taskId != null && record.tasks.some((t) => t !== proposal.taskId)
    })
  }

  /** Apply the policy to one proposed write under the configured scope. */
  decide(proposal: WriteProposal): GovDecision {
    return decideWrite(proposal, this.visibleContention(proposal), this.#config.policy)
  }

  /**
   * Advisory for a specific entity, used where the entity is already known —
   * namely right after a write, attached to the tool result as additional
   * context so the next step can act on it.
   */
  advisory(proposal: WriteProposal, decision: GovDecision): string | null {
    if (!this.#config.advisory) return null
    if (decision.competitors.length === 0) return null

    const loss = sessionContextLoss(this.#ledger.events, proposal.sessionId)
    return buildAdvisory(
      proposal,
      decision,
      { writesAfterContextLoss: loss.writesAfterLoss, compactionEvents: loss.compactions },
      this.#config.advisoryMaxChars,
      this.#config.policy.maxAdvisoryIntentsPerRecord,
    )
  }

  /**
   * The cross-session overview injected before a step.
   *
   * Returns `null` when there is nothing another session is doing that could
   * collide, so an idle repository pays nothing. That silence is a feature: an
   * advisory that always fires trains the model to ignore it, and E6 counts the
   * tokens either way.
   */
  advisoryOverview(sessionId: string): string | null {
    if (!this.#config.advisory) return null
    // `entityTouches` rather than `visibleContention`: the overview deliberately does
    // its own filtering below, because it reports the session's *own* other tasks too,
    // not only other sessions' work. Going through `visibleContention` would silently
    // drop the former.
    const relevant = entityTouches(buildCapsules(this.#scopedEvents(sessionId))).filter(
      (record) => record.tasks.length > 1 || record.sessions.some((s) => s !== sessionId),
    )

    if (relevant.length === 0) return null

    const loss = sessionContextLoss(this.#ledger.events, sessionId)
    return renderOverview(
      relevant,
      sessionId,
      { writesAfterContextLoss: loss.writesAfterLoss, compactionEvents: loss.compactions },
      this.#config.advisoryMaxChars,
      this.#config.policy.maxAdvisoryIntentsPerRecord,
    )
  }

  /** Derive every framework quantity for this instance's ledger. */
  report(): LedgerReport {
    return buildReport(this.#ledger.events)
  }

  /**
   * The derived capsules, exposed for tests and for the harness.
   *
   * `report()` summarizes them, but the H3 probe needs the per-capsule detail
   * (`nCompactEvents` against `writesAfterCompact`), so that a probe silently
   * reading zero is caught rather than aggregated away.
   */
  capsules(): Map<string, Capsule> {
    return buildCapsules(this.#ledger.events)
  }

  /** Every event seen, for the E0 cross-check against the host's own log. */
  get events(): readonly CoordEvent[] {
    return this.#ledger.events
  }

  /** Contain a fault so a defect here can never take the agent down. */
  noteError(handler: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.#errors.push({ handler, message })
    if (this.#errors.length > 100) this.#errors.shift()
  }
}

/** Build the ledger key for a raw path, matching what proposals must use. */
export function keyForPath(path: string, kind = 'file'): string {
  return entityKey({ kind, identifier: path, path })
}
