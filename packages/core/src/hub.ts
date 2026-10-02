/**
 * The coordination hub: one deterministic ruling per contention, published into the ledger.
 *
 * Why this is a *derived function* and not an agent
 * -------------------------------------------------
 * A hub implemented as a conversation would stop ruling the moment that conversation
 * slept, and would pay a model call per write. So the hub is a pure function of the ledger
 * plus a clock: the same events and the same instant always produce the same ruling, and
 * two windows asking at the same time cannot get two answers. "One ruling per contention"
 * is therefore true by construction rather than by agreement.
 *
 * What "unified" is guaranteed to mean
 * ------------------------------------
 * A ruling is published as an append-only `advisory_injected` ledger event carrying a
 * {@link HubVerdict.id} that is a hash of the *ruling* alone. That id deliberately excludes
 * every time-varying quantity — the projection's timestamp, the parallelism figure, and how
 * long an ownership recommendation has stood — because including any of them would make the
 * ruling "change" on every tick and turn a stable conclusion into a stream of new ones.
 *
 * Authority
 * ---------
 * Every ruling is advisory. This module never writes a lease, never grants an owner, and
 * never refuses anything: it *recommends* an owner so two windows see the same
 * recommendation, and the product's own promise (a verdict reports and stops) is untouched.
 * {@link HubVerdict.authority} exists so a binding mode would have somewhere to declare
 * itself; nothing reads it to change behaviour today.
 *
 * The brain
 * ---------
 * A lexical matcher cannot decide every collision, and pretending otherwise is how a
 * coordination signal turns into noise. When two intents exist but their similarity falls
 * inside the undecidable band, the ruling is `ambiguous` and carries
 * {@link HubRuling.needsResolution}. Any window may then answer once through
 * `agentgit_hub_resolve`, which writes a `decision` event; the hub applies the *earliest*
 * answer for that entity, so a second window answering the same question cannot produce a
 * second conclusion.
 *
 * @module @agentgit/core/hub
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadAssumptions, loadContracts, staleAssumptions } from './contracts.ts'
import { buildCapsules, buildEvent, compareCodepoint, entityTouches, toWire } from './ledger.ts'
import { liveLeases, loadLeases } from './leases.ts'
import { intentSimilarity } from './policy.ts'
import type { ContentionRecord, CoordEvent, Entity } from './types.ts'
import { appendEvent, machineId, readAllEvents, type WorkspacePaths } from './workspace.ts'

/** The projection's own format version. Bumped only when the shape breaks. */
export const HUB_PROJECTION_VERSION = 1

/**
 * Similarity band for two recorded intents on one entity.
 *
 * `reuse` matches the product's existing duplicate threshold so the hub and `preflight`
 * never disagree about what "the same work" means. `replan` is a floor rather than a second
 * guess: below it, two intents share so little that calling them the same work would be a
 * fabrication. Between the two the evidence is genuinely insufficient, and that is the one
 * case worth spending a model call on.
 *
 * The floor is deliberately low. Rewording one job is the normal case — "add rate limiting to
 * the login endpoint" and "throttle repeated login attempts" are one change — and a rephrase
 * that falls above the floor is routed to `ambiguous` and answered by the brain, which is the
 * outcome that reuses work. A high floor turned exactly those pairs into `replan`, i.e. it
 * told two agents doing one job to split the interface.
 */
export const HUB_DECIDE_BAND = { reuse: 0.42, replan: 0.1 } as const

/**
 * Similarity at which two tasks are flagged as probably doing one job on *different* ground.
 *
 * Below `HUB_DECIDE_BAND.reuse` on purpose. A ruling needs to be sure, because it names an
 * owner and a decision; this only raises a question, and a question costs a sentence of
 * context. It is the one signal that crosses filenames, which is the most common duplication
 * and the one a per-entity ruler structurally cannot see.
 */
export const HUB_DUPLICATE_WORK_THRESHOLD = 0.3

/** How many cross-file duplicate pairs the advisory names before it stops. */
export const HUB_DUPLICATE_WORK_LIMIT = 5

/** Cap on the injected advisory. It is handed to a context that is already under pressure. */
export const HUB_ADVISORY_MAX_CHARS = 1200

/** Caps that keep the projection small enough for a per-tool-call read to stay constant. */
export const HUB_RULING_LIMIT = 12
export const HUB_INTENT_LIMIT = 3
export const HUB_INTENT_MAX_CHARS = 140

/** Where the ruling this session has already been shown is remembered. */
export const HUB_SEEN_DIRNAME = 'hub-seen'

/** `hostEvent` on the published ruling. Greppable, and cannot collide with the product's own. */
export const HUB_PUBLISH_HOST_EVENT = 'hub/publish'

/** `hostEvent` on a brain answer. Keyed by entity, never by ruling id — see {@link hubVerdictId}. */
export const HUB_RESOLVE_HOST_EVENT = 'hub/resolve'

/** Every hub-written event carries this session prefix, so readers can exclude them. */
export const HUB_SESSION_PREFIX = 'hub:'

/** True for an event this module wrote. Used to keep hub events out of identity heuristics. */
export function isHubEvent(event: CoordEvent): boolean {
  return event.sessionId.startsWith(HUB_SESSION_PREFIX)
}

/** How the ruling for one entity was reached. */
export type HubRulingBasis =
  /** Both sides named the same symbol, which stands on its own. */
  | 'structural-duplicate'
  /** Same file, with intents similar enough to be one piece of work. */
  | 'intent-similarity'
  /** Same file, with intents visibly about different things. */
  | 'different-intent'
  /** Same file, and fewer than two intents were ever recorded. */
  | 'insufficient-intent'
  /** Two intents exist and the lexical matcher cannot call it either way. */
  | 'lexical-undecidable'
  /** A window answered through `agentgit_hub_resolve`. */
  | 'resolved'

/** The word for one ruling. `ambiguous` is the only one that asks for a model. */
export type HubRulingWord = 'reuse' | 'replan' | 'ambiguous'

/** Who is recommended to own an entity, and for how long that has been the recommendation. */
export interface HubOwner {
  readonly taskId: string | null
  /** Why this task: it holds a live lease, or it wrote the entity first. */
  readonly basis: 'lease' | 'first-write' | 'none'
  /**
   * Minutes the same recommendation has stood continuously, per the published rulings.
   *
   * This is the starvation proxy required of any hub that could ever bind. Under an
   * advisory hub nothing is blocked, so it measures recommendation stability rather than
   * lost work — but it is reported anyway, because a recommendation nobody can get out of
   * is the thing to watch before authority is ever raised.
   */
  readonly heldMinutes: number
  /** In-flight tasks other than the owner that also want this entity. */
  readonly waiting: readonly string[]
}

