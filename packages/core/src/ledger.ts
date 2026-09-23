/**
 * The coordination ledger: event stream in, framework quantities out.
 *
 * This is the instrument that `01_问题定义与定位/痛点_速度与上下文失配.md` §10.3
 * proved cannot be built on Git history: unreconciled changes are, by
 * definition, absent from the commit graph, so the produced change stream
 * (`lambda_produced`) and the backlog `B(t)` are only observable from inside the
 * agent runtime. Every function here is pure and dependency-free.
 *
 * @module dsh-coord-governor/ledger
 */

import { createHash } from 'node:crypto'
import {
  ALL_EVENT_KINDS,
  DECAYED_STATES,
  INTEGRATED_STATE,
  LIFECYCLE_TRANSITIONS,
  OPEN_STATES,
  type BacklogPoint,
  type Capsule,
  type ContentionRecord,
  type CoordEvent,
  type CoordEventKind,
  type Entity,
  type EntityRecord,
  type LedgerReport,
  type LifecycleState,
  type Parallelism,
  type Rates,
  type WireEvent,
} from './types.ts'

export const SCHEMA_VERSION = 'coord-ledger-0.1'

/**
 * Below this span a rate is meaningless: a handful of events written one second
 * apart would imply thousands per hour. Rates are withheld rather than reported,
 * because a bogus lambda is indistinguishable from a real spike.
 *
 * This guard exists because the first end-to-end run of the Python sibling tool
 * reported 5625 merges/hour from ten back-to-back events.
 */
export const MIN_RATE_WINDOW_HOURS = 1 / 60

/** Normalise a path so contention is not defeated by spelling. */
export function normalizePath(path: string): string {
  let cleaned = path.trim().replace(/\\/g, '/')
  while (cleaned.startsWith('./')) cleaned = cleaned.slice(2)
  return cleaned
}

/**
 * Accept a plain path string or an ISCC-style entity object.
 * Case is preserved: folding it would merge distinct files on
 * case-sensitive filesystems and inflate contention.
 */
export function normalizeEntity(raw: unknown): Entity | null {
  if (typeof raw === 'string' && raw.trim()) {
    const path = normalizePath(raw)
    return { kind: 'file', identifier: path, path }
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const pathValue = typeof r.path === 'string' ? r.path : typeof r.identifier === 'string' ? r.identifier : null
    if (pathValue && pathValue.trim()) {
      const kind = typeof r.kind === 'string' && r.kind ? r.kind : 'file'
      const identifier = typeof r.identifier === 'string' && r.identifier ? r.identifier : normalizePath(pathValue)
      return { kind, identifier, path: normalizePath(pathValue) }
    }
  }
  return null
}

/**
 * Symbol-level key when available, else path-level.
 *
 * Symbol level matters: the framework's central claim is about repeated
 * touching of the *same* semantic target, which path-level counting cannot
 * distinguish from two unrelated edits in one file.
 */
export function entityKey(entity: Entity): string {
  if (entity.kind && entity.kind !== 'file') {
    return `${entity.kind}::${entity.identifier || entity.path}`
  }
  return `file::${entity.path}`
}

/** Build a well-formed ledger event from already-normalized inputs. */
export function buildEvent(input: {
  kind: CoordEvent['kind']
  timestampUtc: string
  sessionId: string
  developer?: string | null
  taskId?: string | null
  entities?: readonly Entity[]
  intentText?: string | null
  hostEvent?: string | null
  reason?: string | null
  detail?: Record<string, unknown> | null
}): CoordEvent {
  if (!input.sessionId) {
    // Without a session id the record cannot be attributed, so it is worthless
    // as evidence. Failing loudly beats writing an unattributable row.
    throw new Error('sessionId is required: without it, provenance cannot be reconstructed')
  }
  return {
    kind: input.kind,
    timestampUtc: input.timestampUtc,
    sessionId: input.sessionId,
    developer: input.developer ?? null,
    taskId: input.taskId ?? null,
    entities: input.entities ?? [],
    intentText: input.intentText ?? null,
    hostEvent: input.hostEvent ?? null,
    reason: input.reason ?? null,
    detail: input.detail ?? null,
  }
}

