/**
 * E2: measure detection accuracy against construction truth.
 *
 * Why this is separate from E3
 * ---------------------------
 * "Did the detector see the collision?" and "did the governor help?" are different
 * questions, and a study that only asks the second cannot diagnose a null result:
 * a zero effect is consistent with a working detector used badly, and with a
 * detector that never fires. E2 answers the first, so E3's outcome is
 * interpretable either way. This is what iteration trigger I6 exists for.
 *
 * The ground truth is constructed, never inferred from the detector's output.
 *
 * Two truth levels, deliberately
 * ------------------------------
 * A shared entity is not a coordination failure. Hard constraint H9 requires that
 * overlap alone never be treated as evidence of one: two tasks can touch one file
 * for unrelated reasons. So the pack labels each proposal with a *purpose* truth,
 * and a shared-entity-different-purpose proposal counts as a `independent` —
 * strictly, and by construction. That makes same-entity-different-purpose the
 * precision trap the pack is built around, and it makes denying such a write a real
 * false rejection rather than a technicality.
 *
 * The hidden-dependency category is unreachable by entity overlap by construction.
 * It is in the pack not as a detector failure but as the *ceiling*: no entity-key
 * detector can exceed the share of collisions that are entity-visible, and E2 must
 * report that ceiling instead of scoring against a target it cannot reach.
 *
 * @module dsh-coord-governor/e2
 */

import { buildCapsules, entityKey, entityTouches } from './ledger.ts'
import { decideWrite, type DetectionBasis, type GovAction, type PolicyConfig, type WriteProposal } from './policy.ts'
import type { CoordEvent, ContentionRecord } from './types.ts'
import { buildEvent } from './ledger.ts'
import type { Entity } from './types.ts'

export const TASKPACK_SCHEMA_VERSION = 'coord-taskpack-0.1'

/** The four structures the plan requires the pack to contain. */
export type TruthKind =
  | 'true-collision'
  | 'semantic-duplicate'
  | 'independent-control'
  | 'hidden-dependency'

/** What the proposal actually is, decided when the pack was authored. */
export type PurposeTruth = 'collision' | 'independent'

export interface PackPriorEvent {
  readonly minute: number
  readonly kind: CoordEvent['kind']
  readonly sessionId: string
  readonly taskId: string | null
  readonly entityPath?: string
  readonly intentText?: string | null
}

export interface PackProposal {
  readonly id: string
  readonly sessionId: string
  readonly taskId: string
  readonly entityPath: string
  readonly intentText: string | null
  readonly truth: PurposeTruth
  readonly truthKind: TruthKind
  readonly why: string
}

export interface TaskPack {
  readonly pack: string
  readonly schemaVersion: string
  readonly description: string
  readonly priorEvents: readonly PackPriorEvent[]
  readonly proposals: readonly PackProposal[]
}

/** One proposal's outcome, kept per-item so a metric can always be traced to a case. */
export interface ProposalOutcome {
  readonly id: string
  readonly truthKind: TruthKind
  readonly truth: PurposeTruth
  /**
   * Whether some other task or session had already touched this entity.
   *
   * *Derived from the pack's prior events*, never declared. The first version of this
   * pack declared it, and two proposals were declared non-overlapping while sitting on
   * entities other tasks had already written — so the "hidden dependency" was in fact
   * plainly visible and the "independent control" was not independent. Declared
   * structure can be wrong; derived structure cannot.
   */
  readonly overlapsPriorWork: boolean
  /** True when the detector raised the entity at all (any non-passive basis). */
  readonly detected: boolean
  readonly detection: DetectionBasis
  readonly action: GovAction
  readonly intendedAction: GovAction
  readonly similarity: number | null
  readonly why: string
}

