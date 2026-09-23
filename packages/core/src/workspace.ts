/**
 * Workspace layout and event spool for `.agentgit/`.
 *
 * Every Codex workspace folder owns its own coordination ledger, so "which
 * workspace am I in" is the first question any command has to answer. It is
 * answered by walking up from the current directory to the nearest ancestor that
 * a project could plausibly start at, which means a command run from a
 * subdirectory coordinates the repository rather than a stray nested folder.
 *
 * The spool is deliberately the *same* JSONL contract the migrated Python
 * analyser already reads (`coord_ledger.py` reads `<dir>/events.jsonl`). Here it
 * is sharded per machine instead of being one file, because two machines writing
 * one append-only file through a Git push is not a merge Git can do usefully:
 * sharding turns a write conflict into two files that both survive.
 *
 * @module @agentgit/core/workspace
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { fromWire, parseWireLine, serializeEvent } from './ledger.ts'
import type { CoordEvent, WireEvent } from './types.ts'

/** The directory every coordinate lived in. */
export const AGENTGIT_DIR = '.agentgit'

/** Subdirectories of {@link AGENTGIT_DIR}. */
export const EVENTS_DIR = 'events'
export const CONTRACTS_DIR = 'contracts'
export const STATE_DIR = 'state'

export interface WorkspacePaths {
  readonly root: string
  readonly agentgit: string
  readonly config: string
  readonly events: string
  readonly contracts: string
  readonly state: string
}

/** A path is a workspace when it already carries coordination state. */
function looksLikeWorkspace(dir: string): boolean {
  return existsSync(join(dir, AGENTGIT_DIR))
}

/**
 * Nearest ancestor that is a workspace, else nearest ancestor that is a repo.
 *
 * Falling back to `.git` means `agentgit status` works in a repository that has
 * not been claimed yet, which is what lets the first command a user runs be a
 * useful one instead of an error telling them to run a different command first.
 */
export function findWorkspaceRoot(startDir: string = process.cwd()): string {
  let current = resolve(startDir)
  let vcsFallback: string | null = null
  for (;;) {
    if (looksLikeWorkspace(current)) return current
    if (vcsFallback === null && existsSync(join(current, '.git'))) vcsFallback = current
    const parent = dirname(current)
    if (parent === current) return vcsFallback ?? resolve(startDir)
    current = parent
  }
}

/** Resolve the conventional paths for a workspace root. */
export function workspacePaths(root: string): WorkspacePaths {
  const agentgit = join(root, AGENTGIT_DIR)
  return {
    root,
    agentgit,
    config: join(agentgit, 'config.json'),
    events: join(agentgit, EVENTS_DIR),
    contracts: join(agentgit, CONTRACTS_DIR),
    state: join(agentgit, STATE_DIR),
  }
}

/** Stable per-machine shard label. Hostname is sanitised because it becomes a filename. */
export function machineId(): string {
  const raw = process.env.AGENTGIT_MACHINE?.trim() || hostname() || 'unknown'
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'unknown'
}

/** `<events>/<machine>-<YYYY-MM-DD>.jsonl` for a given instant. */
export function shardPath(paths: WorkspacePaths, at: Date = new Date()): string {
  const day = at.toISOString().slice(0, 10)
  return join(paths.events, `${machineId()}-${day}.jsonl`)
}

/** Create every directory the workspace needs. Safe to call repeatedly. */
export function ensureWorkspace(root: string): WorkspacePaths {
  const paths = workspacePaths(root)
  for (const dir of [paths.agentgit, paths.events, paths.contracts, paths.state]) {
    mkdirSync(dir, { recursive: true })
  }
  return paths
}

/** Record one event into the current machine's shard. */
export function appendEvent(paths: WorkspacePaths, event: CoordEvent, at: Date = new Date()): string {
  mkdirSync(paths.events, { recursive: true })
  const file = shardPath(paths, at)
  appendFileSync(file, serializeEvent(event), { encoding: 'utf8' })
  return file
}

/**
 * Read every shard, tolerating a malformed line.
 *
 * A hook can be killed mid-write, so a torn final line is a real possibility and
 * must not make the whole ledger unreadable. The bad line is counted and skipped
 * rather than thrown on, because a coordination view that refuses to load is
 * strictly worse than one that reports it lost a record.
 */