/**
 * Serialize to the snake_case shape `coord_ledger.py` already reads, so the
 * Python analysis tool consumes a DSH ledger with no adapter.
 *
 * `event_id` is a content hash, so re-serializing the same event is idempotent
 * and accidental duplicates are detectable.
 */
export function toWire(event: CoordEvent): WireEvent {
  const body = {
    schema_version: SCHEMA_VERSION,
    kind: event.kind,
    timestamp_utc: event.timestampUtc,
    session_id: event.sessionId,
    developer: event.developer ?? null,
    task_id: event.taskId ?? null,
    entities: event.entities ?? [],
    intent_text: event.intentText ?? null,
    host_event: event.hostEvent ?? null,
    reason: event.reason ?? null,
    detail: event.detail ?? null,
  }
  const eventId = `evt-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24)}`
  return { event_id: eventId, ...body }
}

/** One JSONL line, LF-terminated so committed ledgers diff cleanly cross-platform. */
export function serializeEvent(event: CoordEvent): string {
  return `${JSON.stringify(toWire(event))}\n`
}

/**
 * Assert that a decoded `kind` is one this module knows how to interpret.
 *
 * `WireEvent.kind` is deliberately a plain `string`, because the wire format is shared
 * with `coord_ledger.py` and that side may write kinds this one has not learned yet.
 * The narrowing therefore has to be explicit rather than a cast: every derivation below
 * switches on `kind`, so an unrecognised value that fell through those switches would be
 * counted as an event while contributing to no capsule, no entity touch, and no rate —
 * indistinguishable from an event that never happened.
 *
 * Failing loudly is the same trade the ledger reader already makes for a missing file.
 * An instrument that cannot explain its own input must not report numbers derived from
 * it, and the message names both the kind and the event so a vocabulary divergence
 * between the two analysers is diagnosable from the failure alone.
 */
function narrowKind(kind: string, eventId: string): CoordEventKind {
  if ((ALL_EVENT_KINDS as readonly string[]).includes(kind)) return kind as CoordEventKind
  throw new Error(`unknown event kind ${JSON.stringify(kind)} on ledger event ${eventId}`)
}

/**
 * Rebuild an event from its wire form.
 *
 * Exists so the plugin can re-read a ledger it wrote, and so the E0 cross-check can
 * parse one file with both analyzers and compare. Tolerant of the fields
 * `coord_ledger.py` may write and this plugin does not: unknown keys are dropped
 * rather than forwarded, because carrying them would make two analyzers that agree
 * on meaning still differ on bytes.
 */
export function fromWire(wire: WireEvent): CoordEvent {
  const entities: Entity[] = []
  for (const raw of wire.entities ?? []) {
    const entity = normalizeEntity(raw)
    if (entity) entities.push(entity)
  }
  return {
    kind: narrowKind(wire.kind, wire.event_id),
    timestampUtc: wire.timestamp_utc,
    sessionId: wire.session_id,
    developer: wire.developer ?? null,
    taskId: wire.task_id ?? null,
    entities,
    intentText: wire.intent_text ?? null,
    hostEvent: wire.host_event ?? null,
    reason: wire.reason ?? null,
    detail: wire.detail ?? null,
  }
}

/** Parse one JSONL line back into a wire event, or throw with the line number. */
export function parseWireLine(line: string, lineNumber: number): WireEvent {
  try {
    return JSON.parse(line) as WireEvent
  } catch {
    throw new Error(`malformed JSON on ledger line ${lineNumber}`)
  }
}

function isOpen(state: LifecycleState): boolean {
  return OPEN_STATES.includes(state)
}

