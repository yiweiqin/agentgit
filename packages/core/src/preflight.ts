/**
 * Preflight: one deterministic verdict before an agent writes.
 *
 * This is the product's whole interface in one function. Everything else either
 * feeds it (the ledger, the leases, the contracts) or renders what it returned
 * (the CLI, the MCP tool, the panel, the board).
 *
 * The verdict is one of six words, and the words are chosen so that an agent can
 * act on them without reading the explanation:
 *
 * | verdict   | what the agent should do                                  |
 * |-----------|-----------------------------------------------------------|
 * | `allow`   | nothing is in the way                                     |
 * | `reuse`   | someone is doing this already; consume their work         |
 * | `refresh` | your assumption about an interface is out of date; re-read |
 * | `replan`  | your plan collides with an in-flight plan; change it       |
 * | `wait`    | the interface you need is still landing; stub, or wait     |
 * | `review`  | breaking interface conflict; stop and get a human          |
 *
 * Determinism is a requirement, not a preference. The decision is computed from
 * files on disk and a clock, never from a model call, so the same inputs always
 * produce the same verdict. That is what makes the verdict cacheable, testable and
 * safe to run on every write. A model is only consulted by callers that want a
 * prose explanation, and never to decide the word.
 *
 * @module @agentgit/core/preflight
 */

import { createHash } from 'node:crypto'

import {
  contractsTouchingPath,
  currentVersion,
  loadAssumptions,
  loadContracts,
  staleForTask,
  type StaleAssumption,
} from './contracts.ts'
import { buildCapsules, entityTouches, entityKey } from './ledger.ts'
import { acquireLease, leasesOn, liveLeases, loadLeases, type Lease } from './leases.ts'
import {
  bestSimilarity,
  decideWrite,
  DEFAULT_POLICY,
  intentSimilarity,
  type DetectionBasis,
  type PolicyConfig,
  type WriteProposal,
} from './policy.ts'
import type { ContentionRecord } from './types.ts'
import {
  appendEvent,
  armOffersActions,
  armRecordsNothing,
  armSeesOtherSessions,
  loadConfig,
  readAllEvents,
  type WorkspaceConfig,
  type WorkspacePaths,
} from './workspace.ts'
import { buildEvent } from './ledger.ts'

/** The six words an agent can act on. */
export const VERDICTS = ['allow', 'reuse', 'refresh', 'replan', 'wait', 'review'] as const
export type Verdict = (typeof VERDICTS)[number]

/** Severity order, worst first. Used when a whole task is summarised into one word. */
export const VERDICT_SEVERITY: readonly Verdict[] = ['review', 'wait', 'refresh', 'replan', 'reuse', 'allow']

export interface PreflightQuery {
  readonly taskId: string
  readonly sessionId: string
  /** `file::src/auth.py` or `symbol::resolveIdentity`. */
  readonly entityKey: string
  /** Human-facing path used in reasons and recorded intents. */
  readonly entityPath?: string
  readonly symbol?: string | null
  /** The agent's own words for what it is about to do. */
  readonly intentText?: string | null
  /** Contract names the caller knows it depends on. */
  readonly contracts?: readonly string[]
  /** Do not look further back than this many hours of events. */
  readonly windowHours?: number
}

export interface PreflightResult {
  readonly verdict: Verdict
  readonly reason: string
  /** Seconds the verdict may be reused for. Expired verdicts are recomputed. */
  readonly ttlSeconds: number
  /**
   * Cache key: a hash of everything the verdict depended on.
   *
   * A caller that caches on this key can never serve a stale verdict, because any
   * input that could change the answer changes the key. That is cheaper and more
   * reliable than a time-based cache, which is why it is the primary mechanism and
   * {@link ttlSeconds} is only the fallback.
   */
  readonly version: string
  readonly decidedAt: string
  readonly entityKey: string
  readonly taskId: string
  readonly evidence: {
    readonly detection: DetectionBasis
    readonly similarity: number | null
    readonly competitors: readonly ContentionRecord[]
    readonly otherTasks: readonly string[]
    readonly leaseConflicts: readonly Lease[]
    readonly staleAssumptions: readonly StaleAssumption[]
    readonly contractConflicts: readonly StaleAssumption[]
  }
  /** Concrete commands the caller could run next. Empty when nothing is needed. */
  readonly nextActions: readonly string[]
}

