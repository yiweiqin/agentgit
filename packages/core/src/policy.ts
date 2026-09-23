/**
 * Governance policy: when to speak up, and what kind of intervention that is.
 *
 * The central distinction encoded here
 * ------------------------------------
 * There are two ways to make an unreconciled change leave the backlog, and only
 * one of them is the framework's claim:
 *
 * - **coordination** (advisory): supply the cross-session knowledge the agent
 *   structurally lacks, so it declines to duplicate work. Arrival rate is
 *   untouched; effective reconciliation capacity `R` rises because conflicts are
 *   resolved at write time instead of later.
 * - **admission control** (deny/ask): refuse the write. This removes the change
 *   by removing the *work*, so it lowers `lambda` instead of raising `R`.
 *
 * The second is the trivial solution that kill criterion K4 exists to catch:
 * "any improvement bought by lowering lambda does not count as governance
 * revenue". A naive implementation of a "governance agent" is exactly the one
 * that trips K4, so the two are typed as different `InterventionClass` values
 * and the experiment cannot silently conflate them.
 *
 * @module dsh-coord-governor/policy
 */

import { entityKey } from './ledger.ts'
import type { ContentionRecord } from './types.ts'
import type { Entity } from './types.ts'

/** What kind of thing a decision does to the system. */
export type InterventionClass =
  /** No intervention. */
  | 'none'
  /** Raises R: the agent gains knowledge and coordinates. The framework's claim. */
  | 'coordination'
  /** Lowers lambda: the write is refused. Expected to trip K4 if it is the only win. */
  | 'admission-control'

export type GovAction = 'none' | 'advise' | 'deny' | 'ask'

/** A write the agent is about to perform. */
export interface WriteProposal {
  readonly entityKey: string
  readonly entityPath: string
  readonly sessionId: string
  readonly taskId?: string | null
  /** The agent's own description of the task, when the host supplies one. */
  readonly intentText?: string | null
  readonly toolName?: string | null
}

/** Stable label for why a decision was reached. E2 measures this distribution. */
export type DecisionBasis =
  | 'no-contention'
  | 'below-threshold'
  | 'policy-disabled'
  | 'duplicate-intent'
  | 'cross-task-conflict'
  | 'cross-session-same-task'

/**
 * What the *detector* concluded, independent of what the policy did about it.
 *
 * Kept separate from {@link GovDecision.basis} because the two answer different
 * questions, and conflating them breaks the experiment's core separation. The
 * `A1-instrument` arm runs with `action: 'none'`, so its `basis` is always
 * `policy-disabled` — which means detection accuracy would be unmeasurable in the
 * exact arm E2 is required to measure it in. E2 asks "did the detector see the
 * collision?", not "did the policy act?", so it needs a field the treatment cannot
 * overwrite.
 */
export type DetectionBasis =
  | 'no-contention'
  | 'below-threshold'
  | 'duplicate-intent'
  | 'cross-task-conflict'
  | 'cross-session-same-task'

/** Machine-readable outcome of applying the policy to one proposal. */
export interface GovDecision {
  /** The action actually taken. `none` whenever the policy is passive or dry-run. */
  readonly action: GovAction
  /** The action the policy wanted. Differs from `action` only under `dryRun`. */
  readonly intendedAction: GovAction
  /** Analytic category of the *intended* action; see the module note. */
  readonly interventionClass: InterventionClass
  /** True when this decision was computed but deliberately not acted on. */
  readonly dryRun: boolean
  readonly reason: string
  /** Entities whose other touches are the basis of this decision. */
  readonly competitors: readonly ContentionRecord[]
  /** Similarity against the most similar competing intent, when computable. */
  readonly similarity: number | null
  /**
   * What the detector concluded, regardless of whether the policy acted.
   *
   * E2 reads this field. `basis` cannot serve that purpose on a passive arm,
   * because `action: 'none'` overwrites it with `policy-disabled`.
   */
  readonly detection: DetectionBasis
  /** Distinct tasks other than the proposer's that touched this entity. */
  readonly otherTasks: readonly string[]
  readonly basis: DecisionBasis
}

