/** Directional, evidence-based impact inference. Scores are heuristics, not probabilities. */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import {
  directModuleEdge,
  isStructuralModuleCoupling,
  moduleIdOf,
  moduleNeighborhood,
  type ModuleGraph,
  type ModuleRouting,
} from './modules.ts'
import { intentSimilarity } from './policy.ts'

export type ImpactCategory = 'hard_conflict' | 'breaking_dependency' | 'soft_relevance' | 'background_only'
export type DeliveryPolicy = 'interrupt' | 'defer' | 'store-only'
/**
 * The tier vocabulary a reader and a projection use: when a warning may be injected.
 *
 * `immediate` is a boundary before a write, `defer` is the next safe point, and `record` is
 * never injected — it stays visible only on demand. This is a *derived* name for
 * {@link DeliveryPolicy}, not a second setting: one mapping, one source of truth, so the two
 * cannot drift into disagreeing about when a warning arrives.
 */
export type NotificationTier = 'immediate' | 'defer' | 'record'

export function notificationTierOf(policy: DeliveryPolicy): NotificationTier {
  if (policy === 'interrupt') return 'immediate'
  if (policy === 'defer') return 'defer'
  return 'record'
}

export type ImpactPhase = 'planned' | 'working' | 'writing' | 'idle'
export interface ImpactEntity { key: string; path?: string; access: 'read' | 'write'; parts?: string[] }
export interface ImpactDependency { entity: string; relation: 'call' | 'import' | 'type' | 'read' | 'consume'; parts?: string[] }
export interface ImpactContract { name: string; version: number; parts?: string[]; inferred?: boolean }
export interface ImpactArtifact { id: string; version?: string; access: 'read' | 'write' }
export interface ImpactSession {
  sessionId: string
  taskId: string
  goal: string
  workspace: string
  worktree: string | null
  branch: string | null
  updatedAt: string
  active: boolean
  phase: ImpactPhase
  entities: ImpactEntity[]
  dependencies: ImpactDependency[]
  contracts: ImpactContract[]
  artifacts: ImpactArtifact[]
}
export interface ImpactContractChange {
  name: string
  version: number
  breaking: boolean
  /** All incompatible versions, so an additive v3 does not hide a breaking v2. */
  breakingVersions?: number[]
  parts?: string[]
}
export interface ImpactChange {
  eventId: string
  sessionId: string
  taskId: string
  goal: string
  workspace: string
  worktree: string | null
  branch: string | null
  timestamp: string
  expiresAt?: string
  /** Stable producer-defined stream; a newer revision replaces an older one. */
  stream: string
  revision: number
  status: 'planned' | 'in_progress' | 'completed' | 'cancelled'
  summary: string
  before?: string
  after?: string
  compatibility: 'unknown' | 'compatible' | 'breaking'
  entities: ImpactEntity[]
  dependencies: ImpactDependency[]
  contracts: ImpactContractChange[]
  artifacts: ImpactArtifact[]
  evidence: string[]
}
export interface ImpactEvidence {
  relation: 'same_entity' | 'caller_callee' | 'shared_contract' | 'same_artifact' | 'upstream_downstream' | 'module_coupling'
  source: string
  target: string
  detail: string
  confirmed: boolean
}
export interface ImpactAssessment {
  id: string
  sourceEventId: string
  sourceSessionId: string
  targetSessionId: string
  targetTaskId: string
  category: ImpactCategory
  score: number
  scoreKind: 'heuristic'
  confidence: 'confirmed' | 'possible' | 'insufficient'
  severity: 'high' | 'medium' | 'low' | 'none'
  urgency: 'high' | 'normal' | 'none'
  policy: DeliveryPolicy
  summary: string
  action: string
  evidence: ImpactEvidence[]
  references: string[]
}
export interface ImpactOptions {
  now?: Date
  sessionTtlMs?: number
  thresholds?: Partial<Record<ImpactCategory, number>>
  /**
   * The code's own dependency graph, derived from real imports by `modules.ts`.
   *
   * It is optional, and everything it enables is additive: with no graph the analysis behaves
   * exactly as it did before, which is what makes the pairwise-vs-routed comparison in the
   * experiment an honest ablation rather than a rewrite.
   */
  moduleGraph?: ModuleGraph | null
  /** How far recall may travel from a changed file's module. Defaults to `one-hop` with a graph. */
  moduleRouting?: ModuleRouting
  /**
   * Hop bound for `transitive` routing. Ignored under `off` and `one-hop`, which are fixed at
   * zero and one edge. Left unset the walk is a single edge, so a direct caller cannot
   * accidentally turn `transitive` into "the whole repository".
   */
  moduleHops?: number
}
export const IMPACT_SESSION_TTL_MS = 30 * 60_000
export const IMPACT_THRESHOLDS: Record<ImpactCategory, number> = {
  hard_conflict: 0.85, breaking_dependency: 0.8, soft_relevance: 0.6, background_only: 1,
}
export const impactDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
export const impactKey = (value: string): string => value.startsWith('file::')
  ? `file::${posix.normalize(value.slice(6).replace(/\\/g, '/'))}` : value