export interface DetectionMetrics {
  readonly pack: string
  readonly n: number
  readonly tp: number
  readonly fp: number
  readonly fn: number
  readonly tn: number
  /** Precision against purpose truth: flagged collisions / all flagged. */
  readonly precision: number
  readonly recall: number
  readonly f1: number
  /** Share of independent controls the detector raised. */
  readonly controlFlagRate: number
  /** Share of independent controls the policy would actually refuse. */
  readonly falseRejectionRate: number
  /**
   * Share of true collisions that entity overlap could ever reach.
   *
   * The hard ceiling for this mechanism. Reported so a recall figure is read against
   * what is achievable rather than against 1.0.
   */
  readonly entityVisibleCeiling: number
  /** Recall restricted to the collisions this mechanism can in principle see. */
  readonly recallWithinCeiling: number
  readonly byTruthKind: Readonly<Record<string, { n: number; detected: number }>>
  readonly outcomes: readonly ProposalOutcome[]
}

const FILE_ENTITY = (path: string): Entity => ({ kind: 'file', identifier: path, path })

/** Decode a raw pack, failing loudly on anything malformed. */
export function parsePack(raw: unknown): TaskPack {
  const pack = raw as TaskPack
  if (!pack || typeof pack !== 'object') throw new Error('task pack must be an object')
  if (pack.schemaVersion !== TASKPACK_SCHEMA_VERSION) {
    throw new Error(
      `task pack schema is ${String(pack.schemaVersion)}, expected ${TASKPACK_SCHEMA_VERSION}: ` +
        'a pack authored against another schema has ground truth this evaluator cannot trust',
    )
  }
  if (!Array.isArray(pack.proposals) || pack.proposals.length === 0) {
    throw new Error('task pack has no proposals')
  }
  if (!Array.isArray(pack.priorEvents)) throw new Error('task pack has no priorEvents array')
  const ids = new Set<string>()
  for (const proposal of pack.proposals) {
    if (ids.has(proposal.id)) throw new Error(`duplicate proposal id: ${proposal.id}`)
    ids.add(proposal.id)
  }
  return pack
}

/**
 * Replay prior events into the entity touches the detector would have seen.
 *
 * Uses `entityTouches` rather than `buildContention`. Each collision in this pack has
 * exactly one prior toucher, which is what a first collision actually looks like, and
 * the filtered contention list deliberately excludes that case. Scoring against the
 * filtered list measured an evaluator that could not see the pack's collisions at all
 * (recall 0 with every proposal reported as "no contention").
 */
export function priorContention(pack: TaskPack, baseIso: string): ContentionRecord[] {
  const base = Date.parse(baseIso)
  const events: CoordEvent[] = pack.priorEvents.map((prior) =>
    buildEvent({
      kind: prior.kind,
      timestampUtc: new Date(base + prior.minute * 60_000).toISOString(),
      sessionId: prior.sessionId,
      taskId: prior.taskId,
      entities: prior.entityPath ? [FILE_ENTITY(prior.entityPath)] : [],
      intentText: prior.intentText ?? null,
    }),
  )
  return entityTouches(buildCapsules(events))
}

function proposalOf(proposal: PackProposal): WriteProposal {
  const entity = FILE_ENTITY(proposal.entityPath)
  return {
    entityKey: entityKey(entity),
    entityPath: proposal.entityPath,
    sessionId: proposal.sessionId,
    taskId: proposal.taskId,
    intentText: proposal.intentText,
  }
}

/** The bases that mean "the entity was raised", as opposed to passed over. */
const RAISED: readonly DetectionBasis[] = ['duplicate-intent', 'cross-task-conflict', 'cross-session-same-task']

/**
 * Score one pack.
 *
 * Each proposal is judged against the ledger as it stood *before* any proposal in the
 * pack was written. Letting proposals see each other would make the result depend on
 * pack ordering, and ordering is exactly the thing the experiment must not smuggle in
 * as an effect.
 */