export interface PolicyConfig {
  /** How to act when contention is detected. */
  readonly action: GovAction
  /**
   * Minimum number of *other* tasks that must have touched the entity before it
   * counts as contested. One is the meaningful floor: two tasks on one entity is
   * the smallest real conflict. Default 1, and tests pin it, because an
   * off-by-one here silently disables the governor.
   *
   * This is OR-ed with {@link treatCrossSessionAsContention}, not AND-ed: raising
   * this threshold does not suppress a conflict that another *session* creates.
   * To suppress that, turn the session rule off explicitly.
   */
  readonly minOtherTasks: number
  /**
   * Two sessions inside one task count as contention too.
   *
   * This is the flag that catches the case the framework is actually about: two
   * agents handed the same goal, each unaware of the other. Turn it off to test a
   * strictly task-scoped policy.
   */
  readonly treatCrossSessionAsContention: boolean
  /** Only act when a competing touch comes from a session other than ours. */
  readonly requireDifferentSession: boolean
  /**
   * Similarity at or above which two intents are treated as the same work.
   * Only consulted when both intents exist.
   */
  readonly duplicateIntentThreshold: number
  /**
   * Cap on how many recorded intents are quoted per entity in an advisory.
   *
   * The advisory's size is driven by quoted intents, not by entity count: a
   * decision concerns exactly one entity key by construction, so there is at most
   * one record, while the record accumulates every distinct intent ever recorded
   * for it. E6 prices the tokens this buys, which is why the cap is explicit
   * rather than incidental.
   */
  readonly maxAdvisoryIntentsPerRecord: number
  /**
   * Compute and record the decision but do not act on it. This is the E4
   * "detect-only" ablation: identical detection, identical records, no effect.
   */
  readonly dryRun: boolean
}

export const DEFAULT_POLICY: PolicyConfig = {
  action: 'none',
  minOtherTasks: 1,
  treatCrossSessionAsContention: true,
  requireDifferentSession: true,
  duplicateIntentThreshold: 0.42,
  maxAdvisoryIntentsPerRecord: 3,
  dryRun: false,
}

/** Words too common in code intents to carry matching signal. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'add', 'adds', 'added',
  'use', 'uses', 'used', 'using', 'make', 'makes', 'new', 'fix', 'fixes',
  'update', 'updates', 'change', 'changes', 'support', 'supports', 'allow', 'allows',
  'implement', 'implements', 'handle', 'handles', 'when', 'should', 'must', 'then',
  'also', 'can', 'will', 'not', 'but', 'are', 'was', 'has', 'have', 'its', 'our',
  'all', 'any', 'may', 'per', 'via', 'one', 'two', 'so', 'to', 'of', 'in', 'on',
  'at', 'by', 'or', 'as', 'is', 'it', 'be', 'we', 'if', 'an', 'a',
])

/** Lowercased content words. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
}

/**
 * Identifier-like tokens (`snake_case`, `camelCase`, `dotted.path`), lowercased.
 *
 * Extracted from the original casing, because identifiers are the strongest
 * lexical evidence that two intents concern the same code, and lowercasing first
 * would destroy exactly that signal.
 */
export function extractIdentifiers(text: string): string[] {
  const matches = text.match(/[A-Za-z_][A-Za-z0-9_]*(?:[._][A-Za-z0-9_]+)*/g) ?? []
  return matches
    .filter((token) => /[A-Z_]/.test(token) || token.includes('.'))
    .map((token) => token.toLowerCase())
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setA = new Set(a)
  const setB = new Set(b)
  let shared = 0
  for (const item of setA) if (setB.has(item)) shared += 1
  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : shared / union
}

/**
 * Lexical intent similarity in [0, 1]: content-word Jaccard blended with
 * identifier Jaccard when either side has identifiers.
 *
 * Deliberately a *lexical* baseline. Its known ceiling is what E2 measures: two
 * agents describing the same work in different words ("return JSON from the
 * view" vs "add a jsonify helper to the view") are a genuine semantic duplicate
 * this function scores near zero on. That measurement — not an assumption —
 * motivates the LLM-backed matcher in the iteration step (trigger I3).
 */
export function intentSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  const tokenScore = jaccard(tokenize(a), tokenize(b))
  const idA = extractIdentifiers(a)
  const idB = extractIdentifiers(b)
  if (idA.length === 0 && idB.length === 0) return tokenScore
  return Math.min(1, 0.5 * tokenScore + 0.5 * jaccard(idA, idB))
}