/**
 * Ground somebody is holding right now.
 *
 * Separate from {@link HubRuling} because the two are different facts. A ruling answers "two
 * tasks want this ground, and here is the one conclusion about that". A holder answers "one task
 * is on this ground as of now" — which is the moment coordination actually has to happen, and it
 * precedes the contention that a ruler can see. Without holders the hub could only tell a window
 * about a collision *after* the window had already created one.
 */
export interface HubHolder {
  readonly entityKey: string
  readonly kind: string
  readonly path: string
  readonly taskId: string
  readonly sessionId: string
  readonly reason: string
  readonly expiresAt: string
  /** Minutes this task has been recommended as owner, from the published rulings. */
  readonly heldMinutes: number
  /** Other tasks that have already written this entity. */
  readonly others: readonly string[]
}

/** One contention, and the one conclusion the hub reached about it. */
export interface HubRuling {
  readonly entityKey: string
  readonly kind: string
  readonly path: string
  readonly tasks: readonly string[]
  readonly sessions: readonly string[]
  readonly intents: readonly string[]
  readonly word: HubRulingWord
  readonly basis: HubRulingBasis
  readonly similarity: number | null
  /** True only for `lexical-undecidable`: this is the case the brain exists for. */
  readonly needsResolution: boolean
  readonly owner: HubOwner
  /** Session that answered an ambiguous ruling, when one did. */
  readonly resolvedBy: string | null
  /** True when a later answer exists but the earliest one is the published conclusion. */
  readonly supersededAnswers: number
}

/** One branch that should land, and why. Supplied by the caller because it needs git. */
export interface HubIntegrationItem {
  readonly taskId: string
  readonly branch: string
  readonly reason: string
  readonly blocking: boolean
}

/** One assumption that is behind a published interface. */
export interface HubStaleItem {
  readonly taskId: string
  readonly contract: string
  readonly assumedVersion: number
  readonly currentVersion: number
  readonly breaking: boolean
}

/**
 * Two tasks whose intents say one job, on ground they do not share.
 *
 * This exists because a {@link HubRuling} cannot: rulings are keyed by an entity, so two
 * agents doing one thing in two differently-named files never enter one and are invisible to
 * each other. This is a *question*, not a decision — no owner, no word — so it adds no ruling
 * and changes nothing a window is allowed to do. It only makes the commonest duplication
 * visible instead of silent, which is the whole of the fix.
 */
export interface HubDuplicateWork {
  /** The two tasks, sorted, so the pair has one spelling. */
  readonly tasks: readonly [string, string]
  readonly similarity: number
  /** The two intent sentences that matched, in `tasks` order. */
  readonly intents: readonly [string, string]
}

export interface HubParallelism {
  readonly mean: number
  readonly peak: number
  readonly parallelFraction: number
}

/**
 * The hub's self-report.
 *
 * Kept beside the rulings rather than in a separate surface so a ruling count is never read
 * without the cost the framework requires next to it: `parallelismMean` is effective
 * parallelism \(P\), and a fall in it means the hub bought a quiet workspace by throttling
 * the work rather than by coordinating it.
 */
export interface HubMetrics {
  readonly rulings: number
  readonly ambiguous: number
  readonly owned: number
  /** Entities a task is holding right now, whether or not anyone else has touched them. */
  readonly holders: number
  readonly longestOwnershipMinutes: number
  readonly waitingTasks: number
  /**
   * Age of the newest ledger fact this ruling was computed from, in minutes.
   *
   * This is the spine's *latency*, and it is a cost rather than a benefit: a ruling can never be
   * fresher than the last thing that happened in the workspace, and it is only recomputed on a
   * poll. Reporting it next to the rulings is what stops "the hub was quiet" from being read as
   * "the hub was watching" — a stale ruling and a correct one look identical from the outside.
   */
  readonly inputLagMinutes: number
  /** Rulings published into the ledger, ever. */
  readonly published: number
  /** Effective parallelism, restated here so it cannot be read apart from the rulings. */
  readonly parallelismMean: number
}

/** The whole published conclusion: what every window reads, and what the hook injects. */
export interface HubVerdict {
  readonly version: number
  readonly id: string
  readonly generatedAt: string
  readonly workspace: string
  /** Always `advisory` today. A binding mode would announce itself here. */
  readonly authority: 'advisory'
  /**
   * Workspace-relative paths a tool call can be matched against, for write-time injection.
   *
   * The union of the ruled entities and the held ones, because a window about to write ground
   * somebody reserved needs to hear that just as much as one about to write ground two tasks
   * already fought over.
   */
  readonly targets: readonly string[]
  readonly rulings: readonly HubRuling[]
  readonly holders: readonly HubHolder[]
  readonly integration: readonly HubIntegrationItem[]
  readonly stale: readonly HubStaleItem[]
  /**
   * Tasks that look like one job on ground they do not share. See {@link HubDuplicateWork}.
   *
   * Not part of {@link hubVerdictId}: this is a standing question about the whole workspace, not
   * a conclusion, and folding it into the id would republish the ruling whenever a new task's
   * wording drifted. It rides along with a ruling that is already being published.
   */
  readonly duplicateWork: readonly HubDuplicateWork[]
  readonly parallelism: HubParallelism
  readonly metrics: HubMetrics
  /** The exact text injected into an agent's context. Rendered here so the hook does no work. */
  readonly advisory: string
}

/** What a window answered for an ambiguous ruling. */
export interface HubAnswer {
  readonly entityKey: string
  readonly decision: 'reuse' | 'replan'
  readonly reason: string | null
  readonly sessionId: string
  readonly taskId: string | null
  /** The contention this answer was about; an answer to different contention is ignored. */
  readonly signature: string
  readonly at: string
  readonly eventId: string
  /**
   * True when a later answer exists for the same entity and contention.
   *
   * Mutable because the earliest answer can only be identified once every answer has been
   * read, and stamping the losers afterwards is cheaper than building a second list.
   */
  superseded: boolean
}

/* -------------------------------------------------------------------------- */
/* Reading and writing the projection                                          */
/* -------------------------------------------------------------------------- */

function projectionFile(paths: WorkspacePaths): string {
  return join(paths.state, 'hub.json')
}

function seenDir(paths: WorkspacePaths): string {
  return join(paths.state, HUB_SEEN_DIRNAME)
}

/**
 * A filesystem-safe, collision-free name for one session's marker.
 *
 * The readable part makes the directory diagnosable by hand; the hash makes two ids that
 * sanitise to the same string still two files, which is the whole point of the marker.
 */