/** Policy used by the product: detect everything, refuse nothing. */
export const PRODUCT_POLICY: PolicyConfig = {
  ...DEFAULT_POLICY,
  // The product's verdict is advisory by construction. A hard refusal would lower
  // the amount of work rather than raise the amount of coordination, which is the
  // trivial win the design explicitly refuses to count.
  action: 'none',
  minOtherTasks: 1,
  treatCrossSessionAsContention: true,
  requireDifferentSession: true,
}

export const DEFAULT_TTL_SECONDS = 300

/* -------------------------------------------------------------------------- */
/* Read-only context, assembled once per call                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a verdict is allowed to see, from the workspace's arm.
 *
 * This is where the arm has teeth in the product, and it is the one axis the A/B
 * experiment turns on: `A4-session-only` still writes every event to the ledger, but a
 * proposal is shown only its own session's history — so it catches local duplicates and
 * misses global ones. That is the ablation that asks whether the *shared ledger* is the
 * mechanism, rather than whether the tool does something at all.
 */
export interface ContextScope {
  /** The arm in force. `A4-session-only` narrows what is visible; `A0-baseline` blinds it. */
  readonly arm: string
  /** Whose view this is. Only consulted when the arm narrows visibility. */
  readonly sessionId: string
  readonly taskId?: string | null
}

export interface CoordinationContext {
  readonly paths: WorkspacePaths
  readonly config: WorkspaceConfig
  readonly contention: readonly ContentionRecord[]
  readonly leases: ReturnType<typeof loadLeases>
  readonly stale: readonly StaleAssumption[]
  readonly contractCount: number
  readonly eventCount: number
  readonly malformedEvents: number
  /** Task capsules for the observed window, used to tell "in flight" from "finished". */
  readonly capsules: ReturnType<typeof buildCapsules>
  readonly now: Date
}

/**
 * Assemble everything a verdict can depend on.
 *
 * Read once per call rather than cached in memory, because the whole point is that
 * two sessions in two processes see the same state. An in-memory cache would make
 * the coordinator's answer depend on which process happened to ask first.
 *
 * With no `scope`, everything is visible — which is what the panel and the board want,
 * because they show the workspace rather than one session's view of it. A `scope` narrows
 * the *events* and the *leases*, and only those: see {@link scopeOf} for why contracts
 * stay visible.
 */
export function loadContext(
  paths: WorkspacePaths,
  now: Date = new Date(),
  windowHours = 24,
  scope?: ContextScope,
): CoordinationContext {
  const config = loadConfig(paths)
  const { events, malformed } = readAllEvents(paths)
  const cutoff = now.getTime() - windowHours * 3_600_000
  const windowed = events.filter((event) => {
    const at = Date.parse(event.timestampUtc)
    return Number.isFinite(at) ? at >= cutoff : true
  })
  // The arm can only ever remove things from view, never add, so an unscoped read stays
  // the widest view and the narrowing is a single filter rather than a second code path.
  //
  // Three cases, not two, and the third is the one that matters: the baseline must be blind
  // to *everything*, including this session's own leases. Blinding only the events would
  // leave `A0-baseline` still answering `reuse` from a lease, which would make it identical
  // to `A4-session-only` and turn the experiment's control into a second treatment.
  const blind = scope !== undefined && armRecordsNothing(scope.arm)
  const narrow = scope !== undefined && !blind && !armSeesOtherSessions(scope.arm)
  const visible = blind
    ? []
    : narrow
      ? windowed.filter((event) => event.sessionId === scope!.sessionId)
      : windowed

  const registry = loadContracts(paths)
  const assumptions = loadAssumptions(paths)
  const capsules = buildCapsules(visible)

  /*
   * Leases are narrowed with the events, and this is not optional.
   *
   * A lease is another session's activity written to a shared file, so leaving all leases
   * visible would let the ablated arm catch cross-session duplicates through the lease store
   * while its ledger was blind — and the ablation would attribute to the ledger an effect
   * that came from somewhere else. Under a narrow arm only this session's own leases
   * remain, which is exactly what that session could have learned on its own.
   */
  const allLeases = loadLeases(paths)
  const leases = blind
    ? { ...allLeases, leases: [] }
    : narrow
      ? { ...allLeases, leases: allLeases.leases.filter((entry) => entry.sessionId === scope!.sessionId) }
      : allLeases

  return {
    paths,
    config,
    // `entityTouches`, not `buildContention`: the filtered list hides the first
    // other toucher, which is exactly the collision a first preflight is about.
    contention: entityTouches(capsules),
    leases,
    stale: allStaleAssumptions(assumptions, registry),
    contractCount: registry.contracts.length,
    eventCount: events.length,
    malformedEvents: malformed,
    capsules,
    now,
  }
}