const partsOverlap = (a?: string[], b?: string[]): boolean => !a?.length || !b?.length || a.some(part => b.includes(part))
const activeSession = (session: ImpactSession, now: Date, ttl: number): boolean => session.active &&
  Date.parse(session.updatedAt) <= now.getTime() && now.getTime() - Date.parse(session.updatedAt) <= ttl

function sameEntity(a: ImpactEntity, b: ImpactEntity): boolean {
  if (impactKey(a.key) === impactKey(b.key)) return true
  // Two different symbols in one file are separate entities. File overlap only recalls them.
  const pathA = a.key.startsWith('file::') ? a.key.slice(6) : a.path
  const pathB = b.key.startsWith('file::') ? b.key.slice(6) : b.path
  return (a.key.startsWith('file::') || b.key.startsWith('file::')) && Boolean(pathA && pathB &&
    impactKey(`file::${pathA}`) === impactKey(`file::${pathB}`))
}

/** The module an entity lives in, or null when nothing about it names a place. */
function entityModule(entity: ImpactEntity): string | null {
  if (entity.key.startsWith('file::')) return moduleIdOf(entity.key.slice('file::'.length)).id
  if (entity.path) return moduleIdOf(entity.path).id
  // A symbol with no path is real work with no ground: it cannot be placed, and saying so with
  // null is what keeps the router from silently excluding it.
  return null
}

function keyModule(key: string): string | null {
  return key.startsWith('file::') ? moduleIdOf(key.slice('file::'.length)).id : null
}

export interface ModuleCouplingProof {
  readonly category: ImpactCategory
  readonly score: number
  readonly evidence: ImpactEvidence
}

/**
 * Mechanical coupling evidence between a change and a receiver, from the import graph.
 *
 * This is the half of impact analysis nobody has to declare. The declared path
 * (`agentgit_impact_state`) only sees a receiver that wrote its dependencies down; a module
 * edge sees the receiver that never did — and it is directional, so the two cases are kept
 * apart:
 *
 * - **the receiver's module imports the changed module** — the change can break a consumer,
 *   which is the case a text-only matcher misses entirely when the two agents describe their
 *   work in different words;
 * - **the changed module imports the receiver's module** — the change may be an adaptation to
 *   work that is also moving, which is weaker and is reported as background unless the receiver
 *   is itself mid-write.
 *
 * Every proof is `confirmed: false` on purpose. A resolved import proves the modules are wired,
 * not that this particular change breaks that particular consumer, and a mechanical edge must
 * never be enough on its own to escalate to an interrupt. Module overlap without a real import
 * produces nothing at all — see {@link isStructuralModuleCoupling}.
 */