export function seenMarkerName(sessionId: string): string {
  const readable = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
  return `${readable || 'session'}-${digest}.json`
}

export interface HubMarker {
  readonly version: number
  readonly rulingId: string
  readonly at: string
  /** The hook event that showed it, so a stale marker is diagnosable. */
  readonly event: string
}

/** What this session has already been shown, or `null` when it has been shown nothing. */
export function readHubMarker(paths: WorkspacePaths, sessionId: string): HubMarker | null {
  const file = join(seenDir(paths), seenMarkerName(sessionId))
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HubMarker>
    if (!raw || typeof raw.rulingId !== 'string') return null
    return {
      version: typeof raw.version === 'number' ? raw.version : HUB_PROJECTION_VERSION,
      rulingId: raw.rulingId,
      at: typeof raw.at === 'string' ? raw.at : '',
      event: typeof raw.event === 'string' ? raw.event : '',
    }
  } catch {
    return null
  }
}

/** Remember that this session has now seen this ruling. */
export function writeHubMarker(paths: WorkspacePaths, sessionId: string, marker: Omit<HubMarker, 'version'>): void {
  try {
    mkdirSync(seenDir(paths), { recursive: true })
    writeFileSync(
      join(seenDir(paths), seenMarkerName(sessionId)),
      `${JSON.stringify({ version: HUB_PROJECTION_VERSION, ...marker })}\n`,
      'utf8',
    )
  } catch {
    // A marker that cannot be written costs one repeated injection, which is better than
    // failing the tool call the hook is attached to.
  }
}

/**
 * How many sessions have been shown a ruling, for the coverage figure.
 *
 * Counted from the markers rather than from the ledger on purpose: whether a window saw a
 * ruling is not a coordination fact about the workspace, and the hook that knows it runs on
 * the tool-call critical path. A marker is the cheap, honest place for it.
 */
export function hubSeenCount(paths: WorkspacePaths, rulingId?: string): number {
  const dir = seenDir(paths)
  if (!existsSync(dir)) return 0
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return 0
  }
  let count = 0
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Partial<HubMarker>
      if (typeof raw.rulingId !== 'string') continue
      if (rulingId !== undefined && raw.rulingId !== rulingId) continue
      count += 1
    } catch {
      // A torn marker is a session that will be told again. Skipping it is the safe read.
    }
  }
  return count
}

/**
 * Read the last published ruling.
 *
 * Tolerant by design: the projection is a cache of a conclusion that is also in the ledger,
 * so a missing or torn copy degrades to "nothing to push right now" rather than to an error
 * on a path that runs inside a tool call.
 */
export function readHubVerdict(paths: WorkspacePaths): HubVerdict | null {
  const file = projectionFile(paths)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HubVerdict>
    if (!raw || typeof raw.id !== 'string') return null
    if (!Array.isArray(raw.rulings) || typeof raw.advisory !== 'string') return null
    return {
      version: typeof raw.version === 'number' ? raw.version : HUB_PROJECTION_VERSION,
      id: raw.id,
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      workspace: typeof raw.workspace === 'string' ? raw.workspace : paths.root,
      authority: 'advisory',
      targets: Array.isArray(raw.targets) ? raw.targets.filter((t): t is string => typeof t === 'string') : [],
      rulings: raw.rulings as HubRuling[],
      holders: Array.isArray(raw.holders) ? (raw.holders as HubHolder[]) : [],
      integration: Array.isArray(raw.integration) ? (raw.integration as HubIntegrationItem[]) : [],
      stale: Array.isArray(raw.stale) ? (raw.stale as HubStaleItem[]) : [],
      // Absent from a projection written before this field existed: an older cache degrades to
      // "no cross-file question", which is the same as having none rather than an error.
      duplicateWork: Array.isArray(raw.duplicateWork) ? (raw.duplicateWork as HubDuplicateWork[]) : [],
      parallelism: raw.parallelism ?? { mean: 0, peak: 0, parallelFraction: 0 },
      metrics: raw.metrics ?? {
        rulings: 0,
        ambiguous: 0,
        owned: 0,
        holders: 0,
        longestOwnershipMinutes: 0,
        waitingTasks: 0,
        inputLagMinutes: 0,
        published: 0,
        parallelismMean: 0,
      },
      advisory: raw.advisory,
    }
  } catch {
    return null
  }
}

/**
 * Write the projection atomically.
 *
 * Temp-then-rename because the reader is a hook running inside a tool call: a half-written
 * file would be a ruling that vanishes for one session with nothing to explain it. The
 * fallback exists for the case where the OS refuses the replace, and it is a plain write
 * rather than nothing so a platform quirk cannot disable the push entirely.
 */
export function writeHubVerdict(paths: WorkspacePaths, verdict: HubVerdict): void {
  const file = projectionFile(paths)
  const body = `${JSON.stringify(verdict)}\n`
  try {
    mkdirSync(paths.state, { recursive: true })
    const temp = `${file}.tmp-${process.pid}`
    writeFileSync(temp, body, 'utf8')
    try {
      renameSync(temp, file)
    } catch {
      rmSync(temp, { force: true })
      writeFileSync(file, body, 'utf8')
    }
  } catch {
    // The ledger copy is the durable one; failing to refresh a cache must never throw here.
  }
}

/* -------------------------------------------------------------------------- */
/* Computing the ruling                                                        */
/* -------------------------------------------------------------------------- */

/** Sorted `tasks|sessions` fingerprint of one contention. An answer is only valid for one. */
export function contentionSignature(record: { tasks: readonly string[]; sessions: readonly string[] }): string {
  return `${[...record.tasks].sort(compareCodepoint).join(',')}|${[...record.sessions].sort(compareCodepoint).join(',')}`
}