export function readAllEvents(paths: WorkspacePaths): { events: CoordEvent[]; malformed: number; files: string[] } {
  if (!existsSync(paths.events)) return { events: [], malformed: 0, files: [] }
  const files = readdirSync(paths.events)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => join(paths.events, name))

  const events: CoordEvent[] = []
  let malformed = 0
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      malformed += 1
      continue
    }
    let lineNumber = 0
    for (const line of text.split('\n')) {
      lineNumber += 1
      if (!line.trim()) continue
      try {
        events.push(fromWire(parseWireLine(line, lineNumber) as WireEvent))
      } catch {
        malformed += 1
      }
    }
  }
  return { events, malformed, files }
}

/**
 * The arms this product runs, and why two of the research arms are not here.
 *
 * `config.ts` defines seven arms for the research harness. Two of them cannot be
 * expressed as a workspace setting, and offering them would put two names on one
 * behaviour:
 *
 * - `A4-gated` refuses writes. This product never does - refusing lowers the amount of
 *   work rather than raising the amount of coordination, which is why `PRODUCT_POLICY` is
 *   `action: 'none'`. Wiring it in would make "block my agents" reachable from a config
 *   file, so it is refused *by name* with the reason rather than silently downgraded.
 * - `A2-inert` means "the plugin is loaded and touching nothing". That is a distinction
 *   between two *processes*, and a workspace config has one process. In this product it is
 *   byte-for-byte `A0-baseline`, and two arm labels for one arm would make the experiment's
 *   own labels lie.
 * - `A4-detect-only` computes a gate decision and records it without acting. The product
 *   has no gate to dry-run; more importantly, every verdict is already recorded in the
 *   event detail (`detail.verdict`), so "what a gate would have done" is derivable from
 *   any ledger the product writes. A separate arm would add a name and no information.
 *
 * What remains is the 2x2 that a non-gating coordination tool actually has: whether it
 * records at all, and whether it sees beyond its own session.
 */
export const PRODUCT_ARMS = ['A0-baseline', 'A1-instrument', 'A3-advisory', 'A4-session-only'] as const
export type ProductArm = (typeof PRODUCT_ARMS)[number]

/** The arm the product ships with: record cross-session, and say what was seen. */
export const DEFAULT_ARM: ProductArm = 'A3-advisory'

/**
 * What each arm means in this product, in one line, for `agentgit config`.
 *
 * Kept next to the arm list so an arm cannot be added without a description: the point of
 * exposing them is that a user can tell what they are switching between.
 */
export const ARM_EFFECTS: Readonly<Record<ProductArm, string>> = {
  'A0-baseline': 'record nothing, see nothing, always allow - the control',
  'A1-instrument': 'record cross-session and decide, but offer no next actions - measurement only',
  'A3-advisory': 'record cross-session, report what was seen, offer next actions (default)',
  'A4-session-only': 'record, but see only this session - cross-session work is invisible (the shared-ledger ablation)',
}

/** True when the arm records nothing at all, so the hook should not append. */
export function armRecordsNothing(arm: string): boolean {
  return arm === 'A0-baseline'
}

/** True when the arm may see events written by other sessions. */
export function armSeesOtherSessions(arm: string): boolean {
  return arm === 'A1-instrument' || arm === 'A3-advisory'
}

/** True when the arm may hand the caller next actions. */
export function armOffersActions(arm: string): boolean {
  return arm === 'A3-advisory'
}

export function isProductArm(value: string): value is ProductArm {
  return (PRODUCT_ARMS as readonly string[]).includes(value)
}

/**
 * Resolve a configured arm name, refusing anything the product will not run.
 *
 * Throws rather than falling back to the default. A config file naming `A4-gated` is
 * someone trying to change the product's most load-bearing behaviour, and quietly running
 * `A3-advisory` instead would leave them believing they had gated writes, wondering why
 * nothing was ever blocked. The message names the arm and the reason.
 */
export function resolveProductArm(value: string | null | undefined): ProductArm {
  if (value == null || value === '') return DEFAULT_ARM
  if (isProductArm(value)) return value
  if (value === 'A4-gated') {
    throw new Error(
      'A4-gated refuses writes, and this product never does: it reports what it sees and hands you the command. ' +
        `Choose one of ${PRODUCT_ARMS.join(', ')}.`,
    )
  }
  if (value === 'A2-inert' || value === 'A4-detect-only') {
    throw new Error(
      `${value} is not offered as a workspace setting: in a product without a gate it behaves identically to ` +
        `${value === 'A2-inert' ? "'A0-baseline'" : "'A1-instrument'"}, and two arm names for one behaviour would ` +
        `make the labels meaningless. Choose one of ${PRODUCT_ARMS.join(', ')}.`,
    )
  }
  throw new Error(`unknown arm '${value}'. Choose one of ${PRODUCT_ARMS.join(', ')}.`)
}