/**
 * Every stale assumption in the workspace, across all tasks.
 *
 * `staleForTask` answers a per-task question, so asking it for every distinct task
 * is how the workspace-wide view is built. The task list comes from the assumption
 * ledger rather than from the contracts, because only a task that recorded a belief
 * can hold a stale one.
 */
function allStaleAssumptions(
  assumptions: ReturnType<typeof loadAssumptions>,
  registry: ReturnType<typeof loadContracts>,
): StaleAssumption[] {
  const tasks = [...new Set(assumptions.assumptions.map((entry) => entry.taskId))]
  const out: StaleAssumption[] = []
  for (const task of tasks) out.push(...staleForTask(assumptions, registry, task))
  return out
}

/* -------------------------------------------------------------------------- */
/* The decision                                                                */
/* -------------------------------------------------------------------------- */

function versionOf(context: CoordinationContext, query: PreflightQuery, parts: unknown): string {
  return `pf-${createHash('sha256')
    .update(
      JSON.stringify({
        taskId: query.taskId,
        sessionId: query.sessionId,
        entityKey: query.entityKey,
        symbol: query.symbol ?? null,
        events: context.eventCount,
        leases: liveLeases(context.leases, context.now).length,
        contracts: context.contractCount,
        stale: context.stale.length,
        parts,
      }),
    )
    .digest('hex')
    .slice(0, 24)}`
}

function asProposal(query: PreflightQuery, entityPath: string): WriteProposal {
  return {
    entityKey: query.entityKey,
    entityPath,
    sessionId: query.sessionId,
    taskId: query.taskId,
    intentText: query.intentText ?? null,
  }
}

/**
 * Decide one write.
 *
 * Ordering is by severity, and it is fixed rather than scored. A scoring function
 * would make two verdicts with different meanings collapse into one whenever their
 * scores tie, and the caller acts on the word.
 */
