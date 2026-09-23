/**
 * Structural vocabulary for the coordination ledger.
 *
 * Deliberately free of any `@deepseek-ai/*` import so that the ledger, the policy
 * and their tests run under plain `node --test` with no packages installed. The
 * DSH adapter casts its real payloads into these shapes at the boundary
 * (`plugin.ts`), which keeps the research-critical logic independently testable.
 *
 * @module dsh-coord-governor/types
 */

/**
 * Lifecycle vocabulary, verbatim from the ISCC v0.1 capsule contract
 * (`03_基准与标注/benchmark/iscc-v0.1/iscc.schema.json`, `lifecycle.state`).
 * Reused rather than re-invented so both artifacts describe the same states.
 */
export type LifecycleState =
  | 'proposed'
  | 'active'
  | 'validated'
  | 'integrated'
  | 'stale'
  | 'abandoned'

/**
 * States that count as backlog. `validated` is deliberately included: passing
 * checks is not the same as being reconciled into an explainable repository
 * state, so counting it as done would understate B(t).
 */
export const OPEN_STATES: readonly LifecycleState[] = ['proposed', 'active', 'validated']

/**
 * Terminal states that represent realised waste rather than pending work.
 * Reported separately from backlog: a wave of abandonments must never look
 * like a shrinking backlog.
 */
export const DECAYED_STATES: readonly LifecycleState[] = ['stale', 'abandoned']

/** Terminal state meaning the change actually landed. */
export const INTEGRATED_STATE: LifecycleState = 'integrated'

/** One touched entity, in the ISCC `scope.entities` shape. */
export interface Entity {
  readonly kind: string
  readonly identifier: string
  readonly path: string
}

/**
 * ISCC v0.1 `provenance.events[].kind`, verbatim from `iscc.schema.json`.
 *
 * Kept because `coord_ledger.py` is the shared analysis instrument and counts
 * entity touches only for its `ENTITY_EVENTS` subset of these names.
 */
export const ISCC_EVENT_KINDS = [
  'task_registered',
  'file_read',
  'file_write',
  'command',
  'test',
  'review',
  'decision',
] as const

/**
 * Kinds recorded in the ledger beyond the ISCC v0.1 set.
 *
 * Writes deliberately reuse the ISCC kind `file_write` rather than a bespoke
 * `write_intent`, because `coord_ledger.py` counts entity touches only for
 * `ENTITY_EVENTS = {file_write, file_read}`. A private name would be invisible to
 * the Python analyser, silently emptying every contention figure on that side.
 * `tests/interop.test.ts` enforces this against the Python source.
 *
 * `context_compacted` does not exist in ISCC v0.1 — the upstream contract cannot
 * record this framework's own root cause. It is a declared extension; see the
 * package README for why `iscc-0.2` is required.
 */
export const COORD_EVENT_KINDS = [
  'session_started',
  'session_ended',
  /** Write outcome, recorded after dispatch. TS-side only; Python ignores it. */
  'write_settled',
  'advisory_injected',
  'gate_allowed',
  'gate_denied',
  'gate_asked',
  'context_compacted',
  'lifecycle_validated',
  'lifecycle_integrated',
  'lifecycle_stale',
  'lifecycle_abandoned',
  'turn_ended',
] as const

export type CoordEventKind = (typeof ISCC_EVENT_KINDS)[number] | (typeof COORD_EVENT_KINDS)[number]

export const ALL_EVENT_KINDS: readonly CoordEventKind[] = [
  ...ISCC_EVENT_KINDS,
  ...COORD_EVENT_KINDS,
]

/** Which lifecycle state a transition event moves a capsule into. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<string, LifecycleState>> = {
  lifecycle_validated: 'validated',
  lifecycle_integrated: 'integrated',
  lifecycle_stale: 'stale',
  lifecycle_abandoned: 'abandoned',
}

/**
 * One ledger record. Field names here are camelCase for TypeScript ergonomics;
 * {@link toWire} emits the snake_case shape that matches
 * `04_协调插件/coord_ledger.py`, so the existing Python analysis tool reads a
 * DSH ledger with no adapter.
 */