function cap(value: string, max = HUB_INTENT_MAX_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function entityKeyOf(entity: Entity): string {
  return entity.kind && entity.kind !== 'file'
    ? `${entity.kind}::${entity.identifier || entity.path}`
    : `file::${entity.path}`
}

/** The `hub/resolve` answers in the ledger, earliest first, with later ones marked. */
export function hubAnswers(events: readonly CoordEvent[]): HubAnswer[] {
  const found: HubAnswer[] = []
  for (const event of events) {
    if (event.hostEvent !== HUB_RESOLVE_HOST_EVENT) continue
    const detail = event.detail ?? {}
    const entityKey = typeof detail.entityKey === 'string' ? detail.entityKey : null
    const decision = detail.decision === 'reuse' || detail.decision === 'replan' ? detail.decision : null
    const signature = typeof detail.signature === 'string' ? detail.signature : ''
    if (!entityKey || !decision) continue
    found.push({
      entityKey,
      decision,
      reason: event.reason ?? null,
      sessionId: event.sessionId,
      taskId: event.taskId ?? null,
      signature,
      at: event.timestampUtc,
      eventId: toWire(event).event_id,
      superseded: false,
    })
  }
  // Preserve ledger append order for answers in the same millisecond. Hash order would let
  // a later answer replace one already published. Shards are read in deterministic order.
  found.sort((a, b) => compareCodepoint(a.at, b.at))
  const winners = new Set<string>()
  for (const answer of found) {
    const key = `${answer.entityKey}\u0000${answer.signature}`
    if (winners.has(key)) answer.superseded = true
    else winners.add(key)
  }
  return found
}

/** The earliest answer for one entity and contention, and how many later ones were ignored. */
function answerFor(
  answers: readonly HubAnswer[],
  entityKey: string,
  signature: string,
): { winner: HubAnswer; superseded: number } | null {
  let winner: HubAnswer | null = null
  let superseded = 0
  for (const answer of answers) {
    if (answer.entityKey !== entityKey || answer.signature !== signature) continue
    if (!winner) winner = answer
    else superseded += 1
  }
  return winner ? { winner, superseded } : null
}

/** Ownership recommendations carried by the published rulings, oldest to newest. */
function ownershipHistory(events: readonly CoordEvent[]): Array<{ at: string; owners: Record<string, string> }> {
  const history: Array<{ at: string; owners: Record<string, string> }> = []
  for (const event of events) {
    if (event.hostEvent !== HUB_PUBLISH_HOST_EVENT) continue
    const owners = event.detail?.ownership
    if (!owners || typeof owners !== 'object' || Array.isArray(owners)) continue
    const cleaned: Record<string, string> = {}
    for (const [key, value] of Object.entries(owners as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') cleaned[key] = value
    }
    history.push({ at: event.timestampUtc, owners: cleaned })
  }
  history.sort((a, b) => compareCodepoint(a.at, b.at))
  // Bounded: a long-lived workspace accrues one published ruling per material change, and a
  // window is all the starvation proxy needs.
  return history.slice(-500)
}

/**
 * When the current recommendation for each entity began.
 *
 * Walked newest-first: the first publish naming an entity starts its run, and every earlier
 * publish naming the *same* owner extends it backwards. A different owner ends the walk,
 * because that is where the recommendation actually changed.
 */
function ownershipSince(
  history: readonly { at: string; owners: Record<string, string> }[],
): Map<string, { owner: string; since: string }> {
  const runs = new Map<string, { owner: string; since: string }>()
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index]
    for (const [key, owner] of Object.entries(entry.owners)) {
      const existing = runs.get(key)
      if (!existing) {
        runs.set(key, { owner, since: entry.at })
        continue
      }
      if (existing.owner === owner) existing.since = entry.at
    }
  }
  return runs
}

function minutesBetween(from: string, to: Date): number {
  const at = Date.parse(from)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.round(((to.getTime() - at) / 60_000) * 10) / 10)
}

/** Earliest `file_write` per entity, plus the path each key was written at and who wrote it. */
function writeIndex(events: readonly CoordEvent[]): {
  first: Map<string, string>
  path: Map<string, string>
  tasks: Map<string, string[]>
} {
  const ordered = [...events].sort((a, b) => compareCodepoint(a.timestampUtc, b.timestampUtc))
  const first = new Map<string, string>()
  const path = new Map<string, string>()
  const tasks = new Map<string, string[]>()
  for (const event of ordered) {
    // A `task_registered` event declares the paths a task intends to touch, so it is a legitimate
    // source for a *path* — but not for a touch or an owner, which are claims about work done.
    const declares = event.kind === 'file_write' || event.kind === 'task_registered'
    if (!declares) continue
    for (const entity of event.entities ?? []) {
      const key = entityKeyOf(entity)
      if (entity.path && !path.has(key)) path.set(key, entity.path)
      if (event.kind !== 'file_write') continue
      if (!event.taskId) continue
      if (!first.has(key)) first.set(key, event.taskId)
      const seen = tasks.get(key) ?? []
      if (!seen.includes(event.taskId)) seen.push(event.taskId)
      tasks.set(key, seen)
    }
  }
  return { first, path, tasks }
}

/** The recommended owner: a live lease first, the earliest writer second, nobody third. */
function ownerOf(
  record: ContentionRecord,
  leases: ReturnType<typeof liveLeases>,
  firstWrite: ReadonlyMap<string, string>,
  runs: ReadonlyMap<string, { owner: string; since: string }>,
  now: Date,
): HubOwner {  const onEntity = leases.filter((lease) => lease.entityKey === record.entityKey)
  const all = [...record.tasks].sort(compareCodepoint)
  const sinceAt = runs.get(record.entityKey)?.since ?? null

  if (onEntity.length > 0) {
    const oldest = [...onEntity].sort(
      (a, b) => compareCodepoint(a.grantedAt, b.grantedAt) || compareCodepoint(a.taskId, b.taskId),
    )[0]
    return {
      taskId: oldest.taskId,
      basis: 'lease',
      // A lease is renewed, not re-granted, so its own `grantedAt` is the floor under the
      // published-run figure: the recommendation cannot be older than the lease it rests on.
      heldMinutes: minutesBetween(sinceAt ?? oldest.grantedAt, now),
      waiting: all.filter((taskId) => taskId !== oldest.taskId),
    }
  }

  const first = firstWrite.get(record.entityKey) ?? null
  return {
    taskId: first,
    basis: first ? 'first-write' : 'none',
    heldMinutes: first && sinceAt ? minutesBetween(sinceAt, now) : 0,
    waiting: all.filter((taskId) => taskId !== first),
  }
}