export function preflight(
  paths: WorkspacePaths,
  query: PreflightQuery,
  context: CoordinationContext = loadContext(paths, new Date(), query.windowHours, scopeOf(paths, query)),
): PreflightResult {
  const entityPath = query.entityPath ?? query.entityKey.replace(/^file::/, '')
  const proposal = asProposal(query, entityPath)
  const decision = decideWrite(proposal, context.contention, PRODUCT_POLICY)
  // Read from the context, not from a fresh read, so a caller that assembled a context
  // under one arm cannot have the verdict's action set decided under another.
  const offersActions = armOffersActions(context.config.arm)

  const registry = loadContracts(paths)
  const staleMine = staleForTask(loadAssumptions(paths), registry, query.taskId)
  const staleNamed = query.contracts && query.contracts.length > 0
    ? staleMine.filter((entry) => query.contracts!.includes(entry.contract))
    : staleMine

  const touchedContracts = contractsTouchingPath(registry, entityPath)
  const contractConflicts = staleNamed.filter(
    (entry) =>
      entry.breaking &&
      (touchedContracts.some((contract) => contract.name === entry.contract) ||
        (query.symbol != null && entry.symbol != null && entry.symbol === query.symbol)),
  )

  const conflicts = leasesOn(context.leases, query.entityKey, query.taskId, context.now)

  const decide = (verdict: Verdict, reason: string, nextActions: readonly string[] = []): PreflightResult => ({
    verdict,
    reason,
    ttlSeconds: verdict === 'allow' ? DEFAULT_TTL_SECONDS : 60,
    version: versionOf(context, query, { verdict, reason }),
    decidedAt: context.now.toISOString(),
    entityKey: query.entityKey,
    taskId: query.taskId,
    /*
     * The arm decides whether the caller is handed anything to do about the verdict.
     *
     * `A1-instrument` records and decides identically to the default and returns the same
     * word and reason — it just offers no next actions. That is what makes it measurement
     * only in a product without a gate: the *record* is unchanged, so a comparison against
     * the default measures the effect of being told what to do, not the effect of the
     * detection. The verdict itself is never suppressed, because a caller that asked
     * cannot be lied to about what was seen.
     */
    nextActions: offersActions ? nextActions : [],
    evidence: {
      detection: decision.detection,
      similarity: decision.similarity,
      competitors: decision.competitors,
      otherTasks: decision.otherTasks,
      leaseConflicts: conflicts,
      staleAssumptions: staleNamed,
      contractConflicts,
    },
  })

  /* 1. wait — the interface is being landed right now, so re-reading would race it.
   *
   * Before `review`, deliberately. `review` says "the interface settled at a new
   * version, replan against it", which presupposes something settled to replan
   * against. While the producer is still typing, a replan would be aimed at a moving
   * target and would produce a second stale assumption to replace the first. `wait`
   * is also the only verdict this ordering can hold indefinitely, so it is bounded by
   * `config.inFlightMinutes`: past that, a silent publisher is treated as landed and
   * the consumer gets `review` instead of waiting on a task that will never speak.
   */
  const producerInFlight = staleNamed.find(
    (entry) => entry.breaking && isTaskInFlight(context, entry.publishedBy),
  )
  if (producerInFlight) {
    const publisher = currentVersion(registry, producerInFlight.contract)
    return decide(
      'wait',
      `task ${producerInFlight.publishedBy} is still landing ${producerInFlight.contract} v${producerInFlight.currentVersion}` +
        `${publisher?.declaredIn ? ` in ${publisher.declaredIn}` : ''}. ` +
        'Code against the published signature and stub the rest, or wait for it to land.',
      [`agentgit board`, `agentgit contracts show ${producerInFlight.contract}`],
    )
  }

  /* 2. review — a breaking interface change the task is coding directly against. */
  if (contractConflicts.length > 0) {
    const worst = contractConflicts[0]
    return decide(
      'review',
      `${worst.contract} moved to v${worst.currentVersion} (breaking) and this change touches ${entityPath}. ` +
        `You are coded against v${worst.assumedVersion}: ${worst.summary}. Published by task ${worst.publishedBy}.`,
      [
        `agentgit contracts show ${worst.contract}`,
        `agentgit task replan ${query.taskId} --contract ${worst.contract}`,
      ],
    )
  }

  /* 3. refresh — an assumption is behind, even though nothing is landing now. */
  if (staleNamed.length > 0) {
    const worst = staleNamed.find((entry) => entry.breaking) ?? staleNamed[0]
    return decide(
      worst.breaking ? 'refresh' : 'allow',
      worst.breaking
        ? `${worst.contract} is at v${worst.currentVersion}; you are coded against v${worst.assumedVersion}: ${worst.summary}.`
        : `${worst.contract} moved to v${worst.currentVersion} without a breaking change: ${worst.summary}.`,
      [`agentgit contracts show ${worst.contract}`],
    )
  }

  /* 4. reuse — someone is already building this. */
  const reuseLease = conflicts.find((lease) => intentIsSimilar(query.intentText, lease.reason, context.config))
  if (reuseLease) {
    return decide(
      'reuse',
      `${reuseLease.entityKey} is held by task ${reuseLease.taskId} for the same work: "${reuseLease.reason}" ` +
        `(until ${reuseLease.expiresAt}). Consume their change instead of writing a second one.`,
      [`agentgit board`, `agentgit lease list`],
    )
  }
  if (decision.detection === 'duplicate-intent') {
    const other = decision.competitors[0]
    return decide(
      'reuse',
      `an in-flight change on ${query.entityKey} is doing the same thing` +
        `${other && other.intents.length > 0 ? `: "${other.intents[0]}"` : ''}` +
        ` (task ${decision.otherTasks.join(', ') || 'unknown'}, similarity ${formatSimilarity(decision.similarity)}).`,
      [`agentgit board`],
    )
  }
  if (decision.detection === 'cross-session-same-task') {
    return decide(
      'reuse',
      `another session of task ${query.taskId} is already writing ${query.entityKey}. ` +
        'One of the two should stop so the task does not produce two versions of itself.',
      [`agentgit board`],
    )
  }

  /* 5. replan — a different in-flight plan wants the same ground. */
  const occupied = conflicts.find((lease) => !intentIsSimilar(query.intentText, lease.reason, context.config))
  if (occupied) {
    return decide(
      'replan',
      `${occupied.entityKey} is held by task ${occupied.taskId} for different work: "${occupied.reason}". ` +
        'Either scope this change away from that entity or agree who owns it.',
      [`agentgit lease list`, `agentgit board`],
    )
  }
  if (decision.detection === 'cross-task-conflict') {
    const other = decision.competitors[0]
    return decide(
      'replan',
      `${query.entityKey} is being changed by task ${decision.otherTasks.join(', ')}` +
        `${other && other.intents.length > 0 ? ` for "${other.intents[0]}"` : ''}, which is not the same work. ` +
        'Split the entity or agree an order before both land.',
      [`agentgit board`],
    )
  }

  /* 6. allow — nothing else is on this ground. */
  const note = decision.detection === 'below-threshold'
    ? 'no other task or session is working on this entity'
    : 'no in-flight change, lease or contract on this entity'
  return decide('allow', note, [])
}

