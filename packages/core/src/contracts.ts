/**
 * Versioned shared contracts and the stale-assumption detector.
 *
 * The failure this exists to catch
 * --------------------------------
 * Git merges text. When one agent turns a helper asynchronous and another agent
 * keeps calling it synchronously in a different file, the merge is clean and the
 * result is broken. Nothing in the commit graph records that the second agent was
 * operating on an assumption about the first agent's interface, so nothing can
 * tell it that the assumption has expired.
 *
 * The fix is to make the assumption an object. A contract is a named interface
 * with a version and a place it is declared; an assumption is a note that some
 * task is currently coded against a particular version of it. When the version
 * moves, every task holding the older assumption is *stale* and can be named.
 *
 * Contracts are deliberately committed to Git (`contracts/index.json`) while
 * assumptions are derived state (`state/assumptions.json`). A contract is a fact
 * two machines must agree on; an assumption is an observation about a session that
 * only matters while that session is live.
 *
 * @module @agentgit/core/contracts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { compareCodepoint } from './ledger.ts'
import type { WorkspacePaths } from './workspace.ts'

/** One published version of one named interface. */
export interface ContractVersion {
  /** Stable logical name, e.g. `auth.identity`. Never renamed in place. */
  readonly name: string
  /** Monotonic per name. Bumped, never reused. */
  readonly version: number
  /** The symbol the interface is expressed as, when it has one. */
  readonly symbol: string | null
  /** File the interface is declared in, when known. */
  readonly declaredIn: string | null
  /**
   * True when a consumer written against the previous version may be wrong at
   * runtime even though it still compiles or merges.
   *
   * This is the flag that makes the difference between "informational" and
   * "stop and check", so it is authored by the publisher rather than inferred. A
   * detector that guessed at breakingness would be guessing at the one thing the
   * decision depends on.
   */
  readonly breaking: boolean
  /** Who published it, so a stale consumer knows who to talk to. */
  readonly publishedBy: string
  readonly publishedAt: string
  readonly summary: string
  /** Globs naming the files expected to consume this interface. */
  readonly consumers: readonly string[]
}

export interface ContractRegistry {
  readonly version: number
  readonly contracts: readonly ContractVersion[]
}

export const EMPTY_REGISTRY: ContractRegistry = { version: 1, contracts: [] }

/** A task's recorded belief about a contract. */
export interface Assumption {
  readonly taskId: string
  readonly sessionId: string
  readonly contract: string
  readonly version: number
  readonly recordedAt: string
  /** How the assumption was learned, so an inference is never read as a declaration. */
  readonly source: 'declared' | 'inferred'
  readonly path: string | null
}

export interface AssumptionLedger {
  readonly version: number
  readonly assumptions: readonly Assumption[]
}

export const EMPTY_ASSUMPTIONS: AssumptionLedger = { version: 1, assumptions: [] }

function registryPath(paths: WorkspacePaths): string {
  return join(paths.contracts, 'index.json')
}

function assumptionsPath(paths: WorkspacePaths): string {
  return join(paths.state, 'assumptions.json')
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    // A registry that cannot be parsed must not be silently replaced, because
    // overwriting it would destroy the only record of published versions. The
    // caller is told by returning the sentinel empty registry, and `publishContract`
    // refuses to write when it cannot read what is already there.
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Read the committed contract registry. */
export function loadContracts(paths: WorkspacePaths): ContractRegistry {
  const raw = readJson<ContractRegistry>(registryPath(paths), EMPTY_REGISTRY)
  if (!raw || !Array.isArray(raw.contracts)) return EMPTY_REGISTRY
  return { version: raw.version ?? 1, contracts: raw.contracts }
}

/** True when the registry file exists but could not be parsed. */
export function registryIsCorrupt(paths: WorkspacePaths): boolean {
  const file = registryPath(paths)
  if (!existsSync(file)) return false
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ContractRegistry
    return !Array.isArray(parsed?.contracts)
  } catch {
    return true
  }
}

/** Latest version of a contract, or null when the name is unknown. */
export function currentVersion(registry: ContractRegistry, name: string): ContractVersion | null {
  let best: ContractVersion | null = null
  for (const contract of registry.contracts) {
    if (contract.name !== name) continue
    if (!best || contract.version > best.version) best = contract
  }
  return best
}