/** Decide one contention: structural evidence first, lexical second, ambiguity last. */
function ruleOn(
  record: ContentionRecord,
  answers: readonly HubAnswer[],
): {
  word: HubRulingWord
  basis: HubRulingBasis
  similarity: number | null
  resolvedBy: string | null
  superseded: number
} {
  const intents = record.intents.filter((intent) => intent.trim().length > 0)

  let similarity: number | null = null
  for (let i = 0; i < intents.length; i += 1) {
    for (let j = i + 1; j < intents.length; j += 1) {
      const score = intentSimilarity(intents[i], intents[j])
      similarity = similarity === null ? score : Math.max(similarity, score)
    }
  }

  /*
   * The ledger keeps one copy of each distinct sentence, so two tasks that wrote the *same*
   * intent collapse to a single entry and the loop above finds nothing to compare - the
   * clearest duplicate there is, read as "insufficient intent" and answered with a replan.
   * The holder map remembers who said what, so an identical sentence from more than one task
   * is scored as the duplicate it is instead of being punished for agreeing.
   */
  const holders = record.intentHolders
  if (holders) {
    for (const intent of intents) {
      if ((holders[intent]?.length ?? 0) > 1) {
        similarity = 1
        break
      }
    }
  }

  /*
   * A record keyed by `symbol::` is two tasks naming the same behaviour, which stands on
   * its own — the same reason `isStructuralDuplicate` refuses to let file overlap qualify.
   * It is read off the key rather than inferred from intents, so the structural case cannot
   * be argued away by how either agent happened to phrase its intent.
   */
  const structural = record.kind === 'symbol'

  const provisional: { word: HubRulingWord; basis: HubRulingBasis } = structural
    ? { word: 'reuse', basis: 'structural-duplicate' }
    : similarity === null
      ? { word: 'replan', basis: 'insufficient-intent' }
      : similarity >= HUB_DECIDE_BAND.reuse
        ? { word: 'reuse', basis: 'intent-similarity' }
        : similarity <= HUB_DECIDE_BAND.replan
          ? { word: 'replan', basis: 'different-intent' }
          : { word: 'ambiguous', basis: 'lexical-undecidable' }

  // Only an undecidable ruling is worth a model call, and only an answer to *this* contention
  // counts. Evidence that already decided is never overridden, so the ledger cannot be used
  // to argue a decided collision back open.
  if (provisional.word !== 'ambiguous') {
    return { ...provisional, similarity, resolvedBy: null, superseded: 0 }
  }

  const answered = answerFor(answers, record.entityKey, contentionSignature(record))
  if (!answered) return { ...provisional, similarity, resolvedBy: null, superseded: 0 }
  return {
    word: answered.winner.decision,
    basis: 'resolved',
    similarity,
    resolvedBy: answered.winner.sessionId,
    superseded: answered.superseded,
  }
}

export interface HubComputeExtras {
  /** Branches to land and why. Supplied by the caller because it needs a `git` call. */
  readonly integration?: readonly HubIntegrationItem[]
  readonly parallelism?: HubParallelism
}

/**
 * Compute the whole ruling for one workspace.
 *
 * Reads the same ledger, leases and contracts the verdict does, so the hub and `preflight`
 * cannot be looking at two different workspaces. The parallelism figure is passed in when
 * the caller already derived it, so the hub never pays for a second derivation.
 */
export function computeHubVerdict(
  paths: WorkspacePaths,
  now: Date = new Date(),
  extras: HubComputeExtras = {},
): HubVerdict {
  const { events } = readAllEvents(paths)
  const capsules = buildCapsules(events)
  const contention = entityTouches(capsules).filter(
    (record) => record.tasks.length > 1 || record.sessions.length > 1,
  )
  // Cross-file duplication, which the entity-keyed contention above cannot see by construction.
  const duplicateWork = crossFileDuplicateWork(entityTouches(capsules))
  const leases = liveLeases(loadLeases(paths), now)
  const answers = hubAnswers(events)
  const since = ownershipSince(ownershipHistory(events))
  const index = writeIndex(events)
  const stale = staleAssumptions(loadAssumptions(paths), loadContracts(paths))

  // Most contested first, so the capped list keeps the rulings that matter most.
  const ordered = [...contention].sort(
    (a, b) =>
      b.tasks.length - a.tasks.length ||
      b.touches - a.touches ||
      compareCodepoint(a.entityKey, b.entityKey),
  )

  const rulings: HubRuling[] = ordered.slice(0, HUB_RULING_LIMIT).map((record) => {
    const ruled = ruleOn(record, answers)
    return {
      entityKey: record.entityKey,
      kind: record.kind,
      path: record.path,
      tasks: [...record.tasks].sort(compareCodepoint),
      sessions: [...record.sessions].sort(compareCodepoint),
      intents: record.intents
        .filter((intent) => intent.trim().length > 0)
        .slice(0, HUB_INTENT_LIMIT)
        .map((intent) => cap(intent)),
      word: ruled.word,
      basis: ruled.basis,
      similarity: ruled.similarity === null ? null : Math.round(ruled.similarity * 100) / 100,
      needsResolution: ruled.word === 'ambiguous',
      owner: ownerOf(record, leases, index.first, since, now),
      resolvedBy: ruled.resolvedBy,
      supersededAnswers: ruled.superseded,
    }
  })

  /*
   * Who is on what, right now.
   *
   * One entry per live lease, keyed by task, earliest grant first. The path comes from the
   * ledger rather than from the lease, because a lease records an entity key and a window that
   * is about to write a *file* has to be able to recognise itself in this.
   */
  const holders: HubHolder[] = []
  const holderSeen = new Set<string>()
  for (const lease of [...leases].sort(
    (a, b) => compareCodepoint(a.entityKey, b.entityKey) || compareCodepoint(a.grantedAt, b.grantedAt),
  )) {
    // One holder per (entity, task): renewals are the same holder, not a second one.
    const seenKey = `${lease.entityKey}\u0000${lease.taskId}`
    if (holderSeen.has(seenKey)) continue
    holderSeen.add(seenKey)
    const path = index.path.get(lease.entityKey) ?? (lease.kind === 'file' ? lease.entityKey.replace(/^file::/, '') : '')
    if (!path) continue
    holders.push({
      entityKey: lease.entityKey,
      kind: lease.kind,
      path,
      taskId: lease.taskId,
      sessionId: lease.sessionId,
      reason: cap(lease.reason),
      expiresAt: lease.expiresAt,
      heldMinutes: minutesBetween(since.get(lease.entityKey)?.since ?? lease.grantedAt, now),
      others: (index.tasks.get(lease.entityKey) ?? []).filter((taskId) => taskId !== lease.taskId).sort(compareCodepoint),
    })
  }

  const hubStale: HubStaleItem[] = stale
    .map((entry) => ({
      taskId: entry.taskId,
      contract: entry.contract,
      assumedVersion: entry.assumedVersion,
      currentVersion: entry.currentVersion,
      breaking: entry.breaking,
    }))
    .sort((a, b) => compareCodepoint(a.taskId, b.taskId) || compareCodepoint(a.contract, b.contract))

  const integration = [...(extras.integration ?? [])]
  const parallelism = extras.parallelism ?? { mean: 0, peak: 0, parallelFraction: 0 }
  const published = events.filter((event) => event.hostEvent === HUB_PUBLISH_HOST_EVENT).length

  /*
   * How stale the newest fact in this ruling is.
   *
   * Hub events are excluded: a published ruling is not a fact about work, and counting it would
   * make the lag read as zero on a workspace where nothing had happened for an hour.
   */
  let newestInputAt: number | null = null
  for (const event of events) {
    if (isHubEvent(event)) continue
    const at = Date.parse(event.timestampUtc)
    if (Number.isFinite(at) && (newestInputAt === null || at > newestInputAt)) newestInputAt = at
  }
  const inputLagMinutes =
    newestInputAt === null
      ? 0
      : Math.max(0, Math.round(((now.getTime() - newestInputAt) / 60_000) * 100) / 100)

  const metrics: HubMetrics = {
    rulings: rulings.length,
    ambiguous: rulings.filter((ruling) => ruling.needsResolution).length,
    owned: rulings.filter((ruling) => ruling.owner.taskId !== null).length,
    holders: holders.length,
    longestOwnershipMinutes: [
      ...rulings.map((ruling) => ruling.owner.heldMinutes),
      ...holders.map((holder) => holder.heldMinutes),
    ].reduce((best, minutes) => Math.max(best, minutes), 0),
    waitingTasks: [
      ...new Set([...rulings.flatMap((ruling) => ruling.owner.waiting), ...holders.flatMap((holder) => holder.others)]),
    ].length,
    inputLagMinutes,
    published,
    parallelismMean: parallelism.mean,
  }

  const core = {
    version: HUB_PROJECTION_VERSION,
    generatedAt: now.toISOString(),
    workspace: paths.root,
    authority: 'advisory' as const,
    targets: [
      ...new Set([
        ...rulings.map((ruling) => ruling.path),
        ...holders.map((holder) => holder.path),
      ]),
    ]
      .filter((path) => path !== '')
      .sort(compareCodepoint),
    rulings,
    holders,
    integration,
    stale: hubStale,
    duplicateWork,
    parallelism,
    metrics,
  }

  const id = hubVerdictId(core)
  const verdict: HubVerdict = { ...core, id, advisory: '' }
  return { ...verdict, advisory: renderHubAdvisory(verdict) }
}