/**
 * Compare two strings by code point, as Python's `<` does.
 *
 * `localeCompare` is deliberately avoided everywhere in this module. It applies ICU
 * collation, which orders CJK and accented paths differently from Python's byte-wise
 * comparison, so a Chinese-named file could sort before another one here and after it
 * in `coord_ledger.py`. The two analyzers must agree on ordering or their derived
 * quantities silently diverge on exactly the repositories this project examines.
 */
export function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Order events canonically before deriving anything from them.
 *
 * This must match `coord_ledger.py`'s `load_events`, which sorts by
 * `(timestamp_utc, event_id)`. Deriving in arrival order instead makes the result
 * depend on scheduling: a `context_compacted` and a `file_write` sharing a timestamp
 * are counted as "write after context loss" or not depending on which session the
 * runtime happened to service first. That is not a measurement, it is a race.
 */
export function sortEvents(events: readonly CoordEvent[]): CoordEvent[] {
  return events
    .map((event, index) => ({ event, index, eventId: toWire(event).event_id }))
    .sort((a, b) =>
      compareCodepoint(a.event.timestampUtc, b.event.timestampUtc) ||
      compareCodepoint(a.eventId, b.eventId) ||
      // Byte-identical rows are the only remaining tie; keep arrival order so the
      // sort is total and therefore reproducible.
      a.index - b.index,
    )
    .map((entry) => entry.event)
}

/**
 * Fold an event stream into one capsule per task id.
 *
 * Capsules are *derived* rather than stored as snapshots, because B(t) needs
 * "what was true at time t" and a snapshot cannot express that.
 */
export function buildCapsules(events: readonly CoordEvent[]): Map<string, Capsule> {
  const capsules = new Map<string, Capsule>()
  for (const event of events) {
    const taskId = event.taskId
    if (!taskId) continue // events with no task cannot be reconciled against a goal

    let capsule = capsules.get(taskId)
    if (!capsule) {
      capsule = {
        taskId,
        state: 'proposed',
        openedAtUtc: event.timestampUtc,
        closedAtUtc: null,
        sessions: [],
        developers: [],
        entities: new Map<string, EntityRecord>(),
        nEvents: 0,
        nCompactEvents: 0,
        writesAfterCompact: 0,
        lastEventAtUtc: null,
      }
      capsules.set(taskId, capsule)
    }

    // Events arrive in file order, not necessarily in time order, so this is a
    // comparison rather than an assignment. Taking the last line's timestamp would
    // make a back-dated record look like the newest activity.
    if (capsule.lastEventAtUtc === null || event.timestampUtc > capsule.lastEventAtUtc) {
      capsule.lastEventAtUtc = event.timestampUtc
    }

    capsule.nEvents += 1
    if (!capsule.sessions.includes(event.sessionId)) capsule.sessions.push(event.sessionId)
    if (event.developer && !capsule.developers.includes(event.developer)) {
      capsule.developers.push(event.developer)
    }
    if (event.kind === 'context_compacted') capsule.nCompactEvents += 1

    // Only writes are touches. `coord_ledger.py` also counts `file_read` as an
    // entity touch, which the governor deliberately does not: a read is not a
    // conflict. The divergence is inert because this plugin never emits
    // `file_read`; if read observation is ever added, the two sides must be
    // reconciled first or their contention figures will stop agreeing.
    if (event.kind === 'file_write') {
      for (const entity of event.entities ?? []) {
        const key = entityKey(entity)
        let record = capsule.entities.get(key)
        if (!record) {
          record = { kind: entity.kind, identifier: entity.identifier, path: entity.path, touches: 0, sessions: [], intents: [] }
          capsule.entities.set(key, record)
        }
        record.touches += 1
        if (!record.sessions.includes(event.sessionId)) record.sessions.push(event.sessionId)
        if (event.intentText && !record.intents.includes(event.intentText)) {
          record.intents.push(event.intentText)
        }
        // The H3 probe: a write issued after this session already lost context
        // was produced under degraded global knowledge.
        if (capsule.nCompactEvents > 0) capsule.writesAfterCompact += 1
      }
    }

    const next = LIFECYCLE_TRANSITIONS[event.kind]
    if (next) {
      capsule.state = next
      // First terminal transition wins, so a later inconsistent event cannot
      // silently extend a capsule's lifetime.
      if (!isOpen(next) && capsule.closedAtUtc === null) capsule.closedAtUtc = event.timestampUtc
    }
  }
  return capsules
}