export function moduleCouplingEvidence(change: ImpactChange, target: ImpactSession, graph: ModuleGraph): ModuleCouplingProof[] {
  const changeModules = new Set<string>()
  for (const entity of change.entities) {
    const module = entityModule(entity)
    if (module) changeModules.add(module)
  }
  const targetModules = new Set<string>()
  for (const entity of target.entities) {
    const module = entityModule(entity)
    if (module) targetModules.add(module)
  }
  for (const dependency of target.dependencies) {
    const module = keyModule(dependency.entity)
    if (module) targetModules.add(module)
  }
  if (changeModules.size === 0 || targetModules.size === 0) return []

  const breaking = change.compatibility === 'breaking'
  const proofs: ModuleCouplingProof[] = []
  for (const changed of changeModules) {
    for (const receiver of targetModules) {
      if (changed === receiver) continue
      // Direction is decided by which edge exists, not by which module was passed first.
      const consumer = directModuleEdge(graph, receiver, changed)
      if (consumer && isStructuralModuleCoupling(consumer.kind)) {
        proofs.push({
          category: breaking ? 'breaking_dependency' : 'soft_relevance',
          score: breaking ? 0.85 : 0.62,
          evidence: {
            relation: 'module_coupling',
            source: changed,
            target: receiver,
            detail: `${receiver} imports ${changed} (${consumer.weight} reference(s)); this change touches ${changed} and the receiver declared no dependency on it.`,
            confirmed: false,
          },
        })
      }
      const producer = directModuleEdge(graph, changed, receiver)
      if (producer && isStructuralModuleCoupling(producer.kind)) {
        proofs.push({
          category: 'soft_relevance',
          score: 0.55,
          evidence: {
            relation: 'module_coupling',
            source: changed,
            target: receiver,
            detail: `${changed} imports ${receiver} (${producer.weight} reference(s)); ${receiver} is also moving, so this change may be adapting to it.`,
            confirmed: false,
          },
        })
      }
    }
  }
  return proofs
}

/**
 * Narrow the candidate pool to the modules the change could reach.
 *
 * This is where "route the change to the modules it affects" stops being a metaphor. Without it
 * every session is compared with every change; with it only the modules wired to the change are
 * visited.
 *
 * Three kinds of session are never dropped, and each is a correctness guard rather than a
 * convenience:
 * - one that **shares a contract or artifact**, because those are identifiers with no module and
 *   the router has no basis to exclude them;
 * - one with an entity or dependency the router **cannot place** (a bare symbol), since "unknown
 *   ground" is not evidence of "unrelated";
 * - one with **no entities at all**, because intent similarity is a global signal this router
 *   cannot index, and dropping those would silently remove the only recall path for a session
 *   that described its work without touching anything yet.
 *
 * The consequence is deliberate: a repository whose imports do not resolve degrades to the
 * pairwise baseline instead of losing warnings.
 */
function routeSessions(
  change: ImpactChange,
  sessions: readonly ImpactSession[],
  graph: ModuleGraph,
  routing: ModuleRouting,
  hops: number,
): readonly ImpactSession[] {
  const changeModules = new Set<string>()
  for (const entity of change.entities) {
    const module = entityModule(entity)
    if (module) changeModules.add(module)
  }
  // Nothing to route from: every session must stay, or the change would reach nobody.
  if (changeModules.size === 0) return sessions

  const nearby = new Set<string>()
  for (const module of changeModules) {
    for (const reached of moduleNeighborhood(graph, module, routing, hops)) nearby.add(reached)
  }

  return sessions.filter((session) => {
    if (session.contracts.some((b) => change.contracts.some((a) => a.name === b.name))) return true
    if (session.artifacts.some((b) => change.artifacts.some((a) => a.id === b.id))) return true
    let placed = false
    for (const entity of session.entities) {
      const module = entityModule(entity)
      if (module === null) return true
      placed = true
      if (nearby.has(module)) return true
    }
    for (const dependency of session.dependencies) {
      const module = keyModule(dependency.entity)
      if (module === null) return true
      placed = true
      if (nearby.has(module)) return true
    }
    return !placed
  })
}