/**
 * The ruling's identity: a hash of the conclusion and nothing else.
 *
 * Deliberately excludes the timestamp, the parallelism figure, the metrics and the ownership
 * durations. Every one of those moves on its own schedule; hashing any of them would make the
 * hub publish a "new" ruling every tick and bury the conclusion it exists to state. What is
 * left changes only when a conclusion, an owner recommendation, a branch, or an interface
 * actually changes.
 */
export function hubVerdictId(input: {
  readonly rulings: readonly HubRuling[]
  readonly holders: readonly HubHolder[]
  readonly integration: readonly HubIntegrationItem[]
  readonly stale: readonly HubStaleItem[]
}): string {
  const canonical = {
    rulings: [...input.rulings]
      .map((ruling) => [
        ruling.entityKey,
        ruling.word,
        ruling.basis,
        ruling.owner.taskId,
        ruling.needsResolution ? 1 : 0,
      ])
      .sort((a, b) => compareCodepoint(String(a[0]), String(b[0]))),
    /*
     * Holders are keyed by (entity, task) and deliberately *not* by expiry or by how long the
     * recommendation has stood. A lease is renewed on every call, so hashing its expiry would
     * make the hub publish a new ruling on every write — and "task A is still on this file" is
     * not news. A reservation being taken, transferred, or released is.
     */
    holders: [...input.holders]
      .map((holder) => [holder.entityKey, holder.taskId])
      .sort((a, b) => compareCodepoint(String(a[0]), String(b[0])) || compareCodepoint(String(a[1]), String(b[1]))),
    integration: [...input.integration]
      .map((item) => [item.taskId, item.branch])
      .sort((a, b) => compareCodepoint(String(a[0]), String(b[0]))),
    stale: [...input.stale]
      .map((item) => [item.taskId, item.contract, item.currentVersion])
      .sort(
        (a, b) =>
          compareCodepoint(String(a[0]), String(b[0])) || compareCodepoint(String(a[1]), String(b[1])),
      ),
  }
  return `hub-${createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)}`
}

/* -------------------------------------------------------------------------- */
/* The published event, and the injected text                                  */
/* -------------------------------------------------------------------------- */

/** The append-only ledger event that carries one published ruling. */
export function hubPublishEvent(verdict: HubVerdict, at: string = verdict.generatedAt): CoordEvent {
  /*
   * Every entity somebody is recommended to own, from both facts: a ruling's owner and a live
   * reservation. Recorded so the next ruling can say how long a recommendation has stood — the
   * starvation proxy — without re-deriving it from a mutable file.
   */
  const ownership: Record<string, string> = {}
  for (const holder of verdict.holders) ownership[holder.entityKey] = holder.taskId
  for (const ruling of verdict.rulings) {
    if (ruling.owner.taskId) ownership[ruling.entityKey] = ruling.owner.taskId
  }
  /*
   * Entities are carried so `agentgit_why <entity>` can explain a ruling later. They are
   * inert everywhere that derives contention: `buildCapsules` skips an event with no task
   * id, and `coord_ledger.py` counts entity touches only for `file_write`/`file_read`, so an
   * `advisory_injected` row cannot manufacture a collision.
   */
  const entities: Entity[] = [
    ...verdict.rulings.map((ruling) => ({ kind: ruling.kind, identifier: ruling.path, path: ruling.path })),
    ...verdict.holders.map((holder) => ({ kind: holder.kind, identifier: holder.path, path: holder.path })),
  ]
  const ambiguous = verdict.rulings.filter((ruling) => ruling.needsResolution).map((ruling) => ruling.entityKey)
  const summary = [
    ...verdict.rulings.map(
      (ruling) =>
        `${ruling.entityKey} ${ruling.word}${ruling.owner.taskId ? ` (owner ${ruling.owner.taskId})` : ''}`,
    ),
    ...verdict.holders
      .filter((holder) => !verdict.rulings.some((ruling) => ruling.entityKey === holder.entityKey))
      .map((holder) => `${holder.entityKey} held by ${holder.taskId}`),
  ]
  return buildEvent({
    kind: 'advisory_injected',
    timestampUtc: at,
    sessionId: `${HUB_SESSION_PREFIX}${machineId()}`,
    taskId: null,
    entities,
    intentText: null,
    hostEvent: HUB_PUBLISH_HOST_EVENT,
    reason: summary.length === 0 ? 'no contention: nothing to rule on' : summary.join('; '),
    detail: {
      rulingId: verdict.id,
      authority: verdict.authority,
      /** How many contentions were ruled on. `0` with holders is a reservation, not silence. */
      rulingCount: verdict.rulings.length,
      holderCount: verdict.holders.length,
      ownership,
      ambiguous,
      integration: verdict.integration.map((item) => item.taskId),
      stale: verdict.stale.map((item) => `${item.taskId}:${item.contract}@${item.currentVersion}`),
      parallelismMean: verdict.parallelism.mean,
      /*
       * Recorded per publish, not only in the live projection, so the average lag over a window is
       * computable from the ledger. A snapshot of the current lag says nothing about whether the
       * spine was keeping up an hour ago, and that is the only version of the number that can be
       * compared against anything.
       */
      inputLagMinutes: verdict.metrics.inputLagMinutes,
    },
  })
}