/**
 * Every entity any capsule touched, with who touched it.
 *
 * Distinct from {@link buildContention} on purpose, and the distinction is load-bearing.
 *
 * - `buildContention` answers *"is this entity already contested?"* — it keeps only
 *   entities with two or more tasks or sessions. That is the right question for the
 *   report's contested-entity count.
 * - This answers *"who else has touched this entity?"* — no filter, because one prior
 *   toucher is already a collision in the making.
 *
 * Using the filtered list to make decisions was a real defect: the first session to
 * write an entity is a single toucher, so the governor saw nothing, and it only began
 * firing from the *second* duplicate onward. In E3, where the primary outcome is
 * duplicate landing, that would have disabled the treatment on precisely the events
 * measured. E2 caught it by scoring a pack whose collisions each have exactly one prior
 * toucher, which is what a real first collision looks like.
 */
export function entityTouches(capsules: Map<string, Capsule>): ContentionRecord[] {
  return aggregateEntities(capsules).sort((a, b) => compareCodepoint(a.entityKey, b.entityKey))
}

function aggregateEntities(capsules: Map<string, Capsule>): Array<{
  entityKey: string
  kind: string
  identifier: string
  path: string
  tasks: string[]
  sessions: string[]
  intents: string[]
  touches: number
}> {
  const byEntity = new Map<string, {
    entityKey: string
    kind: string
    identifier: string
    path: string
    tasks: string[]
    sessions: string[]
    intents: string[]
    touches: number
  }>()

  for (const capsule of capsules.values()) {
    for (const [key, record] of capsule.entities) {
      let entry = byEntity.get(key)
      if (!entry) {
        entry = {
          entityKey: key,
          kind: record.kind,
          identifier: record.identifier,
          path: record.path,
          tasks: [],
          sessions: [],
          intents: [],
          touches: 0,
        }
        byEntity.set(key, entry)
      }
      if (!entry.tasks.includes(capsule.taskId)) entry.tasks.push(capsule.taskId)
      for (const session of record.sessions) {
        if (!entry.sessions.includes(session)) entry.sessions.push(session)
      }
      for (const intent of record.intents) {
        if (!entry.intents.includes(intent)) entry.intents.push(intent)
      }
      entry.touches += record.touches
    }
  }
  return [...byEntity.values()]
}

/**
 * Entities touched by more than one task or more than one session.
 *
 * This is the cross-session blind spot made visible: a single session can only
 * see its own touches. Multi-task contention is the ground truth for redundant
 * implementation; multi-session contention is the ground truth for loss of
 * attributable intent.
 *
 * For anything that must *decide* rather than *report*, use {@link entityTouches}:
 * this function's filter hides the first toucher of an entity by construction.
 */
export function buildContention(capsules: Map<string, Capsule>): ContentionRecord[] {
  return aggregateEntities(capsules)
    .filter((e) => e.tasks.length > 1 || e.sessions.length > 1)
    .sort((a, b) =>
      b.tasks.length - a.tasks.length ||
      b.sessions.length - a.sessions.length ||
      b.touches - a.touches ||
      compareCodepoint(a.entityKey, b.entityKey),
    )
}