/** Recall is intentionally broader than inference; lexical similarity never proves impact. */
export function retrieveImpactCandidates(
  change: ImpactChange,
  sessions: readonly ImpactSession[],
  options: ImpactOptions = {},
): ImpactSession[] {
  const now = options.now ?? new Date()
  const graph = options.moduleGraph ?? null
  const routing: ModuleRouting = options.moduleRouting ?? (graph ? 'one-hop' : 'off')
  const hops = options.moduleHops ?? 1
  // Without a graph, or with routing off, the pool is every session: the pairwise baseline.
  const pool = graph && routing !== 'off' ? routeSessions(change, sessions, graph, routing, hops) : sessions
  const keys = new Set(change.entities.map((entity) => impactKey(entity.key)))
  return pool.filter((session) => session.sessionId !== change.sessionId && session.workspace === change.workspace &&
    activeSession(session, now, options.sessionTtlMs ?? IMPACT_SESSION_TTL_MS) && (
      session.entities.some(b => change.entities.some(a => sameEntity(a, b) || Boolean(a.path && a.path === b.path))) ||
      session.dependencies.some(dep => keys.has(impactKey(dep.entity)) || change.artifacts.some(a => a.id === dep.entity)) ||
      session.contracts.some(b => change.contracts.some(a => a.name === b.name)) ||
      session.artifacts.some(b => change.artifacts.some(a => a.id === b.id)) ||
      intentSimilarity(change.goal, session.goal) >= 0.2 ||
      (graph !== null && moduleCouplingEvidence(change, session, graph).length > 0)
    ))
}