function formatSimilarity(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(2)
}

function intentIsSimilar(
  mine: string | null | undefined,
  theirs: string | null | undefined,
  config: WorkspaceConfig,
): boolean {
  if (!mine || !theirs) return false
  return intentSimilarity(mine, theirs) >= config.duplicateIntentThreshold
}

/**
 * Whether the task that published a contract is still working.
 *
 * Read from the ledger rather than from a lease, because publishing a contract does
 * not oblige anyone to hold a lease on it, and a producer that has already
 * integrated must stop causing `wait`.
 *
 * Two conditions, and the second is the one that keeps a forgotten task from wedging
 * the workspace. A capsule is open while the task has not reached a terminal state —
 * but "not terminal" is not the same as "still happening": an agent that published a
 * breaking change and then simply stopped would otherwise leave every consumer waiting
 * on it forever, and no lease expiry would save them, because `wait` is driven by the
 * ledger and not by a reservation. So a task counts as in flight only while its last
 * event is recent. Past that window the interface is treated as settled, and consumers
 * get `review` — a version to replan against — which is the recoverable answer.
 */
function isTaskInFlight(context: CoordinationContext, taskId: string): boolean {
  const capsule = context.capsules.get(taskId)
  if (!capsule) return false
  if (capsule.closedAtUtc !== null) return false

  const last = capsule.lastEventAtUtc
  if (!last) return true
  const ageMinutes = (context.now.getTime() - Date.parse(last)) / 60_000
  if (!Number.isFinite(ageMinutes)) return true
  return ageMinutes <= context.config.inFlightMinutes
}

/* -------------------------------------------------------------------------- */
/* Task-level rollup                                                           */
/* -------------------------------------------------------------------------- */

export interface TaskPreflightSummary {
  readonly taskId: string
  readonly sessionId: string
  /** The worst verdict across every queried entity. */
  readonly verdict: Verdict
  readonly results: readonly PreflightResult[]
  readonly stale: readonly StaleAssumption[]
}

/**
 * Summarise a whole task by taking its worst verdict.
 *
 * Worst rather than most-common, because the caller is deciding whether to keep
 * writing. A majority vote would let one `review` be outvoted by five `allow`s and
 * report that everything is fine.
 */