/** Reconstruct B(t) by replaying open/close transitions in time order. */
export function backlogSeries(capsules: Map<string, Capsule>): BacklogPoint[] {
  const timeline: Array<{ at: string; delta: number }> = []
  for (const capsule of capsules.values()) {
    timeline.push({ at: capsule.openedAtUtc, delta: 1 })
    if (capsule.closedAtUtc) timeline.push({ at: capsule.closedAtUtc, delta: -1 })
  }
  if (timeline.length === 0) return []
  timeline.sort((a, b) => compareCodepoint(a.at, b.at) || a.delta - b.delta)

  const series: BacklogPoint[] = []
  let open = 0
  for (const step of timeline) {
    open = Math.max(0, open + step.delta)
    series.push({ timestampUtc: step.at, openCapsules: open })
  }
  return series
}

function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000
}

/**
 * Arrival and integration rates per hour, withheld when the observed window is
 * too short to mean anything.
 */
export function computeRates(capsules: Map<string, Capsule>, events: readonly CoordEvent[]): Rates {
  const stamps = events.map((e) => e.timestampUtc).filter(Boolean).sort()
  if (stamps.length === 0) {
    return { observedHours: 0, lambdaProducedPerHour: null, integrationRatePerHour: null, rateIsMeaningful: false }
  }
  const observedHours = Math.max(0, hoursBetween(stamps[0], stamps[stamps.length - 1]))
  if (observedHours < MIN_RATE_WINDOW_HOURS) {
    return {
      observedHours,
      lambdaProducedPerHour: null,
      integrationRatePerHour: null,
      rateIsMeaningful: false,
      withheldReason:
        `observed span ${(observedHours * 3600).toFixed(1)}s is below the ` +
        `${(MIN_RATE_WINDOW_HOURS * 3600).toFixed(0)}s floor; rates withheld because a burst of ` +
        'back-to-back events would imply a meaningless arrival rate',
    }
  }
  const integrated = [...capsules.values()].filter((c) => c.state === INTEGRATED_STATE).length
  return {
    observedHours,
    lambdaProducedPerHour: capsules.size / observedHours,
    integrationRatePerHour: integrated / observedHours,
    rateIsMeaningful: true,
  }
}

/**
 * Time-weighted mean and peak of open capsules.
 *
 * `mean` is the average work-in-progress: effective parallelism \(P\), which H5
 * requires to be reported alongside any claimed improvement. `parallelFraction` is
 * the share of the window with two or more capsules in flight.
 *
 * Both are needed. A treatment can leave `mean` unchanged while suppressing every
 * burst of genuine parallel work, and reporting only the mean would call that
 * governance. These are the denominator against which a waste reduction is judged by
 * the K4 criterion.
 */
export function computeParallelism(series: readonly BacklogPoint[]): Parallelism {
  if (series.length === 0) {
    return { mean: 0, peak: 0, openAtEnd: 0, observedHours: 0, parallelHours: 0, parallelFraction: 0 }
  }
  const first = series[0].timestampUtc
  const last = series[series.length - 1].timestampUtc
  const totalHours = Math.max(0, hoursBetween(first, last))

  let area = 0 // capsule-hours
  let parallelHours = 0 // capsule-hours during which work could actually overlap
  for (let i = 0; i < series.length - 1; i += 1) {
    const span = Math.max(0, hoursBetween(series[i].timestampUtc, series[i + 1].timestampUtc))
    area += series[i].openCapsules * span
    if (series[i].openCapsules >= 2) parallelHours += span
  }

  return {
    // With a degenerate window the step function has no width, so fall back to
    // the instantaneous value rather than dividing by zero.
    mean: totalHours > 0 ? area / totalHours : series[series.length - 1].openCapsules,
    peak: Math.max(...series.map((p) => p.openCapsules)),
    openAtEnd: series[series.length - 1].openCapsules,
    observedHours: totalHours,
    parallelHours,
    parallelFraction: totalHours > 0 ? parallelHours / totalHours : 0,
  }
}