/** Every version of a name, oldest first. */
export function versionHistory(registry: ContractRegistry, name: string): ContractVersion[] {
  return registry.contracts
    .filter((contract) => contract.name === name)
    .sort((a, b) => a.version - b.version)
}

/** Distinct contract names, sorted for stable output. */
export function contractNames(registry: ContractRegistry): string[] {
  return [...new Set(registry.contracts.map((contract) => contract.name))].sort(compareCodepoint)
}

export interface PublishInput {
  readonly name: string
  readonly symbol?: string | null
  readonly declaredIn?: string | null
  readonly breaking: boolean
  readonly publishedBy: string
  readonly summary: string
  readonly consumers?: readonly string[]
  /** Omit to auto-increment from the current version. */
  readonly version?: number
  readonly publishedAt?: string
}

export interface PublishResult {
  readonly contract: ContractVersion
  readonly previous: ContractVersion | null
  /** Tasks whose recorded assumption is now behind a breaking change. */
  readonly newlyStale: readonly StaleAssumption[]
}

/** Thrown when publishing would lose data or reuse a version number. */
export class ContractError extends Error {}

/**
 * Publish a new contract version.
 *
 * Refuses to publish over an unreadable registry: the alternative is writing a
 * registry that silently forgets every previously published version, which would
 * make every consumer look fresh.
 */
export function publishContract(
  paths: WorkspacePaths,
  input: PublishInput,
  assumptions: AssumptionLedger = loadAssumptions(paths),
): PublishResult {
  if (registryIsCorrupt(paths)) {
    throw new ContractError(
      `refusing to publish: ${registryPath(paths)} exists but is not a readable registry. ` +
        'Publishing would overwrite the only record of previously published versions.',
    )
  }
  if (!input.name.trim()) throw new ContractError('contract name is required')

  const registry = loadContracts(paths)
  const previous = currentVersion(registry, input.name)
  const version = input.version ?? (previous ? previous.version + 1 : 1)
  if (previous && version <= previous.version) {
    throw new ContractError(
      `version ${version} is not newer than the existing ${input.name} v${previous.version}; ` +
        'versions are bumped rather than reused so an old assumption stays distinguishable',
    )
  }

  const contract: ContractVersion = {
    name: input.name,
    version,
    symbol: input.symbol ?? null,
    declaredIn: input.declaredIn ?? null,
    breaking: input.breaking,
    publishedBy: input.publishedBy,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    summary: input.summary,
    consumers: input.consumers ?? [],
  }

  const next: ContractRegistry = { version: registry.version, contracts: [...registry.contracts, contract] }
  writeJson(registryPath(paths), next)

  return { contract, previous, newlyStale: contract.breaking ? staleAssumptions(assumptions, next) : [] }
}

/** Read the derived assumption ledger. */
export function loadAssumptions(paths: WorkspacePaths): AssumptionLedger {
  const raw = readJson<AssumptionLedger>(assumptionsPath(paths), EMPTY_ASSUMPTIONS)
  if (!raw || !Array.isArray(raw.assumptions)) return EMPTY_ASSUMPTIONS
  return { version: raw.version ?? 1, assumptions: raw.assumptions }
}

/**
 * Record or update one task's belief about one contract.
 *
 * Later records replace earlier ones for the same (task, contract) pair: a task
 * that has re-read the interface holds one belief, not a history of them. Keeping
 * the history would make every task permanently stale.
 */
export function recordAssumption(paths: WorkspacePaths, assumption: Assumption): AssumptionLedger {
  const ledger = loadAssumptions(paths)
  const kept = ledger.assumptions.filter(
    (existing) => !(existing.taskId === assumption.taskId && existing.contract === assumption.contract),
  )
  const next: AssumptionLedger = { version: ledger.version, assumptions: [...kept, assumption] }
  writeJson(assumptionsPath(paths), next)
  return next
}

/** One assumption that no longer matches the published interface. */
export interface StaleAssumption {
  readonly taskId: string
  readonly sessionId: string
  readonly contract: string
  readonly assumedVersion: number
  readonly currentVersion: number
  readonly breaking: boolean
  readonly publishedBy: string
  readonly summary: string
  readonly symbol: string | null
  readonly path: string | null
  readonly source: Assumption['source']
}