export function evaluatePack(
  pack: TaskPack,
  config: PolicyConfig,
  options: { readonly baseIso?: string; readonly label?: string } = {},
): DetectionMetrics {
  const baseIso = options.baseIso ?? '2026-04-01T00:00:00Z'
  const contention = priorContention(pack, baseIso)

  // Overlap is derived from the prior events, and the declared truth is checked
  // against it. A pack whose labels contradict its own event stream would score the
  // detector against a fiction, and it would do so silently: the metrics would look
  // plausible and be meaningless. Refusing to score is the only safe response.
  const overlaps = new Map<string, boolean>()
  for (const proposal of pack.proposals) {
    const key = entityKey(FILE_ENTITY(proposal.entityPath))
    const record = contention.find((r) => r.entityKey === key)
    const byOther = record
      ? record.tasks.some((t) => t !== proposal.taskId) ||
        record.sessions.some((s) => s !== proposal.sessionId)
      : false
    overlaps.set(proposal.id, byOther)

    if (proposal.truthKind === 'hidden-dependency' && byOther) {
      throw new Error(
        `proposal ${proposal.id} is labelled a hidden dependency, but another task or ` +
          `session already touched ${proposal.entityPath}. It is plainly entity-visible, ` +
          'so it cannot establish the recall ceiling. Move it to an untouched entity or ' +
          'relabel it.',
      )
    }
    if (proposal.truth === 'collision' && proposal.truthKind !== 'hidden-dependency' && !byOther) {
      throw new Error(
        `proposal ${proposal.id} is labelled a collision, but nothing else touched ` +
          `${proposal.entityPath}, so no entity-key detector could see it. The label asserts ` +
          'an overlap the pack does not contain.',
      )
    }
  }

  const outcomes: ProposalOutcome[] = pack.proposals.map((proposal) => {
    const decision = decideWrite(proposalOf(proposal), contention, config)
    return {
      id: proposal.id,
      truthKind: proposal.truthKind,
      truth: proposal.truth,
      overlapsPriorWork: overlaps.get(proposal.id) === true,
      detected: RAISED.includes(decision.detection),
      detection: decision.detection,
      action: decision.action,
      intendedAction: decision.intendedAction,
      similarity: decision.similarity,
      why: proposal.why,
    }
  })

  const collisions = outcomes.filter((o) => o.truth === 'collision')
  const controls = outcomes.filter((o) => o.truth === 'independent')
  const tp = collisions.filter((o) => o.detected).length
  const fn = collisions.length - tp
  const fp = controls.filter((o) => o.detected).length
  const tn = controls.length - fp

  // The ceiling is a property of the pack, not of the detector: a collision that shares
  // no entity with any in-flight work cannot be reached by entity-key matching at all.
  const reachable = collisions.filter((o) => o.overlapsPriorWork)
  const reachableTp = reachable.filter((o) => o.detected).length

  // False *rejection*, not false alarm: an advisory a reviewer can dismiss costs
  // tokens, a denial costs the work. Only the second is the E6 failure mode.
  const refusedControls = controls.filter((o) => o.action === 'deny' || o.action === 'ask').length

  const byTruthKind: Record<string, { n: number; detected: number }> = {}
  for (const outcome of outcomes) {
    const entry = (byTruthKind[outcome.truthKind] ??= { n: 0, detected: 0 })
    entry.n += 1
    if (outcome.detected) entry.detected += 1
  }

  const precisionDenominator = tp + fp
  const recallDenominator = tp + fn
  const precision = precisionDenominator === 0 ? 1 : tp / precisionDenominator
  const recall = recallDenominator === 0 ? 1 : tp / recallDenominator

  return {
    pack: pack.pack,
    n: outcomes.length,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    controlFlagRate: controls.length === 0 ? 0 : fp / controls.length,
    falseRejectionRate: controls.length === 0 ? 0 : refusedControls / controls.length,
    entityVisibleCeiling: collisions.length === 0 ? 1 : reachable.length / collisions.length,
    recallWithinCeiling: reachable.length === 0 ? 1 : reachableTp / reachable.length,
    byTruthKind,
    outcomes,
  }
}