/** A -> B only: B's dependencies and assumptions are checked against A's actual changes. */
export function assessImpact(change: ImpactChange, target: ImpactSession, options: ImpactOptions = {}): ImpactAssessment {
  const evidence: ImpactEvidence[] = []
  let category: ImpactCategory = 'background_only'
  let score = 0.15
  let confirmed = false
  const severityRank: Record<ImpactCategory, number> = { background_only: 0, soft_relevance: 1, breaking_dependency: 2, hard_conflict: 3 }
  const add = (kind: ImpactCategory, value: number, proof: ImpactEvidence): void => {
    evidence.push(proof)
    if (severityRank[kind] > severityRank[category]) { category = kind; score = value; confirmed = proof.confirmed }
    else if (kind === category) { score = Math.max(score, value); confirmed ||= proof.confirmed }
  }
  const landed = change.status === 'completed'
  const coLocated = change.worktree !== null && target.worktree !== null && change.worktree === target.worktree
  const contractsKnown = change.contracts.length > 0 && change.contracts.every(c => target.contracts.some(a => a.name === c.name && !a.inferred))
  const contractsAffected = change.contracts.some(c => target.contracts.some(a => a.name === c.name && a.version < c.version && partsOverlap(c.parts, a.parts)))
  const breaksEntity = change.compatibility === 'breaking' && (!contractsKnown || contractsAffected)
  for (const changed of change.contracts) {
    for (const assumed of target.contracts.filter(c => c.name === changed.name && c.version < changed.version)) {
      if (!partsOverlap(changed.parts, assumed.parts)) continue
      const breaking = changed.breaking || (changed.breakingVersions ?? []).some(v => v > assumed.version && v <= changed.version)
      add(breaking ? 'breaking_dependency' : 'soft_relevance', assumed.inferred ? 0.65 : breaking ? 0.98 : 0.75, {
        relation: 'shared_contract', source: `${changed.name}@${changed.version}`, target: `${assumed.name}@${assumed.version}`,
        detail: `Receiver uses v${assumed.version}; producer published v${changed.version}${breaking ? ' across an incompatible change' : ' with compatible changes'}.`,
        confirmed: !assumed.inferred,
      })
    }
  }
  for (const entity of change.entities) {
    for (const dep of target.dependencies.filter(d => impactKey(d.entity) === impactKey(entity.key))) {
      if (!partsOverlap(entity.parts, dep.parts)) continue
      const breaking = breaksEntity
      add(breaking ? 'breaking_dependency' : 'soft_relevance', breaking ? 0.95 : 0.7, {
        relation: dep.relation === 'call' ? 'caller_callee' : 'upstream_downstream', source: entity.key, target: dep.entity,
        detail: `Receiver ${dep.relation}s the changed entity; compatibility is ${change.compatibility}.`, confirmed: true,
      })
    }
    for (const used of target.entities.filter(other => sameEntity(entity, other))) {
      if (!partsOverlap(entity.parts, used.parts)) continue
      const exact = impactKey(entity.key) === impactKey(used.key)
      const conflict = exact && used.access === 'write' && entity.access === 'write' && coLocated &&
        change.compatibility === 'breaking' && change.status !== 'planned'
      const breaksRead = exact && used.access === 'read' && breaksEntity
      add(conflict ? 'hard_conflict' : breaksRead ? 'breaking_dependency' : 'soft_relevance', conflict ? 0.96 : breaksRead ? 0.9 : exact ? 0.65 : 0.4, {
        relation: 'same_entity', source: entity.key, target: used.key,
        detail: conflict ? 'Incompatible writes target the same entity in the same worktree.' : breaksRead ? 'Receiver reads the entity with an explicitly incompatible change.' : 'Entity overlap; incompatible concurrent writes are not established.',
        confirmed: conflict || breaksRead,
      })
    }
  }
  for (const artifact of change.artifacts.filter(a => a.access === 'write')) {
    for (const used of target.artifacts.filter(a => a.id === artifact.id)) {
      if (used.access === 'read' && artifact.version !== undefined && used.version === artifact.version) continue
      const conflict = used.access === 'write' && coLocated && change.compatibility === 'breaking' && change.status !== 'planned'
      const breaking = used.access === 'read' && change.compatibility === 'breaking'
      add(conflict ? 'hard_conflict' : breaking ? 'breaking_dependency' : 'soft_relevance', conflict || breaking ? 0.95 : 0.7, {
        relation: used.access === 'write' ? 'same_artifact' : 'upstream_downstream', source: artifact.id, target: used.id,
        detail: `Producer writes ${artifact.id}${artifact.version ? `@${artifact.version}` : ''}; receiver ${used.access}s it${used.version ? `@${used.version}` : ''}.`,
        confirmed: true,
      })
    }
    for (const dep of target.dependencies.filter(d => d.entity === artifact.id)) {
      add(change.compatibility === 'breaking' ? 'breaking_dependency' : 'soft_relevance', change.compatibility === 'breaking' ? 0.95 : 0.7, {
        relation: 'upstream_downstream', source: artifact.id, target: dep.entity,
        detail: `Receiver ${dep.relation}s the producer's output.`, confirmed: true,
      })
    }
  }
  // Mechanical coupling, added last so it can only ever escalate a pair that the declared
  // evidence left at background. Every proof is unconfirmed, so a module edge alone lands on
  // `defer` at most and can never produce an `interrupt`.
  if (options.moduleGraph) {
    for (const proof of moduleCouplingEvidence(change, target, options.moduleGraph)) {
      add(proof.category, proof.score, proof.evidence)
    }
  }
  // Never label a recalled pair as a risk solely because its goals look alike.
  const selected = category as ImpactCategory
  const high = selected === 'hard_conflict' || selected === 'breaking_dependency'
  const urgent = high && confirmed && (landed || selected === 'hard_conflict') &&
    (target.phase === 'working' || target.phase === 'writing')
  const threshold = options.thresholds?.[selected] ?? IMPACT_THRESHOLDS[selected]
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Impact thresholds must be between 0 and 1')
  const policy: DeliveryPolicy = selected === 'background_only' || score < threshold ? 'store-only' : urgent ? 'interrupt' : 'defer'
  const action = selected === 'hard_conflict' ? 'At the next safe point, inspect the competing patch and coordinate ownership before another write.'
    : selected === 'breaking_dependency' ? 'At the next safe point, inspect the changed contract or output, adapt the consumer, and record its new assumption.'
    : selected === 'soft_relevance' ? 'Review the related change when the current step is complete.' : 'Keep as background; no action is currently required.'
  return {
    id: `impact-${impactDigest([change.sessionId, change.eventId, change.stream, target.sessionId, target.taskId])}`,
    sourceEventId: change.eventId, sourceSessionId: change.sessionId, targetSessionId: target.sessionId, targetTaskId: target.taskId,
    category: selected, score, scoreKind: 'heuristic', confidence: confirmed ? 'confirmed' : evidence.length ? 'possible' : 'insufficient',
    severity: high ? 'high' : selected === 'soft_relevance' ? 'low' : 'none', urgency: urgent ? 'high' : policy === 'defer' ? 'normal' : 'none',
    policy, summary: change.summary + (change.before || change.after ? ` (${change.before ?? '?'} → ${change.after ?? '?'})` : ''), action, evidence, references: change.evidence,
  }
}