/** Best similarity between the proposal's intent and a record's known intents. */
export function bestSimilarity(proposal: WriteProposal, record: ContentionRecord): number | null {
  if (!proposal.intentText || record.intents.length === 0) return null
  let best = 0
  for (const intent of record.intents) best = Math.max(best, intentSimilarity(proposal.intentText, intent))
  return best
}

/**
 * The competing records for a proposal: those on the same entity that involve
 * someone other than the proposer.
 *
 * Deliberately does *not* filter out same-task touches. An earlier version did,
 * and that made `treatCrossSessionAsContention` unreachable for exactly the case
 * it exists to catch — one task split across two unaware sessions. The task and
 * session rules are composed in {@link decideWrite}, in one place.
 */
export function competitorsFor(
  proposal: WriteProposal,
  contention: readonly ContentionRecord[],
  config: Pick<PolicyConfig, 'requireDifferentSession'>,
): ContentionRecord[] {
  return contention.filter((record) => {
    if (record.entityKey !== proposal.entityKey) return false
    if (config.requireDifferentSession && record.sessions.every((s) => s === proposal.sessionId)) {
      return false
    }
    return true
  })
}

/**
 * Decide what to do about one proposed write.
 *
 * Pure: derived contention is passed in, so a test can assert a decision without
 * constructing a session or a harness.
 */
export function decideWrite(
  proposal: WriteProposal,
  contention: readonly ContentionRecord[],
  config: PolicyConfig = DEFAULT_POLICY,
): GovDecision {
  const competing = competitorsFor(proposal, contention, config)

  const otherTasks = [...new Set(competing.flatMap((r) => r.tasks))]
    .filter((t) => t !== proposal.taskId)
    .sort()
  const hasOtherSession = competing.some((r) => r.sessions.some((s) => s !== proposal.sessionId))

  const passive = (
    basis: DecisionBasis,
    reason: string,
    detection: DetectionBasis,
    similarity: number | null = null,
  ): GovDecision => ({
    action: 'none',
    intendedAction: 'none',
    interventionClass: 'none',
    dryRun: config.dryRun,
    reason,
    competitors: [],
    similarity,
    detection,
    otherTasks,
    basis,
  })

  if (competing.length === 0) {
    // Either nothing else touched the entity, or the only other touches were this
    // session's own. Both mean "no action", and they collapse into one label
    // because `buildContention` never emits a record for a single task in a
    // single session — a dead label in an instrument E2 measures would be worse
    // than one honest label.
    return passive(
      'no-contention',
      'no other task or session has touched this entity',
      'no-contention',
    )
  }

  const similarity = competing
    .map((record) => bestSimilarity(proposal, record))
    .filter((value): value is number => value !== null)
    .reduce<number | null>((best, value) => (best === null ? value : Math.max(best, value)), null)

  const taskThresholdMet = otherTasks.length >= Math.max(1, config.minOtherTasks)
  const sessionThresholdMet = config.treatCrossSessionAsContention && hasOtherSession
  if (!taskThresholdMet && !sessionThresholdMet) {
    return passive(
      'below-threshold',
      `only ${otherTasks.length} other task(s) and no other session reached this entity`,
      'below-threshold',
      similarity,
    )
  }

  const crossSessionOnly = otherTasks.length === 0
  const isDuplicate = similarity !== null && similarity >= config.duplicateIntentThreshold
  const detection: DetectionBasis = crossSessionOnly
    ? 'cross-session-same-task'
    : isDuplicate
      ? 'duplicate-intent'
      : 'cross-task-conflict'

  const limited = competing
  const describe = limited
    .map((r) => `${r.entityKey} also touched by task(s) ${r.tasks.join(',') || '(none)'} in session(s) ${r.sessions.join(',')}`)
    .join('; ')

  if (config.action === 'none') {
    return {
      action: 'none',
      intendedAction: 'none',
      interventionClass: 'none',
      dryRun: config.dryRun,
      reason: `recorded only (${detection}): ${describe}`,
      competitors: limited,
      similarity,
      detection,
      otherTasks,
      basis: 'policy-disabled',
    }
  }

  const intended: GovAction = config.action
  const interventionClass: InterventionClass =
    intended === 'advise' ? 'coordination' : 'admission-control'

  const reason =
    intended === 'advise'
      ? `${detection}: ${describe}`
      : `This change overlaps an in-flight change by another session (${detection}). ${describe}. ` +
        'Reuse or extend the existing change instead of producing a second one, ' +
        'or state explicitly why this must differ.'

  return {
    // Under dryRun the decision is fully computed and recorded, but takes no
    // effect. That is the E4 ablation.
    action: config.dryRun ? 'none' : intended,
    intendedAction: intended,
    interventionClass,
    dryRun: config.dryRun,
    reason,
    competitors: limited,
    similarity,
    detection,
    otherTasks,
    basis: detection,
  }
}