/**
 * Every assumption that is behind the current published version.
 *
 * A non-breaking bump is still reported, with `breaking: false`, because a
 * caller may want to mention it while only *acting* on the breaking ones. The
 * distinction is carried in the record rather than baked into which records are
 * returned, so the caller cannot accidentally lose it.
 */
export function staleAssumptions(
  ledger: AssumptionLedger,
  registry: ContractRegistry,
): StaleAssumption[] {
  const stale: StaleAssumption[] = []
  for (const assumption of ledger.assumptions) {
    const current = currentVersion(registry, assumption.contract)
    if (!current) continue
    if (current.version <= assumption.version) continue
    stale.push({
      taskId: assumption.taskId,
      sessionId: assumption.sessionId,
      contract: assumption.contract,
      assumedVersion: assumption.version,
      currentVersion: current.version,
      breaking: current.breaking,
      publishedBy: current.publishedBy,
      summary: current.summary,
      symbol: current.symbol,
      path: assumption.path,
      source: assumption.source,
    })
  }
  return stale.sort(
    (a, b) =>
      Number(b.breaking) - Number(a.breaking) ||
      compareCodepoint(a.contract, b.contract) ||
      compareCodepoint(a.taskId, b.taskId),
  )
}

/** Stale assumptions held by one task, which is what a preflight question is about. */
export function staleForTask(
  ledger: AssumptionLedger,
  registry: ContractRegistry,
  taskId: string,
): StaleAssumption[] {
  return staleAssumptions(ledger, registry).filter((entry) => entry.taskId === taskId)
}

/**
 * Contracts whose consumer globs cover a path.
 *
 * Used to attribute a write to the interfaces it is expected to consume, so a
 * stale assumption can be raised without the agent having declared anything. This
 * is a glob match on purpose: it is cheap, deterministic and auditable, none of
 * which is true of guessing from the file's contents inside a hook.
 */
export function contractsTouchingPath(registry: ContractRegistry, path: string): ContractVersion[] {
  const normalized = path.replace(/\\/g, '/')
  const matched: ContractVersion[] = []
  for (const name of contractNames(registry)) {
    const current = currentVersion(registry, name)
    if (!current) continue
    const hitsDeclaredIn = current.declaredIn !== null && current.declaredIn.replace(/\\/g, '/') === normalized
    const hitsConsumer = current.consumers.some((glob) => globMatches(glob, normalized))
    if (hitsDeclaredIn || hitsConsumer) matched.push(current)
  }
  return matched
}

/**
 * Minimal glob matcher, sufficient for the path patterns a contract declares.
 *
 * `*` stops at a separator and `**` does not, and `**​/` is allowed to match zero
 * directories so that `src/**​/*.ts` covers `src/a.ts` as well as `src/deep/a.ts`.
 * That last rule is the one that matters in practice: a contract written as
 * `src/**​/*.ts` is meant to cover the whole subtree including its root, and a
 * matcher that silently skipped the root would report a stale assumption as fresh
 * for exactly the files most likely to hold it.
 */
export function globMatches(glob: string, path: string): boolean {
  const pattern = glob.replace(/\\/g, '/')
  if (!pattern) return false
  return globToRegExp(pattern).test(path)
}

function escapeRegExpChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

function globToRegExp(pattern: string): RegExp {
  let out = '^'
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          out += '(?:.*/)?'
          index += 3
          continue
        }
        out += '.*'
        index += 2
        continue
      }
      out += '[^/]*'
      index += 1
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    out += escapeRegExpChar(char)
    index += 1
  }
  return new RegExp(`${out}$`)
}

/** A compact view for the board and the panel. */
export function registryView(registry: ContractRegistry): Array<{
  name: string
  version: number
  breaking: boolean
  symbol: string | null
  declaredIn: string | null
  publishedBy: string
  versions: number
}> {
  return contractNames(registry).map((name) => {
    const current = currentVersion(registry, name)!
    return {
      name,
      version: current.version,
      breaking: current.breaking,
      symbol: current.symbol,
      declaredIn: current.declaredIn,
      publishedBy: current.publishedBy,
      versions: versionHistory(registry, name).length,
    }
  })
}