/** The word an agent should act on, for one ruling. */
function actionFor(ruling: HubRuling): string {
  if (ruling.needsResolution) {
    return (
      'undecided — two intents are on this ground and the recorded evidence cannot say whether they are one job. ' +
      `Answer once with agentgit_hub_resolve(entityKey="${ruling.entityKey}", decision="reuse" or "replan")`
    )
  }
  if (ruling.word === 'reuse') {
    return `one job — do not start a second version of it${
      ruling.owner.taskId ? `; ${ruling.owner.taskId} is carrying it` : ''
    }`
  }
  return `different work on shared ground — scope this change away from it, or agree an order${
    ruling.owner.taskId ? `; ${ruling.owner.taskId} has been on it longest` : ''
  }`
}

/**
 * The injected text.
 *
 * Written here rather than in the hook so the thing injected is exactly the thing published:
 * one renderer, one string, and a hook that only reads a file. Session-neutral on purpose —
 * it is the same conclusion for every window, which is what "one answer" has to mean.
 */
/**
 * Pairs of tasks whose intents say one job, on ground they do not share.
 *
 * The blind spot this closes: a {@link HubRuling} is keyed by an entity, so two agents doing
 * one change in two differently-named files never meet one, and the ledger is silent about the
 * commonest duplication there is. This compares the intents across entities instead, and only
 * where the two tasks share no entity at all — shared ground is a ruling's business, and
 * reporting it here too would double-count and dilute the rulings.
 *
 * Bounded on both ends: at most {@link HUB_DUPLICATE_WORK_LIMIT} pairs are returned, and only
 * the first 60 tasks by id are compared, so the cost cannot grow without limit in a workspace
 * with hundreds of capsules.
 */
function crossFileDuplicateWork(records: readonly ContentionRecord[]): HubDuplicateWork[] {
  const byTask = new Map<string, { intents: Set<string>; entities: Set<string> }>()
  for (const record of records) {
    for (const task of record.tasks) {
      let entry = byTask.get(task)
      if (!entry) {
        entry = { intents: new Set(), entities: new Set() }
        byTask.set(task, entry)
      }
      entry.entities.add(record.entityKey)
      for (const intent of record.intents) {
        if (intent.trim().length > 0) entry.intents.add(intent)
      }
    }
  }

  const tasks = [...byTask.keys()].sort(compareCodepoint).slice(0, 60)
  const found: HubDuplicateWork[] = []
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = byTask.get(tasks[i])!
      const b = byTask.get(tasks[j])!
      if (a.intents.size === 0 || b.intents.size === 0) continue
      // Shared ground is what the rulings are for; this pass is only for the disjoint case.
      if ([...a.entities].some((key) => b.entities.has(key))) continue

      let best = 0
      let pair: [string, string] | null = null
      for (const ia of a.intents) {
        for (const ib of b.intents) {
          const score = intentSimilarity(ia, ib)
          if (score > best) {
            best = score
            pair = [ia, ib]
          }
        }
      }
      if (pair === null || best < HUB_DUPLICATE_WORK_THRESHOLD) continue
      found.push({ tasks: [tasks[i], tasks[j]], similarity: Math.round(best * 100) / 100, intents: pair })
    }
  }
  return found
    .sort((x, y) => y.similarity - x.similarity || compareCodepoint(x.tasks[0], y.tasks[0]))
    .slice(0, HUB_DUPLICATE_WORK_LIMIT)
}