/** Anything a project wants the coordinator to leave alone. */
export interface WorkspaceConfig {
  readonly version: number
  /**
   * Which experimental arm this workspace runs.
   *
   * The arm is the experiment's unit of analysis, so it belongs in the workspace rather
   * than in an environment variable: a number is only interpretable if the configuration
   * that produced it is recorded with it, and `.agentgit/config.json` is committed.
   */
  readonly arm: ProductArm
  readonly ignore: readonly string[]
  /** Globs whose writes are always treated as low-signal (lockfiles, generated code). */
  readonly quiet: readonly string[]
  /** Fraction of a matching path prefix that must overlap before it is a conflict. */
  readonly duplicateIntentThreshold: number
  /** Minutes a lease stays valid without a renewal. */
  readonly leaseMinutes: number
  /**
   * How long a task with no terminal event still counts as working.
   *
   * A capsule stays open until something says it closed, and an agent that stops
   * without saying so leaves it open forever. This bounds the damage: past the window,
   * a silent publisher is treated as settled, so the tasks waiting on it get a version
   * to replan against instead of an indefinite `wait`. Defaults to half a day, which is
   * longer than any plausible single session and shorter than a forgotten one.
   */
  readonly inFlightMinutes: number
}

export const DEFAULT_CONFIG: WorkspaceConfig = {
  version: 1,
  arm: DEFAULT_ARM,
  ignore: ['.agentgit/state/', 'node_modules/', '.git/'],
  quiet: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '*.min.js', '*.snap'],
  duplicateIntentThreshold: 0.42,
  leaseMinutes: 20,
  inFlightMinutes: 720,
}

/**
 * Read `.agentgit/config.json`, falling back to defaults field by field.
 *
 * The arm is resolved *outside* the per-field fallback, and deliberately: a config file
 * naming an arm the product will not run is a mistake about the product's most
 * load-bearing behaviour, and the blanket `catch` below would swallow it while silently
 * resetting every other field - so a user who mistyped an arm would also lose their tuned
 * thresholds, with no message saying either had happened. Anything else malformed still
 * degrades field by field, because a partially-usable config beats a refused one.
 */
export function loadConfig(paths: WorkspacePaths): WorkspaceConfig {
  if (!existsSync(paths.config)) return DEFAULT_CONFIG

  const raw = readConfigFile(paths.config)
  if (raw === null) return DEFAULT_CONFIG

  return {
    version: typeof raw.version === 'number' ? raw.version : DEFAULT_CONFIG.version,
    arm: resolveProductArm(raw.arm),
    ignore: Array.isArray(raw.ignore) ? raw.ignore : DEFAULT_CONFIG.ignore,
    quiet: Array.isArray(raw.quiet) ? raw.quiet : DEFAULT_CONFIG.quiet,
    duplicateIntentThreshold:
      typeof raw.duplicateIntentThreshold === 'number'
        ? raw.duplicateIntentThreshold
        : DEFAULT_CONFIG.duplicateIntentThreshold,
    leaseMinutes: typeof raw.leaseMinutes === 'number' ? raw.leaseMinutes : DEFAULT_CONFIG.leaseMinutes,
    inFlightMinutes: typeof raw.inFlightMinutes === 'number' ? raw.inFlightMinutes : DEFAULT_CONFIG.inFlightMinutes,
  }
}

/** Parse the config file, treating unreadable or unparseable JSON as absent. */
function readConfigFile(file: string): Partial<WorkspaceConfig> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Partial<WorkspaceConfig>
  } catch {
    return null
  }
}