export interface CoordEvent {
  readonly kind: CoordEventKind
  readonly timestampUtc: string
  readonly sessionId: string
  readonly developer?: string | null
  readonly taskId?: string | null
  readonly entities?: readonly Entity[]
  /** The agent's own words for what it is about to do, when available. */
  readonly intentText?: string | null
  /** Host event that produced this record, passed through verbatim. */
  readonly hostEvent?: string | null
  readonly reason?: string | null
  /** Free-form extra facts; kept out of the interop-critical field set. */
  readonly detail?: Readonly<Record<string, unknown>> | null
}

/** The serialized, cross-language shape. Mirrors `coord_ledger.py`'s records. */
export interface WireEvent {
  readonly schema_version: string
  readonly event_id: string
  readonly kind: string
  readonly timestamp_utc: string
  readonly session_id: string
  readonly developer: string | null
  readonly task_id: string | null
  readonly entities: readonly Entity[]
  readonly intent_text: string | null
  readonly host_event: string | null
  readonly reason: string | null
  readonly detail: Record<string, unknown> | null
}

/** One task's accumulated state, folded from the event stream. */
export interface Capsule {
  readonly taskId: string
  state: LifecycleState
  openedAtUtc: string
  closedAtUtc: string | null
  readonly sessions: string[]
  readonly developers: string[]
  readonly entities: Map<string, EntityRecord>
  nEvents: number
  nCompactEvents: number
  /** Writes issued after this capsule's session had already lost context. */
  writesAfterCompact: number
}

/** Per-entity accumulation inside one capsule. */
export interface EntityRecord {
  readonly kind: string
  readonly identifier: string
  readonly path: string
  touches: number
  readonly sessions: string[]
  readonly intents: string[]
}

/** One entity seen across capsules. */
export interface ContentionRecord {
  readonly entityKey: string
  readonly kind: string
  readonly identifier: string
  readonly path: string
  readonly tasks: string[]
  readonly sessions: string[]
  readonly intents: string[]
  touches: number
}

/** One point of the reconstructed backlog curve. */
export interface BacklogPoint {
  readonly timestampUtc: string
  readonly openCapsules: number
}

/**
 * Effective parallelism, the denominator that kills trivial wins.
 *
 * `mean` is the time-weighted mean of open capsules over the observed window —
 * that is, the average work-in-progress. This is the operationalization of
 * `tau_parallel` from `01_问题定义与定位/痛点_速度与上下文失配.md` §3.5: a
 * governor that reduces waste while also reducing this number has bought its
 * result by serializing work, which the framework forbids counting as
 * governance.
 */
export interface Parallelism {
  /**
   * Time-weighted mean number of open capsules, i.e. the average amount of
   * simultaneously in-flight work. This is effective parallelism \(P\), the
   * denominator H5 requires to be reported next to any claimed improvement: a
   * treatment that lowers waste by lowering this number has throttled, not governed.
   */
  readonly mean: number
  readonly peak: number
  readonly openAtEnd: number
  readonly observedHours: number
  /** Hours during which two or more capsules were open at once. */
  readonly parallelHours: number
  /**
   * Share of the observed window spent with two or more capsules in flight.
   *
   * Reported separately from {@link mean} because the two can move in opposite
   * directions: a governor could keep the same average while destroying bursts of
   * genuine parallel work, which is exactly the K4 failure this guards.
   */
  readonly parallelFraction: number
}

/** Arrival and reconciliation rates. `null` when the window is too short. */
export interface Rates {
  readonly observedHours: number
  readonly lambdaProducedPerHour: number | null
  readonly integrationRatePerHour: number | null
  readonly rateIsMeaningful: boolean
  readonly withheldReason?: string
}

/** Everything the framework needs derived from one ledger. */
export interface LedgerReport {
  readonly counts: {
    readonly events: number
    readonly capsules: number
    readonly openCapsules: number
    readonly unreconciledCapsules: number
    readonly integratedCapsules: number
    readonly decayedCapsules: number
    readonly contestedEntities: number
    readonly sessionsWithContextLoss: number
  }
  readonly rates: Rates
  readonly parallelism: Parallelism
  readonly backlogSeries: readonly BacklogPoint[]
  readonly stateHistogram: Readonly<Record<string, number>>
  readonly topContestedEntities: readonly ContentionRecord[]
  readonly writesAfterContextLoss: number
}