export function summariseTask(
  paths: WorkspacePaths,
  taskId: string,
  sessionId: string,
  entities: readonly string[],
  intentText: string | null = null,
): TaskPreflightSummary {
  const context = loadContext(paths)
  const results = entities.map((entityKeyValue) =>
    preflight(paths, { taskId, sessionId, entityKey: entityKeyValue, intentText }, context),
  )
  let verdict: Verdict = 'allow'
  for (const candidate of VERDICT_SEVERITY) {
    if (results.some((result) => result.verdict === candidate)) {
      verdict = candidate
      break
    }
  }
  return {
    taskId,
    sessionId,
    verdict,
    results,
    stale: staleForTask(loadAssumptions(paths), loadContracts(paths), taskId),
  }
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run a preflight and record both the decision and the lease it implies.
 *
 * Recording is separate from deciding so that a read-only caller (the panel, the
 * board) can ask the same question without changing the answer for anyone else.
 * A decision that silently took a lease would make observation alter the state
 * being observed.
 */
export function preflightAndClaim(
  paths: WorkspacePaths,
  query: PreflightQuery,
  options: { readonly symbol?: boolean } = {},
): PreflightResult {
  const context = loadContext(paths, new Date(), query.windowHours, scopeOf(paths, query))
  const result = preflight(paths, query, context)

  /*
   * The baseline arm records nothing, so it records nothing here either.
   *
   * A control that still wrote its own decisions to the ledger would not be a control: the
   * next preflight under any other arm would read those events and answer differently, so
   * switching arms would leave the workspace permanently contaminated by whichever arm ran
   * first. Skipping the write keeps the arm a property of the moment it ran.
   */
  if (armRecordsNothing(context.config.arm)) return result

  if (result.verdict === 'allow' || result.verdict === 'reuse') {
    const leaseMinutes = context.config.leaseMinutes
    // On `reuse`, the caller joins the tasks already doing this work instead of waiting
    // on them. Naming them here is what makes the lease mutual, so the second agent is
    // not blocked by a grant it has already given away.
    const shareWith =
      result.verdict === 'reuse'
        ? [
            ...new Set(
              result.evidence.competitors
                .flatMap((record) => record.tasks)
                .filter((taskId) => taskId !== query.taskId),
            ),
          ].sort()
        : []

    acquireLease(paths, {
      entityKey: query.entityKey,
      kind: options.symbol ? 'symbol' : query.entityKey.includes('::') ? undefined : 'file',
      taskId: query.taskId,
      sessionId: query.sessionId,
      reason: query.intentText?.slice(0, 160) || 'preflight claim',
      minutes: leaseMinutes,
      shareWith,
    })
  }

  const entity = {
    kind: query.symbol ? 'symbol' : 'file',
    identifier: query.symbol ?? query.entityPath ?? query.entityKey,
    path: query.entityPath ?? query.entityKey.replace(/^file::/, ''),
  }
  appendEvent(paths, buildEvent({
    kind: 'file_write',
    timestampUtc: result.decidedAt,
    sessionId: query.sessionId,
    taskId: query.taskId,
    entities: [entity],
    intentText: query.intentText ?? null,
    hostEvent: 'preflight',
    reason: `${result.verdict}: ${result.reason}`,
    detail: { verdict: result.verdict, similarity: result.evidence.similarity },
  }))

  return result
}

/** The ledger key for a path or symbol, so every caller spells it the same way. */
export function keyOf(path: string): string {
  return entityKey({ kind: 'file', identifier: path, path })
}

/**
 * The scope a query should be answered under, from the workspace's own arm.
 *
 * Contracts and assumptions are deliberately *outside* the scope and stay fully visible
 * under every arm, including the session-only ablation. The reason is what the ablation is
 * trying to isolate: a ledger of who touched what is coordination memory, while a contract
 * version is an artifact fact — the same kind of thing as reading the code, which no arm
 * can hide. Hiding it would not test the shared ledger, it would only stop `review` from
 * firing, and the ablation would then measure a broken feature instead of a missing ledger.
 * The assumption side is local anyway: a task's recorded belief is its own.
 */
export function scopeOf(paths: WorkspacePaths, query: PreflightQuery): ContextScope {
  return { arm: loadConfig(paths).arm, sessionId: query.sessionId, taskId: query.taskId }
}

/** The ledger key for a symbol. */
export function symbolKeyOf(symbol: string): string {
  return entityKey({ kind: 'symbol', identifier: symbol, path: symbol })
}

/**
 * How a caller should treat a verdict.
 *
 * Exported so the CLI, the panel and the board cannot disagree about which verdicts
 * are worth interrupting someone for. A second copy of this table would drift, and
 * the drift would show up as a panel that stays quiet about a `review`.
 *
 * - `clear`: nothing to do, stay out of the way.
 * - `advisory`: worth showing, worth acting on, never worth blocking.
 * - `blocking`: the caller should stop and get a decision from a human.
 */
export function kindOfVerdict(verdict: Verdict): 'clear' | 'advisory' | 'blocking' {
  if (verdict === 'allow') return 'clear'
  if (verdict === 'review') return 'blocking'
  return 'advisory'
}

/** Best-effort similarity between two free-text intents, exposed for the board. */
export { bestSimilarity, intentSimilarity }