export function renderHubAdvisory(verdict: HubVerdict, maxChars = HUB_ADVISORY_MAX_CHARS): string {
  const lines: string[] = []
  lines.push('## Coordination hub — one ruling per contention (advisory)')
  lines.push(
    'Computed outside every session from the shared ledger, so it is the same in all of them. ' +
      'It never blocks a write; it is what the other windows have already concluded.',
  )

  if (verdict.rulings.length === 0 && verdict.holders.length === 0) {
    lines.push('', 'Nothing in flight: no entity is being changed by more than one task or session, and none is reserved.')
  }
  for (const ruling of verdict.rulings) {
    const held = ruling.owner.heldMinutes > 0 ? `, ${ruling.owner.heldMinutes}m` : ''
    const owner = ruling.owner.taskId
      ? `owner ${ruling.owner.taskId} (${ruling.owner.basis}${held})`
      : 'no owner yet'
    lines.push('', `- ${ruling.entityKey} — ${ruling.word.toUpperCase()} (${ruling.basis}); ${owner}`)
    if (ruling.owner.waiting.length > 0) lines.push(`  also in flight here: ${ruling.owner.waiting.join(', ')}`)
    for (const intent of ruling.intents) lines.push(`  recorded intent: "${intent}"`)
    if (ruling.resolvedBy) lines.push(`  decided by session ${ruling.resolvedBy}`)
    if (ruling.supersededAnswers > 0) {
      lines.push(`  ${ruling.supersededAnswers} later answer(s) recorded and ignored: the earliest conclusion stands`)
    }
    lines.push(`  → ${actionFor(ruling)}`)
  }

  /*
   * Reservations, minus any entity a ruling already covered.
   *
   * This is the block that reaches a window *before* it creates a collision. A ruling can only
   * exist once two tasks have touched the same ground; a lease exists from the moment one task
   * says it is working there, which is the moment a second one needs to know.
   */
  const uncovered = verdict.holders.filter(
    (holder) => !verdict.rulings.some((ruling) => ruling.entityKey === holder.entityKey),
  )
  if (uncovered.length > 0) {
    lines.push('', 'Reserved ground — a task is on this now, whether or not anyone else has touched it:')
    for (const holder of uncovered) {
      lines.push(
        `- ${holder.entityKey} — held by ${holder.taskId}` +
          `${holder.heldMinutes > 0 ? ` for ${holder.heldMinutes}m` : ''} until ${holder.expiresAt}`,
      )
      if (holder.reason) lines.push(`  why: "${holder.reason}"`)
      if (holder.others.length > 0) lines.push(`  also in flight here: ${holder.others.join(', ')}`)
      lines.push(
        '  → if this is the same work, reuse or extend theirs; if it is different, agree who owns it before writing',
      )
    }
  }

  if (verdict.integration.length > 0) {
    lines.push('', `Integration order: ${verdict.integration.map((item) => item.taskId).join(' -> ')}`)
  }

  /*
   * The cross-file pass. Rendered after the rulings because it is a weaker claim than any of
   * them: same work, different ground, no owner and no decision. A window reads it as a
   * question — "is this the change you are already making?" — which is the one thing a
   * per-entity ruler can never ask.
   */
  if (verdict.duplicateWork.length > 0) {
    lines.push(
      '',
      'Possibly one job on different files — no shared ground, so no ruling; check before writing:',
    )
    for (const pair of verdict.duplicateWork) {
      lines.push(
        `- ${pair.tasks[0]} and ${pair.tasks[1]} (intent similarity ${pair.similarity}):` +
          ` "${pair.intents[0]}" vs "${pair.intents[1]}"`,
      )
    }
    lines.push('  → if it is one change, one of you should reuse the other\'s work rather than repeat it')
  }

  if (verdict.stale.length > 0) {
    lines.push('', 'Interfaces that moved (re-read before relying on the old shape):')
    for (const item of verdict.stale) {
      lines.push(
        `  ${item.contract} v${item.assumedVersion} -> v${item.currentVersion}` +
          `${item.breaking ? ' (breaking)' : ''} — ${item.taskId}`,
      )
    }
  }

  const text = lines.join('\n')
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                  */
/* -------------------------------------------------------------------------- */

export interface HubPublishResult {
  readonly published: boolean
  readonly id: string
  readonly reason: 'first-ruling' | 'changed' | 'unchanged' | 'suppressed' | 'nothing-to-rule-on'
}

/**
 * The last ruling in the ledger, with the one fact needed to publish a *clearing* correctly.
 */
export interface HubPublishedRuling {
  readonly id: string
  readonly rulingCount: number
  /** True when the ruling had neither a contention nor a reservation to report. */
  readonly saysNothing: boolean
  /** How many rulings had been published including this one, so the count can be carried forward. */
  readonly published: number
  readonly at: string
}

/**
 * The ruling already in the ledger, if any.
 *
 * Read from the ledger rather than from the projection so a daemon restart republishes
 * nothing: the conclusion is durable in the event stream, and the projection is only a
 * cache of it.
 */
export function lastPublishedRuling(events: readonly CoordEvent[]): HubPublishedRuling | null {
  let newest: HubPublishedRuling | null = null
  let count = 0
  for (const event of events) {
    if (event.hostEvent !== HUB_PUBLISH_HOST_EVENT) continue
    const id = event.detail?.rulingId
    if (typeof id !== 'string' || id === '') continue
    count += 1
    const rulingCount = typeof event.detail?.rulingCount === 'number' ? (event.detail.rulingCount as number) : 1
    if (!newest || compareCodepoint(event.timestampUtc, newest.at) >= 0) {
      newest = {
        id,
        rulingCount,
        // A ruling written before this field existed always had something in it: an empty one was
        // never worth writing. Reading it as "said something" keeps a clearing publishable.
        saysNothing: rulingCount === 0 && event.detail?.holderCount === 0,
        published: count,
        at: event.timestampUtc,
      }
    }
  }
  // The count is a property of the whole stream, not of the newest line, so it is set once every
  // event has been seen. Reading it off the newest event alone would undercount whenever the
  // newest line happened not to be written last in the file.
  return newest === null ? null : { ...newest, published: count }
}

/** {@link lastPublishedRuling} narrowed to the id, for callers that need nothing else. */
export function lastPublishedRulingId(events: readonly CoordEvent[]): string | null {
  return lastPublishedRuling(events)?.id ?? null
}

/** The ruling's self-cost at the moment it was computed, with one correction applied. */
function withPublishedCount(verdict: HubVerdict, published: number): HubVerdict {
  /*
   * `metrics.published` is counted from the ledger *at compute time*, so a verdict that is about to
   * be published necessarily reports the count from before its own write — a projection saying
   * "0 ruling(s) published" while holding the first ruling. The projection is rewritten once after
   * a successful publish so the number it carries includes the ruling it describes.
   */
  if (verdict.metrics.published === published) return verdict
  return { ...verdict, metrics: { ...verdict.metrics, published } }
}

/**
 * Publish the ruling if — and only if — it says something new.
 *
 * The guard is what makes the hub quiet: the projection is refreshed on every tick so a
 * reader always sees current facts, while the ledger only grows when a conclusion actually
 * moved. A ruling that keeps computing to the same id is not news, and writing it again
 * would make every reader treat a stable workspace as a changing one.
 *
 * A ruling with nothing to rule on *and* nobody holding anything is not published. An empty
 * ledger is the absence of a conclusion, not a conclusion, and a workspace that is quiet most of
 * the day would otherwise accumulate one worthless event per restart. Publishing happens when
 * there is a contention, when a reservation is taken or released, and when either is *cleared* to
 * nothing — because "this ground is free again" is a real conclusion.
 */
export function publishHubVerdict(
  paths: WorkspacePaths,
  verdict: HubVerdict,
  options: {
    readonly publish?: boolean
    /** What the caller last published. Omitted means "read the ledger to find out". */
    readonly previous?: HubPublishedRuling | null
  } = {},
): HubPublishResult {
  writeHubVerdict(paths, verdict)

  if (options.publish === false) return { published: false, id: verdict.id, reason: 'suppressed' }

  const previous =
    options.previous !== undefined ? options.previous : lastPublishedRuling(readAllEvents(paths).events)

  const saysNothing = verdict.rulings.length === 0 && verdict.holders.length === 0
  if (saysNothing && (previous === null || previous.saysNothing)) {
    return { published: false, id: verdict.id, reason: 'nothing-to-rule-on' }
  }
  if (previous?.id === verdict.id) return { published: false, id: verdict.id, reason: 'unchanged' }

  const at = new Date(verdict.generatedAt)
  const stamp = Number.isFinite(at.getTime()) ? at : new Date()
  try {
    appendEvent(paths, hubPublishEvent(verdict, stamp.toISOString()), stamp)
  } catch {
    // A publish that cannot be written leaves the previous conclusion standing, which is the
    // honest outcome: the projection still shows the new one, and the next tick tries again.
    return { published: false, id: verdict.id, reason: 'changed' }
  }
  // The projection now describes a ruling that is in the ledger, so its own count must say so.
  writeHubVerdict(paths, withPublishedCount(verdict, (previous?.published ?? verdict.metrics.published) + 1))
  return { published: true, id: verdict.id, reason: previous === null ? 'first-ruling' : 'changed' }
}
