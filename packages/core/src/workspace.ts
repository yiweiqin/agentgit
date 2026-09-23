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

/** Anything a project wants the coordinator to leave alone. */
export interface WorkspaceConfig {
  readonly version: number
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
  ignore: ['.agentgit/state/', 'node_modules/', '.git/'],
  quiet: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '*.min.js', '*.snap'],
  duplicateIntentThreshold: 0.42,
  leaseMinutes: 20,
  inFlightMinutes: 720,
}

/** Read `.agentgit/config.json`, falling back to defaults field by field. */
export function loadConfig(paths: WorkspacePaths): WorkspaceConfig {
  if (!existsSync(paths.config)) return DEFAULT_CONFIG
  try {
    const raw = JSON.parse(readFileSync(paths.config, 'utf8')) as Partial<WorkspaceConfig>
    return {
      version: typeof raw.version === 'number' ? raw.version : DEFAULT_CONFIG.version,
      ignore: Array.isArray(raw.ignore) ? raw.ignore : DEFAULT_CONFIG.ignore,
      quiet: Array.isArray(raw.quiet) ? raw.quiet : DEFAULT_CONFIG.quiet,
      duplicateIntentThreshold:
        typeof raw.duplicateIntentThreshold === 'number'
          ? raw.duplicateIntentThreshold
          : DEFAULT_CONFIG.duplicateIntentThreshold,
      leaseMinutes: typeof raw.leaseMinutes === 'number' ? raw.leaseMinutes : DEFAULT_CONFIG.leaseMinutes,
      inFlightMinutes: typeof raw.inFlightMinutes === 'number' ? raw.inFlightMinutes : DEFAULT_CONFIG.inFlightMinutes,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

/** Write a starter config, never overwriting an existing one. */
export function writeDefaultConfig(paths: WorkspacePaths): boolean {
  if (existsSync(paths.config)) return false
  mkdirSync(paths.agentgit, { recursive: true })
  writeFileSync(paths.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8')
  return true
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
 * volume. The last one is Windows-specific and was a live defect — `path.relative`
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