/** Render the advisory message body. Deterministic, so replay is reproducible. */
export function buildAdvisory(
  proposal: WriteProposal,
  decision: GovDecision,
  ledgerFacts: { readonly writesAfterContextLoss: number; readonly compactionEvents: number },
  maxChars: number,
  maxIntentsPerRecord: number = DEFAULT_POLICY.maxAdvisoryIntentsPerRecord,
): string {
  const lines: string[] = []
  lines.push('## Coordination ledger (external memory)')
  lines.push('The facts below come from a ledger shared across sessions; your own context may not contain them.')

  for (const record of decision.competitors) {
    const otherTasks = record.tasks.filter((t) => t !== proposal.taskId)
    const otherSessions = record.sessions.filter((s) => s !== proposal.sessionId)
    lines.push(
      `- ${record.entityKey}: also touched by task(s) ${otherTasks.join(', ') || '(none)'}` +
        ` in session(s) ${otherSessions.join(', ') || '(none)'}; ${record.touches} touch(es) total.`,
    )
    for (const intent of record.intents.slice(0, maxIntentsPerRecord)) {
      lines.push(`  - recorded intent: "${intent}"`)
    }
  }

  if (ledgerFacts.compactionEvents > 0) {
    lines.push(
      `- This session lost context ${ledgerFacts.compactionEvents} time(s); ` +
        `${ledgerFacts.writesAfterContextLoss} write(s) were issued after such a loss.`,
    )
  }

  lines.push(
    'Before writing: if this entity is already being changed for the same purpose, extend that change ' +
      'instead of adding a second one. If it is genuinely different work, proceed.',
  )

  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

/**
 * Render the cross-session overview injected before a step.
 *
 * At pre-step time the host does not know which file the agent will touch, so a
 * per-entity advisory is impossible. The overview supplies the thing the agent
 * structurally lacks — the fact that other sessions are already changing these
 * entities — and leaves the judgement to the model. That is what "raising R"
 * means in practice, and it spends no tokens claiming to know the future.
 */
export function renderOverview(
  records: readonly ContentionRecord[],
  sessionId: string,
  ledgerFacts: { readonly writesAfterContextLoss: number; readonly compactionEvents: number },
  maxChars: number,
  maxIntentsPerRecord: number = DEFAULT_POLICY.maxAdvisoryIntentsPerRecord,
): string {
  const lines: string[] = []
  lines.push('## Coordination ledger (external memory)')
  lines.push(
    'Your context cannot contain the following, because it comes from other sessions. ' +
      'These entities are currently being changed by more than one task or session:',
  )

  for (const record of records) {
    const otherSessions = record.sessions.filter((s) => s !== sessionId)
    lines.push(
      `- ${record.entityKey} — task(s) ${record.tasks.join(', ') || '(none)'}` +
        `; session(s) ${record.sessions.join(', ') || '(none)'}` +
        `${otherSessions.length > 0 ? ` (other than yours: ${otherSessions.join(', ')})` : ''}` +
        `; ${record.touches} touch(es).`,
    )
    for (const intent of record.intents.slice(0, maxIntentsPerRecord)) {
      lines.push(`  - recorded intent: "${intent}"`)
    }
  }

  lines.push(
    'If you are about to change one of these for the same purpose, extend the existing change ' +
      'instead of producing a second one. If your work is genuinely different, proceed.',
  )

  if (ledgerFacts.compactionEvents > 0) {
    lines.push(
      `Note: this session has already lost context ${ledgerFacts.compactionEvents} time(s), and ` +
        `${ledgerFacts.writesAfterContextLoss} write(s) followed such a loss. Re-check whether the ` +
        'work above is still yours before duplicating it.',
    )
  }

  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

/** The ledger key a raw entity should use. */
export function proposalEntityKey(entity: Entity): string {
  return entityKey(entity)
}