/** Write a starter config, never overwriting an existing one. */
export function writeDefaultConfig(paths: WorkspacePaths): boolean {
  if (existsSync(paths.config)) return false
  mkdirSync(paths.agentgit, { recursive: true })
  writeFileSync(paths.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
  return true
}

/**
 * Change one field of the workspace config, creating the file if it is missing.
 *
 * Merges onto whatever is already there rather than writing defaults, so tuning a
 * threshold does not silently reset the arm or the ignore list. The value is written
 * through the same validation the read path uses, so `setArm` cannot produce a file that
 * `loadConfig` will refuse to read - a config the tool writes but then rejects is the one
 * failure mode that would make the setting untrustworthy.
 */
export function updateConfig(paths: WorkspacePaths, patch: Partial<WorkspaceConfig>): WorkspaceConfig {
  const current = existsSync(paths.config) ? readConfigFile(paths.config) : null
  // Resolve before writing, so an invalid arm is refused here rather than on the next read.
  // Done on the way in rather than by mutating the result, because every field of
  // `WorkspaceConfig` is readonly and a config object that was assigned to after
  // construction is exactly the kind of thing the read path is written to trust.
  const merged: WorkspaceConfig = {
    ...DEFAULT_CONFIG,
    ...(current ?? {}),
    ...patch,
    arm: resolveProductArm(patch.arm ?? current?.arm ?? DEFAULT_CONFIG.arm),
  } as WorkspaceConfig
  mkdirSync(paths.agentgit, { recursive: true })
  writeFileSync(paths.config, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return merged
}

/** True when a path matches one of the configured ignore prefixes. */
export function isIgnored(path: string, config: WorkspaceConfig): boolean {
  const normalized = path.replace(/\\/g, '/')
  return config.ignore.some((entry) => normalized.startsWith(entry) || normalized.includes(`/${entry}`))
}

/** Number of event shards and their total size, for `agentgit status` diagnostics. */
export function spoolStats(paths: WorkspacePaths): { shards: number; bytes: number } {
  if (!existsSync(paths.events)) return { shards: 0, bytes: 0 }
  let shards = 0
  let bytes = 0
  for (const name of readdirSync(paths.events)) {
    if (!name.endsWith('.jsonl')) continue
    shards += 1
    try {
      bytes += statSync(join(paths.events, name)).size
    } catch {
      // A file that vanished between listing and stating contributes nothing.
    }
  }
  return { shards, bytes }
}

/** The machine shard prefix, so a viewer can mark foreign shards as remote work. */
export function shardMachineOf(fileName: string): string {
  const base = fileName.split(sep).pop() ?? fileName
  const match = base.match(/^(.*)-(\d{4}-\d{2}-\d{2})\.jsonl$/)
  return match ? match[1] : base.replace(/\.jsonl$/, '')
}

/** Resolve a configured path, honouring absolute overrides used by the daemon. */
export function resolveConfigured(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  return isAbsolute(value) ? value : resolve(fallback, value)
}

/* -------------------------------------------------------------------------- */
/* One spelling for a file                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalise a path to a workspace-relative POSIX path, or null when it is not inside.
 *
 * Returns null in three cases that are all "cannot be expressed relative to this
 * workspace": the workspace root itself, anything above it, and anything on another
 * volume. The last one is Windows-specific and was a live defect - `path.relative`
 * between `C:\` and `D:\` hands back the absolute target path instead of a `..`
 * climb, so a check that only looked for `..` accepted it and the caller stored a
 * plausible-looking absolute path believing it was relative.
 *
 * A relative input is resolved against the workspace root rather than the process
 * directory. The process directory belongs to whoever launched the server or the
 * hook, and is not reliably the project; resolving against it produced keys that
 * matched nothing while looking correct.
 */
export function toWorkspaceRelative(root: string, path: string): string | null {
  const rootAbs = resolve(root)
  const targetAbs = resolve(rootAbs, path)
  if (targetAbs === rootAbs) return null

  const rel = relative(rootAbs, targetAbs)
  if (!rel || isAbsolute(rel)) return null
  const parts = rel.split(/[\\/]/)
  if (parts.includes('..')) return null
  return parts.join('/')
}

/**
 * The one spelling of a file's identity, shared by every ledger writer and reader.
 *
 * Workspace-relative when the file is inside the workspace, absolute when it is not.
 * This is what lets two clones of the same repository on two machines agree that
 * `file::src/auth.py` is one entity: an absolute key would make every machine's copy
 * look like separate ground, and the ledger's whole purpose is to disagree with that.
 *
 * `plugins/agentgit/scripts/track.mjs` has its own copy of this function, because the
 * hook must run with no dependencies and no build step. A core test drives both
 * through the same input table so the copies cannot drift apart unnoticed.
 */
export function canonicalEntityPath(root: string, path: string): string {
  const normalized = path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized === '') return normalized
  return toWorkspaceRelative(root, normalized) ?? normalized
}