/** Latest revision per producer stream, regardless of input order or duplicated events. */
export function currentImpactChanges(changes: readonly ImpactChange[], now = new Date()): ImpactChange[] {
  const latest = new Map<string, ImpactChange>()
  for (const change of changes) {
    if (Date.parse(change.timestamp) > now.getTime()) continue
    const key = JSON.stringify([change.workspace, change.sessionId, change.stream])
    const previous = latest.get(key)
    if (!previous || change.revision > previous.revision || (change.revision === previous.revision &&
      `${change.timestamp}:${change.eventId}` > `${previous.timestamp}:${previous.eventId}`)) latest.set(key, change)
  }
  return [...latest.values()].filter(change => change.status !== 'cancelled' &&
    (!change.expiresAt || Date.parse(change.expiresAt) > now.getTime()))
    .sort((a, b) => a.eventId.localeCompare(b.eventId))
}

export function analyzeImpacts(changes: readonly ImpactChange[], sessions: readonly ImpactSession[], options: ImpactOptions = {}): ImpactAssessment[] {
  const graph = options.moduleGraph ?? null
  const moduleRouting: ModuleRouting = options.moduleRouting ?? (graph ? 'one-hop' : 'off')
  const resolved: ImpactOptions = { ...options, moduleGraph: graph, moduleRouting }
  return currentImpactChanges(changes, options.now).flatMap(change =>
    retrieveImpactCandidates(change, sessions, resolved).map(target => assessImpact(change, target, resolved)))
}

export function renderImpact(impact: ImpactAssessment): string {
  return `[${impact.category}; ${impact.policy}] ${impact.summary}\n` +
    `From ${impact.sourceSessionId}, event ${impact.sourceEventId}.\n` +
    impact.evidence.map(e => `${e.source} → ${e.target}: ${e.detail}`).join('\n') +
    (impact.references.length ? `\nEvidence: ${impact.references.join('; ')}` : '') + `\n${impact.action}`
}

/** Preserve action and provenance even when a producer supplies a long summary. */
export function renderImpactAdvisory(impact: ImpactAssessment): string {
  const cap = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, n - 1)}…`
  return `[${impact.category}; ${impact.policy}] ${cap(impact.summary, 300)}\n` +
    `From ${cap(impact.sourceSessionId, 80)}, event ${cap(impact.sourceEventId, 80)}.\n` +
    impact.evidence.slice(0, 2).map(e => `${cap(e.source, 80)} → ${cap(e.target, 80)}: ${cap(e.detail, 120)}`).join('\n') +
    (impact.references.length ? `\nEvidence: ${cap(impact.references[0], 120)}` : '') + `\n${impact.action}`
}
