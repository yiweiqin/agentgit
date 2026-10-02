/** Validate untrusted CLI/MCP payloads before any ledger write. */
import { canonicalEntityPath, type WorkspacePaths } from './workspace.ts'
import { resolve } from 'node:path'
import { impactDigest, impactKey, type ImpactArtifact, type ImpactChange, type ImpactContract, type ImpactDependency, type ImpactEntity, type ImpactSession } from './impact.ts'

type ObjectValue = Record<string, unknown>
function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as ObjectValue
}
function string(value: unknown, label: string, fallback?: string): string {
  if (fallback !== undefined && (value === undefined || (fallback === '' && value === ''))) return fallback
  if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw new Error(`${label} must be a nonempty string of at most 4000 characters`)
  return value.trim()
}
function choice<T extends string>(value: unknown, label: string, choices: readonly T[], fallback: T): T {
  if (value === undefined) return fallback
  if (!choices.includes(value as T)) throw new Error(`${label} must be one of ${choices.join(', ')}`)
  return value as T
}
function list<T>(value: unknown, label: string, parse: (v: unknown) => T): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array with at most 100 items`)
  return value.map(parse)
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer`)
  return value as number
}
function boolean(value: unknown, label: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}
function parts(value: unknown): string[] | undefined {
  return value === undefined ? undefined : list(value, 'parts', v => string(v, 'part'))
}
export interface ImpactIdentity { sessionId: string; taskId: string }

function fields(raw: ObjectValue, paths: WorkspacePaths) {
  const key = (v: unknown): string => {
    const value = string(v, 'entity key')
    if (!/^[a-z][a-z_-]*::.+/.test(value)) throw new Error('Entity keys must be qualified, for example file::src/auth.ts or symbol::Auth.login')
    return value.startsWith('file::') ? impactKey(`file::${canonicalEntityPath(paths.root, value.slice(6))}`) : value
  }
  const entities = list<ImpactEntity>(raw.entities, 'entities', v => {
    const item = object(v, 'entity')
    return { key: key(item.key), ...(item.path === undefined ? {} : { path: canonicalEntityPath(paths.root, string(item.path, 'path')) }),
      access: choice(item.access, 'access', ['read', 'write'], 'read'), parts: parts(item.parts) }
  })
  const dependencies = list<ImpactDependency>(raw.dependencies, 'dependencies', v => {
    const item = object(v, 'dependency')
    return { entity: key(item.entity), relation: choice(item.relation, 'relation', ['call', 'import', 'type', 'read', 'consume'], 'read'), parts: parts(item.parts) }
  })
  const artifacts = list<ImpactArtifact>(raw.artifacts, 'artifacts', v => {
    const item = object(v, 'artifact')
    return { id: string(item.id, 'artifact id'), ...(item.version === undefined ? {} : { version: string(item.version, 'artifact version') }),
      access: choice(item.access, 'access', ['read', 'write'], 'read') }
  })
  return {
    goal: string(raw.goal, 'goal', ''), workspace: paths.root,
    worktree: raw.worktree === undefined || raw.worktree === null ? null : resolve(paths.root, string(raw.worktree, 'worktree')).replace(/\\/g, '/'),
    branch: raw.branch === undefined || raw.branch === null ? null : string(raw.branch, 'branch'),
    entities, dependencies, artifacts,
  }
}

export function parseImpactSession(value: unknown, paths: WorkspacePaths, identity: ImpactIdentity, now = new Date()): ImpactSession {
  const raw = object(value, 'state')
  const contracts = list<ImpactContract>(raw.contracts, 'contracts', v => {
    const item = object(v, 'contract')
    return { name: string(item.name, 'contract name'), version: positive(item.version, 'contract version'), parts: parts(item.parts), inferred: boolean(item.inferred, 'inferred') }
  })
  return { ...fields(raw, paths), ...identity, updatedAt: now.toISOString(), active: boolean(raw.active, 'active', true),
    phase: choice(raw.phase, 'phase', ['planned', 'working', 'writing', 'idle'], 'working'), contracts }
}

export function parseImpactChange(value: unknown, paths: WorkspacePaths, identity: ImpactIdentity, now = new Date()): ImpactChange {
  const raw = object(value, 'change')
  const stream = string(raw.stream, 'stream')
  const revision = positive(raw.revision, 'revision')
  const base = fields(raw, paths)
  if (base.entities.some(e => e.access !== 'write') || base.artifacts.some(a => a.access !== 'write')) {
    throw new Error('Changed entities and artifacts must have access: write; put reads in dependencies')
  }
  const contracts = list(raw.contracts, 'contracts', v => {
    const item = object(v, 'contract change')
    return { name: string(item.name, 'contract name'), version: positive(item.version, 'contract version'),
      breaking: boolean(item.breaking, 'breaking'), parts: parts(item.parts) }
  })
  if (!base.entities.length && !base.artifacts.length && !contracts.length) throw new Error('A change must identify at least one entity, contract or artifact')
  const expiresAt = raw.expiresAt === undefined ? undefined : string(raw.expiresAt, 'expiresAt')
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now.getTime())) throw new Error('expiresAt must be a future timestamp')
  return { ...base, ...identity, stream, revision,
    eventId: raw.eventId === undefined ? `change-${impactDigest([identity.sessionId, stream, revision])}` : string(raw.eventId, 'eventId'),
    timestamp: now.toISOString(), expiresAt, summary: string(raw.summary, 'summary'),
    before: raw.before === undefined ? undefined : string(raw.before, 'before'), after: raw.after === undefined ? undefined : string(raw.after, 'after'),
    status: choice(raw.status, 'status', ['planned', 'in_progress', 'completed', 'cancelled'], 'completed'),
    compatibility: choice(raw.compatibility, 'compatibility', ['unknown', 'compatible', 'breaking'], 'unknown'),
    contracts, evidence: list(raw.evidence, 'evidence', v => string(v, 'evidence reference')),
  }
}