/**
 * Context loss and its aftermath for one session, in event order.
 *
 * This is the H3 probe at session granularity. Capsule-level counting answers "how
 * much work was produced under degraded knowledge"; this answers "how much of
 * *this session's* work was", which is what a per-session advisory can honestly
 * claim.
 */
export function sessionContextLoss(
  events: readonly CoordEvent[],
  sessionId: string,
): { compactions: number; writesAfterLoss: number } {
  let compactions = 0
  let writesAfterLoss = 0
  for (const event of events) {
    if (event.sessionId !== sessionId) continue
    if (event.kind === 'context_compacted') compactions += 1
    else if (compactions > 0 && event.kind === 'file_write') {
      writesAfterLoss += 1
    }
  }
  return { compactions, writesAfterLoss }
}

/** Derive every framework quantity from one event stream. */
export function buildReport(events: readonly CoordEvent[]): LedgerReport {
  // Sorted first, so a report is a function of the event *set* and not of the
  // order the runtime happened to observe it in. See `sortEvents`.
  const ordered = sortEvents(events)
  const capsules = buildCapsules(ordered)
  const contention = buildContention(capsules)
  const series = backlogSeries(capsules)
  const rates = computeRates(capsules, ordered)
  const parallelism = computeParallelism(series)

  const states = [...capsules.values()].map((c) => c.state)
  const histogram: Record<string, number> = {}
  for (const state of states) histogram[state] = (histogram[state] ?? 0) + 1

  const openCapsules = states.filter(isOpen).length
  const decayed = states.filter((s) => DECAYED_STATES.includes(s)).length

  return {
    counts: {
      events: ordered.length,
      capsules: capsules.size,
      openCapsules,
      // Equal by definition; named separately because the framework states its
      // propositions in terms of "unreconciled".
      unreconciledCapsules: openCapsules,
      integratedCapsules: states.filter((s) => s === INTEGRATED_STATE).length,
      decayedCapsules: decayed,
      contestedEntities: contention.length,
      sessionsWithContextLoss: new Set(
        ordered.filter((e) => e.kind === 'context_compacted').map((e) => e.sessionId),
      ).size,
    },
    rates,
    parallelism,
    backlogSeries: series,
    stateHistogram: Object.fromEntries(
      Object.entries(histogram).sort(([a], [b]) => compareCodepoint(a, b)),
    ),
    topContestedEntities: contention.slice(0, 20),
    writesAfterContextLoss: [...capsules.values()].reduce((sum, c) => sum + c.writesAfterCompact, 0),
  }
}

/**
 * In-memory ledger with optional append-only persistence.
 *
 * The sink is injectable so tests need no filesystem and so the plugin can run
 * with recording disabled (`ledgerScope: 'off'`) while still deriving in-memory
 * state for the session it is allowed to see.
 */
export class Ledger {
  readonly #events: CoordEvent[] = []
  readonly #sink: ((line: string) => void) | undefined

  constructor(sink?: (line: string) => void) {
    this.#sink = sink
  }

  get events(): readonly CoordEvent[] {
    return this.#events
  }

  /**
   * Record one event: persist first, then retain.
   *
   * The order matters. Retaining before persisting would leave a phantom event in
   * memory whenever a write fails, and a live governor whose state disagrees with
   * the ledger it is audited against is the worst possible failure for an
   * experiment — the run looks healthy while its evidence is incomplete. Failing
   * closed instead makes the fault visible in `errors`.
   */
  record(event: CoordEvent): CoordEvent {
    this.#sink?.(serializeEvent(event))
    this.#events.push(event)
    return event
  }

  capsules(): Map<string, Capsule> {
    return buildCapsules(sortEvents(this.#events))
  }

  contention(): ContentionRecord[] {
    return buildContention(this.capsules())
  }

  report(): LedgerReport {
    return buildReport(this.#events)
  }

  /** Replace the whole stream, used by the E0 cross-check and by replay. */
  load(events: readonly CoordEvent[]): void {
    this.#events.length = 0
    this.#events.push(...events)
  }
}
